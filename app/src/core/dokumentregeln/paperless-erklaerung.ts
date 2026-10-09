/**
 * Which Paperless rule assigned a value — as far as anyone can tell (Idee 11).
 *
 * Paperless sorts documents by its own matching: a correspondent, document type or tag carries a
 * `match` text and a `matching_algorithm`, and on consumption Paperless assigns every one whose rule
 * hits the document's text. This app does not add a second rule engine there; it only SHOWS which
 * rule applied.
 *
 * What Paperless does NOT do is record which rule assigned a value: the document carries
 * `correspondent`, `document_type` and `tags` and nothing about where they came from (checked
 * against the API and `documents/matching.py`; the audit log names a user, not a rule). So the
 * explanation is a reconstruction: take the value the document has today, re-run THAT correspondent's /
 * type's / tag's rule against the document's text, and say what came out. A hit is „vermutlich" —
 * the same value could have been set by hand or by an earlier version of the rule.
 *
 * The matching mirrors `matching.py` for the algorithms that can be recomputed from the text alone
 * (any, all, literal, regex): content only, whole words, optional case-insensitivity. `fuzzy` and
 * `auto` are not recomputable here (a fuzzy ratio, a trained classifier) and are reported as such,
 * never guessed.
 *
 * Pure: the document and the catalogue come in, sentences go out.
 */

/** Paperless `matching_algorithm` values (MatchingModel.MATCH_*). */
export const PAPERLESS_ALGORITHM = {
    none: 0,
    any: 1,
    all: 2,
    literal: 3,
    regex: 4,
    fuzzy: 5,
    auto: 6,
} as const;

const ALGORITHM_LABEL: Record<number, string> = {
    0: 'keine automatische Zuordnung',
    1: 'enthält eines der Wörter',
    2: 'enthält alle Wörter',
    3: 'enthält genau diesen Text',
    4: 'regulärer Ausdruck',
    5: 'unscharf',
    6: 'automatisch (gelernt)',
};

/** Correspondent, document type or tag as `/api/…/` returns it — only what matching needs. */
export interface PaperlessMatchObjekt {
    id: number;
    name: string;
    match?: string | null;
    matching_algorithm?: number | null;
    is_insensitive?: boolean | null;
}

/** The document fields the explanation reads. */
export interface PaperlessZuordnungDokument {
    correspondent: number | null;
    document_type: number | null;
    tags: number[];
    content: string | null;
}

export interface PaperlessKatalog {
    correspondents: readonly PaperlessMatchObjekt[];
    documentTypes: readonly PaperlessMatchObjekt[];
    tags: readonly PaperlessMatchObjekt[];
}

export type ZuordnungArt = 'Korrespondent' | 'Dokumenttyp' | 'Schlagwort';

/**
 * - `vermutlich`: the object's rule hits the document's text — the likely reason it is assigned.
 * - `trifft-nicht`: the rule does NOT hit the text; the value came from somewhere else (hand, AI, a
 *   workflow, an older rule).
 * - `automatisch`: the object uses Paperless' learned classifier; not recomputable.
 * - `nicht-pruefbar`: fuzzy, an unreadable pattern, or no text to check against.
 * - `ohne-regel`: the object has no rule (algorithm „keine"), so it was set by hand or by something else.
 */
export type ZuordnungErgebnis = 'vermutlich' | 'trifft-nicht' | 'automatisch' | 'nicht-pruefbar' | 'ohne-regel';

export interface PaperlessZuordnung {
    art: ZuordnungArt;
    id: number;
    name: string;
    algorithmus: number;
    algorithmusText: string;
    muster: string | null;
    ergebnis: ZuordnungErgebnis;
    /** One German sentence for a person. */
    satz: string;
}

/** Text of a quoted-or-bare word list, like Paperless' `_split_match`. */
function woerter(match: string): string[] {
    const out: string[] = [];
    const re = /"([^"]+)"|(\S+)/g;
    for (let m = re.exec(match); m; m = re.exec(match)) out.push((m[1] ?? m[2]).trim().replace(/\s+/g, ' '));
    return out.filter(Boolean);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word search: Python's `\b` is Unicode-aware, JavaScript's is not, so spell the boundary out. */
function ganzesWort(text: string, wort: string, insensitive: boolean): boolean {
    const body = escapeRegExp(wort).replace(/ /g, '\\s+');
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, insensitive ? 'iu' : 'u');
    return re.test(text);
}

/**
 * Whether Paperless' rule would hit this text. `null` = cannot be recomputed (fuzzy, auto, a pattern
 * that is not a valid expression).
 */
export function paperlessRegelTrifft(obj: PaperlessMatchObjekt, text: string): boolean | null {
    const algo = obj.matching_algorithm ?? PAPERLESS_ALGORITHM.none;
    const match = (obj.match ?? '').trim();
    const insensitive = obj.is_insensitive !== false;
    if (algo === PAPERLESS_ALGORITHM.none || !match) return false;
    try {
        switch (algo) {
            case PAPERLESS_ALGORITHM.all:
                return woerter(match).every((w) => ganzesWort(text, w, insensitive));
            case PAPERLESS_ALGORITHM.any:
                return woerter(match).some((w) => ganzesWort(text, w, insensitive));
            case PAPERLESS_ALGORITHM.literal:
                return ganzesWort(text, match, insensitive);
            case PAPERLESS_ALGORITHM.regex:
                return new RegExp(match, insensitive ? 'iu' : 'u').test(text);
            default:
                return null;
        }
    } catch {
        return null;
    }
}

function erklaere(art: ZuordnungArt, obj: PaperlessMatchObjekt, text: string | null): PaperlessZuordnung {
    const algorithmus = obj.matching_algorithm ?? PAPERLESS_ALGORITHM.none;
    const muster = (obj.match ?? '').trim() || null;
    const base = {
        art,
        id: obj.id,
        name: obj.name,
        algorithmus,
        algorithmusText: ALGORITHM_LABEL[algorithmus] ?? `Verfahren ${algorithmus}`,
        muster,
    };
    const was = `${art} ${obj.name}`;
    if (algorithmus === PAPERLESS_ALGORITHM.none || (algorithmus !== PAPERLESS_ALGORITHM.auto && !muster)) {
        return {
            ...base,
            ergebnis: 'ohne-regel',
            satz: `${was}: Paperless hat dafür keine Regel — von Hand oder durch einen Ablauf gesetzt.`,
        };
    }
    if (algorithmus === PAPERLESS_ALGORITHM.auto) {
        return {
            ...base,
            ergebnis: 'automatisch',
            satz: `${was}: Paperless ordnet automatisch zu (lernt aus Ihren Belegen) — ob es hier gegriffen hat, lässt sich nicht nachrechnen.`,
        };
    }
    const treffer = text == null || text.trim() === '' ? null : paperlessRegelTrifft(obj, text);
    if (treffer === null) {
        return {
            ...base,
            ergebnis: 'nicht-pruefbar',
            satz: `${was} (Muster „${muster}“, ${base.algorithmusText}): nicht nachprüfbar — ${text == null || text.trim() === '' ? 'Paperless liefert keinen Text zum Beleg' : 'dieses Verfahren lässt sich nicht aus dem Text nachrechnen'}.`,
        };
    }
    if (treffer) {
        return {
            ...base,
            ergebnis: 'vermutlich',
            satz: `Zugeordnet durch Paperless-Regel: ${was} (Muster „${muster}“, ${base.algorithmusText}) — vermutlich, denn Paperless merkt sich nicht, welche Regel gegriffen hat.`,
        };
    }
    return {
        ...base,
        ergebnis: 'trifft-nicht',
        satz: `${was}: die Regel (Muster „${muster}“, ${base.algorithmusText}) trifft den Text nicht — der Wert kam von Hand oder aus einem anderen Ablauf.`,
    };
}

/**
 * The explanation for one document: one entry for its correspondent, its document type and each tag
 * it carries. A value Paperless no longer lists (a deleted tag) is skipped.
 */
export function erklaereZuordnung(doc: PaperlessZuordnungDokument, katalog: PaperlessKatalog): PaperlessZuordnung[] {
    const out: PaperlessZuordnung[] = [];
    const korr = katalog.correspondents.find((c) => c.id === doc.correspondent);
    if (korr) out.push(erklaere('Korrespondent', korr, doc.content));
    const typ = katalog.documentTypes.find((t) => t.id === doc.document_type);
    if (typ) out.push(erklaere('Dokumenttyp', typ, doc.content));
    for (const id of doc.tags) {
        const tag = katalog.tags.find((t) => t.id === id);
        if (tag) out.push(erklaere('Schlagwort', tag, doc.content));
    }
    return out;
}

/** The headline for a surface: the first line a person should read. */
export function zuordnungKopf(eintraege: readonly PaperlessZuordnung[]): string {
    const vermutet = eintraege.filter((e) => e.ergebnis === 'vermutlich');
    if (vermutet.length > 0) {
        return `Zugeordnet durch Paperless-Regel (vermutlich): ${vermutet.map((e) => `${e.art} ${e.name}`).join(', ')}`;
    }
    if (eintraege.length === 0)
        return 'Paperless hat diesem Beleg keinen Korrespondenten, Dokumenttyp oder Schlagwort gegeben.';
    return 'Keine Paperless-Regel als Ursache erkennbar — die Werte stammen von Hand, aus der KI oder einem Ablauf.';
}
