import { tidy } from "./utils";

export const BalanceEncoding = tidy(`tuple(
    uint256[2] amount,
    address[2] to
  )`);

export const WithdrawDataEncoding = tidy(`tuple(
    address channelAddress,
    address assetId,
    address recipient,
    address submitter,
    uint256 amount,
    uint256 fee,
    uint256 nonce,
    address callTo,
    bytes callData
  )`);
