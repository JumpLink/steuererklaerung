/**
 * Runtime-agnostic helpers for the ERiC SEND path, shared by the Node (koffi)
 * and GJS (Vala typelib) implementations so the Testmerker safety gate,
 * Transferticket parsing and result mapping live in exactly one place.
 *
 * The actual native call (obtaining a cert handle + EricBearbeiteVorgang with
 * the SENDE flag) is runtime-specific; everything else is here.
 */

import { EricErrorCodes, type EricSendResult, type SendXmlOptions } from './types.ts';
import { EricError } from './errors.ts';

/** Whether an ELSTER XML carries a `<Testmerker>` (→ discarded server-side). */
export function hasTestmerker(xml: string): boolean {
  return /<Testmerker>\s*\d+\s*<\/Testmerker>/.test(xml);
}

/**
 * Guard against an accidental LIVE transmission. An XML without a `<Testmerker>`
 * would reach the real ELSTER system, so it is refused unless the caller opts in
 * explicitly with `allowLive: true`. Throws before any native call is made.
 */
export function assertSendAllowed(xml: string, opts: SendXmlOptions): void {
  if (!opts.keystorePath) {
    throw new EricError(
      EricErrorCodes.ERIC_GLOBAL_NULL_PARAMETER,
      'A keystore path is required to send.',
      'sendXml',
    );
  }
  if (!hasTestmerker(xml) && opts.allowLive !== true) {
    throw new EricError(
      EricErrorCodes.ERIC_GLOBAL_UNGUELTIGER_PARAMETER,
      'Refusing to send: the XML has no <Testmerker> and would reach the LIVE ELSTER ' +
        'system. Pass allowLive:true to submit for real, or stamp a Testmerker to test.',
      'sendXml',
    );
  }
}

/** Extract the Transferticket from an ERiC server-answer XML (empty if absent). */
export function parseTransferticket(serverantwortXml: string): string {
  const m = serverantwortXml.match(/<TransferTicket>\s*([^<\s][^<]*?)\s*<\/TransferTicket>/i);
  return m ? m[1].trim() : '';
}

/**
 * Map a raw `(returnCode, rueckgabeXml, serverantwortXml)` triple from either
 * runtime into the shared {@link EricSendResult}. `ok` is true only when ERiC
 * accepted the transmission (OK or hints); everything else is a failure whose
 * text is surfaced via `fehler`.
 */
export function mapSendResult(
  returnCode: number,
  rueckgabeXml: string,
  serverantwortXml: string,
  sentXml: string,
): EricSendResult {
  const ok =
    returnCode === EricErrorCodes.ERIC_OK || returnCode === EricErrorCodes.ERIC_GLOBAL_HINWEISE;
  return {
    ok,
    returnCode,
    testMode: hasTestmerker(sentXml),
    transferticket: ok ? parseTransferticket(serverantwortXml) : '',
    serverantwortXml,
    rueckgabeXml,
    hinweise: returnCode === EricErrorCodes.ERIC_GLOBAL_HINWEISE ? rueckgabeXml : '',
    fehler: ok ? '' : rueckgabeXml,
  };
}
