/**
 * ERiC reads the plugin and log directories as bytes and garbles anything outside ASCII on Windows
 * ("Steuererklärung" → the plugin directory is reported missing, error 610001083). Windows can
 * name every directory in a pure-ASCII 8.3 form, so a non-ASCII path is handed over in that form.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Whether `path` is safe to pass to ERiC as it is. */
export function isAscii(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(path);
}

/** Maps a path to its 8.3 short form, or returns undefined (8.3 names off, path missing, no Win32). */
export type ShortPathFn = (path: string) => string | undefined;

/**
 * `path` as ERiC can read it: unchanged when ASCII, else the short form, else — when the volume has
 * no 8.3 names — a copy of the directory under `fallbackDir` (ASCII only). Returns the original
 * when nothing works, so the caller's error stays the real one.
 */
export function eric8bitPath(
  path: string,
  opts: { shortPath: ShortPathFn; fallbackDir: string; copyAs: string },
): string {
  if (isAscii(path)) return path;
  const short = opts.shortPath(path);
  if (short && isAscii(short)) return short;
  if (!isAscii(opts.fallbackDir) || !existsSync(path)) return path;
  const target = join(opts.fallbackDir, opts.copyAs);
  if (!existsSync(target)) {
    mkdirSync(opts.fallbackDir, { recursive: true });
    cpSync(path, target, { recursive: true });
  }
  return target;
}

/** `GetShortPathNameW` through koffi; undefined off Windows or on failure. */
export function windowsShortPath(koffi: typeof import('koffi')): ShortPathFn {
  let fn: ((src: string, dst: Uint16Array, n: number) => number) | undefined;
  return (path) => {
    if (process.platform !== 'win32') return undefined;
    try {
      fn ??= koffi
        .load('kernel32.dll')
        .func('uint32_t __stdcall GetShortPathNameW(const char16_t *src, _Out_ char16_t *dst, uint32_t n)');
      const dst = new Uint16Array(32768);
      const n = fn(path, dst, dst.length);
      if (n === 0 || n >= dst.length) return undefined;
      return Buffer.from(dst.buffer, 0, n * 2).toString('utf16le');
    } catch {
      return undefined;
    }
  };
}
