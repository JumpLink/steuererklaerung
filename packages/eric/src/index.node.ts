/**
 * High-level ERiC API.
 *
 * Provides typed, safe wrappers around the ERiC C library.
 * All functions handle buffer management and error mapping automatically.
 */

export { isEricAvailable, getEricPaths, ERIC_NOT_FOUND_MESSAGE } from './paths.ts';
export type { EricPaths } from './paths.ts';

export { EricError, EricNotAvailableError } from './errors.ts';

export {
  EricFlags,
  EricErrorCodes,
  ERIC_TESTMERKER_CLEARINGSTELLE,
  ERIC_TESTMERKER_ECC,
  type EricValidationResult,
  type EricVorgangResult,
  type EricSendResult,
  type SendXmlOptions,
} from './types.ts';
export { hasTestmerker, parseTransferticket, assertSendAllowed, mapSendResult } from './send.ts';

export { runSetup, verifyInstallation, findJarFile } from './setup.ts';
export type { SetupVerification } from './setup.ts';

import {
  ericInitialisiere,
  ericBeende,
  ericBearbeiteVorgang,
  ericHoleFehlerText,
  ericPruefeSteuernummer,
  ericPruefeIBAN,
  ericCheckXML,
  ericVersion,
  ericGetHandleToCertificate,
  ericCloseHandleToCertificate,
} from './ffi.ts';
import { withBuffers } from './buffer.ts';
import { EricError } from './errors.ts';
import {
  EricErrorCodes,
  EricFlags,
  type EricSendResult,
  type EricValidationResult,
  type SendXmlOptions,
} from './types.ts';
import { assertSendAllowed, mapSendResult } from './send.ts';
import { getEricPaths } from './paths.ts';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let initialized = false;

/** Initialize the ERiC library. Must be called before any processing. */
export function initializeEric(): void {
  if (initialized) return;
  const paths = getEricPaths();
  const rc = ericInitialisiere(paths.plugins, paths.logs);
  if (rc !== EricErrorCodes.ERIC_OK) {
    throw new EricError(rc, getErrorText(rc), 'EricInitialisiere');
  }
  initialized = true;

  // Register cleanup on process exit
  const cleanup = () => {
    if (initialized) {
      ericBeende();
      initialized = false;
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
}

/** Shut down the ERiC library. Called automatically on process exit. */
export function shutdownEric(): void {
  if (!initialized) return;
  ericBeende();
  initialized = false;
}

// ---------------------------------------------------------------------------
// Error text lookup
// ---------------------------------------------------------------------------

/** Get the human-readable error message for an ERiC error code. */
export function getErrorText(errorCode: number): string {
  if (errorCode === EricErrorCodes.ERIC_OK) return 'OK';
  return withBuffers(1, ([buf]) => {
    const rc = ericHoleFehlerText(errorCode, buf.raw);
    if (rc !== EricErrorCodes.ERIC_OK) return `Unknown error (code ${errorCode})`;
    return buf.content || `Error code ${errorCode}`;
  });
}

// ---------------------------------------------------------------------------
// Version info
// ---------------------------------------------------------------------------

/** Get ERiC version information as XML string. */
export function getVersion(): string {
  return withBuffers(1, ([buf]) => {
    const rc = ericVersion(buf.raw);
    if (rc !== EricErrorCodes.ERIC_OK) {
      throw new EricError(rc, getErrorText(rc), 'EricVersion');
    }
    return buf.content;
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate tax data XML using ERiC's plausibility checks.
 * Initializes ERiC automatically if needed.
 */
export function validateXml(xml: string, datenartVersion: string): EricValidationResult {
  initializeEric();

  return withBuffers(2, ([rueckgabe, serverantwort]) => {
    const flags = EricFlags.VALIDIERE | EricFlags.PRUEFE_HINWEISE;
    const rc = ericBearbeiteVorgang(
      xml,
      datenartVersion,
      flags,
      null,  // no print
      null,  // no crypto
      null,  // no transfer handle
      rueckgabe.raw,
      serverantwort.raw,
    );

    const rawXml = rueckgabe.content;

    if (rc === EricErrorCodes.ERIC_OK) {
      return { valid: true, returnCode: rc, hinweise: '', fehler: '', rawXml };
    }
    if (rc === EricErrorCodes.ERIC_GLOBAL_HINWEISE) {
      return { valid: true, returnCode: rc, hinweise: rawXml, fehler: '', rawXml };
    }
    if (rc === EricErrorCodes.ERIC_GLOBAL_PRUEF_FEHLER) {
      return { valid: false, returnCode: rc, hinweise: '', fehler: rawXml, rawXml };
    }

    // IO, parse, or other errors — return as validation failure with error text
    const errorText = getErrorText(rc);
    return { valid: false, returnCode: rc, hinweise: '', fehler: rawXml || errorText, rawXml };
  });
}

/**
 * Validate XML against the schema only (no plausibility checks).
 * Lighter-weight than validateXml. Initializes ERiC automatically.
 */
export function checkXml(xml: string, datenartVersion: string): { valid: boolean; errors: string } {
  initializeEric();

  return withBuffers(1, ([buf]) => {
    const rc = ericCheckXML(xml, datenartVersion, buf.raw);
    if (rc === EricErrorCodes.ERIC_OK) {
      return { valid: true, errors: '' };
    }
    return { valid: false, errors: buf.content || getErrorText(rc) };
  });
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * Submit tax data XML to the ELSTER server (EricBearbeiteVorgang with the SENDE
 * flag), signed with the PKCS#12 keystore in `opts`. Whether the transmission
 * hits the live system or is discarded is governed by the `<Testmerker>` in the
 * XML; {@link assertSendAllowed} refuses a live send unless `opts.allowLive` is
 * set. The certificate handle is always released. Performs no retry. Initializes
 * ERiC if needed.
 */
export function sendXml(
  xml: string,
  datenartVersion: string,
  opts: SendXmlOptions,
): EricSendResult {
  assertSendAllowed(xml, opts);
  initializeEric();

  return withBuffers(2, ([rueckgabe, serverantwort]) => {
    const hToken: number[] = [0];
    const pinSupport: number[] = [0];
    const grc = ericGetHandleToCertificate(hToken, pinSupport, opts.keystorePath);
    if (grc !== EricErrorCodes.ERIC_OK) {
      throw new EricError(grc, getErrorText(grc), 'EricGetHandleToCertificate');
    }

    try {
      const flags = EricFlags.VALIDIERE | EricFlags.SENDE;
      const transferHandle: number[] = [0];
      const crypto = { version: 3, zertifikatHandle: hToken[0], pin: opts.pin };
      const rc = ericBearbeiteVorgang(
        xml,
        datenartVersion,
        flags,
        null, // no print
        crypto,
        transferHandle,
        rueckgabe.raw,
        serverantwort.raw,
      );
      return mapSendResult(rc, rueckgabe.content, serverantwort.content, xml);
    } finally {
      ericCloseHandleToCertificate(hToken[0]);
    }
  });
}

// ---------------------------------------------------------------------------
// Utility checks
// ---------------------------------------------------------------------------

/** Check if a Steuernummer is formally valid. */
export function checkSteuernummer(steuernummer: string): boolean {
  initializeEric();
  return ericPruefeSteuernummer(steuernummer) === EricErrorCodes.ERIC_OK;
}

/** Check if an IBAN is formally valid. */
export function checkIBAN(iban: string): boolean {
  initializeEric();
  return ericPruefeIBAN(iban) === EricErrorCodes.ERIC_OK;
}
