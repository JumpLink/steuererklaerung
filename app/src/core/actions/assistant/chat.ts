/**
 * KI-Assistent backend: turns one year-cache into a compact context string and asks the
 * configured LLM a question about it. Context is **aggregates only** (no IBANs, no tax
 * IDs) — the figures the views already show. The LLM call is invoked from an async job
 * scheduled OUTSIDE the request handler (see routes.ts), so it never nests an outbound
 * call inside the libsoup server handler (the GJS fetch-deadlock) and works whether the
 * provider is subprocess- (Claude Agent SDK) or fetch-based.
 */

import type { YearCache } from '../../presenters/year-snapshot.ts';
import { fmtDe as fmt } from '../../lib/money.ts';
import type { Hinweis } from '../../elster/hinweise.ts';
import type { EstIntakeProposal } from '../elster/est-intake-topics.ts';

interface EuerCacheShape {
    aggregate: { totals: { incomeNet: number; expenseNet: number; profit: number; vatPayable: number } };
}
interface UsteShape {
    net_19: number;
    vat_out: number;
    vat_in: number;
    vatPayable: number;
    closingBalance: number;
}
interface GewstShape {
    result: { messbetrag: number; gewerbesteuer: number };
}
interface FestShape {
    result: {
        einkuenfteGesamt: number;
        allocations: Array<{ gesellschafter: { name: string }; gesamtAnteil: number }>;
    };
}
interface BwaShape {
    totals: { gesamtleistung: number; rohertrag: number; betriebskosten: number; betriebsergebnis: number };
}
interface DashShape {
    fristen: Array<{ label: string; dueDate: string; amount: number | null; amountLabel?: string }>;
    load: { ust: number; gewst: number; total: number };
}
interface TxShape {
    rows: unknown[];
    coverage: { unclassified: unknown[] };
}

/** Compact German context from one entity-year cache — only the aggregated figures. */
export function buildChatContext(yc: YearCache, entityName: string, year: number): string {
    const l: string[] = [`Entität: ${entityName}. Wirtschaftsjahr: ${year}.`];

    const euer = yc.euer as EuerCacheShape | undefined;
    if (euer?.aggregate?.totals) {
        const t = euer.aggregate.totals;
        l.push(
            `EÜR: Betriebseinnahmen netto ${fmt(t.incomeNet)} €, Betriebsausgaben netto ${fmt(t.expenseNet)} €, Gewinn ${fmt(t.profit)} €, USt-Zahllast ${fmt(t.vatPayable)} €.`,
        );
    }
    const uste = yc.uste as UsteShape | null;
    if (uste) {
        l.push(
            `USt-Jahreserklärung: Umsätze 19% ${fmt(uste.net_19)} €, vereinnahmte USt ${fmt(uste.vat_out)} €, Vorsteuer ${fmt(uste.vat_in)} €, Zahllast ${fmt(uste.vatPayable)} €, Abschlusszahlung ${fmt(uste.closingBalance)} €.`,
        );
    }
    const gewst = yc.gewst as GewstShape | null;
    if (gewst?.result) {
        l.push(
            `Gewerbesteuer: Messbetrag ${fmt(gewst.result.messbetrag)} €, Gewerbesteuer ${fmt(gewst.result.gewerbesteuer)} €.`,
        );
    }
    const fest = yc.feststellung as FestShape | null;
    if (fest?.result) {
        const parts = (fest.result.allocations ?? [])
            .map((a) => `${a.gesellschafter.name} ${fmt(a.gesamtAnteil)} €`)
            .join(', ');
        l.push(`Feststellung: Einkünfte ${fmt(fest.result.einkuenfteGesamt)} € (Verteilung: ${parts}).`);
    }
    const bwa = yc.bwa as BwaShape | undefined;
    if (bwa?.totals) {
        l.push(
            `BWA: Gesamtleistung ${fmt(bwa.totals.gesamtleistung)} €, Betriebskosten ${fmt(bwa.totals.betriebskosten)} €, Betriebsergebnis ${fmt(bwa.totals.betriebsergebnis)} €.`,
        );
    }
    const dash = yc.dashboard as DashShape | null;
    if (dash?.load) l.push(`Geschätzte Steuerlast (USt+GewSt): ${fmt(dash.load.total)} €.`);
    if (dash?.fristen?.length)
        l.push(
            `Abgabefristen: ${dash.fristen.map((f) => `${f.label} ${f.dueDate}${f.amount != null ? ` (${f.amountLabel ?? ''} ${fmt(f.amount)} €)` : ''}`).join('; ')}.`,
        );
    const tx = yc.transactions as TxShape | undefined;
    if (tx?.rows)
        l.push(`Buchungen: ${tx.rows.length} (davon ${tx.coverage?.unclassified?.length ?? 0} unklassifiziert).`);

    const hinweise = yc.hinweise as Hinweis[] | undefined;
    if (hinweise?.length) l.push(`Hinweise: ${hinweise.map((h) => `[${h.level}] ${h.title} — ${h.text}`).join(' | ')}`);

    return l.join('\n');
}

/** The slice of an entity the assistant needs: id (for the intake write context), display name, ESt flag. */
export interface AssistantEntity {
    id: string;
    name: string;
    /** True when the entity has a private-ESt config → the intake preview tool is offered. */
    hasEst: boolean;
}

/** The assistant's reply: the text answer plus any intake PROPOSALS it previewed (for approve-to-apply). */
export interface AssistantAnswer {
    text: string;
    /** Proposed intake edits (from `steuer_assistent_vorschlag`) the user may approve; empty otherwise. */
    proposals: EstIntakeProposal[];
}

/** One prior turn of the conversation — fed back so the assistant can follow up (multi-turn). */
export interface ChatTurn {
    role: 'user' | 'assistant';
    text: string;
}

/**
 * Answer a question about one entity-year. Uses the agentic, tool-calling assistant when the
 * Claude Agent SDK is the provider (it looks up transactions/BWA/hints itself); falls back to
 * the single-shot aggregate answer for other providers or on any agentic failure. `history` is the
 * prior conversation (empty for a fresh/stateless turn — e.g. the web job, which sends none).
 */
export async function answer(
    question: string,
    yc: YearCache,
    entity: AssistantEntity,
    year: number,
    history: ChatTurn[] = [],
): Promise<AssistantAnswer> {
    const provider = (process.env.LLM_PROVIDER ?? 'claude').trim().toLowerCase();
    if (provider === 'claude' || provider === 'claude-agent' || provider === 'anthropic') {
        try {
            const { answerAgentic } = await import('./chat-agent.ts');
            return await answerAgentic(question, yc, entity, year, history);
        } catch (err) {
            console.error(
                '[assistant] agentic path failed, using aggregate answer:',
                err instanceof Error ? err.message : err,
            );
        }
    }
    return { text: await answerQuestion(question, buildChatContext(yc, entity.name, year)), proposals: [] };
}

/** Ask the configured LLM one question about the given context. */
export async function answerQuestion(question: string, context: string): Promise<string> {
    // Lazy import so the LLM provider code (and its SDK) stays out of the startup path.
    const { getLLMProvider } = await import('../../clients/llm/index.ts');
    const provider = getLLMProvider();
    const system =
        'Du bist ein hilfreicher Finanz- und Buchhaltungsassistent für eine deutsche Entität. ' +
        'Beantworte Fragen AUSSCHLIESSLICH auf Basis der bereitgestellten Daten; wenn die Daten ' +
        'die Frage nicht hergeben, sage das ehrlich. Antworte auf Deutsch, knapp und konkret, mit ' +
        'Beträgen wo sinnvoll. Dies ist KEINE Steuerberatung.';
    const user = `Daten:\n${context}\n\nFrage: ${question}`;
    const res = await provider.complete({ system, user, maxTokens: 700 });
    return res.text.trim();
}
