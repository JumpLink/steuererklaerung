/**
 * ERiC setup: locate JAR, extract runtime files, verify installation.
 *
 * Paths are derived from getEricPaths() (ERIC_HOME / <cwd>/elster/runtime),
 * NOT from import.meta.url — this module is bundled for GJS and lives in its
 * own package.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getEricPaths, isEricAvailable } from './paths.ts';

/** The cli/elster directory (parent of the ERiC runtime home). */
function elsterDir(): string {
  return dirname(getEricPaths().home);
}

/** Regex to match ERiC Linux JAR files. */
const JAR_PATTERN = /^ERiC-[\d.]+-Linux-x86_64\.jar$/;

/** Path prefix inside the JAR for ERiC directories. */
const JAR_INNER_PREFIX = 'ERiC-';

/**
 * Find the ERiC JAR file in known locations.
 * Searches: <elster>/downloads/, <elster>/
 */
export function findJarFile(): string | null {
  const base = elsterDir();
  const searchDirs = [join(base, 'downloads'), base];

  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir);
    const jar = files.find((f) => JAR_PATTERN.test(f));
    if (jar) return join(dir, jar);
  }
  return null;
}

/**
 * Extract the ERiC JAR (which is a ZIP) to the runtime directory.
 * Uses unzip to extract, then copies platform-specific files.
 */
export function extractJar(jarPath: string): void {
  const paths = getEricPaths();
  const runtimeDir = paths.home;
  const base = elsterDir();

  mkdirSync(runtimeDir, { recursive: true });

  const tempDir = join(base, '.extract-tmp');
  mkdirSync(tempDir, { recursive: true });

  try {
    execFileSync('unzip', ['-o', '-q', jarPath, '-d', tempDir], {
      stdio: 'pipe',
      timeout: 120_000,
    });

    // Find the platform directory: ERiC-X.Y.Z.W/Linux-x86_64/
    const entries = readdirSync(tempDir);
    const ericDir = entries.find((e) => e.startsWith(JAR_INNER_PREFIX));
    if (!ericDir) {
      throw new Error(`Could not find ERiC directory in JAR. Found: ${entries.join(', ')}`);
    }

    const platformDir = join(tempDir, ericDir, 'Linux-x86_64');
    if (!existsSync(platformDir)) {
      throw new Error(`Platform directory not found: ${platformDir}`);
    }

    execFileSync('cp', ['-r', `${platformDir}/.`, `${runtimeDir}/`], {
      stdio: 'pipe',
      timeout: 60_000,
    });

    console.log(`Extracted ERiC to ${runtimeDir}`);
  } finally {
    execFileSync('rm', ['-rf', tempDir], { stdio: 'pipe' });
  }
}

/** Required files that must exist after extraction. */
const REQUIRED_FILES = [
  'lib/libericapi.so',
  'lib/libotto.so',
  'lib/libericxerces.so',
  'lib/libeSigner.so',
  'lib/plugins/libcommonData.so',
];

export interface SetupVerification {
  ok: boolean;
  runtimeDir: string;
  missing: string[];
  pluginCount: number;
}

/** Verify that all required files exist in the runtime directory. */
export function verifyInstallation(): SetupVerification {
  const paths = getEricPaths();
  const missing: string[] = [];

  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(paths.home, file))) {
      missing.push(file);
    }
  }

  let pluginCount = 0;
  if (existsSync(paths.plugins)) {
    pluginCount = readdirSync(paths.plugins).filter((f) => f.endsWith('.so')).length;
  }

  return {
    ok: missing.length === 0 && pluginCount > 0,
    runtimeDir: paths.home,
    missing,
    pluginCount,
  };
}

/**
 * Run the full setup: find JAR, extract, verify.
 */
export function runSetup(): SetupVerification {
  if (isEricAvailable()) {
    console.log('ERiC is already installed. Verifying...');
    return verifyInstallation();
  }

  const jarPath = findJarFile();
  if (!jarPath) {
    const base = elsterDir();
    console.error('No ERiC JAR file found.');
    console.error('Place the JAR (e.g. ERiC-43.4.6.0-Linux-x86_64.jar) in:');
    console.error(`  ${join(base, 'downloads')}/`);
    console.error(`  or ${base}/`);
    return {
      ok: false,
      runtimeDir: getEricPaths().home,
      missing: ['JAR file not found'],
      pluginCount: 0,
    };
  }

  console.log(`Found JAR: ${jarPath}`);
  console.log('Extracting...');
  extractJar(jarPath);

  return verifyInstallation();
}
