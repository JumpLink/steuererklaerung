/**
 * EÜR transaction classification: the rule chain that maps a **no-document**
 * transaction to an SKR03 category (+ its implied VAT rate). Pure, side-effect-free.
 *
 * Kept separate from the aggregate (euer-transactions.ts) because these rules encode
 * business-specific supplier/purpose knowledge (counterparties, keywords, confirmed
 * private items) that changes far more often than the aggregation maths that consumes them.
 *
 * **What is compiled in and what is not.** Only signals that mean the same thing for EVERY user
 * live here: generic banking vocabulary (`Privatentnahme`, `Umbuchung`, `Verkaufserlöse`), the
 * securities terms, and merchant keywords that map to a category for any business (`hosting`,
 * `versicherung`, `bewirtung`). Everything that encodes a JUDGEMENT about a concrete counterparty
 * — who the owners are, which customer marks revenue, which merchant this user treats as private,
 * which supplier a personal name or a customer number stands for — comes from the per-entity
 * `elster.klassifizierung` block of the manifest, via {@link TxClassifyRules}.
 *
 * That split is not cosmetic. It used to be the other way round, and the chain then silently did
 * the wrong thing for anybody but its author (the same defect `actions/elster/steuerkonto.ts` had),
 * while third-party names and membership numbers sat in source. With no rules configured the chain
 * still runs — it just classifies less, and never classifies somebody else's counterparties.
 *
 * ⚠ **Filed years depend on the configured needles.** Dropping one re-classifies the bookings it
 * used to catch, and thus the EÜR of an already-submitted year. Treat the config block like
 * `adjustments`: append, do not prune.
 */

import type { UnifiedTransaction } from '@steuererklaerung/store';
import type { EuerKind } from './euer-aggregate.ts';

/**
 * How a transaction got its category. `manual` = a persisted owner override (from the store's
 * `classifications` table) — it wins over both the linked document and the rule chain (S2).
 */
export type ClassSource = 'document' | 'rule' | 'unclassified' | 'manual';

/**
 * Where a matched rule comes from: compiled into the chain (`eingebaut`), the user's own
 * `elster.klassifizierung` (`eigene`), a linked receipt, an owner decision, a confirmed double payment,
 * a refund linked to the debit it refunds (`erstattung`, Idee 9), or a split into parts (`aufteilung`,
 * Idee 13).
 */
export type RegelArt = 'eingebaut' | 'eigene' | 'beleg' | 'manuell' | 'doppelzahlung' | 'erstattung' | 'aufteilung';

/**
 * WHICH rule classified a booking — not just the category it produced. `id` is stable across runs
 * (a built-in rule's name, a user rule's list + needle), so a confirmation or a test can refer to it;
 * `label` is what a person reads after „via Regel".
 */
export interface MatchedRule {
    id: string;
    label: string;
    art: RegelArt;
    /**
     * An Auffangregel: a generic catch-all that guesses from the bank's own category tag (Qonto writes
     * „Verkaufserlöse", „Reisekosten" … into the purpose), not from who the counterparty is. A booking
     * that ONLY hit one of these is worth a look — it lands in „Zu prüfen". Set explicitly per rule,
     * never derived from its name.
     */
    auffang?: boolean;
}

export interface TxClassification {
    category: string;
    kind: EuerKind;
    source: ClassSource;
    /** Short human label of which rule/keyword matched — for the review/detail view. */
    rule?: string;
    /** The rule that matched, with a stable id and the catch-all flag; absent when unclassified. */
    matchedRule?: MatchedRule;
}

/** One configured supplier→category rule (`elster.klassifizierung.aufwand_regeln`). */
export interface TxClassifyRule {
    /** Case-insensitive substring of the booking text. */
    muster: string;
    /** Target SKR03 category, exactly as the EÜR spells it. */
    kategorie: string;
    /** Transaction ids the rule must NOT classify — the bookings deselected when it was created. */
    ausnahmen?: string[];
}

/** Stable id of a user supplier rule — its pattern, lowercased, so reordering the list keeps it. */
export function eigeneRegelId(muster: string): string {
    return `eigene:aufwand_regeln:${muster.trim().toLowerCase()}`;
}

/**
 * The user's own counterparty knowledge, mapped from `elster.klassifizierung`. Every list is
 * optional; an omitted list simply contributes no matches. All entries are matched
 * case-insensitively as substrings of `counterparty + purpose + reference + type`.
 */
export interface TxClassifyRules {
    /** Own accounts / former firm names → internal transfer (1360). */
    eigeneKonten?: string[];
    /** Merchants confirmed as private consumption → Privatentnahme/-einlage. */
    privatGegenseiten?: string[];
    /** Owner/Gesellschafter counterparty names → capital movement when no invoice number is present. */
    gesellschafterGegenseiten?: string[];
    /** Extra identifiers of a partner's KSK membership (e.g. the membership number). */
    kskKennungen?: string[];
    /** Customer names that mark an incoming payment as revenue (8400). */
    erloesGegenseiten?: string[];
    /** Supplier→category rules, checked BEFORE the built-in keyword table. */
    aufwandRegeln?: TxClassifyRule[];
}

const NO_RULES: TxClassifyRules = {};

/** The classification input: counterparty + purpose + reference + type, lowercased. */
function hay(t: UnifiedTransaction): string {
    return `${t.counterparty ?? ''} ${t.purpose ?? ''} ${t.reference ?? ''} ${t.type ?? ''}`.toLowerCase();
}

/** The first configured needle that appears in the (already lowercased) booking text, or null. */
function firstMatch(h: string, needles: string[] | undefined): string | null {
    for (const n of needles ?? []) {
        const needle = n.trim().toLowerCase();
        if (needle.length > 0 && h.includes(needle)) return n.trim();
    }
    return null;
}

/** A built-in rule of the chain. */
function eingebaut(id: string, label: string, auffang = false): MatchedRule {
    return auffang
        ? { id: `eingebaut:${id}`, label, art: 'eingebaut', auffang }
        : { id: `eingebaut:${id}`, label, art: 'eingebaut' };
}

/** A needle from one of the user's lists in `elster.klassifizierung`. */
function eigene(list: string, needle: string): MatchedRule {
    return { id: `eigene:${list}:${needle.toLowerCase()}`, label: `„${needle}“ (${list})`, art: 'eigene' };
}

/**
 * Classify a transaction that has **no** linked document, by counterparty /
 * purpose patterns. Neutral categories (internal/private/tax) are excluded from
 * the profit; bank fees are a deductible expense.
 *
 * `rules` carries the user's own counterparty needles (see {@link TxClassifyRules}); omitting it
 * runs the generic chain only.
 */
export function classifyNoDocTransaction(t: UnifiedTransaction, rules: TxClassifyRules = NO_RULES): TxClassification {
    const h = hay(t);
    const has = (...needles: string[]) => needles.some((n) => h.includes(n));

    // Internal transfers / neutral cash movements (GuV-neutral). The generic vocabulary is
    // universal; WHICH counterparty is one of the user's own accounts is not — that comes from
    // `eigene_konten` (a bank often prints a name the manifest no longer carries, e.g. a former
    // firm name or another bank's sub-account label).
    const transferBuiltin =
        has(
            'interne ueberweisung',
            'interne überweisung',
            'umbuchung',
            'eigenübertrag',
            'eigenuebertrag',
            'uebertrag',
            'übertrag',
            'restguthaben',
            'aufladung',
            'rueckueberweisung',
            'rücküberweisung',
        ) || /\bhauptkonto\b/.test(h);
    const eigenesKonto = transferBuiltin ? null : firstMatch(h, rules.eigeneKonten);
    if (transferBuiltin || eigenesKonto) {
        const rule = 'interne Überweisung / Umbuchung';
        return {
            category: '1360 Interne Überweisung',
            kind: 'neutral',
            source: 'rule',
            rule,
            matchedRule: eigenesKonto ? eigene('eigene_konten', eigenesKonto) : eingebaut('interne-ueberweisung', rule),
        };
    }
    // Owner draws / contributions, securities, private purchases (GuV-neutral).
    // Direction-aware: in → Einlage, out → Entnahme.
    //
    // Compiled in: the German booking vocabulary and the securities terms — they mean the same
    // for everybody. NOT compiled in: which MERCHANT counts as private consumption. That is a
    // judgement about one household (a games shop is a business expense for a games studio), and
    // several of those merchants are only visible at all through the PayPal/Amazon enrichment —
    // so they live in `privat_gegenseiten`.
    const privatBuiltin = has(
        'privatentnahme',
        'privateinlage',
        'ausgleich verkaufserlöse',
        'rueckueberweisung verkaufserlöse',
        'rücküberweisung verkaufserlöse',
        'deckelung',
        'aktien',
        'wertpapier',
        'depot',
        'sparplan',
    );
    const privatNeedle = privatBuiltin ? null : firstMatch(h, rules.privatGegenseiten);
    if (privatBuiltin || privatNeedle) {
        const rule = 'privat (Entnahme/Einlage/Wertpapier/…)';
        const matchedRule = privatNeedle ? eigene('privat_gegenseiten', privatNeedle) : eingebaut('privat', rule);
        return t.amount > 0
            ? { category: '1810 Privateinlage', kind: 'neutral', source: 'rule', rule, matchedRule }
            : { category: '1800 Privatentnahme', kind: 'neutral', source: 'rule', rule, matchedRule };
    }
    // An owner's own transfer (counterparty is a Gesellschafter) with no invoice
    // number is a private capital movement — in → Einlage, out → Entnahme — even when
    // an instant-transfer reference carries a stray "Verkaufserlöse" label (e.g. money
    // round-tripped through the owner's private account). A genuinely forwarded
    // customer payment would carry an RE-number and falls through to the income rule.
    //
    // WHO the owners are is per-user data (`gesellschafter_gegenseiten`, typically the
    // `gesellschafter[].name` values); with none configured the rule cannot fire.
    const ownerNeedle = firstMatch((t.counterparty ?? '').toLowerCase(), rules.gesellschafterGegenseiten);
    const hasInvoiceNo = /\bre[\s.-]?\d{4,}|renr|rechnungsnr/.test(h);
    if (ownerNeedle && !hasInvoiceNo) {
        const rule = 'Eigenübertrag Gesellschafter (kein Beleg)';
        const matchedRule = eigene('gesellschafter_gegenseiten', ownerNeedle);
        return t.amount > 0
            ? { category: '1810 Privateinlage', kind: 'neutral', source: 'rule', rule, matchedRule }
            : { category: '1800 Privatentnahme', kind: 'neutral', source: 'rule', rule, matchedRule };
    }
    // Künstlersozialkasse: a KSK membership belongs to a PERSON, not to the firm — it is
    // that partner's own old-age/health provision (private Vorsorge / Sonderausgabe in their
    // ESt), not a partnership operating expense. So when the firm's account pays it, it is a
    // private draw of that partner → Privatentnahme (neutral), not 4380. The prior return
    // prepared by a Steuerberater booked no KSK in the EÜR either, which is the reference
    // this rule was validated against. (Genuine firm dues — IHK/Handelskammer — stay a 4380
    // expense; see EXPENSE_KEYWORDS.)
    //
    // Some banks print only the MEMBERSHIP NUMBER, never the KSK's name. That number identifies a
    // natural person and cannot live in source — configure it as a `ksk_kennungen` entry.
    const kskBuiltin = has('künstlersozial', 'kunstlersozial', 'kuenstlersozial');
    const kskNeedle = kskBuiltin ? null : firstMatch(h, rules.kskKennungen);
    if (kskBuiltin || kskNeedle) {
        const rule = 'KSK eines Gesellschafters (private Vorsorge, kein Betriebsaufwand)';
        const matchedRule = kskNeedle ? eigene('ksk_kennungen', kskNeedle) : eingebaut('ksk', rule);
        return t.amount > 0
            ? { category: '1810 Privateinlage', kind: 'neutral', source: 'rule', rule, matchedRule }
            : { category: '1800 Privatentnahme', kind: 'neutral', source: 'rule', rule, matchedRule };
    }
    // GNOME Foundation monthly donation (counterparty "GNOME.ORG* DONATION GN").
    // A voluntary gift to a US non-profit is NOT an operating expense and carries no
    // German Vorsteuer. Qonto mis-tags the card charge as
    // "Travel Expenses / Sonstige Reisekosten", which would otherwise land it in
    // 4670 Reisekosten (with 19% input VAT) via EXPENSE_KEYWORDS — so it must be
    // caught here first. A donation is an outgoing private draw → Privatentnahme
    // (GuV-neutral, no VAT), like the private items above.
    const counterparty = (t.counterparty ?? '').toLowerCase();
    if (/gnome/.test(counterparty) && (counterparty.includes('donation') || counterparty.includes('gnome.org'))) {
        return {
            category: '1800 Privatentnahme',
            kind: 'neutral',
            source: 'rule',
            rule: 'GNOME-Spende (privat, kein Betriebsaufwand)',
            matchedRule: eingebaut('gnome-spende', 'GNOME-Spende (privat, kein Betriebsaufwand)'),
        };
    }
    // Tax payments / refunds — USt is durchlaufend, Gewerbesteuer not deductible → neutral.
    if (
        has('finanzamt', 'landeshauptkasse', 'hauptzollamt', 'stadtkasse', 'umsatzsteuer', 'gewerbesteuer') ||
        /\bust\b/.test(h)
    ) {
        return {
            category: 'Steuer (neutral)',
            kind: 'neutral',
            source: 'rule',
            rule: 'Steuer (FA/USt/Gewerbe)',
            matchedRule: eingebaut('steuer', 'Steuer (FA/USt/Gewerbe)'),
        };
    }
    // Bank fees / account charges — deductible expense (4970).
    if (has('qonto', 'olinda', 'gebühr', 'gebuehr', 'entgelt', 'kontoführung', 'kontofuehrung', 'kartenpreis')) {
        return {
            category: '4970 Nebenkosten Geldverkehr',
            kind: 'expense',
            source: 'rule',
            rule: 'Bankgebühr (Qonto/Entgelt)',
            matchedRule: eingebaut('bankgebuehr', 'Bankgebühr (Qonto/Entgelt)'),
        };
    }
    // Incoming customer payment: the bank/Qonto tags revenue as "Verkaufserlöse"
    // (internal/private squaring like "Ausgleich/Rückueberweisung Verkaufserlöse"
    // was already caught above), or the purpose carries an invoice number. A customer who
    // does neither is only recognisable by NAME → `erloes_gegenseiten`. The Qonto
    // "Verkaufserlöse" tag also lands on SUPPLIER refunds/credit notes ("Gutschrift",
    // "Erstattung") — exclude those. The refund check is against the PURPOSE only: the booking
    // *type* of every incoming transfer is "Ueberweisungsgutschrift", which must NOT count as a
    // refund.
    const purposeText = `${t.counterparty ?? ''} ${t.purpose ?? ''} ${t.reference ?? ''}`.toLowerCase();
    const isSupplierRefund = ['einkauf', 'aliexpress', 'gutschrift', 'erstatt', 'rückerstatt', 'refund'].some((n) =>
        purposeText.includes(n),
    );
    if (t.amount > 0 && !isSupplierRefund) {
        // Same condition as before, split by WHAT matched: an invoice number or a named customer
        // identifies the payment; the bank's own „Verkaufserlöse" tag alone is only a guess — every
        // incoming credit may carry it — so that path is the Auffangregel.
        const kunde = firstMatch(h, rules.erloesGegenseiten);
        const reNr = /\bre[\s.-]?\d{4,}|renr|rechnungsnr/.test(h);
        const tag = has('verkaufserlöse', 'erlös');
        if (tag || kunde || reNr) {
            const rule = 'Einnahme (Verkaufserlöse/RE-Nr/Kunde)';
            return {
                category: '8400 Erlöse 19% USt',
                kind: 'income',
                source: 'rule',
                rule,
                matchedRule: reNr
                    ? eingebaut('einnahme-rechnungsnummer', 'Einnahme mit Rechnungsnummer')
                    : kunde
                      ? eigene('erloes_gegenseiten', kunde)
                      : eingebaut('einnahme-bankkennzeichen', 'Einnahme (Bank-Kennzeichen „Verkaufserlöse“)', true),
            };
        }
    }
    // Configured supplier→category rules first: a supplier's personal name, or the customer
    // number a telco prints instead of its own name. They must beat the generic keywords, because
    // the same booking often also carries a Qonto category tag that would mis-file it.
    for (const r of rules.aufwandRegeln ?? []) {
        const muster = r.muster.trim().toLowerCase();
        if (muster.length > 0 && h.includes(muster) && !r.ausnahmen?.includes(t.id)) {
            return {
                category: r.kategorie,
                kind: 'expense',
                source: 'rule',
                rule: `Regel „${r.muster}“`,
                matchedRule: { id: eigeneRegelId(r.muster), label: `„${r.muster.trim()}“`, art: 'eigene' },
            };
        }
    }
    // Expense category keywords — Qonto writes the category into the purpose
    // ("Technologiekosten Hosting-Dienstleistungen", "Betriebskosten Miete", …).
    for (const k of EXPENSE_KEYWORDS) {
        if (k.re.test(h)) {
            return {
                category: k.category,
                kind: 'expense',
                source: 'rule',
                rule: `Keyword /${k.re.source}/`,
                matchedRule: eingebaut(`stichwort:${k.id}`, `Stichwort ${k.id}`, k.auffang),
            };
        }
    }
    // Unknown — the real gap. Kind defaults by direction.
    return { category: '(unklassifiziert)', kind: t.amount > 0 ? 'income' : 'expense', source: 'unclassified' };
}

/**
 * Purpose-keyword → SKR03 expense category (first match wins). Generic only: every entry here
 * must map to the same category for any business. A supplier that is only recognisable by a
 * person's name or by a customer number belongs in `elster.klassifizierung.aufwand_regeln`.
 */
interface ExpenseKeyword {
    /** Stable name — the rule id is `eingebaut:stichwort:<id>`. */
    id: string;
    re: RegExp;
    category: string;
    /**
     * True for the generic category words a bank writes into the purpose (Qonto: „Reisekosten",
     * „Marketing", …) — a guess about the booking, not knowledge about the counterparty. A merchant
     * name (`telekom`, `inwx`) is not an Auffangregel.
     */
    auffang?: boolean;
}

const EXPENSE_KEYWORDS: ExpenseKeyword[] = [
    { id: 'steuerberater', re: /steuerberat/, category: '4950 Rechts-/Beratungskosten' },
    { id: 'telefonanbieter', re: /1\s*\+\s*1|1und1|1\s*und\s*1|telekom|vodafone/, category: '4921 Telefon/Internet' },
    // Genuine firm dues only. KSK is handled earlier as a partner's private Vorsorge →
    // Privatentnahme, so it is intentionally NOT here.
    { id: 'ihk', re: /\bihk\b|handelskammer/, category: '4380 Beiträge/Künstlersozialkasse' },
    // Merchants resolved via the PayPal import (the bank purpose alone is opaque);
    // checked before the broad /lizenz/ rule so they win over the Qonto category tag.
    { id: 'cloud-anbieter', re: /digitalocean|serverpilot/, category: '4806 Hosting/Cloud' },
    // AI dev tools (some arrive under a merchant e-mail, not a brand name)
    { id: 'ki-werkzeuge', re: /deepseek|cursor|openai|chatgpt/, category: '4964 Software/Lizenzen' },
    // Lastenrad spare part (business vehicle)
    { id: 'kugellager', re: /kugellager/, category: '4650 Sonstige Betriebsausgaben' },
    // Amazon item categories (folded into the store by `transactions enrich-amazon`) — business gear.
    // PC peripherals, scanner, business-phone case
    { id: 'computer-zubehoer', re: /computer & zubehör|oneplus/, category: '4930 Bürobedarf', auffang: true },
    { id: 'hosting', re: /hosting/, category: '4806 Hosting/Cloud', auffang: true },
    { id: 'lizenz', re: /software.?lizenz|lizenz/, category: '4964 Software/Lizenzen', auffang: true },
    { id: 'domain', re: /\bdomain|\binwx\b/, category: '4955 Domains' },
    { id: 'druckerei', re: /flyeralarm|druckerei|\bflyer\b|visitenkarte/, category: '4600 Werbe-/Marketingkosten' },
    { id: 'notebook-pro', re: /notebook-pro|notebookpro/, category: '0420 Büroeinrichtung/GWG' },
    {
        id: 'telefon',
        re: /telekommunikation|telefon|\binternet\b/,
        category: '4921 Telefon/Internet',
        auffang: true,
    },
    { id: 'buerobedarf', re: /bürobedarf|buerobedarf|\bporto\b/, category: '4930 Bürobedarf', auffang: true },
    { id: 'miete', re: /\bmiete\b|raumkosten/, category: '4210 Miete/Raumkosten', auffang: true },
    {
        id: 'energie',
        re: /strom|\bgas\b|\bwasser\b|nebenkosten.*(strom|energie)/,
        category: '4240 Gas/Strom/Wasser',
        auffang: true,
    },
    { id: 'marketing', re: /marketing|werbung|werbe/, category: '4600 Werbe-/Marketingkosten', auffang: true },
    { id: 'versicherung', re: /versicherung/, category: '4360 Versicherungen', auffang: true },
    { id: 'reise', re: /reisekosten|\breise\b|bahn|hotel|übernachtung/, category: '4670 Reisekosten', auffang: true },
    { id: 'bewirtung', re: /bewirtung/, category: '4654 Bewirtungskosten', auffang: true },
    {
        id: 'fortbildung',
        re: /fortbildung|seminar|fachliteratur|fachbuch/,
        category: '4940 Fortbildung/Fachliteratur',
        auffang: true,
    },
    { id: 'fremdleistung', re: /fremdleistung/, category: '4946 Fremdleistungen', auffang: true },
    // NOTE: no rule on the trailing card number a bank writes into every card booking.
    // It appears on EVERY such booking (incl. Verkaufserlöse, Personalkosten, Marketing),
    // so it identifies the CARD, not a creditor. A bare "NONREF <card-no>" charge therefore
    // stays unclassified (unknown merchant) instead of being guessed as hosting; real
    // hosting is caught by the /hosting/ keyword above.
];

/** VAT-exempt SKR03 categories (rent, insurance, dues, payroll, bank fees). */
const VAT_EXEMPT = new Set([
    '4210 Miete/Raumkosten',
    '4360 Versicherungen',
    '4380 Beiträge/Künstlersozialkasse',
    '4970 Nebenkosten Geldverkehr',
    '4240 Gas/Strom/Wasser',
    '4100 Personalkosten (Löhne/Gehälter)',
    '4138 Soziale Abgaben',
    '4830 Abschreibungen (AfA)', // non-cash, no input VAT
]);

/**
 * Implied VAT rate (fraction) for a rule-classified transaction with no document:
 * 0 for neutral/VAT-exempt, 7% for the reduced categories, else 19%.
 */
export function impliedRate(category: string, kind: EuerKind): number {
    if (kind === 'neutral') return 0;
    if (category.startsWith('8300') || category.startsWith('8125') || category.startsWith('8336')) {
        return category.startsWith('8300') ? 0.07 : 0;
    }
    if (VAT_EXEMPT.has(category)) return 0;
    return 0.19;
}
