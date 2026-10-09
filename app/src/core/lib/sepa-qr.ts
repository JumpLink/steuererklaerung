/**
 * SEPA GiroCode (EPC069-12) generation.
 *
 * Builds the EPC QR payload for a SEPA credit transfer and renders it as a
 * scan-to-pay QR code (terminal art + PNG data URL). This NEVER initiates a
 * payment — it only produces a code the user scans and approves in their
 * banking app.
 *
 * Spec: European Payments Council "Quick Response Code – Guidelines to Enable
 * the Data Capture for the Initiation of a SEPA Credit Transfer" (EPC069-12).
 */

// Lazy-load qrcode: importing it eagerly pulls in its PNG renderer
// (pngjs -> sync-inflate -> node:zlib streaming classes), whose module init
// throws under GJS. Deferring the import keeps the MCP server — which registers
// but seldom calls generate_sepa_qr — starting cleanly on both Node and GJS.
import type QRCodeType from 'qrcode';

let _qr: typeof QRCodeType | null = null;
async function qr(): Promise<typeof QRCodeType> {
  if (!_qr) _qr = (await import('qrcode')).default;
  return _qr;
}

export interface SepaQrInput {
  /** Beneficiary name (max 70 chars). */
  name: string;
  /** Beneficiary IBAN (spaces allowed; they are stripped). */
  iban: string;
  /** Amount in euros, e.g. 85.93. Omit/0 for an open-amount code. */
  amount?: number;
  /** ISO 4217 currency. EPC only allows EUR. Default "EUR". */
  currency?: string;
  /** Beneficiary BIC (optional within the EEA for version 002). */
  bic?: string;
  /** Unstructured remittance info / Verwendungszweck (max 140 chars). */
  remittance?: string;
  /** 4-char SEPA purpose code (optional). */
  purpose?: string;
}

const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/;

/** Strip spaces and upper-case an IBAN. */
export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

/**
 * Build the EPC069-12 payload string (the text encoded in the GiroCode).
 * Throws on invalid/missing mandatory data.
 */
export function buildEpcPayload(input: SepaQrInput): string {
  const currency = (input.currency ?? 'EUR').toUpperCase();
  if (currency !== 'EUR') {
    throw new Error('EPC GiroCode only supports EUR.');
  }

  const name = input.name?.trim();
  if (!name) throw new Error('Beneficiary name is required.');
  if (name.length > 70) throw new Error('Beneficiary name exceeds 70 characters.');

  const iban = normalizeIban(input.iban ?? '');
  if (!IBAN_RE.test(iban)) throw new Error(`Invalid IBAN: "${input.iban}".`);

  let amountLine = '';
  if (input.amount != null && input.amount > 0) {
    if (input.amount < 0.01 || input.amount > 999_999_999.99) {
      throw new Error('Amount must be between 0.01 and 999999999.99 EUR.');
    }
    amountLine = `EUR${input.amount.toFixed(2)}`;
  }

  const remittance = (input.remittance ?? '').trim().slice(0, 140);
  const bic = (input.bic ?? '').replace(/\s+/g, '').toUpperCase();
  const purpose = (input.purpose ?? '').trim().slice(0, 4);

  // 12 lines, in order. Line 10 (structured ref) left empty in favour of
  // line 11 (unstructured remittance) — only one of the two may be used.
  return [
    'BCD', // 1 service tag
    '002', // 2 version
    '1', // 3 character set (1 = UTF-8)
    'SCT', // 4 identification
    bic, // 5 BIC (optional)
    name, // 6 beneficiary name
    iban, // 7 beneficiary IBAN
    amountLine, // 8 amount (optional)
    purpose, // 9 purpose code (optional)
    '', // 10 structured remittance (unused)
    remittance, // 11 unstructured remittance
    '', // 12 beneficiary-to-originator info (unused)
  ].join('\n');
}

/** Render the payload as a compact terminal QR code (ASCII). */
export async function renderQrTerminal(payload: string): Promise<string> {
  return (await qr()).toString(payload, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
}

/** Render the payload as a PNG data URL (base64). */
export async function renderQrDataUrl(payload: string): Promise<string> {
  return (await qr()).toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
}

export interface GeneratedSepaQr {
  /** The raw EPC069-12 payload encoded in the QR. */
  epc_payload: string;
  /** Terminal/ASCII rendering of the QR. */
  qr_terminal: string;
  /** PNG data URL (base64). */
  data_url: string;
  /** Normalized echo of the key fields, for confirmation. */
  beneficiary: { name: string; iban: string; amount: string | null; remittance: string | null };
}

/** Build the payload and render it in all forms. */
export async function generateSepaQr(input: SepaQrInput): Promise<GeneratedSepaQr> {
  const epc_payload = buildEpcPayload(input);
  const [qr_terminal, data_url] = await Promise.all([
    renderQrTerminal(epc_payload),
    renderQrDataUrl(epc_payload),
  ]);
  return {
    epc_payload,
    qr_terminal,
    data_url,
    beneficiary: {
      name: input.name.trim(),
      iban: normalizeIban(input.iban),
      amount: input.amount != null && input.amount > 0 ? `EUR${input.amount.toFixed(2)}` : null,
      remittance: input.remittance?.trim() || null,
    },
  };
}
