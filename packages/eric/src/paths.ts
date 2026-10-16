/**
 * ERiC library path resolution and availability checks.
 *
 * Resolution order for the runtime ("home") directory:
 *   1. explicit argument
 *   2. the folder the person chose in the app (`eric_home` in the config, see setConfiguredEricHome)
 *   3. ERIC_HOME environment variable
 *   4. the copy bundled with the application (`<prefix>/lib/steuererklaerung/eric/<platform>/`)
 *   5. <cwd>/elster/runtime  (the steuererklaerung CLI is normally run from app/) when it exists
 *   6. the user's data directory (`ericDataDir()`), where `elster setup` puts a JAR it unpacked
 *
 * The cwd and data-directory entries are NOT derived from import.meta.url: this module is bundled
 * for GJS (the bundle path is not the project path) and lives in its own package, so a
 * file-relative anchor would be wrong there. Only the bundled copy is searched relative to the
 * bundle — it is shipped next to it, and nowhere else would be right.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE_LIBS, ericPlatform, libFileName, type EricPlatform } from './platform.ts';

export interface EricPaths {
  /** Root directory of the ERiC installation (contains lib/ or dll/). */
  home: string;
  /** Directory containing the shared libraries (libericapi.so, ericapi.dll, …). */
  lib: string;
  /** Directory containing the validation plugins. */
  plugins: string;
  /** Directory for ERiC log files (always writable, also when the install itself is read-only). */
  logs: string;
  /** Where `home` came from. */
  source: EricHomeSource;
}

export type EricHomeSource = 'explicit' | 'config' | 'env' | 'bundled' | 'project' | 'data';

let configuredEricHome: string | undefined;

/**
 * Register the ERiC folder the person chose (`eric_home`; blank or undefined clears it). It ranks
 * like `ERIC_HOME` above the bundled copy, but stays its own source so the UI can say "your own
 * folder" instead of "ERIC_HOME" — which it used to be, by writing the config into `process.env`.
 */
export function setConfiguredEricHome(home: string | undefined): void {
  configuredEricHome = home?.trim() || undefined;
}

/**
 * The per-user data directory of the application: `$XDG_DATA_HOME/steuererklaerung` on Linux,
 * `~/Library/Application Support/steuererklaerung` on macOS, `%LOCALAPPDATA%\steuererklaerung` on
 * Windows.
 */
export function appDataDir(platform: string = process.platform): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'steuererklaerung');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'steuererklaerung');
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'steuererklaerung');
}

/**
 * Where an INSTALLED application keeps an ERiC the user unpacked: `<appDataDir>/eric`.
 *
 * A build without a bundled ERiC needs the user to fetch it. That makes "where do I put it" a
 * question the program has to answer, and `<cwd>/elster/runtime` is no answer at all for an app
 * launched from the GNOME overview, where the working directory is `/` or `$HOME`.
 */
export function ericDataDir(platform: string = process.platform): string {
  return join(appDataDir(platform), 'eric');
}

/** Whether `home` holds the base library of `p` — the cheapest proof it is an ERiC runtime. */
function hasBaseLibrary(home: string, p: EricPlatform): boolean {
  return existsSync(join(home, p.libDir, libFileName(p, 'ericapi')));
}

/**
 * The ERiC bundled with the application, or null. The payload puts it at
 * `<prefix>/lib/steuererklaerung/eric/<platform>/`, next to the bundle, so the search climbs from
 * the bundle's directory — bounded, like `demoDir()`, so a stray `eric/` far above is never picked.
 */
export function bundledEricHome(
  p: EricPlatform | null = ericPlatform(),
  fromDir: string = dirname(fileURLToPath(import.meta.url)),
): string | null {
  if (!p) return null;
  let dir = fromDir;
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, 'eric', p.id);
    if (hasBaseLibrary(candidate, p)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The Hersteller-ID an official build carries, or undefined. The release pipeline writes it from a
 * CI secret to `<bundled ERiC>/hersteller-id`; it is never in the repository. A person's own
 * `hersteller_id` in the config wins over it (callers use this only as the fallback).
 */
export function bundledHerstellerId(
  p: EricPlatform | null = ericPlatform(),
  fromDir?: string,
): string | undefined {
  const home = bundledEricHome(p, fromDir);
  if (!home) return undefined;
  try {
    return readFileSync(join(home, 'hersteller-id'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the ERiC home directory and say where it came from.
 *
 * `ERIC_HOME` wins over everything so a person can always point the app at a full ERiC (older tax
 * years, a newer release). The cwd entry keeps a checkout working exactly as before and only yields
 * when there is nothing there, which is every installed app.
 */
export function resolveEricHomeWithSource(
  ericHome?: string,
  probe: { bundled?: string | null; cwd?: string } = {},
): { home: string; source: EricHomeSource } {
  if (ericHome) return { home: resolve(ericHome), source: 'explicit' };
  if (configuredEricHome) return { home: resolve(configuredEricHome), source: 'config' };
  if (process.env.ERIC_HOME) return { home: resolve(process.env.ERIC_HOME), source: 'env' };
  const bundled = probe.bundled === undefined ? bundledEricHome() : probe.bundled;
  if (bundled) return { home: bundled, source: 'bundled' };
  const inProject = join(probe.cwd ?? process.cwd(), 'elster', 'runtime');
  if (existsSync(inProject)) return { home: inProject, source: 'project' };
  return { home: ericDataDir(), source: 'data' };
}

export function resolveEricHome(ericHome?: string): string {
  return resolveEricHomeWithSource(ericHome).home;
}

/** Build all relevant paths from the ERiC home directory. */
export function getEricPaths(platform: EricPlatform | null = ericPlatform()): EricPaths {
  const { home, source } = resolveEricHomeWithSource();
  const libDir = platform?.libDir ?? 'lib';
  // A bundled copy sits in a root-owned prefix: its logs belong in the user's data directory.
  const logs = source === 'bundled' ? join(appDataDir(), 'logs') : join(dirname(home), 'logs');
  return {
    home,
    lib: join(home, libDir),
    plugins: join(home, libDir, 'plugins'),
    logs,
    source,
  };
}

/**
 * Whether ERiC can be loaded: this platform has an ERiC build, and the resolved home holds its
 * main library and the `commonData` plugin. Both are checked by the file names of THAT platform.
 */
export function isEricAvailable(platform: string = process.platform, arch: string = process.arch): boolean {
  const p = ericPlatform(platform, arch);
  if (!p) return false;
  const paths = getEricPaths(p);
  return (
    existsSync(join(paths.lib, libFileName(p, 'ericapi'))) &&
    existsSync(join(paths.plugins, libFileName(p, 'commonData')))
  );
}

/** Whether an ERiC build exists for this platform at all (independent of what is installed). */
export function ericPlatformKnown(platform: string = process.platform, arch: string = process.arch): boolean {
  return ericPlatform(platform, arch) !== null;
}

/** The base libraries of a platform in the order they must be loaded. */
export function baseLibraryPaths(paths: EricPaths, p: EricPlatform): string[] {
  return BASE_LIBS.map((b) => join(paths.lib, libFileName(p, b)));
}

/** User-facing message when ERiC is not installed. */
export const ERIC_NOT_FOUND_MESSAGE = `ERiC ist nicht installiert. Ohne ERiC funktioniert alles außer dem
Absenden an ELSTER — XML erzeugen, prüfen und in Mein ELSTER hochladen geht.

ERiC ist in dieser Installation nicht enthalten (es ist proprietär und liegt nicht im Quell-Repo),
also musst du es selbst holen:

1. Von https://www.elster.de/elsterweb/entwickler/infoseite/eric herunterladen
   (Registrierung als Entwickler und Zustimmung zur Lizenz nötig)
2. Die JAR-Datei für dein Betriebssystem in ${join(appDataDir(), 'downloads')} ablegen und
   "steuererklaerung elster setup" ausführen — oder das Archiv selbst nach ${ericDataDir()}
   entpacken, sodass dort lib/ (Windows: dll/) mit der ERiC-Bibliothek liegt

Oder ERIC_HOME auf ein vorhandenes ERiC zeigen lassen.`;
