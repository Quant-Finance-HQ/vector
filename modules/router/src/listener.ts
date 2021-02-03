import {
  EngineEvents,
  RouterSchemas,
  INodeService,
  ConditionalTransferCreatedPayload,
  FullChannelState,
  IVectorChainReader,
  jsonifyError,
  Result,
} from "@connext/vector-types";
import { getRandomBytes32 } from "@connext/vector-utils";
import { Counter, Gauge } from "prom-client";
import Ajv from "ajv";
import { JsonRpcProvider } from "@ethersproject/providers";
import { BaseLogger } from "pino";
import { BigNumber } from "@ethersproject/bignumber";

import { adjustCollateral, requestCollateral } from "./services/collateral";
import { forwardTransferCreation, forwardTransferResolution, handleIsAlive } from "./forwarding";
import { IRouterStore } from "./services/store";
import { getRebalanceProfile } from "./services/config";
import { IRouterMessagingService } from "./services/messaging";
import { config } from "./config";

const ajv = new Ajv();

export type ChainJsonProviders = {
  [k: string]: JsonRpcProvider;
};

// Track number of times a payment was forwarded
const attempts = new Gauge({
  name: "router_forwarded_attempts",
  help: "router_forwarded_attempts_help",
  labelNames: ["routingId"] as const,
});

// Track successful forwards
const successfulCreation = new Gauge({
  name: "router_successful_forwarded_creation",
  help: "router_successful_forwarded_creation_help",
  labelNames: ["routingId"] as const,
});

const successfulResolution = new Gauge({
  name: "router_successful_forwarded_resolution",
  help: "router_successful_forwarded_resolution_help",
  labelNames: ["routingId"] as const,
});

// Track failing forwards
const failed = new Gauge({
  name: "router_failed_forwardeds",
  help: "router_failed_forwardeds_help",
  labelNames: ["routingId"] as const,
});

const activeTransfers = new Gauge({
  name: "router_active_transfers",
  help: "router_active_transfers_help",
  labelNames: ["channelAddress"] as const,
});

const transferSendTime = new Gauge({
  name: "router_sent_time",
  help: "router_sent_time_help",
  labelNames: ["routingId"] as const,
});

const openChannels = new Counter({
  name: "router_open_channels",
  help: "router_open_channels_help",
  labelNames: ["channelAddress", "chainId", "aliceIdentifier", "bobIdentifier"] as const,
});

export async function setupListeners(
  routerPublicIdentifier: string,
  routerSignerAddress: string,
  nodeService: INodeService,
  store: IRouterStore,
  chainReader: IVectorChainReader,
  messagingService: IRouterMessagingService,
  logger: BaseLogger,
): Promise<void> {
  const method = "setupListeners";
  const methodId = getRandomBytes32();
  logger.debug({ method, methodId, routerPublicIdentifier, routerSignerAddress }, "Method started");

  nodeService.on(EngineEvents.SETUP, async (data) => {
    openChannels.inc({
      channelAddress: data.channelAddress,
      chainId: data.chainId,
      aliceIdentifier: data.aliceIdentifier,
      bobIdentifier: data.bobIdentifier,
    });
  });

  // Set up listener to handle transfer creation
  nodeService.on(
    EngineEvents.CONDITIONAL_TRANSFER_CREATED,
    async (data: ConditionalTransferCreatedPayload) => {
      const meta = data.transfer.meta as RouterSchemas.RouterMeta;
      attempts.inc({ routingId: meta.routingId }, 1);
      const end = transferSendTime.startTimer({ routingId: meta.routingId });
      const res = await forwardTransferCreation(
        data,
        routerPublicIdentifier,
        routerSignerAddress,
        nodeService,
        store,
        logger,
        chainReader,
      );
      if (res.isError) {
        failed.inc({ routingId: meta.routingId }, 1);
        return logger.error(
          { method: "forwardTransferCreation", error: jsonifyError(res.getError()!) },
          "Error forwarding transfer",
        );
      }
      end();
      successfulCreation.inc({ routingId: meta.routingId }, 1);
      activeTransfers.set({ channelAddress: data.channelAddress }, data.activeTransferIds?.length ?? 0);
      logger.info({ method: "forwardTransferCreation", result: res.getValue() }, "Successfully forwarded transfer");
    },
    (data: ConditionalTransferCreatedPayload) => {
      // Only forward transfers with valid routing metas
      const meta = data.transfer.meta as RouterSchemas.RouterMeta;
      const validate = ajv.compile(RouterSchemas.RouterMeta);
      const valid = validate(meta);
      if (!valid) {
        logger.info(
          {
            transferId: data.transfer.transferId,
            routingId: meta.routingId,
            channelAddress: data.channelAddress,
            errors: validate.errors?.map((err) => err.message).join(","),
          },
          "Not forwarding non-routing transfer",
        );
        return false;
      }

      if (data.transfer.initiator === routerSignerAddress) {
        logger.info(
          { initiator: data.transfer.initiator },
          "Not forwarding transfer which was initiated by our node, doing nothing",
        );
        return false;
      }

      if (!meta.path[0].recipient || meta.path[0].recipient === routerPublicIdentifier) {
        logger.warn(
          { path: meta.path[0], publicIdentifier: routerPublicIdentifier },
          "Not forwarding transfer with no path to follow",
        );
        return false;
      }
      return true;
    },
  );

  // Set up listener to handle transfer resolution
  nodeService.on(
    EngineEvents.CONDITIONAL_TRANSFER_RESOLVED,
    async (data: ConditionalTransferCreatedPayload) => {
      const res = await forwardTransferResolution(
        data,
        routerPublicIdentifier,
        routerSignerAddress,
        nodeService,
        store,
        logger,
      );
      if (res.isError) {
        failed.inc({ routingId: res.getError()?.context?.routingId }, 1);
        return logger.error(
          { method: "forwardTransferResolution", error: jsonifyError(res.getError()!) },
          "Error forwarding resolution",
        );
      }
      const resolved = res.getValue();
      successfulResolution.inc({ routingId: resolved?.routingId }, 1);
      logger.info(
        { event: EngineEvents.CONDITIONAL_TRANSFER_RESOLVED, result: resolved },
        "Successfully forwarded resolution",
      );

      const transferSenderResolutionChannelAddress = resolved?.channelAddress;
      const transferSenderResolutionAssetId = resolved?.assetId;
      if (!transferSenderResolutionChannelAddress || !transferSenderResolutionAssetId) {
        logger.warn(
          {
            event: EngineEvents.CONDITIONAL_TRANSFER_RESOLVED,
            transferSenderResolutionChannelAddress,
            transferSenderResolutionAssetId,
          },
          "No channel or transfer found in response, will not adjust sender collateral",
        );
        return;
      }

      // Adjust collateral in channel
      const response = await adjustCollateral(
        transferSenderResolutionChannelAddress,
        transferSenderResolutionAssetId,
        routerPublicIdentifier,
        nodeService,
        chainReader,
        logger,
      );
      if (response.isError) {
        return logger.error(
          { method: "adjustCollateral", error: jsonifyError(response.getError()!) },
          "Error adjusting collateral",
        );
      }
      logger.info({ method: "adjustCollateral", result: response.getValue() }, "Successfully adjusted collateral");
    },
    (data: ConditionalTransferCreatedPayload) => {
      // Only forward transfers with valid routing metas
      const validate = ajv.compile(RouterSchemas.RouterMeta);
      const valid = validate(data.transfer.meta);
      if (!valid) {
        logger.info(
          {
            transferId: data.transfer.transferId,
            channelAddress: data.channelAddress,
            errors: validate.errors?.map((err) => err.message),
          },
          "Not forwarding non-routing transfer",
        );
        return false;
      }

      // If there is no resolver, do nothing
      if (!data.transfer.transferResolver) {
        logger.warn(
          {
            transferId: data.transfer,
            routingId: data.transfer.meta.routingId,
            channelAddress: data.transfer.channelAddress,
          },
          "No resolver found in transfer",
        );
        return false;
      }

      // If we are the receiver of this transfer, do nothing
      if (data.transfer.responder === routerSignerAddress) {
        logger.info({ routingId: data.transfer.meta.routingId }, "Nothing to reclaim");
        return false;
      }
      activeTransfers.set({ channelAddress: data.channelAddress }, data.activeTransferIds?.length ?? 0);

      return true;
    },
  );

  nodeService.on(EngineEvents.REQUEST_COLLATERAL, async (data) => {
    const method = "requestCollateral";
    const methodId = getRandomBytes32();
    logger.info(
      { method, methodId, channelAddress: data.channelAddress, assetId: data.assetId, amount: data.amount },
      "Received request collateral event",
    );
    logger.debug({ method, methodId, event: data }, "Handling event");
    const channelRes = await nodeService.getStateChannel({
      channelAddress: data.channelAddress,
      publicIdentifier: routerPublicIdentifier,
    });
    if (channelRes.isError) {
      logger.error(
        {
          method,
          methodId,
          channelAddress: data.channelAddress,
          error: jsonifyError(channelRes.getError()!),
        },
        "Could not get channel",
      );
      return;
    }
    const channel = channelRes.getValue();
    if (!channel) {
      logger.error({ method, methodId, channelAddress: data.channelAddress }, "Channel undefined");
      return;
    }

    // Verify the requested amount here is less than the reclaimThreshold
    // NOTE: this is done to allow users to request a specific amount of
    // collateral via the server-node requestCollateral endpoint. If it
    // is done within the `requestCollateral` function, then when that fn
    // is called by `justInTimeCollateral` it will not allow for a large
    // payment
    const profileRes = getRebalanceProfile(channel.networkContext.chainId, data.assetId);
    if (profileRes.isError) {
      logger.error(
        {
          method,
          methodId,
          error: jsonifyError(profileRes.getError()!),
          assetId: data.assetId,
          channelAddress: channel.channelAddress,
        },
        "Could not get rebalance profile",
      );
      return;
    }
    const profile = profileRes.getValue();
    if (data.amount && BigNumber.from(data.amount).gt(profile.reclaimThreshold)) {
      logger.error(
        {
          method,
          methodId,
          profile,
          requestedAmount: data.amount,
          assetId: data.assetId,
          channelAddress: channel.channelAddress,
        },
        "Requested amount gt reclaimThreshold",
      );
      return;
    }

    const res = await requestCollateral(
      channel as FullChannelState,
      data.assetId,
      routerPublicIdentifier,
      nodeService,
      chainReader,
      logger,
      data.amount,
    );
    if (res.isError) {
      logger.error({ method, methodId, error: jsonifyError(res.getError()!) }, "Error requesting collateral");
      return;
    }

    logger.info(
      { method, methodId, assetId: data.assetId, channelAddress: channel.channelAddress },
      "Succesfully requested collateral",
    );
  });

  nodeService.on(EngineEvents.IS_ALIVE, async (data) => {
    const res = await handleIsAlive(
      data,
      routerPublicIdentifier,
      routerSignerAddress,
      nodeService,
      store,
      chainReader,
      logger,
    );
    if (res.isError) {
      logger.error({ method: "handleIsAlive", error: jsonifyError(res.getError()!) }, "Error handling isAlive");
      return;
    }

    logger.info({ method: "handleIsAlive", res: res.getValue() }, "Succesfully handled isAlive");
  });

  /////////////////////////////////
  ///// Messaging responses //////
  ///////////////////////////////
  await messagingService.onReceiveRouterConfigMessage(routerPublicIdentifier, async (request, from, inbox) => {
    const method = "configureSubscriptions";
    const methodId = getRandomBytes32();
    logger.debug({ method, methodId }, "Method started");
    if (request.isError) {
      logger.error(
        { error: request.getError()!.toJson(), from, method, methodId },
        "Received error, shouldn't happen!",
      );
      return;
    }
    const { chainProviders, allowedSwaps } = config;
    const supportedChains = Object.keys(chainProviders)
      .map((x) => parseInt(x))
      .filter((x) => !!x);
    await messagingService.respondToRouterConfigMessage(inbox, Result.ok({ supportedChains, allowedSwaps }));
    logger.debug({ method, methodId }, "Method complete");
  });

  logger.debug({ method, methodId }, "Method complete");
}
