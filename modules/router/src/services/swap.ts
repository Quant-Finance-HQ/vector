import { Result } from "@connext/vector-types";
import { calculateExchangeAmount, inverse } from "@connext/vector-utils";

import { config } from "../config";
import { SwapError } from "../errors";

export const getSwappedAmount = (
  fromAmount: string,
  fromAssetId: string,
  fromChainId: number,
  toAssetId: string,
  toChainId: number,
): Result<string, SwapError> => {
  let swap = config.allowedSwaps.find(
    (s) =>
      s.fromAssetId === fromAssetId &&
      s.fromChainId === fromChainId &&
      s.toAssetId === toAssetId &&
      s.toChainId === toChainId,
  );

  let invert = false;
  if (!swap) {
    // search other way around swap
    swap = config.allowedSwaps.find(
      (s) =>
        s.toAssetId === fromAssetId &&
        s.toChainId === fromChainId &&
        s.fromAssetId === toAssetId &&
        s.fromChainId === toChainId,
    );
    invert = true;
  }

  // couldnt find both ways
  if (!swap) {
    return Result.fail(
      new SwapError(SwapError.reasons.SwapNotAllowed, fromAmount, fromAssetId, fromChainId, toAssetId, toChainId),
    );
  }

  // TODO: decimals
  if (swap.hardcodedRate) {
    if (invert) {
      return Result.ok(calculateExchangeAmount(fromAmount, inverse(swap.hardcodedRate)));
    } else {
      return Result.ok(calculateExchangeAmount(fromAmount, swap.hardcodedRate));
    }
  }
  return Result.fail(
    new SwapError(SwapError.reasons.SwapNotHardcoded, fromAmount, fromAssetId, fromChainId, toAssetId, toChainId),
  );
};
