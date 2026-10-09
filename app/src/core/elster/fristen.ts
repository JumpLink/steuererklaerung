/**
 * Steuer-Dashboard: the filing deadlines (Fristen) for a year's annual declarations,
 * plus the estimated OWN tax load (USt-Abschlusszahlung + Gewerbesteuer). Read-only
 * guidance derived from the already-computed figures.
 *
 * The deadline is the statutory Regelfrist **without** advisor — 31 July of the
 * following year (§149 AO) — shifted by `deadlineExtensionMonths` for a granted
 * Fristverlängerung / advised case. For a business entity, Einkommensteuer is the partners'
 * PERSONAL matter (their other income, Splitting, deductions) and is NOT estimated from the
 * Feststellung — only the festgestellten Einkünfte that flow into it are surfaced. A privat
 * entity that carries its own `est` config DOES get its Einkommensteuererklärung deadline (and,
 * when the estimate could be computed, its vsl. Erstattung/Nachzahlung) via the `est` input —
 * so the Übersicht surfaces a "nächster Abgabetermin" for privat just like for gbr/jumplink.
 */

import { round2 } from '../lib/money.ts';

export type FristStatus = 'berechnet' | 'offen' | 'hinweis';

export interface SteuerFrist {
    key: string;
    label: string;
    /** Regelabgabefrist (YYYY-MM-DD). */
    dueDate: string;
    /** Headline amount for this declaration (signed), or null. */
    amount: number | null;
    amountLabel?: string;
    status: FristStatus;
    note?: string;
}

export interface SteuerDashboardInput {
    year: number;
    deadlineExtensionMonths?: number;
    uste?: { vatPayable: number; closingBalance: number; prepaidVat: number } | null;
    gewst?: { messbetrag: number; gewerbesteuer: number } | null;
    feststellung?: { einkuenfteGesamt: number; partner: Array<{ name: string; anteil: number }> } | null;
    euerGewinn?: number | null;
    /**
     * Private Einkommensteuer of an entity that files its own ESt (a `privat` entity). Its
     * presence adds the Einkommensteuererklärung Regelfrist to `fristen`; `erstattung` (+ = vsl.
     * Erstattung, − = vsl. Nachzahlung, or null when the estimate could not be computed — e.g. an
     * unsourced year) also becomes the entity's headline tax figure. Independent of the business
     * declarations — an entity may carry `est`, the business inputs, or both.
     */
    est?: { erstattung: number | null } | null;
}

export interface SteuerDashboard {
    year: number;
    fristen: SteuerFrist[];
    /** Estimated own tax load: USt-Abschlusszahlung (signed) + Gewerbesteuer. ESt excluded. */
    load: { ust: number; gewst: number; total: number };
    /** Festgestellte Einkünfte → the partners' personal ESt (informational only). */
    einkuenfte: number | null;
    partner: Array<{ name: string; anteil: number }>;
    /**
     * Private-ESt estimate for an entity that files its own ESt (+ = vsl. Erstattung, − = vsl.
     * Nachzahlung), or null (no `est` input, or the estimate could not be computed). The Übersicht
     * uses it as the personal tax KPI; for a business entity it is null and the USt+GewSt `load` is used.
     */
    estErstattung: number | null;
}

/**
 * Regelabgabefrist (ohne Berater): the last day of July of the following year (§149 AO),
 * shifted by `extensionMonths` — always snapped to the month end (so +7 → end of Feb, not
 * an overflowed 31st).
 */
export function jahresAbgabefrist(year: number, extensionMonths = 0): string {
    const month = 6 + (extensionMonths ?? 0); // July = month index 6 (0-based)
    // Day 0 of the next month = the last day of `month`.
    return new Date(Date.UTC(year + 1, month + 1, 0)).toISOString().slice(0, 10);
}

export function computeSteuerDashboard(input: SteuerDashboardInput): SteuerDashboard {
    const dueDate = jahresAbgabefrist(input.year, input.deadlineExtensionMonths ?? 0);
    const fristen: SteuerFrist[] = [];

    if (input.uste) {
        const close = round2(input.uste.closingBalance);
        fristen.push({
            key: 'ust-jahres',
            label: 'USt-Jahreserklärung',
            dueDate,
            amount: close,
            amountLabel: close >= 0 ? 'Abschlusszahlung' : 'Erstattung',
            status: 'berechnet',
            note: input.uste.prepaidVat ? undefined : 'Vorauszahlungen noch nicht erfasst',
        });
    }

    if (input.feststellung) {
        fristen.push({
            key: 'feststellung',
            label: 'Feststellung + Anlage EÜR',
            dueDate,
            amount: round2(input.feststellung.einkuenfteGesamt),
            amountLabel: 'Einkünfte',
            status: 'berechnet',
            note: 'fließt in die persönliche ESt der Gesellschafter',
        });
    } else if (input.euerGewinn != null) {
        fristen.push({
            key: 'euer',
            label: 'Anlage EÜR',
            dueDate,
            amount: round2(input.euerGewinn),
            amountLabel: 'Gewinn',
            status: 'berechnet',
        });
    }

    if (input.gewst) {
        const g = round2(input.gewst.gewerbesteuer);
        const messNull = input.gewst.messbetrag === 0;
        fristen.push({
            key: 'gewst',
            label: 'Gewerbesteuererklärung',
            dueDate,
            amount: g,
            amountLabel: 'Gewerbesteuer',
            status: messNull ? 'hinweis' : 'berechnet',
            note: messNull ? 'Messbetrag 0 € (unter Freibetrag) — Erklärung dennoch abgeben' : undefined,
        });
    }

    // Private Einkommensteuer of a `privat` entity — its own Pflichtveranlagungs-Frist,
    // independent of any business activity. Amount is the estimate (may be null for an unsourced year).
    if (input.est) {
        const erst = input.est.erstattung;
        fristen.push({
            key: 'est',
            label: 'Einkommensteuererklärung',
            dueDate,
            amount: erst,
            amountLabel: erst == null ? undefined : erst >= 0 ? 'vsl. Erstattung' : 'vsl. Nachzahlung',
            status: 'offen',
            note: 'Pflichtveranlagung · Regelfrist §149 AO (ohne Steuerberater 31.07. des Folgejahres)',
        });
    }

    const ust = round2(input.uste?.closingBalance ?? 0);
    const gewst = round2(input.gewst?.gewerbesteuer ?? 0);
    return {
        year: input.year,
        fristen,
        load: { ust, gewst, total: round2(ust + gewst) },
        einkuenfte: input.feststellung?.einkuenfteGesamt ?? input.euerGewinn ?? null,
        partner: input.feststellung?.partner ?? [],
        estErstattung: input.est ? (input.est.erstattung != null ? round2(input.est.erstattung) : null) : null,
    };
}
