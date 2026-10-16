/**
 * ERiC setup: locate the JAR for this platform, unpack the slim runtime from it, verify.
 *
 * Paths are derived from getEricPaths() (ERIC_HOME / <cwd>/elster/runtime / data dir), NOT from
 * import.meta.url — this module is bundled for GJS and lives in its own package. Unpacking is plain
 * JavaScript (see zip.ts), so it works the same on Linux, macOS and Windows with no `unzip`/`cp`.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getEricPaths, isEricAvailable } from './paths.ts';
import { BASE_LIBS, ericPlatform, libFileName, pluginBaseName, slimTarget, type EricPlatform } from './platform.ts';
import { ZipArchive } from './zip.ts';

/** The directory next to the runtime home that holds JARs and the like. */
function elsterDir(): string {
  return dirname(getEricPaths().home);
}

/** Directories searched for a JAR, in order. */
export function jarSearchDirs(): string[] {
  const base = elsterDir();
  return [join(base, 'downloads'), base];
}

/**
 * Find the ERiC JAR of the current platform in known locations: `<elster>/downloads/`, `<elster>/`.
 */
export function findJarFile(p: EricPlatform | null = ericPlatform()): string | null {
  if (!p) return null;
  for (const dir of jarSearchDirs()) {
    if (!existsSync(dir)) continue;
    const jar = readdirSync(dir).find((f) => p.jarPattern.test(f));
    if (jar) return join(dir, jar);
  }
  return null;
}

/**
 * Unpack the slim runtime of platform `p` from `jarPath` into `destHome` and return the relative
 * paths written. Only the base libraries, the plugins listed in platform.ts and the licence
 * documents are taken — the JAR is hundreds of megabytes of procedures this app never sends.
 */
export function extractJar(jarPath: string, p: EricPlatform, destHome: string): string[] {
  const zip = new ZipArchive(jarPath);
  try {
    // Entries live under `ERiC-<version>/<platform id>/…`.
    const marker = `/${p.id}/`;
    const written: string[] = [];
    for (const entry of zip.entries) {
      if (entry.name.endsWith('/')) continue;
      const at = entry.name.indexOf(marker);
      if (at < 0 || !entry.name.startsWith('ERiC-')) continue;
      const relative = slimTarget(p, entry.name.slice(at + marker.length));
      if (!relative) continue;
      const target = join(destHome, ...relative.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, zip.read(entry), { mode: 0o755 });
      written.push(relative);
    }
    if (written.length === 0) {
      throw new Error(`No ${p.id} runtime found in ${jarPath} — is this the JAR for this platform?`);
    }
    return written;
  } finally {
    zip.close();
  }
}

/** Files that must exist after extraction, relative to the ERiC home. */
export function requiredFiles(p: EricPlatform): string[] {
  return [
    ...BASE_LIBS.map((b) => `${p.libDir}/${libFileName(p, b)}`),
    `${p.libDir}/plugins/${libFileName(p, 'commonData')}`,
  ];
}

export interface SetupVerification {
  ok: boolean;
  runtimeDir: string;
  missing: string[];
  pluginCount: number;
  /** Base names of the plugins found (`checkUStVA_2025`), sorted. */
  pluginNames: string[];
}

/** Verify that all required files exist in the runtime directory. */
export function verifyInstallation(p: EricPlatform | null = ericPlatform()): SetupVerification {
  const paths = getEricPaths(p);
  if (!p) {
    return { ok: false, runtimeDir: paths.home, missing: ['unsupported platform'], pluginCount: 0, pluginNames: [] };
  }
  const missing = requiredFiles(p).filter((file) => !existsSync(join(paths.home, file)));
  const pluginNames = existsSync(paths.plugins)
    ? readdirSync(paths.plugins)
        .map((f) => pluginBaseName(p, f))
        .filter((b): b is string => b !== null)
        .sort()
    : [];
  const pluginCount = pluginNames.length;

  return {
    ok: missing.length === 0 && pluginCount > 0,
    runtimeDir: paths.home,
    missing,
    pluginCount,
    pluginNames,
  };
}

/**
 * Run the full setup: find the JAR, extract, verify.
 */
export function runSetup(): SetupVerification {
  const p = ericPlatform();
  if (!p) {
    console.error(`ERiC is not available for ${process.platform}/${process.arch}.`);
    return verifyInstallation(p);
  }
  if (isEricAvailable()) {
    console.log('ERiC is already installed. Verifying...');
    return verifyInstallation(p);
  }

  const jarPath = findJarFile(p);
  if (!jarPath) {
    console.error('No ERiC JAR file found.');
    console.error(`Place the JAR (e.g. ERiC-44.3.6.0-${p.id}.jar) in:`);
    for (const dir of jarSearchDirs()) console.error(`  ${dir}`);
    return {
      ok: false,
      runtimeDir: getEricPaths(p).home,
      missing: ['JAR file not found'],
      pluginCount: 0,
      pluginNames: [],
    };
  }

  console.log(`Found JAR: ${jarPath}`);
  console.log('Extracting...');
  const home = getEricPaths(p).home;
  const written = extractJar(jarPath, p, home);
  console.log(`Extracted ${written.length} files to ${home}`);

  return verifyInstallation(p);
}
