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
