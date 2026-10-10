/**
 * Agentic KI-Assistent: instead of stuffing one static aggregate string into a single
 * prompt, this gives the LLM a small set of READ-ONLY tools over the in-memory year-cache
 * (the same data the views show) and lets it look things up itself — list/filter
 * transactions, drill into one booking, read the monthly BWA, read the advisory hints.
 *
 * Safety + correctness:
 *  - Tools are cache reads only (no outbound fetch) → no libsoup-in-handler deadlock and
 *    no new network. They run inside the setTimeout(…,0) job scheduled in routes.ts.
 *  - The toolset is an allow-list of READ tools; the agent gets no Bash/Read/Write and no
 *    write access — `allowedTools` lists only our tools and `permissionMode` bypasses
 *    interactive prompts in this headless context.
 *  - Data scope = exactly what the UI already shows for the active entity-year (the user's
 *    own figures, sent to their own Claude subscription). No document bodies, IBANs or
 *    credentials are ever exposed.
 *  - Used only when the Claude Agent SDK is the provider; chat.ts falls back to the simple
 *    aggregate answer otherwise or on any error here.
 */

import { z } from 'zod';
import { buildChatContext, type AssistantEntity, type AssistantAnswer, type ChatTurn } from './chat.ts';
import { DEFAULT_CLAUDE_MODEL } from '../../clients/llm/claude-agent-provider.ts';
import { isDemoMode } from '../../config/demo.ts';
import { buildProposal, describeIntakeTopics, type EstIntakeProposal } from '../elster/est-intake-topics.ts';
import { config as paperlessConfig, listDocuments, getDocument, type Document } from '@steuererklaerung/paperless';
import type { YearCache } from '../../presenters/year-snapshot.ts';

const SERVER = 'steuer_review';
const MAX_TURNS = 12;

export interface Row {
    id: string;
    bookingDate: string;
    counterparty?: string;
    purpose?: string;
    amount: number;
    kind: string;
    source: string;
    category: string;
    net: number;
    vat: number;
    gross: number;
    receipt: unknown | null;
}
interface TxCache {
    rows: Row[];
}

/** Arguments of the `list_transactions` tool — extracted so the filter logic is testable. */
export interface TxQuery {
    kind?: 'income' | 'expense' | 'neutral';
    classification?: 'document' | 'rule' | 'unclassified';
    month?: number;
    query?: string;
    withoutReceiptOnly?: boolean;
    minAbsAmount?: number;
    sort?: 'amount' | 'date';
    limit?: number;
}

/** Pure filter+sort+limit over the cached rows (the core of the `list_transactions` tool). */
export function selectTransactions(
    rows: Row[],
    a: TxQuery,
): { total: number; shown: number; rows: ReturnType<typeof compact>[] } {
    let r = rows;
    if (a.kind) r = r.filter((x) => x.kind === a.kind);
    if (a.classification) r = r.filter((x) => x.source === a.classification);
    if (a.month) r = r.filter((x) => Number(x.bookingDate.slice(5, 7)) === a.month);
    if (a.withoutReceiptOnly) r = r.filter((x) => x.kind === 'expense' && Math.abs(x.vat) > 0.005 && !x.receipt);
    if (a.minAbsAmount != null) r = r.filter((x) => Math.abs(x.net) >= (a.minAbsAmount as number));
    if (a.query) {
        const q = a.query.toLowerCase();
        r = r.filter((x) => `${x.counterparty ?? ''} ${x.purpose ?? ''} ${x.category}`.toLowerCase().includes(q));
    }
    const sorted = [...r].sort((x, y) =>
        a.sort === 'date' ? x.bookingDate.localeCompare(y.bookingDate) : Math.abs(y.net) - Math.abs(x.net),
    );
    const limit = a.limit ?? 20;
    return { total: sorted.length, shown: Math.min(limit, sorted.length), rows: sorted.slice(0, limit).map(compact) };
}
interface BwaCache {
    months: number[];
    lines: Array<{ key: string; label: string; values: (number | null)[]; total: number | null }>;
    totals: { gesamtleistung: number; rohertrag: number; betriebskosten: number; betriebsergebnis: number };
}

const text = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });

/** Privacy-safe Paperless document metadata — never the OCR body (`content`). */
const docMeta = (d: Document) => ({
    id: d.id,
    title: d.title,
    created: d.created,
    documentTypeId: d.document_type,
    correspondentId: d.correspondent,
    asn: d.archive_serial_number,
    file: d.original_file_name,
    customFields: d.custom_fields ?? [],
});
const compact = (r: Row) => ({
    id: r.id,
    date: r.bookingDate,
    counterparty: r.counterparty ?? '',
    purpose: r.purpose ?? '',
    kind: r.kind,
    category: r.category,
    net: r.net,
    vat: r.vat,
    gross: r.gross,
    hasReceipt: !!r.receipt,
});

/**
 * Answer a question agentically: the LLM calls read-only tools over `yc` to gather what it
 * needs. Throws on SDK/transport failure (chat.ts falls back to the simple answer).
 */
export async function answerAgentic(
    question: string,
    yc: YearCache,
    entity: AssistantEntity,
    year: number,
    history: ChatTurn[] = [],
): Promise<AssistantAnswer> {
    // Lazy-load the SDK (keeps it off the startup path; bundled + GJS-compatible).
    const { query, createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');

    const entityName = entity.name;
    const rows = (yc.transactions as TxCache).rows ?? [];
    // Intake proposals the model previews via `steuer_assistent_vorschlag` — surfaced to the UI for
    // the user to APPROVE (deduped by topic+kind, last preview wins). The model never applies them.
    const proposals: EstIntakeProposal[] = [];

    const cacheTools = [
        tool(
            'overview',
            'Aggregierte Jahres-Kennzahlen (EÜR, USt, GewSt, Feststellung, BWA, Fristen, Hinweise).',
            {},
            async () => text(buildChatContext(yc, entityName, year)),
        ),
        tool(
            'list_transactions',
            'Buchungen filtern. Standardsortierung nach Betrag absteigend. Liefert kompakte Zeilen + Gesamtzahl der Treffer.',
            {
                kind: z.enum(['income', 'expense', 'neutral']).optional().describe('Einnahme / Ausgabe / neutral'),
                classification: z
                    .enum(['document', 'rule', 'unclassified'])
                    .optional()
                    .describe('Klassifizierungsquelle'),
                month: z.number().int().min(1).max(12).optional().describe('Buchungsmonat (1–12)'),
                query: z.string().optional().describe('Volltext in Gegenpartei / Verwendungszweck / Kategorie'),
                withoutReceiptOnly: z.boolean().optional().describe('Nur Vorsteuer-Ausgaben ohne hinterlegten Beleg'),
                minAbsAmount: z.number().optional().describe('Mindesthöhe |Netto| in EUR'),
                sort: z.enum(['amount', 'date']).optional().describe('Sortierung (Standard: amount)'),
                limit: z.number().int().min(1).max(100).optional().describe('Max. Zeilen (Standard 20)'),
            },
            async (a) => text(selectTransactions(rows, a)),
        ),
        tool(
            'get_transaction',
            'Eine einzelne Buchung mit allen Feldern (inkl. Belegstatus) per id.',
            { id: z.string().describe('Buchungs-id aus list_transactions') },
            async (a) => {
                const row = rows.find((x) => x.id === a.id);
                return row
                    ? text({ ...row, hasReceipt: !!row.receipt })
                    : text({ error: `Keine Buchung mit id ${a.id}.` });
            },
        ),
        tool('bwa_by_month', 'Monatliche BWA: Zeilen (Umsatz, Kosten …) je Monat plus Jahres-Summen.', {}, async () => {
            const bwa = yc.bwa as BwaCache;
            return text({
                months: bwa.months,
                lines: bwa.lines.map((l) => ({ label: l.label, key: l.key, values: l.values, total: l.total })),
                totals: bwa.totals,
            });
        }),
        tool('list_hinweise', 'Die aus den Daten abgeleiteten Hinweise (Warnungen, Tipps, Infos).', {}, async () =>
            text(yc.hinweise ?? []),
        ),
    ];

    // Live Paperless read tools, in-process — independent of the MCP server switch, which only
    // governs what EXTERNAL agents see. Offered when Paperless is configured, never in the demo
    // (its DMS is the built-in one). The agentic job runs OUTSIDE the request handler, so the
    // outbound libsoup fetch is deadlock-safe. Write tools are never given to the auto-assistant.
    const hasPaperless = !isDemoMode() && !paperlessConfig().error;
    const liveTools = hasPaperless
        ? [
              tool(
                  'paperless_search',
                  'Belege/Dokumente in Paperless per Volltext suchen (live). Liefert Metadaten (Titel, Datum, Typ-/Korrespondent-ID, Felder) — KEINEN Dokumentinhalt.',
                  {
                      query: z
                          .string()
                          .optional()
                          .describe('Volltext-Suchbegriff (z. B. Lieferant oder Rechnungsnummer)'),
                      limit: z.number().int().min(1).max(25).optional().describe('Max. Treffer (Standard 10)'),
                  },
                  async (a) => {
                      const limit = a.limit ?? 10;
                      const res = await listDocuments({ query: a.query, page_size: limit, ordering: '-created' });
                      return text({ count: res.count, results: res.results.slice(0, limit).map(docMeta) });
                  },
              ),
              tool(
                  'paperless_get',
                  'Ein einzelnes Paperless-Dokument per id (Metadaten + benutzerdefinierte Felder, kein Volltext).',
                  { id: z.number().int().describe('Dokument-id aus paperless_search') },
                  async (a) => {
                      try {
                          return text(docMeta(await getDocument(a.id)));
                      } catch (e) {
                          return text({ error: e instanceof Error ? e.message : String(e) });
                      }
                  },
              ),
          ]
        : [];

    // Intake-PREVIEW tool (only for entities with an ESt config): the assistant gathers the plain-
    // language answers and shows the computed effect + Hinweise via the topic's PURE `vorschau()`.
    // It NEVER writes — consistent with "write tools are never given to the auto-assistant". The
    // actual write (`anwenden`) is a separate, user-triggered approval, not an assistant tool.
    const intakeTools = entity.hasEst
        ? [
              tool(
                  'steuer_assistent_vorschlag',
                  'VORSCHAU eines privaten Einkommensteuer-Themas: rechnet aus den Klartext-Antworten den Abzug/Effekt aus und liefert Ergebnis + Hinweise — SCHREIBT NICHTS. Zeige dem Nutzer damit den Effekt, bevor er selbst zustimmt. Die answers-Schlüssel sind die Frage-ids des Themas.',
                  {
                      topicId: z.enum(['entlastung', 'kinderbetreuung', 'haushalt', 'lohnersatz']),
                      answers: z
                          .record(z.string(), z.unknown())
                          .describe('Antworten je Frage-id des Themas (siehe Themenliste im System-Prompt)'),
                      kindIdnr: z.string().optional().describe('IdNr des Kindes (für kinderbetreuung/haushalt)'),
                  },
                  async (a) => {
                      const p = buildProposal(a.topicId, a.answers, {
                          entityId: entity.id,
                          year,
                          kindIdnr: a.kindIdnr,
                      });
                      if (!p) return text({ error: `Unbekanntes Thema ${a.topicId}` });
                      // Keep the LAST preview per topic+kind so the UI shows one actionable card each.
                      const key = `${p.topicId}:${p.kindIdnr ?? ''}`;
                      const i = proposals.findIndex((q) => `${q.topicId}:${q.kindIdnr ?? ''}` === key);
                      if (i >= 0) proposals[i] = p;
                      else proposals.push(p);
                      return text({ thema: p.titel, ergebnis: p.vorschau.ergebnis, hinweise: p.vorschau.hinweise });
                  },
              ),
          ]
        : [];
    const tools = [...cacheTools, ...liveTools, ...intakeTools];

    const server = createSdkMcpServer({ name: SERVER, version: '1.0.0', tools });
    const allowedTools = tools.map((t) => `mcp__${SERVER}__${t.name}`);
    const systemPrompt =
        `Du bist der Buchhaltungs-Assistent für die Entität "${entityName}", Wirtschaftsjahr ${year}. ` +
        'Beantworte Fragen AUSSCHLIESSLICH mit den bereitgestellten Werkzeugen (read-only Sicht auf die ' +
        'Buchhaltung dieser Entität). Rufe die nötigen Werkzeuge auf, um an Zahlen und Buchungen zu kommen — ' +
        'beginne bei offenen Fragen mit "overview". ' +
        (hasPaperless ? 'Für Rechnungen/Belege nutze paperless_search bzw. paperless_get (Live-Zugriff). ' : '') +
        (entity.hasEst
            ? 'Du kannst dem Nutzer außerdem helfen, private Steuer-Sachverhalte einzutragen: frage die nötigen ' +
              'Angaben Schritt für Schritt in Klartext ab und rufe dann steuer_assistent_vorschlag(topicId, answers) ' +
              'auf, um den berechneten Effekt + Hinweise zu ZEIGEN. Du selbst schreibst NICHTS in die Erklärung — ' +
              'der Nutzer bestätigt und überträgt selbst über den „Übernehmen"-Weg. Verfügbare Themen und ihre ' +
              `Frage-ids:\n${describeIntakeTopics()}\n`
            : '') +
        'Erfinde nichts; wenn die Daten die Frage nicht hergeben, sage das ehrlich. Antworte auf Deutsch, ' +
        'knapp und konkret, mit Beträgen in EUR wo sinnvoll. Dies ist KEINE Steuerberatung.';
    const model = process.env.LLM_MODEL?.trim() || DEFAULT_CLAUDE_MODEL;

    // Multi-turn: prepend the prior conversation as context so the assistant can follow up. The web
    // job sends no history (stateless single-turn); the native panel passes its transcript.
    const prompt = history.length
        ? `Bisheriges Gespräch (Kontext für die Rückfrage):\n${history
              .map((t) => `${t.role === 'user' ? 'Nutzer' : 'Assistent'}: ${t.text}`)
              .join('\n')}\n\nNeue Frage des Nutzers: ${question}`
        : question;

    let result: string | undefined;
    for await (const message of query({
        prompt,
        options: {
            model,
            systemPrompt,
            mcpServers: { [SERVER]: server },
            allowedTools,
            maxTurns: MAX_TURNS,
            permissionMode: 'bypassPermissions',
        },
    }) as AsyncIterable<Record<string, unknown>>) {
        if (message.type === 'result' && message.subtype === 'success' && typeof message.result === 'string')
            result = message.result;
    }
    if (result === undefined) throw new Error('Agentic assistant returned no result');
    return { text: result, proposals };
}
