/**
 * Deterministic sample data for the fictional demo company "Fischer & Weber GbR" (+ the "Privat"
 * household), mirroring the v2 design mock.
 *
 * Pure + reproducible — NO Math.random / Date.now — so `steuer demo seed` regenerates the
 * committed `app/demo/transactions-data/*.ndjson` byte-for-byte. Every name, amount, IBAN and date
 * is fictional; nothing here is real financial data. Accounts use the real store key prefixes
 * (`qonto:`/`paypal:`/`camt:`/`fints:`) so the isolated demo workspace behaves as a faithful replica.
 */

import { shiftDate } from '@steuererklaerung/shared';
import type {
    StatementMeta,
    TxSource,
    UnifiedTransaction,
    ContactInput,
    FilingInput,
    InvoiceIssuerSnapshot,
} from '@steuererklaerung/store';

export interface DemoAccountData {
    key: string;
    source: TxSource;
    txs: UnifiedTransaction[];
}

interface Account {
    key: string;
    source: TxSource;
    /** Short, filesystem-friendly tag used to build stable transaction ids. */
    short: string;
    iban?: string;
}

// Fischer & Weber GbR (business) → qonto + paypal + camt globs; Privat (household) → fints glob.
const QONTO: Account = { key: 'qonto:demo-fw-geschaeft', source: 'qonto', short: 'qonto', iban: 'DE89370400440532013000' };
const PAYPAL: Account = { key: 'paypal:demo-fw', source: 'paypal', short: 'paypal' };
const CAMT: Account = { key: 'camt:DE76370400440532013040', source: 'camt', short: 'camt24', iban: 'DE76370400440532013040' };
const GIRO: Account = { key: 'fints:demo-musterbank-giro', source: 'fints', short: 'giro', iban: 'DE55370400440532013030' };

/** A recurring booking template, expanded across the given months × years. */
interface Recurring {
    acc: Account;
    day: number;
    amount: number;
    counterparty: string;
    purpose: string;
    category: string;
    months: number[];
    years: number[];
    /** The recipient's (invented) IBAN — what a SEPA transfer carries; card payments have none. */
    counterpartyIban?: string;
}

/** A single dated booking. */
interface OneOff {
    acc: Account;
    date: string;
    amount: number;
    counterparty: string;
    purpose: string;
    category: string;
    counterpartyIban?: string;
}

// Invented supplier IBANs (DE00 …) for the Geld-Prüfungen; Hetzner's second one is the IBAN-Wechsel.
const IBAN_HAUSVERWALTUNG = 'DE00200000000000045743';
const IBAN_HETZNER = 'DE00100000000000006819';
const IBAN_HETZNER_NEU = 'DE00990000000000004711';
const IBAN_TELEKOM = 'DE00300000000000004995';
const IBAN_NORDWIND = 'DE00400000000000059500';
// A Danish SaaS supplier (Prüfungen vor der Abgabe): the foreign IBAN is the only sign of § 13b.
const IBAN_NORDLYS = 'DK0000000000004242';

const M_ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
// The demo's "current" year 2026 is partial (through June) — the expand loop caps it below.
const RUN_YEARS = [2025, 2026];

const RECURRING: Recurring[] = [
    // ── Fischer & Weber GbR — recurring operating expenses (Qonto) ──
    { acc: QONTO, day: 1, amount: -457.43, counterparty: 'Hausverwaltung Musterstadt', purpose: 'Miete Büro Musterstraße 1', category: 'Miete/Raumkosten', months: M_ALL, years: RUN_YEARS, counterpartyIban: IBAN_HAUSVERWALTUNG },
    { acc: QONTO, day: 3, amount: -68.19, counterparty: 'Hetzner Online GmbH', purpose: 'Server & Backup', category: 'EDV/Hosting', months: M_ALL, years: RUN_YEARS, counterpartyIban: IBAN_HETZNER },
    { acc: QONTO, day: 5, amount: -49.95, counterparty: 'Deutsche Telekom AG', purpose: 'Internet & Telefon', category: 'Telefon/Internet', months: M_ALL, years: RUN_YEARS, counterpartyIban: IBAN_TELEKOM },
    { acc: QONTO, day: 7, amount: -12.44, counterparty: 'Cloud-Provider EU', purpose: 'Cloud-Dienste', category: 'Software-Lizenzen', months: M_ALL, years: RUN_YEARS },
    { acc: QONTO, day: 27, amount: -9.0, counterparty: 'Qonto', purpose: 'Kontoführungsgebühr', category: 'Nebenkosten Geldverkehr', months: M_ALL, years: RUN_YEARS },
    // ── Fischer & Weber GbR — recurring income (Qonto) ──
    { acc: QONTO, day: 15, amount: 1204.0, counterparty: 'Stripe Payments UG', purpose: 'Auszahlung SaaS-Abonnements', category: 'Umsatzerlöse', months: M_ALL, years: RUN_YEARS },
    // ── Privat household (Musterbank Giro / FinTS) ──
    { acc: GIRO, day: 28, amount: 2850.0, counterparty: 'Nordsee IT GmbH', purpose: 'Gehalt', category: 'Einnahmen (privat)', months: M_ALL, years: RUN_YEARS },
    { acc: GIRO, day: 1, amount: -995.0, counterparty: 'Hausverwaltung Musterstadt', purpose: 'Miete Wohnung', category: 'Miete (privat)', months: M_ALL, years: RUN_YEARS },
    { acc: GIRO, day: 6, amount: -124.3, counterparty: 'Stadtwerke Musterstadt', purpose: 'Strom & Gas', category: 'Nebenkosten (privat)', months: M_ALL, years: RUN_YEARS },
    { acc: GIRO, day: 2, amount: -58.0, counterparty: 'Verkehrsbetriebe Musterstadt', purpose: 'Deutschlandticket', category: 'Mobilität', months: M_ALL, years: RUN_YEARS },
    { acc: GIRO, day: 12, amount: -87.34, counterparty: 'REWE Markt', purpose: 'Lebensmittel', category: 'Lebensmittel', months: M_ALL, years: RUN_YEARS },
    { acc: GIRO, day: 9, amount: -78.2, counterparty: 'Versicherung Nord AG', purpose: 'Hausratversicherung', category: 'Versicherungen', months: M_ALL, years: RUN_YEARS },
];

const ONEOFFS: OneOff[] = [
    // ── Fischer & Weber GbR — one-off customer income (Qonto), 2025 ──
    { acc: QONTO, date: '2025-02-18', amount: 357.0, counterparty: 'Wattküste Naturtouren', purpose: 'Webdesign', category: 'Umsatzerlöse' },
    { acc: QONTO, date: '2025-03-12', amount: 357.0, counterparty: 'Praxis Dr. Nele Brandt', purpose: 'SEO-Paket', category: 'Umsatzerlöse' },
    { acc: QONTO, date: '2025-06-14', amount: 476.0, counterparty: 'Wattküste Naturtouren', purpose: 'Website-Relaunch, Abschlag 2', category: 'Umsatzerlöse' },
    { acc: QONTO, date: '2025-06-20', amount: 238.0, counterparty: 'Hafenkontor GmbH', purpose: 'Wartung Q2', category: 'Umsatzerlöse' },
    { acc: QONTO, date: '2025-07-08', amount: 595.0, counterparty: 'Praxis Dr. Nele Brandt', purpose: 'SEO-Paket Juli', category: 'Umsatzerlöse' },
    { acc: QONTO, date: '2025-11-05', amount: 1428.0, counterparty: 'Kundin Musterfrau', purpose: 'Onlineshop-Einrichtung', category: 'Umsatzerlöse' },
    { acc: QONTO, date: '2025-11-20', amount: 285.6, counterparty: 'Restaurant Seeblick', purpose: 'Website-Pflege November', category: 'Umsatzerlöse' },
    // Doppelzahlungen: Seeblick pays RE-2025-0004 a second time (full duplicate); Dr. Brandt overpays RE-2026-0003 by 100 € (partial).
    { acc: QONTO, date: '2025-12-03', amount: 285.6, counterparty: 'Restaurant Seeblick', purpose: 'RE-2025-0004 Website-Pflege November', category: 'Umsatzerlöse' },
    { acc: QONTO, date: '2026-07-15', amount: 695.0, counterparty: 'Praxis Dr. Nele Brandt', purpose: 'RE-2026-0003 SEO-Paket Juli', category: 'Umsatzerlöse' },
    // ── Fischer & Weber GbR — one-off expenses (Qonto), 2025 ──
    { acc: QONTO, date: '2025-01-10', amount: -44.62, counterparty: 'Adobe Systems', purpose: 'Creative Cloud (anteilig)', category: 'Software-Lizenzen' },
    { acc: QONTO, date: '2025-02-16', amount: -23.8, counterparty: 'KI-Labs LLC', purpose: 'KI-API (Reverse Charge)', category: 'Fremdleistungen' },
    { acc: QONTO, date: '2025-03-11', amount: -23.58, counterparty: 'INWX GmbH', purpose: 'Domainverlängerung', category: 'Software-Lizenzen' },
    { acc: QONTO, date: '2025-04-09', amount: -42.9, counterparty: 'Amazon EU S.à r.l.', purpose: 'USB-Hub & Kabel', category: 'Bürobedarf' },
    { acc: QONTO, date: '2025-08-16', amount: -23.8, counterparty: 'KI-Labs LLC', purpose: 'KI-API (Reverse Charge)', category: 'Fremdleistungen' },
    { acc: QONTO, date: '2025-09-11', amount: -23.58, counterparty: 'INWX GmbH', purpose: 'Domainverlängerung', category: 'Software-Lizenzen' },
    // Quarterly USt-Vorauszahlung (Qonto)
    { acc: QONTO, date: '2025-04-10', amount: -1303.59, counterparty: 'Finanzamt Musterstadt', purpose: 'USt-Vorauszahlung Q1/2025', category: 'Umsatzsteuer-Vorauszahlung' },
    { acc: QONTO, date: '2025-07-10', amount: -558.8, counterparty: 'Finanzamt Musterstadt', purpose: 'USt-Vorauszahlung Q2/2025', category: 'Umsatzsteuer-Vorauszahlung' },
    { acc: QONTO, date: '2025-10-10', amount: -346.19, counterparty: 'Finanzamt Musterstadt', purpose: 'USt-Vorauszahlung Q3/2025', category: 'Umsatzsteuer-Vorauszahlung' },
    // ── PayPal (Fischer & Weber GbR) ──
    { acc: PAYPAL, date: '2025-03-22', amount: -19.99, counterparty: 'PayPal', purpose: 'Tool-Abo (Sammelbuchung)', category: 'Software-Lizenzen' },
    { acc: PAYPAL, date: '2025-05-15', amount: 214.2, counterparty: 'Kundin Musterfrau', purpose: 'PayPal-Zahlung Kleinauftrag', category: 'Umsatzerlöse' },
    // ── Privat household — one-offs (Giro), 2025 ──
    { acc: GIRO, date: '2025-03-19', amount: -238.0, counterparty: 'Elektro Petersen', purpose: 'Elektroinstallation', category: 'Handwerkerleistungen' },
    { acc: GIRO, date: '2025-05-14', amount: -386.5, counterparty: 'Zahnarztpraxis Dr. Kern', purpose: 'Zahnbehandlung', category: 'Gesundheit' },
    { acc: GIRO, date: '2025-07-05', amount: -89.0, counterparty: 'Fahrschule Nordlicht', purpose: 'Fahrstunde', category: 'Sonstiges' },
    { acc: GIRO, date: '2025-09-03', amount: -714.0, counterparty: 'Malermeister Voss', purpose: 'Malerarbeiten Wohnung', category: 'Handwerkerleistungen' },
    { acc: GIRO, date: '2025-12-06', amount: -150.0, counterparty: 'Seenotretter e.V.', purpose: 'Spende', category: 'Spenden' },
    // ── CAMT-Datei 2024 — historical Fischer & Weber GbR bookings (12) ──
    { acc: CAMT, date: '2024-01-31', amount: 980.0, counterparty: 'Stripe Payments UG', purpose: 'Auszahlung SaaS-Abonnements', category: 'Umsatzerlöse' },
    { acc: CAMT, date: '2024-02-15', amount: -68.19, counterparty: 'Hetzner Online GmbH', purpose: 'Server & Backup', category: 'EDV/Hosting' },
    { acc: CAMT, date: '2024-03-20', amount: 357.0, counterparty: 'Wattküste Naturtouren', purpose: 'Webdesign', category: 'Umsatzerlöse' },
    { acc: CAMT, date: '2024-04-05', amount: -49.95, counterparty: 'Deutsche Telekom AG', purpose: 'Internet & Telefon', category: 'Telefon/Internet' },
    { acc: CAMT, date: '2024-05-18', amount: 1190.0, counterparty: 'Kundin Musterfrau', purpose: 'Projektabschluss', category: 'Umsatzerlöse' },
    { acc: CAMT, date: '2024-06-11', amount: -457.43, counterparty: 'Hausverwaltung Musterstadt', purpose: 'Miete Büro', category: 'Miete/Raumkosten' },
    { acc: CAMT, date: '2024-07-09', amount: -23.58, counterparty: 'INWX GmbH', purpose: 'Domainverlängerung', category: 'Software-Lizenzen' },
    { acc: CAMT, date: '2024-08-22', amount: 476.0, counterparty: 'Praxis Dr. Nele Brandt', purpose: 'SEO-Paket', category: 'Umsatzerlöse' },
    { acc: CAMT, date: '2024-09-14', amount: -42.9, counterparty: 'Amazon EU S.à r.l.', purpose: 'Bürobedarf', category: 'Bürobedarf' },
    { acc: CAMT, date: '2024-10-30', amount: -296.42, counterparty: 'Finanzamt Musterstadt', purpose: 'USt-Vorauszahlung Q3/2024', category: 'Umsatzsteuer-Vorauszahlung' },
    { acc: CAMT, date: '2024-11-08', amount: 833.0, counterparty: 'Hafenkontor GmbH', purpose: 'Wartung', category: 'Umsatzerlöse' },
    { acc: CAMT, date: '2024-12-19', amount: -9.0, counterparty: 'Qonto', purpose: 'Kontoführungsgebühr', category: 'Nebenkosten Geldverkehr' },
    // ── Geld-Prüfungen (Idee 7), appended so the earlier ids stay stable ──
    // IBAN-Wechsel: Hetzner, paid to the same IBAN every month, once goes to an IBAN never used before.
    { acc: QONTO, date: '2025-10-17', amount: -149.0, counterparty: 'Hetzner Online GmbH', purpose: 'Dedicated Server HR-2025-1017', category: 'EDV/Hosting', counterpartyIban: IBAN_HETZNER_NEU },
    // Lieferant doppelt bezahlt: the Messewand invoice WN-2025-0812 paid twice.
    { acc: QONTO, date: '2025-08-12', amount: -595.0, counterparty: 'Werbetechnik Nordwind', purpose: 'WN-2025-0812 Messewand', category: 'Werbekosten', counterpartyIban: IBAN_NORDWIND },
    { acc: QONTO, date: '2025-08-26', amount: -595.0, counterparty: 'Werbetechnik Nordwind', purpose: 'Rechnung WN-2025-0812', category: 'Werbekosten', counterpartyIban: IBAN_NORDWIND },
    // ── Laufende Kosten (Idee 8), appended like the Geld-Prüfungen ──
    // A yearly Betriebshaftpflicht over three years, one price change in 2026.
    { acc: CAMT, date: '2024-03-01', amount: -289.17, counterparty: 'Hanse Versicherung AG', purpose: 'Betriebshaftpflicht 2024', category: 'Versicherungen' },
    { acc: QONTO, date: '2025-03-03', amount: -289.17, counterparty: 'Hanse Versicherung AG', purpose: 'Betriebshaftpflicht 2025', category: 'Versicherungen' },
    { acc: QONTO, date: '2026-03-02', amount: -301.4, counterparty: 'Hanse Versicherung AG', purpose: 'Betriebshaftpflicht 2026', category: 'Versicherungen' },
    // A design-software subscription that got dearer in 2026 (29,75 → 35,70 €).
    ...[2025, 2026].flatMap((y) =>
        M_ALL.filter((m) => y === 2025 || m <= 6).map(
            (m): OneOff => ({
                acc: QONTO,
                date: `${y}-${pad(m)}-14`,
                amount: y === 2025 ? -29.75 : -35.7,
                counterparty: 'Pixelkraft Software GmbH',
                purpose: 'Design-Suite Team-Abo',
                category: 'Software-Lizenzen',
            }),
        ),
    ),
    // ── Erstattungen (Idee 9), appended like the laufende Kosten ──
    // A returned office chair: refunded in full in the next quarter (19 % VAT inside).
    { acc: QONTO, date: '2026-03-10', amount: -416.5, counterparty: 'Büromöbel Kranich GmbH', purpose: 'Bürobedarf Bestellung KR-2026-0310 Bürostuhl', category: 'Bürobedarf' },
    { acc: QONTO, date: '2026-04-02', amount: 416.5, counterparty: 'Büromöbel Kranich GmbH', purpose: 'Gutschrift Rücksendung KR-2026-0310', category: 'Gutschriften' },
    // A trade-fair stand, part of it refunded when the booth got smaller.
    { acc: QONTO, date: '2026-02-20', amount: -1547.0, counterparty: 'Messebau Ostsee GmbH', purpose: 'Werbung Messestand Frühjahr MO-2026-17', category: 'Werbekosten' },
    { acc: QONTO, date: '2026-05-12', amount: 297.5, counterparty: 'Messebau Ostsee GmbH', purpose: 'Teilerstattung MO-2026-17 Standfläche', category: 'Gutschriften' },
    // ── Prüfungen vor der Abgabe (Idee 10), appended like the Erstattungen ──
    // A foreign SaaS debit without VAT that nothing books as § 13b (only its IBAN is Danish).
    { acc: QONTO, date: '2026-05-08', amount: -59.0, counterparty: 'Nordlys Analytics ApS', purpose: 'Software-Lizenz Analytics Pro Mai 2026', category: 'Software-Lizenzen', counterpartyIban: IBAN_NORDLYS },
    // A workstation above the GWG limit (1.200 € net) that is not in the Anlageverzeichnis.
    { acc: QONTO, date: '2026-05-20', amount: -1428.0, counterparty: 'Technikhaus Nord GmbH', purpose: 'Bürobedarf Grafik-Workstation TN-2026-0520', category: 'Bürobedarf' },
    // Two expenses whose receipts name no VAT (see buildDemoDocuments, `ohneUst`).
    { acc: QONTO, date: '2026-04-16', amount: -89.25, counterparty: 'Copyshop Möwe', purpose: 'Flyer-Druck CM-2026-0416', category: 'Werbekosten' },
    { acc: QONTO, date: '2026-06-11', amount: -160.0, counterparty: 'Fotostudio Kranz', purpose: 'Werbefotos Produktkatalog FK-2026-0611', category: 'Werbekosten' },
    // Offene Forderungen (Idee 12): Restaurant Seeblick pays 400 € on account of RE-2026-0005 (1.190 €) and nothing since.
    { acc: QONTO, date: '2026-05-30', amount: 400.0, counterparty: 'Restaurant Seeblick', purpose: 'RE-2026-0005 Teilzahlung Speisekarten-Relaunch', category: 'Umsatzerlöse' },
    // Splitbuchung (Idee 13): one online order with office supplies and a private coffee machine (half each),
    // and a business lunch to split 70/30 as a Bewirtung.
    { acc: QONTO, date: '2026-06-03', amount: -238.0, counterparty: 'Versandhaus Möwenpost', purpose: 'Bürobedarf Bestellung VM-2026-0603 Toner, Papier, Kaffeemaschine', category: 'Bürobedarf' },
    { acc: QONTO, date: '2026-06-18', amount: -142.8, counterparty: 'Gasthaus Leuchtturm', purpose: 'Bewirtung Kundengespräch Hafenkontor', category: 'Bewirtung' },
    // Projekte auch für Ausgaben (Idee 14): three costs of the project „Website-Relaunch Wattküste“. The
    // first two are assigned by hand (multi-select), the domain by the project rule „Relaunch Wattküste“.
    { acc: QONTO, date: '2026-05-12', amount: -59.5, counterparty: 'Bildagentur Küstenlicht', purpose: 'Bürobedarf Bildlizenzen Startseite Wattküste KL-2026-0512', category: 'Bürobedarf' },
    { acc: QONTO, date: '2026-05-14', amount: -35.7, counterparty: 'Schriftgießerei Nordtype', purpose: 'Bürobedarf Schriftlizenz Webfonts Wattküste NT-2026-0514', category: 'Bürobedarf' },
    { acc: QONTO, date: '2026-05-18', amount: -14.28, counterparty: 'INWX GmbH', purpose: 'Domain wattkueste-neu.example Relaunch Wattküste', category: 'Software-Lizenzen' },
    // ── ERiC-Prüfung der Demodaten, appended like the others ──
    // The payment of „Website-Relaunch, Abschlag 1" (paid 2026-03-12), which the bookings lacked.
    { acc: QONTO, date: '2026-03-12', amount: 952.0, counterparty: 'Wattküste Naturtouren', purpose: 'Rechnungsnr. Abschlag 1 Website', category: 'Umsatzerlöse' },
    // A subcontractor in July: more Vorsteuer than USt, so Q3/2026 ends in an Erstattung — the
    // deliberate „USt-Zahllast weicht ab" of the Prüfungen vor der Abgabe (Idee 10).
    { acc: QONTO, date: '2026-07-01', amount: -1190.0, counterparty: 'Kodewerk Nord GmbH', purpose: 'Fremdleistung Backend-Entwicklung KN-2026-0701', category: 'Fremdleistungen' },
];

function pad(n: number): string {
    return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Build the full deterministic demo transaction set, grouped by account. Ids are stable
 * (`demo-<accountTag>-<n>`) so re-seeding upserts the same rows without duplication.
 */
export function buildDemoTransactions(): DemoAccountData[] {
    const byKey = new Map<string, { acc: Account; txs: UnifiedTransaction[] }>();
    const seq = new Map<string, number>();

    const emit = (
        acc: Account,
        date: string,
        amount: number,
        counterparty: string,
        purpose: string,
        category: string,
        counterpartyIban?: string,
    ): void => {
        const n = (seq.get(acc.short) ?? 0) + 1;
        seq.set(acc.short, n);
        const tx: UnifiedTransaction = {
            id: `demo-${acc.short}-${n}`,
            source: acc.source,
            accountKey: acc.key,
            iban: acc.iban,
            bookingDate: date,
            valueDate: date,
            amount: Math.round(amount * 100) / 100,
            currency: 'EUR',
            counterparty,
            ...(counterpartyIban ? { counterpartyIban } : {}),
            purpose,
            category,
        };
        let bucket = byKey.get(acc.key);
        if (!bucket) {
            bucket = { acc, txs: [] };
            byKey.set(acc.key, bucket);
        }
        bucket.txs.push(tx);
    };

    for (const r of RECURRING) {
        for (const y of r.years) {
            for (const m of r.months) {
                // 2026 is the partial "current" year in the demo — only H1 has data.
                if (y === 2026 && m > 6) continue;
                emit(r.acc, `${y}-${pad(m)}-${pad(r.day)}`, r.amount, r.counterparty, r.purpose, r.category, r.counterpartyIban);
            }
        }
    }
    for (const o of ONEOFFS) {
        emit(o.acc, o.date, o.amount, o.counterparty, o.purpose, o.category, o.counterpartyIban);
    }

    return [...byKey.values()].map((b) => ({ key: b.acc.key, source: b.acc.source, txs: b.txs }));
}

/**
 * Monthly CAMT statement metadata for the GbR's Qonto account in 2025 — with statement Nr. 9
 * (September) never imported, so „Kontoauszug lückenlos?" has a finding to show: the balance chain
 * breaks between the August and the October statement. The opening balance is invented.
 */
export function buildDemoStatements(): { key: string; statements: StatementMeta[] } {
    const txs = buildDemoTransactions().find((a) => a.key === QONTO.key)?.txs ?? [];
    const statements: StatementMeta[] = [];
    let balance = 3200;
    for (let m = 1; m <= 12; m++) {
        const from = `2025-${pad(m)}-01`;
        const to = `2025-${pad(m)}-${pad(new Date(Date.UTC(2025, m, 0)).getUTCDate())}`;
        const own = txs.filter((t) => t.bookingDate >= from && t.bookingDate <= to);
        const sum = Math.round(own.reduce((a, t) => a + t.amount, 0) * 100) / 100;
        const opening = balance;
        balance = Math.round((balance + sum) * 100) / 100;
        if (m === 9) continue;
        statements.push({ from, to, opening, closing: balance, seq: m, sum, count: own.length, source: 'camt' });
    }
    return { key: QONTO.key, statements };
}

// ─────────────────────────────────────────────────────────────────────────────
// Master data for the Kontakte + Rechnungen screens (SQLite ledger, entity "gbr")
// ─────────────────────────────────────────────────────────────────────────────

/** §14 issuer identity for the demo GbR's outgoing invoices (fictional Steuernummer). */
export const DEMO_ISSUER: InvoiceIssuerSnapshot = {
    name: 'Fischer & Weber GbR',
    address: 'Musterstraße 1',
    zip: '12345',
    city: 'Musterstadt',
    countryCode: 'DE',
    email: 'buchhaltung@fischer-weber.example',
    taxNumber: '9198081508152',
    bank: { iban: 'DE89370400440532013000', bankName: 'Musterbank' },
};

/** The demo contacts (customers + suppliers); stable ids so re-seeding upserts them. */
export function buildDemoContacts(): ContactInput[] {
    return [
        { id: 'demo-c-wattkueste', entityId: 'gbr', kind: 'company', name: 'Wattküste Naturtouren', email: 'info@wattkueste.example', iban: 'DE89370400440532013000', isCustomer: true },
        { id: 'demo-c-brandt', entityId: 'gbr', kind: 'company', name: 'Praxis Dr. Nele Brandt', email: 'praxis@brandt.example', isCustomer: true },
        { id: 'demo-c-hafenkontor', entityId: 'gbr', kind: 'company', name: 'Hafenkontor GmbH', email: 'buchhaltung@hafenkontor.example', isCustomer: true },
        { id: 'demo-c-musterfrau', entityId: 'gbr', kind: 'individual', name: 'Kundin Musterfrau', email: 'm.musterfrau@example.org', isCustomer: true },
        { id: 'demo-c-seeblick', entityId: 'gbr', kind: 'company', name: 'Restaurant Seeblick', email: 'kontakt@seeblick.example', isCustomer: true },
        { id: 'demo-c-strandperle', entityId: 'gbr', kind: 'company', name: 'Gasthof Strandperle', email: 'wirt@strandperle.example', isCustomer: true },
        { id: 'demo-c-leuchtfeuer', entityId: 'gbr', kind: 'company', name: 'Leuchtfeuer Medien OHG', email: 'office@leuchtfeuer.example', isCustomer: true },
        { id: 'demo-c-segelschule', entityId: 'gbr', kind: 'company', name: 'Segelschule Nordwind', email: 'buero@nordwind-segeln.example', address: 'Am Yachthafen 3', zip: '24937', city: 'Flensburg', countryCode: 'DE', isCustomer: true },
        { id: 'demo-c-hetzner', entityId: 'gbr', kind: 'company', name: 'Hetzner Online GmbH', email: 'billing@hetzner.example', isSupplier: true },
        { id: 'demo-c-inwx', entityId: 'gbr', kind: 'company', name: 'INWX GmbH', email: 'rechnung@inwx.example', isSupplier: true },
        { id: 'demo-c-telekom', entityId: 'gbr', kind: 'company', name: 'Deutsche Telekom AG', email: 'rechnung@telekom.example', isSupplier: true },
    ];
}

/** One demo outgoing invoice. `paid` set → "bezahlt"; else "offen" (rendered "überfällig" if dueDate is past). */
export interface DemoInvoice {
    contactId: string;
    recipient: string;
    title: string;
    /** Net amount in EUR; 19 % VAT is added. */
    net: number;
    issueDate: string;
    dueDate: string;
    paid?: string;
    /** The booking that settled it (counterparty + date) — lets the demo show a second receipt for the same invoice. */
    paidTx?: { counterparty: string; date: string };
}

/** The day the age-dependent demo invoices are measured from when the caller names none (keeps tests fixed). */
export const DEMO_REFERENCE_DATE = '2026-10-09';

/**
 * Demo invoices in emission order (drives the per-year RE-YYYY-NNNN numbering). Four of them are dated
 * RELATIVE to `today` — due in 10 days, and 12, 45 and 75 days overdue — so the age buckets of „Offene
 * Forderungen" are all filled whenever the demo is seeded. The ledger is derived and never committed, so
 * this does not touch the reproducible NDJSON; the demo CLI passes the real date.
 */
export function buildDemoInvoices(today: string = DEMO_REFERENCE_DATE): DemoInvoice[] {
    return [
        { contactId: 'demo-c-wattkueste', recipient: 'Wattküste Naturtouren', title: 'Webdesign', net: 300, issueDate: '2025-09-14', dueDate: '2025-09-28', paid: '2025-09-25' },
        { contactId: 'demo-c-brandt', recipient: 'Praxis Dr. Nele Brandt', title: 'SEO-Paket', net: 300, issueDate: '2025-10-12', dueDate: '2025-10-26', paid: '2025-10-20' },
        { contactId: 'demo-c-musterfrau', recipient: 'Kundin Musterfrau', title: 'Onlineshop-Einrichtung', net: 1200, issueDate: '2025-11-05', dueDate: '2025-11-19', paid: '2025-11-15' },
        { contactId: 'demo-c-seeblick', recipient: 'Restaurant Seeblick', title: 'Website-Pflege November', net: 240, issueDate: '2025-11-20', dueDate: '2025-12-04', paid: '2025-12-01', paidTx: { counterparty: 'Restaurant Seeblick', date: '2025-11-20' } },
        { contactId: 'demo-c-wattkueste', recipient: 'Wattküste Naturtouren', title: 'Website-Relaunch, Abschlag 2', net: 400, issueDate: '2026-06-07', dueDate: '2026-06-21' },
        { contactId: 'demo-c-hafenkontor', recipient: 'Hafenkontor GmbH', title: 'Wartung Q2', net: 200, issueDate: '2026-06-08', dueDate: '2026-06-22' },
        { contactId: 'demo-c-brandt', recipient: 'Praxis Dr. Nele Brandt', title: 'SEO-Paket Juli', net: 500, issueDate: '2026-07-01', dueDate: '2026-07-21' },
        // Offene Forderungen (Idee 12), appended so the numbers above stay put. Over 90 days overdue:
        { contactId: 'demo-c-hafenkontor', recipient: 'Hafenkontor GmbH', title: 'Wartung Q1', net: 200, issueDate: '2026-02-02', dueDate: '2026-02-16' },
        // Partly paid (400 € on account, see the Qonto credit of 2026-05-30):
        { contactId: 'demo-c-seeblick', recipient: 'Restaurant Seeblick', title: 'Speisekarten-Relaunch', net: 1000, issueDate: '2026-05-04', dueDate: '2026-05-18' },
        // A slow payer whose delay grows: 2, 5, 11, 18 and 26 days after the due date.
        { contactId: 'demo-c-strandperle', recipient: 'Gasthof Strandperle', title: 'Webshop-Pflege Januar', net: 150, issueDate: '2025-02-03', dueDate: '2025-02-17', paid: '2025-02-19' },
        { contactId: 'demo-c-strandperle', recipient: 'Gasthof Strandperle', title: 'Webshop-Pflege April', net: 150, issueDate: '2025-04-07', dueDate: '2025-04-21', paid: '2025-04-26' },
        { contactId: 'demo-c-strandperle', recipient: 'Gasthof Strandperle', title: 'Webshop-Pflege Juni', net: 150, issueDate: '2025-06-02', dueDate: '2025-06-16', paid: '2025-06-27' },
        { contactId: 'demo-c-strandperle', recipient: 'Gasthof Strandperle', title: 'Webshop-Pflege August', net: 150, issueDate: '2025-08-04', dueDate: '2025-08-18', paid: '2025-09-05' },
        { contactId: 'demo-c-strandperle', recipient: 'Gasthof Strandperle', title: 'Webshop-Pflege Oktober', net: 150, issueDate: '2025-10-06', dueDate: '2025-10-20', paid: '2025-11-15' },
        // Age buckets, relative to the seeding day: not yet due, 1–30, 31–60 and 61–90 days overdue.
        { contactId: 'demo-c-wattkueste', recipient: 'Wattküste Naturtouren', title: 'Hosting-Paket Quartal', net: 120, issueDate: shiftDate(today, -4), dueDate: shiftDate(today, 10) },
        { contactId: 'demo-c-musterfrau', recipient: 'Kundin Musterfrau', title: 'Shop-Anpassungen', net: 300, issueDate: shiftDate(today, -26), dueDate: shiftDate(today, -12) },
        { contactId: 'demo-c-seeblick', recipient: 'Restaurant Seeblick', title: 'Website-Pflege Sommer', net: 240, issueDate: shiftDate(today, -59), dueDate: shiftDate(today, -45) },
        { contactId: 'demo-c-strandperle', recipient: 'Gasthof Strandperle', title: 'Webshop-Pflege Juli', net: 150, issueDate: shiftDate(today, -89), dueDate: shiftDate(today, -75) },
        // An old claim: arose in 2023, so „Handeln bis 31.12.2026".
        { contactId: 'demo-c-leuchtfeuer', recipient: 'Leuchtfeuer Medien OHG', title: 'Logo und Visitenkarten', net: 800, issueDate: '2023-04-12', dueDate: '2023-04-26' },
        // Projekte (Idee 14): the first instalment of the project „Website-Relaunch Wattküste“ (the second is above).
        { contactId: 'demo-c-wattkueste', recipient: 'Wattküste Naturtouren', title: 'Website-Relaunch, Abschlag 1', net: 800, issueDate: '2026-03-02', dueDate: '2026-03-16', paid: '2026-03-12', paidTx: { counterparty: 'Wattküste Naturtouren', date: '2026-03-12' } },
        // Rechnung ↔ Projekt: a flat fee without tracked hours for the only project of „Segelschule Nordwind“. Last, so
        // no number above moves; it stays unassigned until the person assigns it.
        { contactId: 'demo-c-segelschule', recipient: 'Segelschule Nordwind', title: 'Pauschale Einrichtung Buchungssystem', net: 600, issueDate: '2026-04-20', dueDate: '2026-05-04', paid: '2026-05-06' },
    ];
}

/**
 * Demo filing register (entity "gbr"): Q1/2026 filed and paid, Q2/2026 filed but unpaid — so "Frei
 * verfügbar" counts the USt from Q3 on and deducts the overdue Q2 Zahllast, and a Splitbuchung in Q2
 * asks first (Idee 13). The declared amounts are what the demo bookings yield per quarter (USt − Vorsteuer
 * by payment date, without the Erstattungen and splits the E2Es add); a test keeps them in step.
 */
export function buildDemoFilings(): FilingInput[] {
    return [
        { entityId: 'gbr', kind: 'ustva', period: '2026-Q1', filedAt: '2026-04-08', paidAt: '2026-04-10', declaredAmount: 335.54 },
        { entityId: 'gbr', kind: 'ustva', period: '2026-Q2', filedAt: '2026-07-09', declaredAmount: 319.41 },
    ];
}

/** An incoming Beleg (supplier invoice) for the built-in DMS. `date`+`correspondent` match a demo tx so it links. */
export interface DemoDocument {
    correspondent: string;
    /** YYYY-MM-DD — must equal a demo transaction's bookingDate to link (see findTxId in the seeder). */
    date: string;
    /** Gross amount in EUR (19 % VAT is split out). */
    gross: number;
    invoiceNumber: string;
    docType: string;
    /** Booking category the receipt already carries (what „Als Regel merken" can remember). */
    category?: string;
    /** Auto-link to the matching demo tx. `false` ⇒ the Beleg stays unlinked → appears in the review queue. */
    link?: boolean;
    /** Ship the Beleg as a ZUGFeRD-style hybrid PDF with an attached XRechnung (read without AI on seeding). */
    eInvoice?: boolean;
    /** The receipt names only its gross amount — no VAT, no net (Buchungen ohne USt-Angabe). */
    ohneUst?: boolean;
}

/** Demo Belege — most auto-linked to a tx; two stay unlinked so the guided Beleg-Eingang has a queue. */
export function buildDemoDocuments(): DemoDocument[] {
    return [
        { correspondent: 'Hetzner Online GmbH', date: '2026-01-03', gross: 68.19, invoiceNumber: 'HR-2026-0001', docType: 'Rechnung' },
        { correspondent: 'Deutsche Telekom AG', date: '2026-01-05', gross: 49.95, invoiceNumber: 'TK-2026-01', docType: 'Rechnung', category: '4921 Telefon/Internet', link: false },
        { correspondent: 'Büro Nordlicht GmbH', date: '2026-02-12', gross: 238, invoiceNumber: 'BN-2026-0212', docType: 'Rechnung', link: false, eInvoice: true },
        { correspondent: 'Cloud-Provider EU', date: '2026-02-07', gross: 12.44, invoiceNumber: 'CP-2026-02', docType: 'Rechnung', link: false },
        { correspondent: 'INWX GmbH', date: '2025-03-11', gross: 23.58, invoiceNumber: 'inwx-2025-0311', docType: 'Rechnung' },
        { correspondent: 'Adobe Systems', date: '2025-01-10', gross: 44.62, invoiceNumber: 'ADBE-2025-01', docType: 'Rechnung' },
        { correspondent: 'Amazon EU S.à r.l.', date: '2025-04-09', gross: 42.9, invoiceNumber: 'AMZ-302-1234567', docType: 'Rechnung', link: false },
        // Doppelte Rechnung: the same print job invoiced twice within two weeks under two numbers.
        { correspondent: 'Druckerei Hafenblick', date: '2025-10-06', gross: 476, invoiceNumber: 'DH-2025-311', docType: 'Rechnung', link: false },
        { correspondent: 'Druckerei Hafenblick', date: '2025-10-20', gross: 476, invoiceNumber: 'DH-2025-318', docType: 'Rechnung', link: false },
        // Lieferant doppelt bezahlt: linked to the first of its two payments.
        { correspondent: 'Werbetechnik Nordwind', date: '2025-08-12', gross: 595, invoiceNumber: 'WN-2025-0812', docType: 'Rechnung' },
        // Prüfungen vor der Abgabe: the workstation's invoice, and two receipts without a VAT figure.
        { correspondent: 'Technikhaus Nord GmbH', date: '2026-05-20', gross: 1428, invoiceNumber: 'TN-2026-0520', docType: 'Rechnung' },
        { correspondent: 'Copyshop Möwe', date: '2026-04-16', gross: 89.25, invoiceNumber: 'CM-2026-0416', docType: 'Rechnung', ohneUst: true },
        { correspondent: 'Fotostudio Kranz', date: '2026-06-11', gross: 160, invoiceNumber: 'FK-2026-0611', docType: 'Rechnung', ohneUst: true },
    ];
}

/** A tracked time entry of the demo project; `billedTo` is the title of the demo invoice it went into. */
export interface DemoTimeEntry {
    id: string;
    projectId: string;
    project: string;
    contactId: string;
    /** YYYY-MM-DD, started at 09:00 UTC. */
    date: string;
    hours: number;
    description: string;
    billedTo?: string;
}

/**
 * The hours behind the demo project „Website-Relaunch Wattküste“ (Idee 14): 10 h on the first instalment,
 * 5 h on the second, 1,5 h not yet billed — together with the invoices and the three expenses above a
 * project result with hours and a result per hour.
 */
export function buildDemoTimeEntries(): DemoTimeEntry[] {
    const base = { projectId: 'wattkueste-relaunch', project: 'Website-Relaunch Wattküste', contactId: 'demo-c-wattkueste' };
    return [
        { ...base, id: 'demo-t-1', date: '2026-02-24', hours: 6, description: 'Konzept und Gestaltung Startseite', billedTo: 'Website-Relaunch, Abschlag 1' },
        { ...base, id: 'demo-t-2', date: '2026-02-26', hours: 4, description: 'Seitenvorlagen und Navigation', billedTo: 'Website-Relaunch, Abschlag 1' },
        { ...base, id: 'demo-t-3', date: '2026-05-27', hours: 3, description: 'Inhalte einpflegen', billedTo: 'Website-Relaunch, Abschlag 2' },
        { ...base, id: 'demo-t-4', date: '2026-05-28', hours: 2, description: 'Abnahme und Korrekturen', billedTo: 'Website-Relaunch, Abschlag 2' },
        { ...base, id: 'demo-t-5', date: '2026-09-02', hours: 1.5, description: 'Nacharbeiten nach dem Start' },
    ];
}

/**
 * Open hours of the second demo project „Buchungssystem Segelschule“ (Rechnung ↔ Projekt): 3 h + 1,25 h of
 * „Konzept“ and 2,5 h of „Umsetzung“, none billed — they become invoice lines in „Zeiten übernehmen“.
 */
export function buildDemoSegelschuleTimeEntries(): DemoTimeEntry[] {
    const base = { projectId: 'segelschule-buchung', project: 'Buchungssystem Segelschule', contactId: 'demo-c-segelschule' };
    return [
        { ...base, id: 'demo-t-6', date: '2026-09-14', hours: 3, description: 'Konzept' },
        { ...base, id: 'demo-t-7', date: '2026-09-15', hours: 2.5, description: 'Umsetzung' },
        { ...base, id: 'demo-t-8', date: '2026-09-16', hours: 1.25, description: 'Konzept' },
    ];
}
