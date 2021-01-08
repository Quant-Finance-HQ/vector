import { UpdateParams, FullChannelState, ChannelUpdate } from "./channel";
import { NodeParams } from "./schemas";
export class Result<T, Y = any> {
  private value?: T;
  private error?: Y;

  public isError: boolean;

  private constructor(error?: Y, value?: T) {
    if (error) {
      this.isError = true;
      this.error = error;
    } else {
      this.isError = false;
      this.value = value;
    }
  }

  public getValue(): T {
    if (this.isError) {
      throw new Error(`Can't getValue() of error result: ${this.error}`);
    }
    return this.value as T;
  }

  public getError(): Y | undefined {
    if (this.isError) {
      return this.error as Y;
    }
    return undefined;
  }

  public toJson(): ResultJson {
    if (!this.isError) {
      return { isError: false, value: this.value };
    }
    return {
      isError: true,
      // NOTE: Error.message is not returned as a property
      // on default
      error:
        this.error instanceof Error
          ? {
              ...this.error,
              message: this.error.message,
            }
          : this.error,
    };
  }

  public static fromJson<U, Y extends Error>(json: ResultJson<U, Y>): Result<U, Y> {
    return json.isError ? Result.fail(json.error) : Result.ok(json.value);
  }

  public static fail<U, Y extends Error>(error: Y): Result<U, Y> {
    return new Result<U, Y>(error);
  }

  public static ok<T>(result: T): Result<T> {
    return new Result<T>(undefined, result);
  }
}

export type ResultJson<U = any, Y = any> =
  | {
      isError: true;
      error: Y;
    }
  | {
      isError: false;
      value: U;
    };

export type Values<E> = E[keyof E];

// Abstract error for package
export type VectorErrorJson = {
  message: string;
  context: any;
  type: string;
  stack?: string;
};
export abstract class VectorError extends Error {
  abstract readonly type: string;
  static readonly reasons: { [key: string]: string };

  constructor(public readonly msg: Values<typeof VectorError.reasons>, public readonly context: any = {}) {
    super(msg);
  }

  public toJson(): VectorErrorJson {
    return {
      message: this.message,
      context: this.context,
      type: this.type,
      stack: this.stack,
    };
  }
}

export class MessagingError extends VectorError {
  readonly type = "MessagingError";

  static readonly reasons = {
    Timeout: "Request timed out",
    Unknown: "Unknown messaging error",
  } as const;

  constructor(public readonly message: Values<typeof MessagingError.reasons>, public readonly context: any = {}) {
    super(message, context);
  }
}

export type ProtocolErrorContext = {
  state?: FullChannelState;
  params?: UpdateParams<any>;
  update?: ChannelUpdate;
} & any;
export abstract class ProtocolError extends VectorError {
  readonly context: ProtocolErrorContext;

  constructor(
    public readonly msg: string,
    state?: FullChannelState,
    update?: ChannelUpdate,
    params?: UpdateParams<any>,
    context: any = {},
  ) {
    super(msg, { ...context, update, state, params });
    this.context = { ...context, update, state, params };
  }
}

export type EngineErrorContext = {
  channelAddress: string;
  publicIdentifier: string;
} & any;
export abstract class EngineError extends VectorError {
  readonly context: EngineErrorContext;

  constructor(public readonly msg: string, channelAddress: string, publicIdentifier: string, context: any = {}) {
    super(msg, { ...context, channelAddress, publicIdentifier });
    this.context = { ...context, channelAddress, publicIdentifier };
  }
}

export type NodeErrorContext = {
  publicIdentifier: string;
  params: any;
} & any;
export abstract class NodeError extends VectorError {
  readonly context: NodeErrorContext;

  constructor(
    public readonly msg: string,
    publicIdentifier: string,
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    params: any,
    context: any = {},
  ) {
    super(msg, { ...context, publicIdentifier, params });
    this.context = { ...context, publicIdentifier, params };
  }
}

export type RouterErrorContext = {
  channelAddress: string;
} & any;
export abstract class RouterError extends VectorError {
  readonly context: RouterErrorContext;

  constructor(public readonly msg: string, channelAddress: string, context: any = {}) {
    super(msg, { ...context, channelAddress });
    this.context = { ...context, channelAddress };
  }
}
