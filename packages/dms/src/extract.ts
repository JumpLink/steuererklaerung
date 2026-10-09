/**
 * AI document extraction for the built-in DMS — "KI statt OCR".
 *
 * Claude reads the receipt **directly** (Vision for images, native PDF input) and returns,
 * in ONE pass, both the structured metadata (invoice no., date, correspondent, net/gross/VAT,
 * direction) AND the full transcribed text. The text is stored as the document's `ocrText`
 * (source `ai`) — so the built-in DMS gets searchable full text with no OCR dependency.
 *
 * The Agent SDK draws on the logged-in Claude subscription (no API key). This runs inside the
 * setTimeout(…,0) job scheduled by the document routes, so its outbound call is deadlock-safe.
 */

import { z } from 'zod';
import { parseJsonWithSchema, shiftDate, DEFAULT_CLAUDE_MODEL } from '@steuererklaerung/shared';
import { searchTransactions } from '@steuererklaerung/store';
import type { DmsProvider, DmsDocument } from './types.ts';

/** Structured fields the model extracts from a receipt. */
export interface ExtractedMeta {
    invoiceNumber: string | null;
    date: string | null;
    correspondent: string | null;
    net: number | null;
    gross: number | null;
    vat: number | null;
    direction: 'incoming' | 'outgoing' | null;
}

export interface DocExtraction {
    metadata: ExtractedMeta;
    /** The full transcribed document text (becomes ocrText). */
    fullText: string;
}

const ExtractionSchema = z.object({
    metadata: z
        .object({
            invoiceNumber: z.string().nullish(),
            date: z.string().nullish(),
            correspondent: z.string().nullish(),
            net: z.number().nullish(),
            gross: z.number().nullish(),
            vat: z.number().nullish(),
            direction: z.enum(['incoming', 'outgoing']).nullish(),
        })
        .default({}),
    fullText: z.string().default(''),
});

export const EXTRACTION_SYSTEM_PROMPT =
    'Du bist ein Beleg-Extraktor für eine deutsche Buchhaltung. Dir wird EIN Beleg (Rechnung, ' +
    'Quittung, Gutschrift) als Bild oder PDF gezeigt. Lies ihn vollständig und gib AUSSCHLIESSLICH ' +
    'ein einziges JSON-Objekt zurück (keine Prosa, keine Markdown-Zäune) mit genau dieser Form:\n' +
    '{"metadata":{"invoiceNumber":string|null,"date":"YYYY-MM-DD"|null,"correspondent":string|null,' +
    '"net":number|null,"gross":number|null,"vat":number|null,"direction":"incoming"|"outgoing"|null},' +
    '"fullText":string}\n' +
    'Regeln: Beträge als Zahl in EUR (Punkt als Dezimaltrenner, kein Tausenderpunkt, kein Währungszeichen). ' +
    'date = Rechnungs-/Belegdatum. correspondent = der andere Geschäftspartner (Lieferant bei Eingangs-, ' +
    'Kunde bei Ausgangsrechnung). direction = incoming, wenn WIR Empfänger/Zahlende sind, sonst outgoing. ' +
    'fullText = der wörtlich abgetippte gesamte Belegtext (für die Volltextsuche). Unbekanntes = null.';

export const EXTRACTION_USER_PROMPT =
    'Extrahiere die Metadaten und den Volltext dieses Belegs als JSON nach dem vorgegebenen Schema.';

/** Parse the model's raw reply into a normalized extraction (pure — unit-tested). */
export function parseExtraction(raw: string | undefined): DocExtraction {
    const res = parseJsonWithSchema(raw, ExtractionSchema);
    if (!res.success) throw new Error(`KI-Antwort nicht lesbar: ${res.error}`);
    const m = res.data.metadata;
    return {
        metadata: {
            invoiceNumber: m.invoiceNumber ?? null,
            date: m.date ?? null,
            correspondent: m.correspondent ?? null,
            net: m.net ?? null,
            gross: m.gross ?? null,
            vat: m.vat ?? null,
            direction: m.direction ?? null,
        },
        fullText: res.data.fullText ?? '',
    };
}

/** Map an extraction's metadata onto the DMS document shape (for setMetadata). */
export function extractionToMeta(ex: DocExtraction): Partial<DmsDocument> {
    return {
        invoiceNumber: ex.metadata.invoiceNumber,
        created: ex.metadata.date ?? undefined,
        correspondent: ex.metadata.correspondent,
        net: ex.metadata.net,
        gross: ex.metadata.gross,
        vat: ex.metadata.vat,
        direction: ex.metadata.direction,
        ocrText: ex.fullText || null,
        ocrSource: ex.fullText ? 'ai' : null,
    };
}

/** A candidate store transaction the receipt could be booked against. */
export interface MatchCandidate {
    id: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
}

/**
 * Propose store transactions to link, by gross amount within a date window around the
 * receipt date. Pure ranking over the store — the user confirms the actual link.
 */
export function proposeTransactionLinks(
    meta: ExtractedMeta,
    opts: { maxDayGap?: number; tolerance?: number } = {},
): MatchCandidate[] {
    if (meta.gross == null || !meta.date) return [];
    const gap = opts.maxDayGap ?? 45;
    const tol = opts.tolerance ?? 0.02;
    const target = Math.abs(meta.gross);
    const from = shiftDate(meta.date, -gap);
    const to = shiftDate(meta.date, gap);
    return searchTransactions({ from, to })
        .transactions.filter((t) => Math.abs(Math.abs(t.amount) - target) <= Math.max(0.01, target * tol))
        .sort((a, b) => Math.abs(Math.abs(a.amount) - target) - Math.abs(Math.abs(b.amount) - target))
        .slice(0, 5)
        .map((t) => ({ id: t.id, bookingDate: t.bookingDate, amount: t.amount, counterparty: t.counterparty }));
}

const mediaTypeOf = (mime: string): { kind: 'image' | 'document'; media_type: string } | null => {
    if (mime === 'application/pdf') return { kind: 'document', media_type: 'application/pdf' };
    if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp' || mime === 'image/gif')
        return { kind: 'image', media_type: mime };
    return null;
};

/** Send the document bytes to Claude (Vision/PDF) and return the raw JSON reply text. */
async function runVisionExtraction(bytes: Uint8Array, mimeType: string): Promise<string> {
    const media = mediaTypeOf(mimeType);
    if (!media) throw new Error(`Dateityp ${mimeType} wird für die KI-Analyse nicht unterstützt (PDF/PNG/JPEG).`);
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const data = Buffer.from(bytes).toString('base64');
    const block =
        media.kind === 'document'
            ? { type: 'document', source: { type: 'base64', media_type: media.media_type, data } }
            : { type: 'image', source: { type: 'base64', media_type: media.media_type, data } };
    const message = {
        type: 'user' as const,
        message: { role: 'user' as const, content: [{ type: 'text', text: EXTRACTION_USER_PROMPT }, block] },
        parent_tool_use_id: null,
        session_id: '',
    };
    async function* prompt(): AsyncGenerator<typeof message> {
        yield message;
    }
    const model = process.env.LLM_MODEL?.trim() || DEFAULT_CLAUDE_MODEL;
    let text: string | undefined;
    for await (const m of query({
        // The SDK's prompt union accepts a user-message stream; cast through unknown for the
        // vision content blocks (its TS shape varies by version).
        prompt: prompt() as unknown as AsyncIterable<never>,
        options: { model, systemPrompt: EXTRACTION_SYSTEM_PROMPT, allowedTools: [], maxTurns: 1 },
    }) as AsyncIterable<Record<string, unknown>>) {
        if (m.type === 'result' && m.subtype === 'success' && typeof m.result === 'string') text = m.result;
    }
    if (text === undefined) throw new Error('KI-Analyse lieferte kein Ergebnis.');
    return text;
}

export interface AnalyzeResult {
    extraction: DocExtraction;
    candidates: MatchCandidate[];
}

/**
 * Persist an extraction onto a document. `keep` names fields something else already decided (a
 * Dokumentregel): they are held back from the model's answer, so the AI fills what is left open and
 * never overwrites what a rule set.
 */
export async function applyExtraction(
    provider: DmsProvider,
    docId: string,
    extraction: DocExtraction,
    keep: readonly (keyof DmsDocument)[] = [],
): Promise<AnalyzeResult> {
    if (!provider.setMetadata) throw new Error('Dieser DMS-Provider unterstützt keine KI-Analyse.');
    const meta = extractionToMeta(extraction);
    for (const key of keep) delete meta[key];
    await provider.setMetadata(docId, meta);
    return { extraction, candidates: proposeTransactionLinks(extraction.metadata) };
}

/**
 * Analyze one built-in document: read its file, let the AI extract metadata + full text in one
 * pass, persist them (incl. ocrText), and propose matching transactions to link.
 */
export async function analyzeDocument(
    provider: DmsProvider,
    docId: string,
    opts: { keep?: readonly (keyof DmsDocument)[] } = {},
): Promise<AnalyzeResult> {
    if (!provider.getFile || !provider.setMetadata)
        throw new Error('Dieser DMS-Provider unterstützt keine KI-Analyse.');
    const file = await provider.getFile(docId);
    if (!file) throw new Error(`Datei für Dokument ${docId} nicht gefunden.`);
    const raw = await runVisionExtraction(file.bytes, file.mimeType);
    return applyExtraction(provider, docId, parseExtraction(raw), opts.keep);
}
