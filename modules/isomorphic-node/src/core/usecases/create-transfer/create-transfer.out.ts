import { Result } from "../../definitions/result";
import { WalletError } from "../../shared/wallet/errors/wallet-error";

import { CreateTransferInvalidRequest } from "./errors/invalid-request";

export type CreateTransferOutput = Result<
  {
    channelId: string;
    routingId: string;
    preImage: string;
  },
  CreateTransferInvalidRequest | WalletError
>;
