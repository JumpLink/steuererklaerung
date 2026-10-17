/**
 * The intake TOPIC REGISTRY — a uniform façade over the per-topic `derive*`/`apply*` pairs in
 * {@link file://./est-intake.ts est-intake.ts}. Each topic (§24b, Kinderbetreuung, Haushalts-Zeitachse,
 * §32b Lohnersatz) exposes the SAME shape: its question flow, a pure `vorschau()` (preview headline +
 * Hinweise) and an `anwenden()` (persist via the config seam). This is the single seam both surfaces
 * that DRIVE the wizard consume — the GUI "Steuer-Assistent" renders `INTAKE_TOPICS` generically, and
 * the future AI copilot iterates the same list to know what it may propose. Add a topic here once and
 * both surfaces pick it up; the answer shapes stay typed inside each adapter (the cast is the boundary).
 */

import type { IntakeQuestion } from './est-intake.ts';
import { _, _n, fmt } from '../../lib/i18n.ts';
import {
    entlastungFragen,
    deriveEntlastungAlleinerziehende,
    applyEntlastungAlleinerziehende,
    type EntlastungAnswers,
    type EntlastungDerived,
    kinderbetreuungFragen,
    deriveKinderbetreuung,
    applyKinderbetreuung,
    type KinderbetreuungAnswers,
    type KinderbetreuungDerived,
    haushaltFragen,
    deriveHaushalt,
    applyHaushalt,
    type HaushaltAnswers,
    type HaushaltDerived,
    lohnersatzFragen,
    deriveLohnersatz,
    applyLohnersatz,
    type LohnersatzAnswers,
    type LohnersatzDerived,
} from './est-intake.ts';

/** Where the answers land: which entity's est config, which year, and (for per-child topics) which kind. */
export interface IntakeContext {
    entityId: string;
    year: number;
    /** IdNr of the child — required for `proKind` topics (Kinderbetreuung, Haushalts-Zeitachse). */
    kindIdnr?: string;
}

/** The derived, human-facing result of a topic: a one-line headline + the plain-language Hinweise. */
export interface IntakeVorschau {
    ergebnis: string;
    hinweise: string[];
}

/** One wizard topic — uniform across the four ESt intake areas. */
export interface IntakeTopic {
    id: string;
    titel: string;
    beschreibung: string;
    /** The question flow the GUI renders / the AI asks (branch via {@link frageAktiv}). */
    fragen: IntakeQuestion[];
    /** True when the topic applies per child → `ctx.kindIdnr` must be set before `anwenden`. */
    proKind: boolean;
    /** Pure preview from the answers so far (no write) — for the confirm step / live update. */
    vorschau: (answers: Record<string, unknown>, ctx: IntakeContext) => IntakeVorschau;
    /** Persist the answers via the topic's `apply*` and return the same headline+Hinweise. */
    anwenden: (answers: Record<string, unknown>, ctx: IntakeContext) => IntakeVorschau;
}

/** §24b headline: Grundbetrag 4.260 € + 240 € je weiterem Kind, anteilig monate/12 (seit VZ 2023). */
export function entlastungBetrag(monate: number, weitereKinder: number): number {
    return Math.round(((4260 + 240 * weitereKinder) * monate) / 12);
}

// Result headline per topic. `vorschau()` (pure) and `anwenden()` (after the write) format the SAME
// `*Derived` shape identically — so each derives once and both share the topic's `*Ergebnis` helper
// (the returned STRINGS are contract-tested verbatim, e.g. "2 months → 710 €", "net -538.53 €").
function entlastungErgebnis(d: EntlastungDerived): string {
    return fmt(_n('{n} month → {amount} €', '{n} months → {amount} €', d.monate), {
        n: d.monate,
        amount: entlastungBetrag(d.monate, d.weitere_kinder),
    });
}
function kinderbetreuungErgebnis(d: KinderbetreuungDerived): string {
    return d.eintrag
        ? fmt(_('your share {share} € → 80 % = {amount} € deductible'), {
              share: d.eintrag.von_mir,
              amount: Math.round(d.eintrag.von_mir * 0.8),
          })
        : _('no deduction on your side');
}
function haushaltErgebnis(d: HaushaltDerived): string {
    return fmt(
        _n('§24b: {n} month as a single parent', '§24b: {n} months as a single parent', d.alleinstehend_monate),
        { n: d.alleinstehend_monate },
    );
}
function lohnersatzErgebnis(d: LohnersatzDerived): string {
    return fmt(_('net {amount} €'), { amount: d.netto });
}

/**
 * The four ESt intake topics. A FUNCTION, not a constant: the titles, descriptions and questions are
 * translated, and a module-level array would be built at import time — before the frontend registers
 * its translator. Callers that keep a topic across calls compare by `id`, never by object identity.
 */
export function intakeTopics(): IntakeTopic[] {
    return [
        {
            id: 'entlastung',
            titel: _('Entlastungsbetrag für Alleinerziehende (§24b)'),
            beschreibung: _('Single with at least one child in the household — pro rata per full month.'),
            fragen: entlastungFragen(),
            proKind: false,
            vorschau: (a) => {
                const d = deriveEntlastungAlleinerziehende(a as unknown as EntlastungAnswers);
                return { ergebnis: entlastungErgebnis(d), hinweise: d.hinweise };
            },
            anwenden: (a, ctx) => {
                const d = applyEntlastungAlleinerziehende(ctx.entityId, ctx.year, a as unknown as EntlastungAnswers);
                return { ergebnis: entlastungErgebnis(d), hinweise: d.hinweise };
            },
        },
        {
            id: 'kinderbetreuung',
            titel: _('Kinderbetreuungskosten (§10 Nr. 5)'),
            beschreibung: _(
                'Nursery/after-school club/childminder — including the split between separated parents (double-deduction guard).',
            ),
            fragen: kinderbetreuungFragen(),
            proKind: true,
            vorschau: (a) => {
                const d = deriveKinderbetreuung(a as unknown as KinderbetreuungAnswers);
                return { ergebnis: kinderbetreuungErgebnis(d), hinweise: d.hinweise };
            },
            anwenden: (a, ctx) => {
                const d = applyKinderbetreuung(
                    ctx.entityId,
                    ctx.year,
                    ctx.kindIdnr ?? '',
                    a as unknown as KinderbetreuungAnswers,
                );
                return { ergebnis: kinderbetreuungErgebnis(d), hinweise: d.hinweise };
            },
        },
        {
            id: 'haushalt',
            titel: _('Household/separation timeline'),
            beschreibung: _(
                'When you lived apart and who the child lived with — feeds the §24b months and the Anlage Kind household block.',
            ),
            fragen: haushaltFragen(),
            proKind: true,
            vorschau: (a, ctx) => {
                const d = deriveHaushalt(a as unknown as HaushaltAnswers, ctx.year);
                return { ergebnis: haushaltErgebnis(d), hinweise: d.hinweise };
            },
            anwenden: (a, ctx) => {
                const d = applyHaushalt(ctx.entityId, ctx.year, ctx.kindIdnr ?? '', a as unknown as HaushaltAnswers);
                return { ergebnis: haushaltErgebnis(d), hinweise: d.hinweise };
            },
        },
        {
            id: 'lohnersatz',
            titel: _('Lohnersatzleistungen (§32b)'),
            beschreibung: _(
                'Elterngeld, Arbeitslosengeld, Krankengeld, Mutterschaftsgeld … including repayments (Abflussprinzip).',
            ),
            fragen: lohnersatzFragen(),
            proKind: false,
            vorschau: (a) => {
                const d = deriveLohnersatz(a as unknown as LohnersatzAnswers);
                return { ergebnis: lohnersatzErgebnis(d), hinweise: d.hinweise };
            },
            anwenden: (a, ctx) => {
                const d = applyLohnersatz(ctx.entityId, ctx.year, a as unknown as LohnersatzAnswers);
                return { ergebnis: lohnersatzErgebnis(d), hinweise: d.hinweise };
            },
        },
    ];
}

/** Find one intake topic by id (fail-soft — undefined when unknown). */
export function intakeTopic(id: string): IntakeTopic | undefined {
    return intakeTopics().find((t) => t.id === id);
}

/**
 * A proposed intake edit the KI-Assistant surfaces for the user to APPROVE — a pure preview plus the
 * answers needed to apply it later. Serializable (it may cross the web wire); the write happens only
 * via {@link applyProposal} on an explicit user click, never by the model.
 */
export interface EstIntakeProposal {
    topicId: string;
    titel: string;
    answers: Record<string, unknown>;
    kindIdnr?: string;
    vorschau: IntakeVorschau;
}

/** Build a proposal (pure preview, NO write) for a topic + answers; null when the topic is unknown. */
export function buildProposal(
    topicId: string,
    answers: Record<string, unknown>,
    ctx: IntakeContext,
): EstIntakeProposal | null {
    const topic = intakeTopic(topicId);
    if (!topic) return null;
    return { topicId, titel: topic.titel, answers, kindIdnr: ctx.kindIdnr, vorschau: topic.vorschau(answers, ctx) };
}

/**
 * Apply a previously-built proposal — the ONLY write path, invoked by an explicit user approval (the
 * „Übernehmen" click), never by the model. `entityId`/`year` come from the trusted app/server scope
 * (NOT from the proposal), `kindIdnr` from the proposal. Throws on unknown topic.
 */
export function applyProposal(proposal: EstIntakeProposal, ctx: { entityId: string; year: number }): IntakeVorschau {
    const topic = intakeTopic(proposal.topicId);
    if (!topic) throw new Error(fmt(_('Unknown tax topic “{id}”.'), { id: proposal.topicId }));
    return topic.anwenden(proposal.answers, { entityId: ctx.entityId, year: ctx.year, kindIdnr: proposal.kindIdnr });
}

/**
 * A compact, model-readable description of every topic and its questions (id · type · options ·
 * branching) — injected into the KI-Assistant's system prompt so it knows exactly which answer keys
 * `steuer_assistent_vorschlag` expects. Derived from the SAME descriptors the GUI renders, so the
 * assistant and the wizard never drift apart.
 */
export function describeIntakeTopics(): string {
    return intakeTopics()
        .map((t) => {
            const fragen = t.fragen
                .map((q) => {
                    const opt = q.optionen ? ` (Werte: ${q.optionen.map((o) => o.wert).join(' | ')})` : '';
                    const gate = q.wennId ? ` [nur wenn ${q.wennId}=${JSON.stringify(q.wennWert)}]` : '';
                    return `    · ${q.id} (${q.typ})${opt}${gate}: ${q.frage}`;
                })
                .join('\n');
            return `• ${t.id} — ${t.titel}${t.proKind ? ' [kindIdnr nötig]' : ''}\n${fragen}`;
        })
        .join('\n');
}
