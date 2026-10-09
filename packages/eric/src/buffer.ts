/**
 * RAII-like wrapper for ERiC return buffers.
 * Ensures buffers are always freed after use.
 */

import {
  ericRueckgabepufferErzeugen,
  ericRueckgabepufferFreigeben,
  ericRueckgabepufferInhalt,
  ericRueckgabepufferLaenge,
} from './ffi.ts';

export class EricBuffer {
  private handle: unknown;
  private freed = false;

  constructor() {
    this.handle = ericRueckgabepufferErzeugen();
  }

  /** Raw handle for passing to FFI functions. */
  get raw(): unknown {
    if (this.freed) throw new Error('EricBuffer already freed');
    return this.handle;
  }

  /** Read the buffer content as a UTF-8 string. */
  get content(): string {
    if (this.freed) return '';
    return ericRueckgabepufferInhalt(this.handle);
  }

  /** Get the buffer content length in bytes. */
  get length(): number {
    if (this.freed) return 0;
    return ericRueckgabepufferLaenge(this.handle);
  }

  /** Free the underlying native buffer. Safe to call multiple times. */
  free(): void {
    if (this.freed) return;
    this.freed = true;
    ericRueckgabepufferFreigeben(this.handle);
    this.handle = null;
  }
}

/**
 * Execute a function with one or more ERiC buffers, ensuring cleanup.
 *
 * @example
 * const content = withBuffers(2, ([buf1, buf2]) => {
 *   someEricFunction(buf1.raw, buf2.raw);
 *   return buf1.content;
 * });
 */
export function withBuffers<T>(count: number, fn: (buffers: EricBuffer[]) => T): T {
  const buffers = Array.from({ length: count }, () => new EricBuffer());
  try {
    return fn(buffers);
  } finally {
    for (const buf of buffers) buf.free();
  }
}
