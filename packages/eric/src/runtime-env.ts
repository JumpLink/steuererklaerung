/**
 * What the operating system needs before ERiC's libraries can be loaded by absolute path.
 *
 * Linux needs nothing here: `libericapi.so` carries `RPATH=$ORIGIN`, and the base libraries are
 * loaded explicitly in dependency order. Windows resolves a DLL's own dependencies through its
 * search path, and macOS refuses (or asks about) a dylib that carries a download quarantine.
 */

import { execFileSync } from 'node:child_process';
import { delimiter } from 'node:path';

import type { EricPlatform } from './platform.ts';

type Env = Record<string, string | undefined>;

/**
 * Put `dir` in front of PATH and return the variable name used. Windows spells it `Path` and
 * environment names are case-insensitive there, so an existing spelling is reused — adding a
 * second, differently-cased `PATH` would leave the process with two variables of one name.
 */
export function prependToPath(env: Env, dir: string): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key];
  const entries = current ? current.split(delimiter) : [];
  if (!entries.includes(dir)) env[key] = [dir, ...entries].join(delimiter);
  return key;
}

const quarantineCleared = new Set<string>();

/**
 * Remove the download quarantine from an unpacked ERiC. A browser marks what it downloads with
 * `com.apple.quarantine`, and files unpacked from such an archive inherit it; Gatekeeper then
 * blocks `dlopen` of the unsigned dylibs. Best effort: with no mark, or no `xattr`, nothing is lost.
 */
export function clearQuarantine(
  home: string,
  run: (cmd: string, args: string[]) => void = (cmd, args) => {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 30_000 });
  },
): void {
  if (quarantineCleared.has(home)) return;
  quarantineCleared.add(home);
  try {
    run('xattr', ['-dr', 'com.apple.quarantine', home]);
  } catch {
    // Not marked, or not removable (read-only bundle): the load itself will say if it matters.
  }
}

/** Platform preparation, run once before the first library is loaded. */
export function prepareLoad(home: string, libDir: string, p: EricPlatform, env: Env = process.env): void {
  if (p.id === 'Windows-x86_64') prependToPath(env, libDir);
  if (p.id === 'Darwin-universal') clearQuarantine(home);
}
