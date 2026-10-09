/**
 * Steuer-Zahlungsübersicht: a best-effort reconciliation of the tax payments/refunds
 * that actually flowed through the bank accounts in a year, classified by entity
 * (Steuernummer), tax type and the period they relate to. It is NOT the authoritative
 * Finanzamt-Steuerkonto (which lives in Mein ELSTER) — it answers "what did we pay/get
 * back, and for whom" from the imported transactions, so the expected Nachzahlung /
 * Erstattung can be sanity-checked against the filed UStVA/GewSt figures.
 *
 * Why this matters: a Finanzamt booking names neither the firm nor the tax type, only a
 * Steuernummer in the reference text. When several entities settle through the same
 * accounts — a dissolved partnership, its successor Einzelunternehmen, and the partners'
 * personal ESt — every payment looks alike until it is attributed by that number.
 *
 * The attribution comes ENTIRELY from the manifest ({@link steuerkontoScope}): every
 * Steuernummer the report knows is one a user configured for one of their entities. The
 * table used to be compiled in, which made the report work for exactly one person.
 */

import type { Manifest } from '../../config/index.ts';
import { loadManifest } from '../../config/index.ts';
import { searchTransactions, searchAccountKeys } from '../transactions.ts';
import { round2, fmtDe as fmt } from '../../lib/money.ts';

export type SteuerArt = 'USt' | 'GewSt' | 'ESt' | 'Sonstige';

/** Label used when a Finanzamt flow carries no Steuernummer that matches a configured entity. */
export const UNKNOWN_ENTITY = 'unbekannt';

/** One configured entity the report can attribute a booking to. */
export interface SteuerkontoEntity {
    /** The digits that identify this entity in a booking text — the last block of its Steuernummer. */
    token: string;
    /** The Steuernummer exactly as configured, for display. */
    taxNumber: string;
    /** Display label: the entity's name plus its Steuernummer. */
    label: string;
    /**
     * True when the number comes from a business (`elster`) section. Gewerbesteuer is only
     * ever owed by a business, so an untagged GewSt flow falls back to the first such entity.
     */
    business: boolean;
}

/** Everything the report needs to know about the user, derived from the manifest. */
export interface SteuerkontoScope {
    /** Entities in manifest order — the first whose token appears in the booking text wins. */
    entities: SteuerkontoEntity[];
    /**
     * Lower-cased name fragments of the user's OWN accounts (entity names + account labels).
     * A transfer between two of them is an internal earmarking, not a payment to an authority.
     */
    ownAccountNames: string[];
}

export interface SteuerFlowItem {
    bookingDate: string;
    amount: number;
    counterparty?: string;
    purpose?: string;
    entity: string;
    art: SteuerArt;
    bezugsjahr: number | null;
}

export interface SteuerGroup {
    entity: string;
    art: SteuerArt;
    gezahlt: number; // Σ of outflows (negative amounts) as a positive number
    erstattet: number; // Σ of inflows (refunds)
    netto: number; // erstattet − gezahlt (positive = net refund received)
    items: SteuerFlowItem[];
}

export interface SteuerkontoReport {
    year: number;
    groups: SteuerGroup[];
    /** The configured attribution table: Steuernummer → the entity label it was matched to. */
    entities: Record<string, string>;
    /** Internal earmarking transfers to the own tax sub-account (not FA payments). */
    internalReserve: { count: number; out: number };
}

/**
 * The digits that identify a Steuernummer inside a free-text booking reference: the last
 * `/`-separated block (`11/222/33333` → `33333`), or the trailing 5 digits of a 13-digit
 * ELSTER-form number. Returns `''` for anything too short to match on safely — a 3-digit
 * token would hit half the amounts in the file.
 */
export function steuernummerToken(taxNumber: string): string {
    const trimmed = taxNumber.trim();
    if (!trimmed) return '';
    const blocks = trimmed.split('/').filter(Boolean);
    const last = blocks.length > 1 ? blocks[blocks.length - 1] : trimmed;
    const digits = last.replace(/\D/g, '');
    const token = digits.length > 5 ? digits.slice(-5) : digits;
    return token.length >= 4 ? token : '';
}

/**
 * Derive the attribution scope from the manifest. Each entity contributes the Steuernummer of
 * its `elster` section (business) and/or its `est` section (private ESt); the first entity to
 * claim a given number keeps it, so a business and its owner's private return sharing one
 * number resolve to the business (the manifest order decides, as everywhere else).
 */
export function steuerkontoScope(manifest: Manifest): SteuerkontoScope {
    const entities: SteuerkontoEntity[] = [];
    const seen = new Set<string>();
    const ownAccountNames = new Set<string>();

    const add = (taxNumber: string | undefined, name: string, business: boolean): void => {
        const token = steuernummerToken(taxNumber ?? '');
        if (!token || seen.has(token)) return;
        seen.add(token);
        entities.push({ token, taxNumber: (taxNumber ?? '').trim(), label: `${name} (${taxNumber})`, business });
    };

    for (const entity of manifest.entities) {
        add(entity.elster?.tax_number, entity.name, true);
        add(entity.est?.person?.steuernummer, entity.name, false);
        if (entity.name.trim()) ownAccountNames.add(entity.name.trim().toLowerCase());
        for (const label of Object.values(entity.elster?.account_labels ?? {})) {
            if (label.trim()) ownAccountNames.add(label.trim().toLowerCase());
        }
    }
    return { entities, ownAccountNames: [...ownAccountNames] };
}

/** {@link steuerkontoScope} over the manifest on disk. Fail-loud, like every other config loader. */
export function loadSteuerkontoScope(): SteuerkontoScope {
    return steuerkontoScope(loadManifest());
}

function classify(
    scope: SteuerkontoScope,
    purpose: string,
    counterparty: string,
): { entity: string; art: SteuerArt; bezugsjahr: number | null } {
    const t = `${purpose} ${counterparty}`;
    let entity = scope.entities.find((e) => t.includes(e.token))?.label ?? '';
    let art: SteuerArt = 'Sonstige';
    if (/gewerbesteuer|gewst/i.test(t)) {
        art = 'GewSt';
        // GewSt-VZ runs on a business Steuerkonto, so an untagged one belongs to the first
        // business entity — a private entity never owes Gewerbesteuer.
        if (!entity) entity = scope.entities.find((e) => e.business)?.label ?? '';
    } else if (/ums\.?st|umsatzsteuer|\bust\b/i.test(t)) {
        art = 'USt';
    } else if (/\beste?r?\b|einkommensteuer/i.test(t)) {
        art = 'ESt';
    }
    // A Finanzamt/Landeshauptkasse flow that carries a Steuernummer but no type keyword
    // is, for these small entities, almost always Umsatzsteuer (the dominant obligation).
    if (art === 'Sonstige' && entity) art = 'USt';
    if (!entity) entity = UNKNOWN_ENTITY;
    // Reference period: "DEZ.24" / "JAN.24" / "2024" → 2024; "1VJ.25" / "2025" → 2025.
    let bezugsjahr: number | null = null;
    if (/\b20?24\b|\.24\b/.test(t)) bezugsjahr = 2024;
    else if (/\b20?25\b|\.25\b|vj\.?25/i.test(t)) bezugsjahr = 2025;
    return { entity, art, bezugsjahr };
}

/** A real flow to/from a tax authority (FA, Landeshauptkasse, Stadtkasse, Hauptzollamt). */
function isRealAuthority(counterparty: string): boolean {
    return /finanzamt|landeshauptka|hauptzollamt|stadtkasse|stadtkämmerei/i.test(counterparty);
}

/**
 * An INTERNAL transfer to the own tax-reserve sub-account (not a payment to an authority):
 * the counterparty is one of the user's own accounts — a generic sub-account name, or an
 * entity/account name from their manifest — AND the text is about a tax.
 */
function isInternalTaxReserve(scope: SteuerkontoScope, counterparty: string, purpose: string): boolean {
    const cp = counterparty.toLowerCase();
    const isOwnAccount = /steuerkonto|hauptkonto/.test(cp) || scope.ownAccountNames.some((n) => cp.includes(n));
    return isOwnAccount && /gewerbesteuer|umsatzsteuer|ums\.?st|steuer/i.test(`${counterparty} ${purpose}`);
}

/** Build the tax-payment overview for a year from the imported transactions. */
export function steuerkontoReport(scope: SteuerkontoScope, year: number, accountKeys?: string[]): SteuerkontoReport {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const txs = accountKeys?.length
        ? searchAccountKeys(accountKeys, { from, to })
        : searchTransactions({ source: 'camt', from, to }).transactions;

    const byKey = new Map<string, SteuerGroup>();
    let internalReserveCount = 0;
    let internalReserveOut = 0; // Σ of the outflows earmarked as tax reserve (no FA payment)
    for (const t of txs) {
        const cp = t.counterparty ?? '';
        const purpose = t.purpose ?? '';
        // Skip internal earmarking transfers to the own tax sub-account (both legs are in
        // the camt data, so they net to 0 and are NOT payments to an authority).
        if (isInternalTaxReserve(scope, cp, purpose)) {
            internalReserveCount += 1;
            if (t.amount < 0) internalReserveOut = round2(internalReserveOut + Math.abs(t.amount));
            continue;
        }
        if (!isRealAuthority(cp)) continue;
        const { entity, art, bezugsjahr } = classify(scope, purpose, cp);
        const key = `${entity}__${art}`;
        const g = byKey.get(key) ?? { entity, art, gezahlt: 0, erstattet: 0, netto: 0, items: [] };
        if (t.amount < 0) g.gezahlt = round2(g.gezahlt + Math.abs(t.amount));
        else g.erstattet = round2(g.erstattet + t.amount);
        g.netto = round2(g.erstattet - g.gezahlt);
        g.items.push({
            bookingDate: t.bookingDate,
            amount: t.amount,
            counterparty: cp,
            purpose,
            entity,
            art,
            bezugsjahr,
        });
        byKey.set(key, g);
    }
    const groups = [...byKey.values()].sort((a, b) => a.entity.localeCompare(b.entity) || a.art.localeCompare(b.art));
    return {
        year,
        groups,
        entities: Object.fromEntries(scope.entities.map((e) => [e.taxNumber, e.label])),
        internalReserve: { count: internalReserveCount, out: internalReserveOut },
    };
}

/** Print the tax-payment overview. */
export function printSteuerkonto(report: SteuerkontoReport): void {
    console.log(`\nSteuer-Zahlungsübersicht ${report.year} — tatsächliche Flüsse über die Konten (best-effort)`);
    console.log('='.repeat(80));
    console.log('Hinweis: kein amtlicher FA-Steuerkonto-Stand — Abgleich gegen Mein ELSTER empfohlen.\n');
    for (const g of report.groups) {
        const tag = g.netto >= 0 ? `Erstattung netto ${fmt(g.netto)} €` : `gezahlt netto ${fmt(-g.netto)} €`;
        console.log(
            `▸ ${g.entity} · ${g.art}  —  ${tag}  (gezahlt ${fmt(g.gezahlt)} € / erstattet ${fmt(g.erstattet)} €, ${g.items.length} Buchungen)`,
        );
        const byYear = new Map<string, number>();
        for (const it of g.items) {
            const k = it.bezugsjahr ? `Bezug ${it.bezugsjahr}` : 'Bezug ?';
            byYear.set(k, round2((byYear.get(k) ?? 0) + it.amount));
        }
        for (const [k, v] of [...byYear.entries()].sort()) console.log(`    ${k}: ${fmt(v)} €`);
    }
    if (report.internalReserve.count > 0) {
        console.log(
            `\nℹ ${report.internalReserve.count} interne Umbuchungen zwischen eigenen Konten (z. B. „Gewerbesteuer Vorauszahlung" aufs Steuerkonto-Unterkonto, ${fmt(report.internalReserve.out)} € raus / gegengebucht → netto 0). KEINE Steuerzahlung an eine Behörde — ignoriert.`,
        );
    }
    // The attribution is only as complete as the manifest: a Steuernummer nobody configured
    // cannot be matched, so say so instead of silently pooling those payments.
    if (report.groups.some((g) => g.entity === UNKNOWN_ENTITY)) {
        console.log(
            `\nℹ Buchungen unter „${UNKNOWN_ENTITY}" tragen keine der konfigurierten Steuernummern` +
                `${Object.keys(report.entities).length ? ` (${Object.keys(report.entities).join(', ')})` : ' (keine konfiguriert)'}.` +
                ' Fehlt eine Entität, ihre Steuernummer in steuererklaerung.json ergänzen' +
                ' (`elster.tax_number` bzw. `est.person.steuernummer`).',
        );
    }
    console.log('');
}
