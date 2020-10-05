import {
  ChainProviders,
  ConditionalTransferCreatedPayload,
  ConditionalTransferResolvedPayload,
  EngineEvent,
  EngineEventMap,
  EngineEvents,
  Result,
  ServerNodeParams,
  ServerNodeResponses,
  Values,
  VectorError,
  DepositReconciledPayload,
} from "@connext/vector-types";
import Ajv from "ajv";
import Axios from "axios";
import { providers } from "ethers";
import { Evt } from "evt";
import { BaseLogger } from "pino";

const ajv = new Ajv();

export interface IServerNodeService {
  publicIdentifier: string;
  signerAddress: string;
  getStateChannelByParticipants(
    params: ServerNodeParams.GetChannelStateByParticipants,
  ): Promise<Result<ServerNodeResponses.GetChannelStateByParticipants, ServerNodeError>>;

  getStateChannel(
    params: ServerNodeParams.GetChannelState,
  ): Promise<Result<ServerNodeResponses.GetChannelState, ServerNodeError>>;

  getTransferByRoutingId(
    params: ServerNodeParams.GetTransferStateByRoutingId,
  ): Promise<Result<ServerNodeResponses.GetTransferStateByRoutingId, ServerNodeError>>;

  getTransfersByRoutingId(
    params: ServerNodeParams.GetTransferStatesByRoutingId,
  ): Promise<Result<ServerNodeResponses.GetTransferStatesByRoutingId, ServerNodeError>>;

  setup(params: ServerNodeParams.Setup): Promise<Result<ServerNodeResponses.Setup, ServerNodeError>>;

  deposit(params: ServerNodeParams.SendDepositTx): Promise<Result<ServerNodeResponses.Deposit, ServerNodeError>>;

  conditionalTransfer(
    params: ServerNodeParams.ConditionalTransfer,
  ): Promise<Result<ServerNodeResponses.ConditionalTransfer, ServerNodeError>>;

  resolveTransfer(
    params: ServerNodeParams.ResolveTransfer,
  ): Promise<Result<ServerNodeResponses.ResolveTransfer, ServerNodeError>>;

  withdraw(params: ServerNodeParams.Withdraw): Promise<Result<ServerNodeResponses.Withdraw, ServerNodeError>>;

  once<T extends EngineEvent>(
    event: T,
    callback: (payload: EngineEventMap[T]) => void | Promise<void>,
    filter?: (payload: EngineEventMap[T]) => boolean,
  ): Promise<void>;

  on<T extends EngineEvent>(
    event: T,
    callback: (payload: EngineEventMap[T]) => void | Promise<void>,
    filter?: (payload: EngineEventMap[T]) => boolean,
  ): Promise<void>;

  off<T extends EngineEvent>(event: T): Promise<void>;
}

export class ServerNodeError extends VectorError {
  readonly type = VectorError.errors.ServerNodeError;

  static readonly reasons = {
    InternalServerError: "Failed to send request",
    InvalidParams: "Request has invalid parameters",
    ProviderNotFound: "Provider not available for chain",
    Timeout: "Timeout",
    TransactionNotMined: "Failed to wait for transaction to be mined",
  } as const;

  constructor(
    public readonly message: Values<typeof ServerNodeError.reasons>,
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public readonly context?: any,
  ) {
    super(message, context);
  }
}

export type EventCallbackConfig = {
  [EngineEvents.CONDITIONAL_TRANSFER_CREATED]: { evt: Evt<ConditionalTransferCreatedPayload>; url: string };
  [EngineEvents.CONDITIONAL_TRANSFER_RESOLVED]: { evt: Evt<ConditionalTransferResolvedPayload>; url: string };
  [EngineEvents.DEPOSIT_RECONCILED]: { evt: Evt<DepositReconciledPayload>; url: string };
};

export class RestServerNodeService implements IServerNodeService {
  public publicIdentifier = "";
  public signerAddress = "";
  public chainProviders: { [chainId: string]: providers.JsonRpcProvider } = {};

  private constructor(
    private readonly serverNodeUrl: string,
    private readonly providerUrls: ChainProviders,
    private readonly logger: BaseLogger,
    private readonly index: number,
    private readonly evts?: EventCallbackConfig,
  ) {
    this.chainProviders = Object.fromEntries(
      Object.entries(providerUrls).map(([chainId, url]) => [chainId, new providers.JsonRpcProvider(url)]),
    );
  }

  static async connect(
    serverNodeUrl: string,
    providerUrls: ChainProviders,
    logger: BaseLogger,
    evts?: EventCallbackConfig,
    index = 0,
  ): Promise<RestServerNodeService> {
    const service = new RestServerNodeService(serverNodeUrl, providerUrls, logger, index, evts);
    const node = await service.createNode({ index });
    if (node.isError) {
      throw node.getError();
    }

    service.publicIdentifier = node.getValue().publicIdentifier;
    service.signerAddress = node.getValue().signerAddress;
    return service;
  }

  private assertProvider(chainId: number): providers.JsonRpcProvider {
    if (!this.chainProviders[chainId]) {
      throw new ServerNodeError(ServerNodeError.reasons.ProviderNotFound, { chainId });
    }
    return this.chainProviders[chainId];
  }

  async getConfig(): Promise<Result<ServerNodeResponses.GetConfig, ServerNodeError>> {
    return this.executeHttpRequest("config", "get", {}, ServerNodeParams.GetConfigSchema);
  }

  async createNode(
    params: ServerNodeParams.CreateNode,
  ): Promise<Result<ServerNodeResponses.CreateNode, ServerNodeError>> {
    return this.executeHttpRequest(`node`, "post", params, ServerNodeParams.CreateNodeSchema);
  }

  async getStateChannel(
    params: ServerNodeParams.GetChannelState,
  ): Promise<Result<ServerNodeResponses.GetChannelState, ServerNodeError>> {
    return this.executeHttpRequest(
      `channel/${params.channelAddress}/${params.publicIdentifier ?? this.publicIdentifier}`,
      "get",
      params,
      ServerNodeParams.GetChannelStateSchema,
    );
  }

  async getTransfersByRoutingId(
    params: ServerNodeParams.GetTransferStatesByRoutingId,
  ): Promise<Result<ServerNodeResponses.GetTransferStatesByRoutingId, ServerNodeError>> {
    return this.executeHttpRequest(
      `transfer/${params.routingId}/${params.publicIdentifier ?? this.publicIdentifier}`,
      "get",
      params,
      ServerNodeParams.GetTransferStatesByRoutingIdSchema,
    );
  }

  async getTransferByRoutingId(
    params: ServerNodeParams.GetTransferStateByRoutingId,
  ): Promise<Result<ServerNodeResponses.GetTransferStateByRoutingId, ServerNodeError>> {
    return this.executeHttpRequest(
      `channel/${params.channelAddress}/transfer/${params.routingId}/${params.publicIdentifier ??
        this.publicIdentifier}`,
      "get",
      params,
      ServerNodeParams.GetTransferStateByRoutingIdSchema,
    );
  }

  async getStateChannelByParticipants(
    params: ServerNodeParams.GetChannelStateByParticipants,
  ): Promise<Result<ServerNodeResponses.GetChannelStateByParticipants, ServerNodeError>> {
    return this.executeHttpRequest(
      `channel/${params.alice}/${params.bob}/${params.chainId}/${params.publicIdentifier ?? this.publicIdentifier}`,
      "get",
      params,
      ServerNodeParams.GetChannelStateByParticipantsSchema,
    );
  }

  async setup(params: ServerNodeParams.Setup): Promise<Result<ServerNodeResponses.Setup, ServerNodeError>> {
    return this.executeHttpRequest<ServerNodeParams.Setup, ServerNodeResponses.Setup>(
      "setup",
      "post",
      { ...params, publicIdentifier: params.publicIdentifier ?? this.publicIdentifier },
      ServerNodeParams.SetupSchema,
    );
  }

  async deposit(params: ServerNodeParams.SendDepositTx): Promise<Result<ServerNodeResponses.Deposit, ServerNodeError>> {
    let provider: providers.JsonRpcProvider;
    try {
      provider = this.assertProvider(params.chainId);
    } catch (e) {
      return Result.fail(new ServerNodeError(ServerNodeError.reasons.ProviderNotFound));
    }

    const sendDepositTxRes = await this.executeHttpRequest<
      ServerNodeParams.SendDepositTx,
      ServerNodeResponses.SendDepositTx
    >(
      "send-deposit-tx",
      "post",
      { ...params, publicIdentifier: params.publicIdentifier ?? this.publicIdentifier },
      ServerNodeParams.SendDepositTxSchema,
    );

    if (sendDepositTxRes.isError) {
      return Result.fail(sendDepositTxRes.getError());
    }

    const { txHash } = sendDepositTxRes.getValue()!;

    try {
      this.logger.info({ txHash }, "Waiting for tx to be mined");
      const receipt = await provider.waitForTransaction(txHash);
      this.logger.info({ txHash: receipt.transactionHash }, "Tx has been mined");
    } catch (e) {
      return Result.fail(new ServerNodeError(ServerNodeError.reasons.TransactionNotMined, { txHash, params }));
    }
    return this.executeHttpRequest<ServerNodeParams.Deposit, ServerNodeResponses.Deposit>(
      "deposit",
      "post",
      {
        channelAddress: params.channelAddress,
        assetId: params.assetId,
        publicIdentifier: params.publicIdentifier ?? this.publicIdentifier,
      },
      ServerNodeParams.DepositSchema,
    );
  }

  async conditionalTransfer(
    params: ServerNodeParams.ConditionalTransfer,
  ): Promise<Result<ServerNodeResponses.ConditionalTransfer, ServerNodeError>> {
    return this.executeHttpRequest<ServerNodeParams.ConditionalTransfer, ServerNodeResponses.ConditionalTransfer>(
      `hashlock-transfer/create`,
      "post",
      { ...params, publicIdentifier: params.publicIdentifier ?? this.publicIdentifier },
      ServerNodeParams.ConditionalTransferSchema,
    );
  }

  async resolveTransfer(
    params: ServerNodeParams.ResolveTransfer,
  ): Promise<Result<ServerNodeResponses.ResolveTransfer, ServerNodeError>> {
    return this.executeHttpRequest<ServerNodeParams.ResolveTransfer, ServerNodeResponses.ResolveTransfer>(
      `hashlock-transfer/resolve`,
      "post",
      { ...params, publicIdentifier: params.publicIdentifier ?? this.publicIdentifier },
      ServerNodeParams.ResolveTransferSchema,
    );
  }

  async withdraw(params: ServerNodeParams.Withdraw): Promise<Result<ServerNodeResponses.Withdraw, ServerNodeError>> {
    return this.executeHttpRequest<ServerNodeParams.Withdraw, ServerNodeResponses.Withdraw>(
      `withdraw`,
      "post",
      { ...params, publicIdentifier: params.publicIdentifier ?? this.publicIdentifier },
      ServerNodeParams.WithdrawSchema,
    );
  }

  async once<T extends EngineEvent>(
    event: T,
    callback: (payload: EngineEventMap[T]) => void | Promise<void>,
    filter: (payload: EngineEventMap[T]) => boolean = () => true,
  ): Promise<void> {
    if (!this.evts) {
      this.logger.warn("No evts provided, subscriptions will not work");
      return;
    }
    throw new Error("Method not implemented.");
  }

  async on<T extends EngineEvent>(
    event: T,
    callback: (payload: EngineEventMap[T]) => void | Promise<void>,
    filter: (payload: EngineEventMap[T]) => boolean = () => true,
  ): Promise<void> {
    if (!this.evts || !this.evts[event as string]) {
      this.logger.warn("No evts provided, subscriptions will not work");
      return;
    }
    const url = `${this.evts[event as string].url}`;
    this.evts[event as string].evt.pipe(filter!).attach(callback);
    try {
      await Axios.post<ServerNodeResponses.ConditionalTransfer>(`${this.serverNodeUrl}/event/subscribe`, {
        [event]: url,
      });
      this.logger.info({ event, url }, "Engine event subscription created");
    } catch (e) {
      this.logger.error({ error: e.response?.data, event, method: "on" }, "Error creating subscription");
    }
  }

  async off<T extends EngineEvent>(event: T): Promise<void> {
    this.evts[event as string].evt.detach();
    try {
      await Axios.post<ServerNodeResponses.ConditionalTransfer>(`${this.serverNodeUrl}/event/subscribe`, {
        [event]: "",
      });
      this.logger.info({ event }, "Engine event subscription removed");
    } catch (e) {
      this.logger.error({ error: e.response?.data, event, method: "off" }, "Error removed subscription");
    }
  }

  // Helper methods
  private async executeHttpRequest<T, U>(
    urlPath: string,
    method: "get" | "post",
    params: T,
    paramSchema: any,
  ): Promise<Result<U, ServerNodeError>> {
    const url = `${this.serverNodeUrl}/${urlPath}`;
    // Validate parameters are in line with schema
    const validate = ajv.compile(paramSchema);
    if (!validate(params)) {
      return Result.fail(
        new ServerNodeError(ServerNodeError.reasons.InvalidParams, {
          errors: validate.errors?.map(err => err.message).join(","),
        }),
      );
    }

    // Attempt request
    try {
      const res = method === "get" ? await Axios.get(url) : await Axios.post(url, params);
      return Result.ok(res.data);
    } catch (e) {
      return Result.fail(
        new ServerNodeError(ServerNodeError.reasons.InternalServerError, { error: e.message, params, url }),
      );
    }
  }
}
