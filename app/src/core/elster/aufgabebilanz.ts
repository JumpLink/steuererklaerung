/**
 * Aufgabebilanz + Übergangsgewinn — the balance sheet at the Betriebsaufgabe and the profit from
 * switching the Gewinnermittlung from §4 Abs. 3 to §4 Abs. 1 EStG.
 *
 * A business that gives up while on the EÜR is treated as if it had switched to Bestandsvergleich
 * at the Aufgabe date (R 4.5 Abs. 6 EStR): the Aufgabegewinn must rest on a Bilanz, and every
 * receivable or liability still open at that date is settled into a Übergangsgewinn instead of
 * flowing later as a §24 nachträgliche Einnahme/Ausgabe. The Übergangsgewinn is laufender Gewinn
 * of the last year (not part of the §16 Aufgabegewinn, not §34-privileged). Corrections per
 * Anlage zu R 4.6 EStR: + Forderungen, − Verbindlichkeiten, − Rückstellungen.
 *
 * The app books a post-Aufgabe payment on a pre-Aufgabe invoice as §24 in the year the money flows.
 * Presenting the same flows as Übergangsgewinn moves no euro when they all fall in the final year —
 * this module makes that reconciliation explicit ({@link AufgabebilanzResult.ueberleitung}).
 *
 * The profit stays NET of USt (the app computes the EÜR net); the USt in a receivable and the
 * Vorsteuer in a liability appear in the Bilanz but not in the Übergangsgewinn. Sources:
 * docs/references/tax-sources.md § "Betriebsaufgabe — Aufgabebilanz und Übergangsgewinn".
 */

import { round2 } from '../lib/money.ts';

/** How a post-Aufgabe flow enters the Aufgabebilanz. */
export type AufgabePostenAls = 'forderung' | 'verbindlichkeit' | 'rueckstellung' | 'nachtraeglich';

/** A §24 flow after the Aufgabe date (a bank row or a configured nachträglicher Posten). */
export interface AufgabePostenInput {
    /** Transaction id or a stable label of the configured posten. */
    ref: string;
    /** When the money flowed (YYYY-MM-DD). */
    datum: string;
    bezeichnung: string;
    /** Net amount, positive. */
    netto: number;
    /** USt / Vorsteuer in it, positive. */
    ust: number;
    art: 'einnahme' | 'ausgabe';
    /** When the claim/obligation arose; after the Aufgabe date ⇒ stays nachträglich (§24). */
    entstanden?: string;
    /** Explicit classification; wins over the default by `art` / `entstanden`. */
    als?: AufgabePostenAls;
}

export interface AufgabeAnlage {
    id: string;
    bezeichnung: string;
    restbuchwert: number;
}

/** A tax balance carried in the Bilanz (USt-Verbindlichkeit, GewSt-Erstattungsanspruch, …). */
export interface AufgabeSteuerposten {
    bezeichnung: string;
    betrag: number;
    seite: 'aktiv' | 'passiv';
}

export interface AufgabebilanzInput {
    /** Aufgabe date (YYYY-MM-DD). */
    datum: string;
    anlagen: AufgabeAnlage[];
    bank: Array<{ konto: string; saldo: number }>;
    kasse?: number;
    posten: AufgabePostenInput[];
    steuerposten?: AufgabeSteuerposten[];
    /** The laufender Gewinn of the final year as the EÜR computes it (incl. the §24 flows). */
    laufenderGewinn: number;
    /** The net §24 result inside {@link laufenderGewinn} — cross-checks that `posten` is complete. */
    nachtraeglichNet: number;
}

export interface AufgabeBilanzPosten {
    ref: string;
    datum: string;
    bezeichnung: string;
    art: 'einnahme' | 'ausgabe';
    als: AufgabePostenAls;
    netto: number;
    ust: number;
    brutto: number;
}

export interface AufgabeBilanzZeile {
    bezeichnung: string;
    betrag: number;
}

export interface AufgabebilanzResult {
    datum: string;
    aktiva: AufgabeBilanzZeile[];
    passiva: AufgabeBilanzZeile[];
    summeAktiva: number;
    /** Sum of the Passiva rows as listed, Eigenkapital included. */
    summePassiva: number;
    /** Balancing figure: Aktiva − Fremdkapital (negative = negatives Kapital). */
    eigenkapital: number;
    forderungen: AufgabeBilanzPosten[];
    verbindlichkeiten: AufgabeBilanzPosten[];
    rueckstellungen: AufgabeBilanzPosten[];
    /** Flows that stay §24 nachträglich (arose after the Aufgabe). */
    nachtraeglich: AufgabeBilanzPosten[];
    /** Anlage zu R 4.6 EStR: + Forderungen − Verbindlichkeiten − Rückstellungen (all net). */
    uebergangsgewinn: {
        forderungen: number;
        verbindlichkeiten: number;
        rueckstellungen: number;
        summe: number;
    };
    ueberleitung: {
        /** The EÜR result for the active period up to the Aufgabe date (without any §24 flow). */
        euerBisAufgabe: number;
        uebergangsgewinn: number;
        /** Signed net of the flows that stay §24. */
        nachtraeglichNet: number;
        /** euerBisAufgabe + uebergangsgewinn + nachtraeglichNet. */
        laufenderGewinn: number;
        /** The EÜR's laufender Gewinn as computed (= filed, if unchanged since). */
        laufenderGewinnLautEuer: number;
        /** Σ signed net of `posten` − the EÜR's §24 net; non-zero ⇒ a §24 flow is missing. */
        abweichung: number;
    };
}

function classify(p: AufgabePostenInput, datum: string): AufgabePostenAls {
    if (p.als) return p.als;
    if (p.entstanden && p.entstanden > datum) return 'nachtraeglich';
    return p.art === 'einnahme' ? 'forderung' : 'verbindlichkeit';
}

const sum = (xs: number[]): number => round2(xs.reduce((s, x) => s + x, 0));

/** Build the Aufgabebilanz, the Übergangsgewinn and its reconciliation to the EÜR's laufender Gewinn. */
export function computeAufgabebilanz(input: AufgabebilanzInput): AufgabebilanzResult {
    const posten: AufgabeBilanzPosten[] = input.posten.map((p) => {
        const als = classify(p, input.datum);
        if (p.art === 'einnahme' && (als === 'verbindlichkeit' || als === 'rueckstellung')) {
            throw new Error(`Posten ${p.ref}: eine Einnahme kann keine ${als} sein`);
        }
        if (p.art === 'ausgabe' && als === 'forderung') {
            throw new Error(`Posten ${p.ref}: eine Ausgabe kann keine Forderung sein`);
        }
        const netto = round2(p.netto);
        const ust = round2(p.ust);
        return {
            ref: p.ref,
            datum: p.datum,
            bezeichnung: p.bezeichnung,
            art: p.art,
            als,
            netto,
            ust,
            brutto: round2(netto + ust),
        };
    });
    const by = (als: AufgabePostenAls) => posten.filter((p) => p.als === als);
    const forderungen = by('forderung');
    const verbindlichkeiten = by('verbindlichkeit');
    const rueckstellungen = by('rueckstellung');
    const nachtraeglich = by('nachtraeglich');

    const aktiva: AufgabeBilanzZeile[] = [];
    const passiva: AufgabeBilanzZeile[] = [];
    for (const a of input.anlagen) aktiva.push({ bezeichnung: a.bezeichnung, betrag: round2(a.restbuchwert) });
    if (forderungen.length) {
        aktiva.push({
            bezeichnung: 'Forderungen aus Lieferungen und Leistungen',
            betrag: sum(forderungen.map((p) => p.brutto)),
        });
    }
    const vorsteuer = sum(verbindlichkeiten.map((p) => p.ust));
    if (vorsteuer) aktiva.push({ bezeichnung: 'Vorsteuer in den Verbindlichkeiten', betrag: vorsteuer });
    for (const b of input.bank) aktiva.push({ bezeichnung: `Bank ${b.konto}`, betrag: round2(b.saldo) });
    if (input.kasse) aktiva.push({ bezeichnung: 'Kasse', betrag: round2(input.kasse) });
    for (const s of input.steuerposten ?? []) {
        (s.seite === 'aktiv' ? aktiva : passiva).push({ bezeichnung: s.bezeichnung, betrag: round2(s.betrag) });
    }
    if (verbindlichkeiten.length) {
        passiva.push({
            bezeichnung: 'Verbindlichkeiten aus Lieferungen und Leistungen',
            betrag: sum(verbindlichkeiten.map((p) => p.brutto)),
        });
    }
    // Netto: the Vorsteuer on an invoice not yet received is deductible once it arrives.
    if (rueckstellungen.length) {
        passiva.push({ bezeichnung: 'Sonstige Rückstellungen', betrag: sum(rueckstellungen.map((p) => p.netto)) });
    }
    const ustForderungen = sum(forderungen.map((p) => p.ust));
    if (ustForderungen) passiva.push({ bezeichnung: 'Umsatzsteuer in den Forderungen', betrag: ustForderungen });

    const summeAktiva = sum(aktiva.map((z) => z.betrag));
    const eigenkapital = round2(summeAktiva - sum(passiva.map((z) => z.betrag)));
    passiva.unshift({ bezeichnung: 'Eigenkapital', betrag: eigenkapital });
    const summePassiva = sum(passiva.map((z) => z.betrag));

    const ueForderungen = sum(forderungen.map((p) => p.netto));
    const ueVerbindlichkeiten = sum(verbindlichkeiten.map((p) => p.netto));
    const ueRueckstellungen = sum(rueckstellungen.map((p) => p.netto));
    const uebergangsgewinn = round2(ueForderungen - ueVerbindlichkeiten - ueRueckstellungen);

    const signed = (p: AufgabeBilanzPosten) => (p.art === 'einnahme' ? p.netto : -p.netto);
    const postenNet = sum(posten.map(signed));
    const nachtraeglichNet = sum(nachtraeglich.map(signed));
    const euerBisAufgabe = round2(input.laufenderGewinn - input.nachtraeglichNet);

    return {
        datum: input.datum,
        aktiva,
        passiva,
        summeAktiva,
        summePassiva,
        eigenkapital,
        forderungen,
        verbindlichkeiten,
        rueckstellungen,
        nachtraeglich,
        uebergangsgewinn: {
            forderungen: ueForderungen,
            verbindlichkeiten: ueVerbindlichkeiten,
            rueckstellungen: ueRueckstellungen,
            summe: uebergangsgewinn,
        },
        ueberleitung: {
            euerBisAufgabe,
            uebergangsgewinn,
            nachtraeglichNet,
            laufenderGewinn: round2(euerBisAufgabe + uebergangsgewinn + nachtraeglichNet),
            laufenderGewinnLautEuer: round2(input.laufenderGewinn),
            abweichung: round2(postenNet - input.nachtraeglichNet),
        },
    };
}
