/**
 * „IBAN-Wechsel" — a known supplier is suddenly paid to an IBAN it was never paid to before (Idee 7 in
 * docs/ideen-nutzerfuehrung.md). A changed bank account on an invoice is the common shape of invoice
 * fraud, and money sent there is usually gone, so the finding sorts above everything else
 * ({@link Hinweis.vorrang}) whatever the amount. The text sends the owner to the contact they ALREADY
 * know, never to the one printed on the invoice with the new IBAN.
 *
 * Per debit, chronologically: the IBANs the same recipient (by {@link parteiSchluessel}) was paid to
 * BEFORE it. Not a finding:
 * - the first payment to a recipient ever (no history to compare with);
 * - a payment to one of the entity's own accounts (Umbuchung, Einlage, Entnahme);
 * - an IBAN this recipient was already paid to earlier — an established second account, also when the
 *   two alternate.
 * PayPal carries no IBANs and is skipped; an account whose debits carry no counterparty IBAN at all
 * (Qonto rows synced before the app read it) is named as „nicht geprüft".
 *
 * IBANs are shown masked (`DE…3000`) — in every surface, because the Hinweis is the same object for
 * the app, the CLI JSON and MCP. The full IBAN stays in the booking detail, one click away.
 *
 * Pure — the caller loads the store bookings (all years) and the entity's own IBANs.
 */

import { buchungZeile, capBetroffen, HANDLUNG_IN_ORDNUNG, hinweisFingerprint, type Hinweis } from './hinweise.ts';
import { parteiSchluessel } from './serie.ts';

/** Sources without a bank account of their own and so without IBANs. */
const OHNE_IBAN = new Set(['paypal']);

export interface IbanBuchung {
    id: string;
    accountKey: string;
    source: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
    counterpartyIban?: string;
    purpose?: string;
}

export interface IbanWechselInput {
    year: number;
    /** Every booking of the entity's accounts, ALL years — the history decides what is known. */
    buchungen: IbanBuchung[];
    /** IBANs of the owner's own accounts (any entity): a payment there is never a supplier's. */
    eigeneIbans: readonly string[];
    /** Display name per account key, for „nicht geprüft: …". */
    kontoLabel?: (accountKey: string, source: string) => string;
}

/** Without spaces, upper case: `de00 1234 …` → `DE001234…`. */
export function normalisiereIban(iban: string | null | undefined): string {
    return (iban ?? '').replace(/\s+/g, '').toUpperCase();
}

/** Country code + last four characters: `DE…3000`. Short input stays recognisable but never whole. */
export function maskiereIban(iban: string | null | undefined): string {
    const n = normalisiereIban(iban);
    if (n.length <= 6) return '…';
    return `${n.slice(0, 2)}…${n.slice(-4)}`;
}

interface Fund {
    name: string;
    neu: string;
    bekannt: string[];
    tx: IbanBuchung;
}

export function pruefeIbanWechsel(i: IbanWechselInput): Hinweis[] {
    const yearStart = `${i.year}-01-01`;
    const yearEnd = `${i.year}-12-31`;
    const inYear = (t: IbanBuchung) => t.bookingDate >= yearStart && t.bookingDate <= yearEnd;
    const eigene = new Set(i.eigeneIbans.map(normalisiereIban).filter(Boolean));

    const debits = i.buchungen.filter((t) => t.amount < 0 && !OHNE_IBAN.has(t.source));
    const debitsYear = debits.filter(inYear);
    if (debitsYear.length === 0) return [];

    // Accounts that pay but never say where to.
    const mitIban = new Set<string>();
    const konten = new Map<string, string>();
    for (const t of debitsYear) {
        konten.set(t.accountKey, t.source);
        if (normalisiereIban(t.counterpartyIban)) mitIban.add(t.accountKey);
    }
    const label = (k: string) => i.kontoLabel?.(k, konten.get(k) ?? '') ?? k;
    const ohne = [...konten.keys()].filter((k) => !mitIban.has(k)).map(label);
    if (mitIban.size === 0) {
        return [
            {
                key: 'iban-wechsel',
                level: 'info',
                title: 'IBAN-Wechsel: nicht prüfbar',
                text: `Keine Abbuchung ${i.year} nennt die IBAN des Empfängers (${ohne.join(', ')}).`,
                status: 'nicht_pruefbar',
                weil: 'die Konten keine IBAN der Gegenseite liefern',
                begriff: 'iban-wechsel',
            },
        ];
    }

    const sorted = debits
        .filter((t) => normalisiereIban(t.counterpartyIban) && parteiSchluessel(t.counterparty))
        .sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id));
    const bekannt = new Map<string, Set<string>>();
    const funde = new Map<string, Fund[]>();
    let geprueft = 0;
    let erste = 0;
    let eigen = 0;
    let zweitkonto = 0;
    for (const t of sorted) {
        const iban = normalisiereIban(t.counterpartyIban);
        const partei = parteiSchluessel(t.counterparty);
        const zaehlt = inYear(t);
        if (zaehlt) geprueft++;
        if (eigene.has(iban)) {
            if (zaehlt) eigen++;
            continue;
        }
        const known = bekannt.get(partei);
        if (!known) {
            bekannt.set(partei, new Set([iban]));
            if (zaehlt) erste++;
            continue;
        }
        if (known.has(iban)) {
            if (zaehlt && known.size > 1) zweitkonto++;
            continue;
        }
        if (zaehlt) {
            const list = funde.get(partei) ?? [];
            list.push({ name: t.counterparty!.trim(), neu: iban, bekannt: [...known], tx: t });
            funde.set(partei, list);
        }
        known.add(iban);
    }

    const nichtGeprueft = ohne.length ? `; nicht geprüft: ${ohne.join(', ')} (keine IBAN der Gegenseite)` : '';
    if (funde.size === 0) {
        return [
            {
                key: 'iban-wechsel',
                level: 'info',
                title: 'IBAN-Wechsel: keiner gefunden',
                text: `${geprueft} Abbuchung(en) ${i.year} mit IBAN des Empfängers geprüft.`,
                status: 'ohne_befund',
                geprueft:
                    'jede Abbuchung gegen die IBANs, an die derselbe Empfänger vorher bezahlt wurde; ausgenommen: ' +
                    `erste Zahlung an einen Empfänger (${erste}), eigene Konten und Umbuchungen (${eigen}), ` +
                    `eine schon früher genutzte zweite IBAN (${zweitkonto})${nichtGeprueft}`,
                begriff: 'iban-wechsel',
            },
        ];
    }

    const out: Hinweis[] = [];
    for (const [partei, list] of funde) {
        const name = list[0].name;
        const neu = [...new Set(list.map((f) => f.neu))];
        const vorher = list[0].bekannt.map(maskiereIban).join(', ');
        out.push({
            key: `iban-wechsel:${partei}`,
            level: 'warnung',
            vorrang: true,
            title: `IBAN-Wechsel bei ${name}: vermutlich neue Bankverbindung`,
            text:
                `${list.length === 1 ? 'Eine Zahlung' : `${list.length} Zahlungen`} an ${name} ging${list.length === 1 ? '' : 'en'} ` +
                `an ${neu.length === 1 ? 'eine IBAN' : 'IBANs'}, an die bisher nie gezahlt wurde (${neu.map(maskiereIban).join(', ')}); ` +
                `bisher: ${vorher}. Zu klären, bevor weiter gezahlt wird: beim Lieferanten unter der bisher bekannten ` +
                'Telefonnummer oder E-Mail-Adresse nachfragen — nicht unter den Kontaktdaten auf der Rechnung mit der neuen IBAN.',
            status: 'befund',
            ...capBetroffen(
                list.map((f) => ({
                    art: 'buchung' as const,
                    id: f.tx.id,
                    zeile: `${buchungZeile(f.tx)} · an ${maskiereIban(f.neu)}`,
                })),
            ),
            handlungen: [
                {
                    id: 'buchung',
                    label: 'Buchung öffnen',
                    target: { art: 'dialog', dialog: 'buchung', ref: list[0].tx.id },
                },
                HANDLUNG_IN_ORDNUNG,
            ],
            fingerprint: hinweisFingerprint([partei, ...neu]),
            begriff: 'iban-wechsel',
        });
    }
    return out;
}
