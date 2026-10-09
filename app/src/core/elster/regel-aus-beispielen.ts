/**
 * Regel aus Beispielen (Idee 6): mark a few bookings, get the pattern they share, and see — before
 * anything is saved — every existing booking that pattern would classify.
 *
 * The rule model is the existing one (`elster.klassifizierung.aufwand_regeln`: a case-insensitive
 * substring of counterparty + purpose + reference + type → a category), extended by `ausnahmen`: the
 * transaction ids a person deselected in the preview. Tightening the pattern instead would have to
 * guess a substring that excludes exactly those bookings, which often does not exist (same supplier,
 * different purpose) — an explicit list says what was decided.
 *
 * The hits are computed by running the real rule chain with the new rule appended, exactly where
 * `rememberRule` puts it: a booking an earlier rule already catches is NOT a hit, and is reported as
 * such, instead of a preview that promises more than the chain will do. Receipts and manual
 * decisions win over every rule, so those bookings are never hits either.
 *
 * Pure: bookings and rules come in, nothing is read or written.
 */

import type { UnifiedTransaction } from '@steuererklaerung/store';
import {
    classifyNoDocTransaction,
    eigeneRegelId,
    type ClassSource,
    type MatchedRule,
    type TxClassifyRule,
    type TxClassifyRules,
} from './euer-classify.ts';

/**
 * The pattern a booking suggests for itself.
 *
 * The counterparty when there is one — it is the stable half of a bank booking, where the purpose
 * carries invoice numbers and dates that would make the rule match exactly one payment and never
 * the next. Falls back to the longest word of the purpose, which is the closest thing to a name
 * when the bank printed none.
 */
export function suggestPattern(booking: { counterparty?: string | null; purpose?: string | null }): string {
    const counterparty = (booking.counterparty ?? '').trim();
    if (counterparty) return counterparty;
    return purposeWords(booking.purpose).sort((a, b) => b.length - a.length)[0] ?? '';
}

/** Words of a purpose that could name a supplier: ≥ 4 characters and not mostly digits. */
function purposeWords(purpose: string | null | undefined): string[] {
    return (
        (purpose ?? '')
            .split(/[\s,;/]+/)
            .map((w) => w.trim())
            // Drop anything that is mostly digits: an invoice or customer number matches one booking.
            .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && (w.match(/\d/g)?.length ?? 0) * 2 < w.length)
    );
}

/** Shortest pattern worth proposing — shorter needles match half the bank statement. */
const MIN_MUSTER = 4;

/** Longest substring all strings share (case-insensitive), in the spelling of the first one. */
function longestCommonSubstring(texts: readonly string[]): string {
    if (texts.length === 0) return '';
    const lower = texts.map((t) => t.toLowerCase());
    const [first, ...rest] = lower;
    for (let len = first.length; len >= MIN_MUSTER; len--) {
        for (let start = 0; start + len <= first.length; start++) {
            const candidate = first.slice(start, start + len);
            if (candidate.trim() !== candidate) continue; // no leading/trailing blank
            if (rest.every((t) => t.includes(candidate))) return texts[0].slice(start, start + len);
        }
    }
    return '';
}

/** A booking as the pattern and hit search see it. */
export interface RegelBuchung {
    id: string;
    bookingDate: string;
    amount: number;
    counterparty?: string;
    purpose?: string;
    reference?: string;
    type?: string;
    /** How the booking is classified NOW. */
    source: ClassSource;
    category: string;
    matchedRule?: MatchedRule;
}

/**
 * The pattern several bookings share: their common suggested pattern when they agree, else the
 * longest text their counterparties share, else a purpose word they all carry. Empty when they
 * share nothing worth a rule — then the person types one.
 */
export function musterAusBeispielen(beispiele: readonly RegelBuchung[]): string {
    if (beispiele.length === 0) return '';
    const own = beispiele.map((b) => suggestPattern(b));
    if (own[0] && own.every((p) => p.toLowerCase() === own[0].toLowerCase())) return own[0];

    const counterparties = beispiele.map((b) => (b.counterparty ?? '').trim());
    if (counterparties.every((c) => c.length > 0)) {
        const common = longestCommonSubstring(counterparties).trim();
        if (common.length >= MIN_MUSTER) return common;
    }
    const words = purposeWords(beispiele[0].purpose);
    const shared = words.filter((w) =>
        beispiele.every((b) => `${b.counterparty ?? ''} ${b.purpose ?? ''}`.toLowerCase().includes(w.toLowerCase())),
    );
    return shared.sort((a, b) => b.length - a.length)[0] ?? '';
}

/** The category the examples suggest: the most frequent classified one, else none. */
export function kategorieAusBeispielen(beispiele: readonly RegelBuchung[]): string {
    const counts = new Map<string, number>();
    for (const b of beispiele) {
        if (b.source === 'unclassified' || !b.category || b.category === '(unklassifiziert)') continue;
        counts.set(b.category, (counts.get(b.category) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/** Why an example is not hit by the new rule. */
export interface NichtErfasst {
    id: string;
    warum: string;
}

export interface RegelVorschau {
    muster: string;
    kategorie: string;
    /** Every existing booking the rule would classify, examples included. */
    treffer: RegelBuchung[];
    /** Examples the rule would NOT classify, with the reason. */
    nichtErfasst: NichtErfasst[];
}

function asTransaction(b: RegelBuchung): UnifiedTransaction {
    return {
        id: b.id,
        source: 'camt',
        accountKey: '',
        bookingDate: b.bookingDate,
        amount: b.amount,
        currency: 'EUR',
        counterparty: b.counterparty,
        purpose: b.purpose,
        reference: b.reference,
        type: b.type,
    };
}

/** Bookings a rule can reach at all: no receipt, no manual decision, no double payment. */
function regelFaehig(b: RegelBuchung): boolean {
    if (b.source !== 'rule' && b.source !== 'unclassified') return false;
    return b.matchedRule?.art !== 'doppelzahlung';
}

/**
 * Every booking the rule `muster → kategorie` would classify, given the entity's current rules and
 * the transaction ids to leave out (`ausnahmen`). Runs the real chain with the rule appended.
 */
export function regelTreffer(
    muster: string,
    kategorie: string,
    buchungen: readonly RegelBuchung[],
    rules: TxClassifyRules = {},
    ausnahmen: readonly string[] = [],
): RegelBuchung[] {
    const needle = muster.trim();
    if (needle.length === 0) return [];
    const neu: TxClassifyRule = { muster: needle, kategorie, ausnahmen: [...ausnahmen] };
    const id = eigeneRegelId(needle);
    // An existing rule with the same pattern comes first in the list and would win — the new one only
    // adds what is not already caught, so the preview must not count those as its hits.
    const withRule: TxClassifyRules = { ...rules, aufwandRegeln: [...(rules.aufwandRegeln ?? []), neu] };
    const before = new Set(buchungen.filter((b) => regelFaehig(b) && b.matchedRule?.id === id).map((b) => b.id));
    return buchungen.filter((b) => {
        if (!regelFaehig(b) || before.has(b.id)) return false;
        const cls = classifyNoDocTransaction(asTransaction(b), withRule);
        return cls.matchedRule?.id === id && cls.category === kategorie;
    });
}

/**
 * Pattern + category from the examples (or the ones the person typed) and the bookings it would hit.
 * Examples that are not hit are listed with the reason, so nothing silently falls out of the rule.
 */
export function regelAusBeispielen(
    beispiele: readonly RegelBuchung[],
    buchungen: readonly RegelBuchung[],
    rules: TxClassifyRules = {},
    opts: { muster?: string; kategorie?: string; ausnahmen?: readonly string[] } = {},
): RegelVorschau {
    const muster = (opts.muster ?? musterAusBeispielen(beispiele)).trim();
    const kategorie = (opts.kategorie ?? kategorieAusBeispielen(beispiele)).trim();
    const treffer = muster && kategorie ? regelTreffer(muster, kategorie, buchungen, rules) : [];
    const hit = new Set(treffer.map((t) => t.id));
    const ausnahmen = new Set(opts.ausnahmen ?? []);
    const nichtErfasst: NichtErfasst[] = [];
    for (const b of beispiele) {
        if (hit.has(b.id) || ausnahmen.has(b.id)) continue;
        let warum: string;
        if (!muster) warum = 'kein gemeinsames Muster';
        else if (!kategorie) warum = 'keine Kategorie gewählt';
        else if (b.source === 'document') warum = 'über einen Beleg zugeordnet — der Beleg gewinnt';
        else if (b.source === 'manual') warum = 'manuell gebucht — die eigene Umbuchung gewinnt';
        else if (b.matchedRule?.art === 'doppelzahlung') warum = 'als Doppelzahlung eingetragen';
        else if (
            !`${b.counterparty ?? ''} ${b.purpose ?? ''} ${b.reference ?? ''} ${b.type ?? ''}`
                .toLowerCase()
                .includes(muster.toLowerCase())
        )
            warum = `enthält „${muster}“ nicht`;
        else warum = `eine frühere Regel greift zuerst${b.matchedRule ? `: ${b.matchedRule.label}` : ''}`;
        nichtErfasst.push({ id: b.id, warum });
    }
    return { muster, kategorie, treffer, nichtErfasst };
}
