/**
 * Per-platform facts about an ERiC distribution: the JAR it ships in, the directory names inside
 * it, the shared-library naming, and which validation plugins this app actually uses.
 *
 * Pure data and pure functions — nothing here touches the disk, so every platform branch is
 * unit-testable from any host.
 */

export type EricPlatformId = 'Linux-x86_64' | 'Windows-x86_64' | 'Darwin-universal';

export interface EricPlatform {
  /** Directory name inside the JAR and in a bundled payload (`eric/<id>/`). */
  id: EricPlatformId;
  /** Matches the JAR file name of this platform. */
  jarPattern: RegExp;
  /** Directory holding the base libraries, relative to the ERiC home. Windows calls it `dll`. */
  libDir: 'lib' | 'dll';
  /** File name prefix of a shared library (`lib` everywhere except Windows). */
  libPrefix: string;
  /** File name suffix of a shared library. */
  libExt: '.so' | '.dll' | '.dylib';
}

const PLATFORMS: Record<EricPlatformId, EricPlatform> = {
  'Linux-x86_64': {
    id: 'Linux-x86_64',
    jarPattern: /^ERiC-[\d.]+-Linux-x86_64\.jar$/,
    libDir: 'lib',
    libPrefix: 'lib',
    libExt: '.so',
  },
  'Windows-x86_64': {
    id: 'Windows-x86_64',
    jarPattern: /^ERiC-[\d.]+-Windows-x86_64\.jar$/,
    libDir: 'dll',
    libPrefix: '',
    libExt: '.dll',
  },
  'Darwin-universal': {
    id: 'Darwin-universal',
    jarPattern: /^ERiC-[\d.]+-Darwin-universal\.jar$/,
    libDir: 'lib',
    libPrefix: 'lib',
    libExt: '.dylib',
  },
};

/**
 * The ERiC distribution for a Node `process.platform` / `process.arch`, or null where ERiC does not
 * exist (Linux on arm64, Windows on arm64, …). macOS ships one universal build for both CPUs.
 */
export function ericPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): EricPlatform | null {
  if (platform === 'linux' && arch === 'x64') return PLATFORMS['Linux-x86_64'];
  if (platform === 'win32' && arch === 'x64') return PLATFORMS['Windows-x86_64'];
  if (platform === 'darwin') return PLATFORMS['Darwin-universal'];
  return null;
}

export function platformById(id: EricPlatformId): EricPlatform {
  return PLATFORMS[id];
}

export const ERIC_PLATFORM_IDS = Object.keys(PLATFORMS) as EricPlatformId[];

/**
 * Base libraries in load order: each depends on the ones before it, so they are pre-loaded by
 * absolute path and `ericapi` comes last.
 */
export const BASE_LIBS = ['ericxerces', 'eSigner', 'otto', 'ericapi'] as const;

/** `libericapi.so` / `ericapi.dll` / `libericapi.dylib`. */
export function libFileName(p: EricPlatform, base: string): string {
  return `${p.libPrefix}${base}${p.libExt}`;
}

/**
 * Plugins this app needs, by base name (no prefix, no extension): `commonData` is loaded by the
 * API itself on every call, the rest are one per datenartVersion the app builds
 * (`UStVA_<year>`, `USt_<year>`, `EUER_<year>`, `ESt_<year>`, `GewSt_<year>`, `FEIN_90_<year>`,
 * `ElsterKontoabfrage_6`). Every other plugin (Lohn, Grundsteuer, Erbschaftsteuer, …) belongs to a
 * procedure the app never sends.
 */
const NEEDED_PLUGIN = /^(?:commonData|check(?:ElsterKontoabfrage_6|(?:UStVA|USt|EUER|ESt|GewSt|FEIN_90)_(\d{4})))$/;

/** Oldest tax year whose plugin is bundled; older years need a full ERiC via `ERIC_HOME`. */
export const MIN_PLUGIN_YEAR = 2024;

/** Whether a plugin (base name, e.g. `checkUStVA_2025`) is part of the slim runtime. */
export function isNeededPlugin(base: string): boolean {
  const m = NEEDED_PLUGIN.exec(base);
  if (!m) return false;
  return m[1] === undefined || Number(m[1]) >= MIN_PLUGIN_YEAR;
}

/**
 * The plugin base name for a file name, or null when the name is not a plugin of this platform
 * (`libcheckUStVA_2025.so` → `checkUStVA_2025`).
 */
export function pluginBaseName(p: EricPlatform, fileName: string): string | null {
  if (!fileName.startsWith(p.libPrefix) || !fileName.endsWith(p.libExt)) return null;
  const base = fileName.slice(p.libPrefix.length, fileName.length - p.libExt.length);
  return base.length > 0 ? base : null;
}

/** Whether `fileName` (one entry of the plugins directory) belongs in the slim runtime. */
export function isNeededPluginFile(p: EricPlatform, fileName: string): boolean {
  const base = pluginBaseName(p, fileName);
  return base !== null && isNeededPlugin(base);
}

/**
 * Whether a path inside the platform directory of a JAR (`ERiC-44.3.6.0/Linux-x86_64/` stripped)
 * is part of the slim runtime; returns the path to copy it to, or null. Besides the libraries and
 * plugins this keeps the licence documents, which travel with every copy (licence § 4).
 */
export function slimTarget(p: EricPlatform, relative: string): string | null {
  const parts = relative.split('/');
  if (relative === 'lizenz.pdf' || relative === 'Liesmich.txt') return relative;
  if (parts[0] !== p.libDir) return null;
  if (parts.length === 2) {
    const isBase = BASE_LIBS.some((b) => parts[1] === libFileName(p, b));
    return isBase ? relative : null;
  }
  if (parts.length === 3 && parts[1] === 'plugins' && isNeededPluginFile(p, parts[2])) return relative;
  return null;
}
