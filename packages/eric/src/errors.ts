/**
 * ERiC-specific error class.
 *
 * Note: No TypeScript parameter properties — Node 22
 * --experimental-strip-types does not support them.
 */

export class EricError extends Error {
  readonly name = 'EricError';
  readonly ericCode: number;
  readonly ericMessage: string;

  constructor(ericCode: number, ericMessage: string, context?: string) {
    const msg = context
      ? `${context}: ERiC ${ericCode} — ${ericMessage}`
      : `ERiC ${ericCode} — ${ericMessage}`;
    super(msg);
    this.ericCode = ericCode;
    this.ericMessage = ericMessage;
  }
}

export class EricNotAvailableError extends Error {
  readonly name = 'EricNotAvailableError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * The native GJS binding exists but is unusable: its typelib resolved no GType, which GJS reports as
 * "Unsupported type void". In practice a stale prebuild whose libsteuereric.so still links a
 * library that is gone. Rebuilding the binding fixes it; the message of the cause is kept.
 */
export class EricBindingError extends EricNotAvailableError {
  readonly cause: string;

  constructor(cause: string) {
    super(`The native SteuerEric binding is broken (${cause}). Rebuild it with \`gjsify run -w @steuererklaerung/eric build:meson\`.`);
    this.cause = cause;
  }
}
