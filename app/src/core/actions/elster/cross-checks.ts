/**
 * Machine-evaluated cross-checks (S6): the honest readiness signals a tax return needs
 * before submission. Instead of trusting a single report, this CONSUMES the existing
 * report actions (EÜR, USt-VA year overview, USt-Jahreserklärung, Steuerkonto,
 * Feststellung) and reconciles them against each other — so a figure that only looks
 * right in isolation is caught when it disagrees with an independent derivation.
 *
 * No tax logic is (re)implemented here: every number comes from a report action. The
 * comparison itself is a pure function ({@link evaluateCrossChecks}) so it is unit-testable
 * on hand-built fixtures; {@link computeCrossChecks} is the thin I/O orchestrator that
 * gathers the reports and feeds them in, skipping gracefully (status 'info') when an input
 * is unavailable for the entity (e.g. a private entity has no USt).
 */

import type { SyncConfig } from '../../config/index.ts';
import type { ElsterConfig } from '../../config/index.ts';
import { round2, fmtDe as fmt } from '../../lib/money.ts';
import type { EuerTxAggregate } from '../../elster/euer-transactions.ts';
import type { UsteAggregate } from '../../elster/uste-aggregate.ts';
import { aggregateUstvaYear, type UstvaYearQuarter } from '../../elster/ustva-aggregate.ts';
import { vorsteuerKorrekturenDesJahres } from '../erstattungen.ts';
import { euerReportByTransactions } from './euer.ts';
import { listFilingSnapshots } from './snapshots.ts';
import { usteReport } from './uste.ts';
import { feststellungReport } from './feststellung.ts';
import { steuerkontoReport, steuerkontoScope, type SteuerkontoReport } from './steuerkonto.ts';
import { findEntity, loadManifest } from '../../config/index.ts';
import type { Manifest } from '../../config/index.ts';

/** Readiness signal of a single cross-check. */
export type CrossCheckStatus = 'ok' | 'warn' | 'error' | 'info';

/**
 * One machine-evaluated reconciliation. `status` is the headline signal; `detail` is a
 * human German explanation; the optional `expected`/`actual`/`delta` carry the compared
 * amounts (EUR) so a surface can render the numbers next to the verdict.
 */
export interface CrossCheckResult {
    /** Stable id (e.g. 'ustva-vs-uste'). */
    id: string;
    /** Short human label. */
    label: string;
    status: CrossCheckStatus;
    /** Human-readable German explanation of what was compared and why the status. */
    detail: string;
    /** The value the check expected (EUR), when it compares two amounts. */
    expected?: number;
    /** The value actually found (EUR). */
    actual?: number;
    /** actual − expected (EUR); 0 when it reconciles. */
    delta?: number;
}

/** The already-computed report figures a cross-check needs (no I/O). */
export interface CrossCheckInputs {
    year: number;
    /** Entity label/id, for messages (e.g. 'gbr', 'jumplink', 'privat'). */
    entityLabel?: string;
    /** Whether the entity is subject to USt (false ⇒ USt checks emit 'info'). */
    hasUst: boolean;
    /** Whether a Feststellung applies (GbR/Personengesellschaft with Gesellschafter). */
    hasFeststellung: boolean;
    /**
     * Whether the entity files an EÜR (a Gewerbe/Betrieb). A pure Arbeitnehmer-ESt (`privat`)
     * does NOT: its figures come from config (Lohn/Vorsorge/…), not transaction classification,
     * so unclassified private-account bookings do not distort the return. Defaults to true
     * (an EÜR entity) when omitted, preserving the strict completeness check for gbr/jumplink.
     */
    filesEuer?: boolean;
    euer?: EuerTxAggregate;
    ustvaQuarters?: UstvaYearQuarter[];
    uste?: UsteAggregate;
    steuerkonto?: SteuerkontoReport;
    /** The laufender Gewinn the Feststellung allocated (FeststellungResult.totalProfit). */
    feststellungProfit?: number;
    /**
     * The Einkünfte aus Gewerbebetrieb an ESt profile declares as a COPY of this entity's EÜR
     * profit, together with the profile it came from. Present only when some `est.jahre[]` entry
     * names this entity in `einkuenfte_gewerbe_quelle`.
     */
    estGewerbe?: {
        profil: string;
        betrag: number;
        /**
         * Whether that ESt has ALREADY been transmitted. It decides the severity: an unsent
         * return with a stale copy is a defect to fix before sending (error), a sent one is a
         * fact that needs a decision (warn) — and must NOT block a different, correct form whose
         * deadline is running.
         */
        abgegeben: boolean;
    };
    /** Why an input was skipped (report threw), surfaced in the 'info' detail. */
    skips?: { ustva?: string; uste?: string; feststellung?: string; steuerkonto?: string };
}

/** Classify a signed EUR delta: within `okEps` ⇒ ok, at/above `errorEps` ⇒ error, else warn. */
function classify(delta: number, opts: { okEps?: number; errorEps?: number } = {}): CrossCheckStatus {
    const okEps = opts.okEps ?? 1;
    const errorEps = opts.errorEps ?? Number.POSITIVE_INFINITY;
    const a = Math.abs(delta);
    if (a <= okEps) return 'ok';
    if (a >= errorEps) return 'error';
    return 'warn';
}

/** An informational (skipped/not-applicable) result. */
function info(id: string, label: string, detail: string): CrossCheckResult {
    return { id, label, status: 'info', detail };
}

const USTVA_USTE_LABEL = 'USt-VA (Σ Quartale) vs. USt-Jahreserklärung';
const STEUERKONTO_LABEL = 'Steuerkonto-Zahlungen vs. angemeldete USt';
const EUER_FEST_LABEL = 'EÜR-Gewinn vs. Feststellung (laufender Gewinn)';
const VOLLSTAENDIGKEIT_LABEL = 'Vollständigkeit der Buchungen';
const VERPROBUNG_LABEL = 'USt-Verprobung (Umsatz × Satz vs. angemeldete USt)';
const VORJAHR_LABEL = 'Vorjahresvergleich';
const EUER_EST_LABEL = 'EÜR-Gewinn vs. ESt (Einkünfte aus Gewerbebetrieb)';

const NO_UST_DETAIL = 'Entität ohne Umsatzsteuer (z. B. privat) — USt-Abgleich entfällt.';

/**
 * Check 1 — the DECLARED quarterly USt-VA Vorauszahlungssoll (Σ Anmeldungssoll from the filing
 * register, which is exactly what the annual Vorauszahlungssoll / Z119 sums) must reconcile to the
 * COMPUTED Σ quarterly Zahllast (an independent Paperless-driven derivation, {@link aggregateUstvaYear}).
 * A non-zero delta means the register and the recomputed quarters disagree, i.e. either:
 *   - a WRONG Soll (e.g. the actual payment or a Säumniszuschlag was recorded as the Zahllast instead
 *     of the declared amount — the bug this catches: 444,57 € paid vs 440,57 € declared → Δ +4,00 €), or
 *   - a MISSING or DUPLICATE quarter in the register (a quarter never recorded, or recorded twice).
 *
 * NOTE: a true ELSTER-side Doppelabgabe (the SAME period submitted to the Finanzamt twice) is NOT
 * detectable here without ELSTER-Steuerkonto access — our register is keyed by (entity, kind, period)
 * so it structurally dedupes and can only hold one row per quarter. What this check DOES catch is an
 * AMOUNT divergence between the recorded Soll and the independently recomputed quarters.
 */
export function checkUstvaVsUste(i: CrossCheckInputs): CrossCheckResult {
    const id = 'ustva-vs-uste';
    if (!i.hasUst) return info(id, USTVA_USTE_LABEL, NO_UST_DETAIL);
    if (!i.uste) return info(id, USTVA_USTE_LABEL, i.skips?.uste ?? 'USt-Jahreserklärung nicht verfügbar.');
    if (!i.ustvaQuarters) return info(id, USTVA_USTE_LABEL, i.skips?.ustva ?? 'Quartals-USt-VA nicht verfügbar.');

    // Independent Paperless-driven derivation: the recomputed Σ of the four quarterly Zahllasten.
    const sumQ = round2(i.ustvaQuarters.reduce((s, q) => s + q.zahllast, 0));
    // What the annual Z119 actually uses: the register's Σ declared USt-VA Anmeldungssoll (falls back
    // to the config `uste.prepaid_vat` when the register holds none — prepaidVatSource says which).
    const registerSoll = round2(i.uste.prepaidVat);
    // Recorded Soll − independently computed truth. Identical in magnitude to the old
    // (Jahr − Quartale) vs Abschlusszahlung framing (both reduce to prepaidVat − ΣQuartale), but now
    // stated directly as the two quantities that must agree.
    const delta = round2(registerSoll - sumQ);
    const raw = classify(delta, { okEps: 1, errorEps: 10 });

    // Is the recomputed side even a valid yardstick? The quarters are PAPERLESS-DOCUMENT-driven,
    // while the annual figures on the other side are TRANSACTION-driven. For an entity whose
    // bookings are mostly rule-classified with no document attached, the quarterly derivation
    // reconstructs only a fraction of the year's Vorsteuer, so every quarterly Zahllast comes out
    // too high and the Δ says nothing about the register. Measured on gbr 2025: the quarters saw
    // 183,60 € of the year's 1.447,47 € Vorsteuer and thus claimed a Σ Zahllast of 2.604,86 €
    // against a declared 440,57 € — a false 'error' that hard-blocked the (unrelated, provably
    // consistent) Anlage-EÜR submission. So: still report the divergence, but never as an error
    // when our own basis is demonstrably incomplete.
    const docVorsteuer = round2(i.ustvaQuarters.reduce((s, q) => s + q.aggregate.vat_in, 0));
    const txVorsteuer = round2(i.uste.vat_in);
    const fehlbetrag = round2(txVorsteuer - docVorsteuer);
    const basisUnvollstaendig = txVorsteuer > 1 && fehlbetrag > Math.max(1, txVorsteuer * 0.1);
    const status = basisUnvollstaendig && raw === 'error' ? 'warn' : raw;

    const quelle = i.uste.prepaidVatSource === 'config' ? 'Config' : 'Register';
    const detail =
        `Σ angemeldete USt-VA-Vorauszahlungssoll (${quelle}) ${fmt(registerSoll)} € vs. Σ berechnete Quartals-Zahllast ${fmt(sumQ)} € ` +
        `(Δ ${fmt(delta)} €). Ein Δ ≠ 0 bedeutet einen falschen Soll (z. B. Zahlung oder Säumniszuschlag statt der ` +
        `angemeldeten Zahllast erfasst) oder eine fehlende/doppelte Periode im Register.` +
        (basisUnvollstaendig
            ? ` ACHTUNG — die Quartalsseite ist belegbasiert (Paperless) und deckt nur ${fmt(docVorsteuer)} € ` +
              `der ${fmt(txVorsteuer)} € Jahres-Vorsteuer ab (${fmt(fehlbetrag)} € fehlen): Buchungen ohne Beleg ` +
              `fehlen dort, dadurch ist die berechnete Quartals-Zahllast systematisch zu hoch. Das Δ ist deshalb ` +
              `KEIN Nachweis für einen falschen Soll — nur als Hinweis gewertet. Zum Klären das ELSTER-Steuerkonto ` +
              `gegenlesen, nicht diese Zahl.`
            : '');
    return { id, label: USTVA_USTE_LABEL, status, detail, expected: sumQ, actual: registerSoll, delta };
}

/**
 * Check 2 — the USt payments that actually flowed to the Finanzamt over the accounts
 * (Steuerkonto, art USt) against the declared quarterly Zahllasten. Cash timing (Q4 and
 * the Abschlusszahlung settle in the following year) makes an exact match unrealistic, so
 * this flags the honest cases: declared-but-unpaid (warn), a clean match (ok), otherwise
 * an informational timing note.
 */
export function checkSteuerkontoVsUst(i: CrossCheckInputs): CrossCheckResult {
    const id = 'steuerkonto-vs-ust';
    if (!i.hasUst) return info(id, STEUERKONTO_LABEL, NO_UST_DETAIL);
    if (!i.steuerkonto)
        return info(id, STEUERKONTO_LABEL, i.skips?.steuerkonto ?? 'Steuerkonto-Übersicht nicht verfügbar.');
    if (!i.ustvaQuarters) return info(id, STEUERKONTO_LABEL, i.skips?.ustva ?? 'Quartals-USt-VA nicht verfügbar.');

    const declared = round2(i.ustvaQuarters.reduce((s, q) => s + q.zahllast, 0));
    const ustGroups = i.steuerkonto.groups.filter((g) => g.art === 'USt');
    // Net paid to the FA = outflows − refunds (positive = net paid).
    const paidNet = round2(ustGroups.reduce((s, g) => s + (g.gezahlt - g.erstattet), 0));
    const delta = round2(declared - paidNet);

    let status: CrossCheckStatus;
    let note: string;
    if (Math.abs(declared) <= 0.01) {
        status = 'info';
        note = 'Keine USt angemeldet — nichts abzugleichen.';
    } else if (declared > 0.01 && paidNet <= 0.01) {
        status = 'warn';
        note = 'USt angemeldet, aber keine Zahlung auf dem Steuerkonto gefunden — prüfen.';
    } else if (Math.abs(delta) <= 1) {
        status = 'ok';
        note = 'Angemeldete USt und Steuerkonto-Zahlungen stimmen überein.';
    } else {
        status = 'info';
        note =
            'Differenz ist meist ein Timing-Effekt (Q4/Abschluss zahlen im Folgejahr) — manuell gegen Mein ELSTER prüfen.';
    }
    const detail = `Angemeldete USt (Σ Q1–Q4) ${fmt(declared)} € · über die Konten an das FA gezahlt (netto) ${fmt(paidNet)} € (Δ ${fmt(delta)} €). ${note}`;
    return { id, label: STEUERKONTO_LABEL, status, detail, expected: declared, actual: paidNet, delta };
}

/**
 * Check 3 — the EÜR-Gewinn and the laufender Gewinn the Feststellung allocated must be
 * identical (they derive from the same aggregate); any mismatch is an error.
 */
export function checkEuerVsFeststellung(i: CrossCheckInputs): CrossCheckResult {
    const id = 'euer-vs-feststellung';
    if (!i.hasFeststellung) {
        return info(
            id,
            EUER_FEST_LABEL,
            i.skips?.feststellung ?? 'Keine GbR/Personengesellschaft — Feststellung entfällt.',
        );
    }
    if (i.euer == null || i.feststellungProfit == null) {
        return info(id, EUER_FEST_LABEL, 'EÜR oder Feststellung nicht verfügbar.');
    }
    const expected = round2(i.euer.totals.profit);
    const actual = round2(i.feststellungProfit);
    const delta = round2(actual - expected);
    const status = classify(delta, { okEps: 0.01, errorEps: 0.01 });
    const detail = `EÜR-Gewinn ${fmt(expected)} € · in der Feststellung angesetzter laufender Gewinn ${fmt(actual)} € (Δ ${fmt(delta)} €).`;
    return { id, label: EUER_FEST_LABEL, status, detail, expected, actual, delta };
}

/**
 * Check 4 — completeness: every booking in the active period must be classified.
 * A single unclassified booking falsifies profit, USt and every derived figure, so any
 * residue is an error.
 */
export function checkVollstaendigkeit(i: CrossCheckInputs): CrossCheckResult {
    const id = 'vollstaendigkeit';
    if (i.euer == null) return info(id, VOLLSTAENDIGKEIT_LABEL, 'EÜR nicht verfügbar.');
    const c = i.euer.coverage;
    const n = c.unclassified.length;
    if (n === 0) {
        const detail = `Alle ${c.transactions} Buchung(en) im aktiven Zeitraum sind klassifiziert (via Beleg ${c.classifiedByDocument} / via Regel ${c.classifiedByRule}).`;
        return { id, label: VOLLSTAENDIGKEIT_LABEL, status: 'ok', detail, expected: 0, actual: 0, delta: 0 };
    }
    // A pure Arbeitnehmer-ESt (privat) is config-driven — unclassified private-account bookings do
    // NOT distort the return, so they must not block filing. They CAN still hide deductible items,
    // so surface them as a warning (not an error) with the right hint instead of the EÜR wording.
    if (i.filesEuer === false) {
        const detail =
            `${n} unklassifizierte Privatbuchung(en) — die ESt beruht auf Konfigurationswerten (Lohn/Vorsorge/…), ` +
            `nicht auf diesen Buchungen. Nur auf abziehbare Posten durchsehen: Spenden, § 35a (haushaltsnahe ` +
            `Dienstleistungen/Handwerkerleistungen), außergewöhnliche Belastungen.`;
        return { id, label: VOLLSTAENDIGKEIT_LABEL, status: 'warn', detail, expected: 0, actual: n, delta: n };
    }
    const detail = `${n} unklassifizierte Buchung(en) — sie verfälschen Gewinn, USt und alle abgeleiteten Zahlen. Vor Abgabe klären (elster euer report --by transactions --detail).`;
    return { id, label: VOLLSTAENDIGKEIT_LABEL, status: 'error', detail, expected: 0, actual: n, delta: n };
}

/**
 * Check 5 — USt-Verprobung: the output VAT implied by the taxable revenue (19 % of the
 * 19 %-net + 7 % of the 7 %-net) against the declared vereinnahmte USt. Drift (e.g. from
 * mixed rates on a single invoice, or a mis-typed rate) is a warning.
 */
export function checkUstVerprobung(i: CrossCheckInputs): CrossCheckResult {
    const id = 'ust-verprobung';
    if (!i.hasUst) return info(id, VERPROBUNG_LABEL, NO_UST_DETAIL);
    if (!i.uste) return info(id, VERPROBUNG_LABEL, i.skips?.uste ?? 'USt-Jahreserklärung nicht verfügbar.');
    const implied = round2(i.uste.net_19 * 0.19 + i.uste.net_7 * 0.07);
    const declared = round2(i.uste.vat_out);
    const delta = round2(declared - implied);
    const status = classify(delta, { okEps: 1 }); // ok ≤1 €, else warn
    const detail =
        `Erwartete USt aus Umsätzen: 19 % von ${fmt(i.uste.net_19)} € + 7 % von ${fmt(i.uste.net_7)} € = ${fmt(implied)} € · ` +
        `vereinnahmte USt lt. Erklärung ${fmt(declared)} € (Δ ${fmt(delta)} €).`;
    return { id, label: VERPROBUNG_LABEL, status, detail, expected: implied, actual: declared, delta };
}

/**
 * Vorjahresvergleich — a full prior-year comparison needs the prior year's report inputs
 * (another Paperless aggregate + its config), so it is a follow-up. Emitted as 'info' so
 * the panel reminds the user to eyeball the prior-year figures manually for now.
 */
/**
 * Check 6 — the Einkünfte aus Gewerbebetrieb an ESt declares must equal the EÜR profit it is a
 * copy of. Two documents go to the same Finanzamt claiming the same profit; when the copy drifts,
 * they contradict each other and only the Finanzamt notices.
 *
 * It drifted for real: the 2025 ESt went out on 28.07.2026 with 811,53 €, while the Anlage EÜR for
 * the same year computes 837,56 € — a 26,03 € contradiction that survived every existing check,
 * because nothing compared the two. An `error` rather than a `warn` above a euro: unlike the USt
 * checks, there is no legitimate reason for these two numbers to differ.
 */
export function checkEuerVsEst(i: CrossCheckInputs): CrossCheckResult {
    if (i.filesEuer === false)
        return info('euer-vs-est', EUER_EST_LABEL, 'Entität ohne EÜR — Abgleich mit der ESt entfällt.');
    if (!i.euer) return info('euer-vs-est', EUER_EST_LABEL, 'EÜR-Bericht nicht verfügbar — Abgleich übersprungen.');
    if (!i.estGewerbe)
        return info(
            'euer-vs-est',
            EUER_EST_LABEL,
            'Keine ESt erklärt diesen Gewinn als ihre Einkünfte aus Gewerbebetrieb. Wenn doch, in der ' +
                `est-Konfiguration des Jahres \`einkuenfte_gewerbe_quelle: "${i.entityLabel ?? '<entität>'}"\` ` +
                'setzen — dann wird die Kopie hier geprüft statt still zu veralten.',
        );

    const expected = round2(i.euer.totals.profit);
    const actual = round2(i.estGewerbe.betrag);
    const delta = round2(actual - expected);
    // An already-transmitted ESt downgrades this to a warning. Not because the divergence matters
    // less — it is the same 26,03 € — but because an `error` BLOCKS the sign-off gate, and what it
    // would block here is the Anlage EÜR: the correct form, with a running deadline, carrying the
    // very figure that makes the ESt look wrong. Holding back the right filing does not fix the
    // sent one; it only adds a second missed deadline.
    const raw = classify(delta, { okEps: 1, errorEps: 1 });
    const status = raw === 'error' && i.estGewerbe.abgegeben ? 'warn' : raw;
    const detail =
        raw === 'ok'
            ? `ESt-Profil '${i.estGewerbe.profil}' erklärt ${fmt(actual)} € als Einkünfte aus Gewerbebetrieb — deckt sich mit dem EÜR-Gewinn ${fmt(expected)} €.`
            : `ESt-Profil '${i.estGewerbe.profil}' erklärt ${fmt(actual)} € als Einkünfte aus Gewerbebetrieb, die Anlage EÜR ergibt ${fmt(expected)} € (Δ ${fmt(delta)} €). Beide Zahlen gehen an dasselbe Finanzamt und müssen übereinstimmen.` +
              (i.estGewerbe.abgegeben
                  ? ' Diese ESt ist bereits übermittelt — die Anlage EÜR mit dem richtigen Gewinn abzugeben ist trotzdem korrekt (sie IST die Gewinnermittlung, das Finanzamt zieht den Gewinn von dort). Danach entscheiden, ob eine berichtigte ESt nachgereicht wird; §153 AO greift, wenn die Erklärung dadurch zu niedrig war.'
                  : ' Vor der Abgabe die ESt-Konfiguration nachziehen.');
    return { id: 'euer-vs-est', label: EUER_EST_LABEL, status, detail, expected, actual, delta };
}

export function checkVorjahresvergleich(i: CrossCheckInputs): CrossCheckResult {
    return info(
        'vorjahresvergleich',
        VORJAHR_LABEL,
        `Automatischer Vorjahresvergleich (${i.year - 1} ↔ ${i.year}) ist noch nicht implementiert — Vorjahreszahlen bis dahin manuell gegenprüfen (Follow-up).`,
    );
}

/** Run every cross-check over the supplied report figures (pure — no I/O). */
export function evaluateCrossChecks(inputs: CrossCheckInputs): CrossCheckResult[] {
    return [
        checkUstvaVsUste(inputs),
        checkSteuerkontoVsUst(inputs),
        checkEuerVsFeststellung(inputs),
        checkVollstaendigkeit(inputs),
        checkUstVerprobung(inputs),
        checkEuerVsEst(inputs),
        checkVorjahresvergleich(inputs),
    ];
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * Gather the report actions for the entity/year and reconcile them into
 * {@link CrossCheckResult}s. Entity/year scoping mirrors `elster euer report`: pass the
 * resolved `accountKeys` (never a blanket camt:* sum) and the entity's `elster` config.
 * USt/Feststellung checks skip gracefully (status 'info') when they do not apply (a
 * private entity, an Einzelunternehmen without Gesellschafter) or a report throws.
 *
 * Pass a pre-computed EÜR `agg` (e.g. a front-end's per-entity-year cache) to reuse the
 * single ground-truth derivation instead of triggering a second Paperless fetch — exactly
 * as `buildTaxReturnPlan` threads its aggregate into the per-form reports.
 */
export async function computeCrossChecks(
    config: SyncConfig,
    opts: { entity?: string; year: number; accountKeys?: string[]; elster?: ElsterConfig; agg?: EuerTxAggregate },
): Promise<CrossCheckResult[]> {
    const { year, accountKeys, elster, entity, agg } = opts;
    // "Privat" is a question of the entity KIND, not of the id — there can be several private
    // ESt profiles (one per assessed person). Fall back to the id when no manifest is in reach.
    let entityKind: string | undefined;
    // The manifest also carries the Steuernummern the Steuerkonto overview attributes by, so
    // load it once here and reuse it below instead of reading the file twice.
    let manifest: Manifest | undefined;
    try {
        manifest = loadManifest();
        entityKind = entity ? findEntity(manifest, entity)?.kind : undefined;
    } catch {
        /* no manifest in scope — fall back to the id check below */
    }
    const isPrivat = entityKind === 'privat' || entity === 'privat';
    const hasUst = elster != null && !isPrivat;
    const hasFeststellung = (elster?.gesellschafter.length ?? 0) > 0 && !isPrivat;
    const skips: NonNullable<CrossCheckInputs['skips']> = {};

    // Shared tx-driven EÜR — the ground truth reused by the USt-Jahr and the Feststellung
    // (passed in as `agg` so there is a single derivation, no extra Paperless fetch). When a
    // caller supplies its cached aggregate, reuse it verbatim (same entity scope + adjustments).
    let euer: EuerTxAggregate | undefined;
    try {
        euer = agg ?? (await euerReportByTransactions(config, year, { accountKeys, elster }));
    } catch {
        euer = undefined;
    }

    let uste: UsteAggregate | undefined;
    if (hasUst && elster) {
        try {
            uste = await usteReport(config, elster, year, { accountKeys, entityId: elster.entity_id, agg: euer });
        } catch (err) {
            skips.uste = errMsg(err);
        }
    }

    // Quarterly USt-VA is Paperless-document-driven (scoped by the config's tags), an
    // independent derivation from the tx-driven annual figures — that is what makes the
    // Σ-Quartale-vs-Jahr reconciliation meaningful.
    let ustvaQuarters: UstvaYearQuarter[] | undefined;
    if (hasUst && elster) {
        try {
            ustvaQuarters = await aggregateUstvaYear(elster, year, vorsteuerKorrekturenDesJahres(elster, year));
        } catch (err) {
            skips.ustva = errMsg(err);
        }
    }

    let steuerkonto: SteuerkontoReport | undefined;
    try {
        if (!manifest) throw new Error('Kein steuererklaerung.json-Manifest geladen.');
        steuerkonto = steuerkontoReport(steuerkontoScope(manifest), year, accountKeys);
    } catch (err) {
        skips.steuerkonto = errMsg(err);
    }

    let feststellungProfit: number | undefined;
    if (hasFeststellung && elster) {
        try {
            const f = await feststellungReport(config, elster, year, { accountKeys, agg: euer });
            feststellungProfit = f.result.totalProfit;
        } catch (err) {
            skips.feststellung = errMsg(err);
        }
    }

    // Which ESt profile declares THIS entity's EÜR profit as its Einkünfte aus Gewerbebetrieb?
    // The link is opt-in (`einkuenfte_gewerbe_quelle`), so an undeclared copy is reported as
    // undeclared rather than silently matched to the wrong Betrieb.
    let estGewerbe: CrossCheckInputs['estGewerbe'];
    if (manifest && entity) {
        for (const e of manifest.entities ?? []) {
            const jahr = e.est?.jahre?.find((j) => j.jahr === year);
            if (jahr?.einkuenfte_gewerbe_quelle === entity) {
                // Was that ESt already transmitted? A `submitted` snapshot is the tool's own
                // record of the send; without one we treat it as unsent, which is the stricter
                // reading and the safe direction to be wrong in.
                let abgegeben = false;
                try {
                    abgegeben = listFilingSnapshots(e.id, year, 'est').some((snap) => snap.status === 'submitted');
                } catch {
                    /* unreadable ledger — stay strict */
                }
                estGewerbe = { profil: e.id, betrag: jahr.einkuenfte_gewerbe ?? 0, abgegeben };
                break;
            }
        }
    }

    return evaluateCrossChecks({
        year,
        entityLabel: entity,
        hasUst,
        hasFeststellung,
        filesEuer: !isPrivat,
        euer,
        ustvaQuarters,
        uste,
        steuerkonto,
        feststellungProfit,
        estGewerbe,
        skips,
    });
}

/** Roll-up of a set of cross-checks: per-status counts + the headline verdict. */
export interface CrossCheckSummary {
    ok: number;
    warn: number;
    error: number;
    info: number;
    /** Worst status present (error > warn > ok > info) — the one-glance verdict. */
    status: CrossCheckStatus;
    /** True when no check errored — the machine reconciliation is clean enough to file. */
    clean: boolean;
}

/**
 * Reduce cross-check results to a single verdict (pure). Any `error` means the reconciliation
 * is NOT clean — the honest gate a surface uses instead of a static "abgabebereit". An empty
 * set (e.g. an entity the checks don't apply to) is `clean` with an `info` headline.
 */
export function summarizeCrossChecks(results: CrossCheckResult[]): CrossCheckSummary {
    const count = (s: CrossCheckStatus): number => results.filter((r) => r.status === s).length;
    const error = count('error');
    const warn = count('warn');
    const ok = count('ok');
    const info = count('info');
    const status: CrossCheckStatus = error > 0 ? 'error' : warn > 0 ? 'warn' : ok > 0 ? 'ok' : 'info';
    return { ok, warn, error, info, status, clean: error === 0 };
}

/** Status glyph for the CLI table. */
function glyph(status: CrossCheckStatus): string {
    switch (status) {
        case 'ok':
            return '✓';
        case 'warn':
            return '⚠';
        case 'error':
            return '✗';
        default:
            return 'ℹ';
    }
}

/** Print the cross-checks as a human-readable readiness panel. */
export function printCrossChecks(results: CrossCheckResult[], year: number, entityLabel?: string): void {
    const scope = entityLabel ? ` · ${entityLabel}` : '';
    console.log(`\nQuerprüfungen ${year}${scope} — maschinelle Abstimmung vor der Abgabe`);
    console.log('='.repeat(80));
    for (const r of results) {
        console.log(`\n${glyph(r.status)} ${r.label}  [${r.status}]`);
        console.log(`  ${r.detail}`);
        if (r.expected != null || r.actual != null) {
            const parts: string[] = [];
            if (r.expected != null) parts.push(`erwartet ${fmt(r.expected)} €`);
            if (r.actual != null) parts.push(`tatsächlich ${fmt(r.actual)} €`);
            if (r.delta != null) parts.push(`Δ ${fmt(r.delta)} €`);
            console.log(`  ${parts.join(' · ')}`);
        }
    }
    const { ok: oks, warn: warns, error: errors } = summarizeCrossChecks(results);
    console.log(`\n${oks} ok · ${warns} Warnung(en) · ${errors} Fehler.`);
    if (errors > 0) console.log('✗ Es bestehen Fehler — NICHT abgeben, bis sie geklärt sind.');
    else if (warns > 0) console.log('⚠ Warnungen prüfen, bevor abgegeben wird.');
    else console.log('✓ Keine Abweichungen gefunden.');
    console.log('');
}
