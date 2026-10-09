/**
 * ERiC library path resolution and availability checks.
 *
 * Resolution order for the runtime ("home") directory:
 *   1. explicit argument
 *   2. ERIC_HOME environment variable
 *   3. <cwd>/elster/runtime  (the steuererklaerung CLI is normally run from app/)
 *
 * Deliberately NOT derived from import.meta.url: this module is bundled for GJS
 * (the bundle path is not the project path) and lives in its own package, so a
 * file-relative anchor would be wrong. The ERiC native lib is user-provided
 * (gitignored); ERIC_HOME is the reliable override for any non-default layout.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface EricPaths {
  /** Root directory of the ERiC installation (contains lib/). */
  home: string;
  /** Directory containing the shared libraries (libericapi.so, etc.). */
  lib: string;
  /** Directory containing the validation plugins. */
  plugins: string;
  /** Directory for ERiC log files. */
  logs: string;
}

/**
 * Where an INSTALLED application keeps ERiC: `$XDG_DATA_HOME/steuererklaerung/eric`.
 *
 * ERiC is never redistributed — the licence forbids it, so the user fetches it themselves. That
 * makes "where do I put it" a question the program has to answer, and `<cwd>/elster/runtime` is no
 * answer at all for an app launched from the GNOME overview, where the working directory is `/`
 * or `$HOME`. Measured on a real `.rpm` install: without this, ELSTER submission can never work
 * from a package, whatever the user downloads.
 */
export function ericDataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(process.env.HOME ?? '', '.local', 'share');
  return join(base, 'steuererklaerung', 'eric');
}

/**
 * Resolve the ERiC home directory.
 *
 * Priority: explicit parameter > `ERIC_HOME` > `<cwd>/elster/runtime` WHEN IT EXISTS > the XDG data
 * directory. The cwd entry keeps a checkout working exactly as before — it is where a developer's
 * ERiC already lives — and only yields when there is nothing there, which is every installed app.
 */
export function resolveEricHome(ericHome?: string): string {
  if (ericHome) return resolve(ericHome);
  if (process.env.ERIC_HOME) return resolve(process.env.ERIC_HOME);
  const inProject = join(process.cwd(), 'elster', 'runtime');
  if (existsSync(inProject)) return inProject;
  return ericDataDir();
}

/** Build all relevant paths from the ERiC home directory. */
export function getEricPaths(): EricPaths {
  const home = resolveEricHome();
  return {
    home,
    lib: join(home, 'lib'),
    plugins: join(home, 'lib', 'plugins'),
    logs: join(dirname(home), 'logs'),
  };
}

/**
 * Check whether the ERiC library is available at the resolved path.
 * Verifies that the main shared library and at least one plugin exist.
 */
export function isEricAvailable(): boolean {
  const paths = getEricPaths();
  return (
    existsSync(join(paths.lib, 'libericapi.so')) &&
    existsSync(join(paths.plugins, 'libcommonData.so'))
  );
}

/** User-facing message when ERiC is not installed. */
export const ERIC_NOT_FOUND_MESSAGE = `ERiC ist nicht installiert. Ohne ERiC funktioniert alles außer dem
Absenden an ELSTER — XML erzeugen, prüfen und in Mein ELSTER hochladen geht.

ERiC darf nicht mitgeliefert werden (die Lizenz verbietet die Weitergabe), also musst du es selbst
holen:

1. Von https://www.elster.de/elsterweb/entwickler/infoseite/eric herunterladen
   (Registrierung als Entwickler und Zustimmung zur Lizenz nötig)
2. Das Archiv nach ${ericDataDir()} entpacken,
   sodass dort lib/libericapi.so liegt

Oder ERIC_HOME auf ein vorhandenes ERiC zeigen lassen.`;
