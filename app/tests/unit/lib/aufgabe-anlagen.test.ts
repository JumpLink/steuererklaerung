import { describe, it, expect } from "@gjsify/unit";
import {
  aufgabegewinnAnlage,
  aufgabebilanzAnlage,
  uebergangsgewinnAnlage,
  steuerblattToMarkdown,
} from "../../../src/core/actions/elster/aufgabe-anlagen.ts";
import { fmtDe } from "../../../src/core/lib/money.ts";
import { computeAufgabegewinn } from "../../../src/core/elster/betriebsaufgabe.ts";
import { computeAufgabebilanz } from "../../../src/core/elster/aufgabebilanz.ts";
import { computeFeststellung } from "../../../src/core/elster/feststellung.ts";
import type { ElsterConfig } from "../../../src/core/config/index.ts";
import type { FeststellungReport } from "../../../src/core/actions/elster/feststellung.ts";
import type { AufgabebilanzReport } from "../../../src/core/actions/elster/aufgabebilanz.ts";

const gesellschafter = [
  { id: "a", name: "Anna Muster", steuerId: "00000000000", quote: 0.5 },
  { id: "b", name: "Bernd Muster", steuerId: "00000000001", quote: 0.5 },
];
const elster = {
  tax_number: "11/222/33333",
  datenlieferant: "Muster GbR",
  gesellschafter,
  betrieb: { name: "Muster & Partner GbR" },
} as unknown as ElsterConfig;

const aufgabe = computeAufgabegewinn(
  [
    { id: "inv-1", bezeichnung: "Regal", restbuchwertEnde: 100 },
    { id: "inv-2", bezeichnung: "Laptop", restbuchwertEnde: 300 },
    { id: "inv-3", bezeichnung: "Einbau", restbuchwertEnde: 50 },
  ],
  {
    "inv-1": 40,
    "inv-2": [{ gemeinerWert: 250, uebernehmer: "a", realteilung: true }],
    "inv-3": 0,
  },
  10,
  "2025-10-31",
);
const fest: FeststellungReport = {
  result: computeFeststellung(
    1000,
    gesellschafter,
    2025,
    {},
    aufgabe.aufgabegewinn,
  ),
  aufgabe,
} as FeststellungReport;

const bilanz: AufgabebilanzReport = {
  year: 2025,
  bank: [
    { accountKey: "k", konto: "Hauptkonto", saldo: 500, quelle: "buchungen" },
  ],
  bilanz: computeAufgabebilanz({
    datum: "2025-10-31",
    anlagen: [{ id: "inv-1", bezeichnung: "Regal", restbuchwert: 100 }],
    bank: [{ konto: "Hauptkonto", saldo: 500 }],
    posten: [
      {
        ref: "x",
        datum: "2025-11-02",
        bezeichnung: "Rechnung",
        netto: 100,
        ust: 19,
        art: "einnahme",
      },
    ],
    laufenderGewinn: 100,
    nachtraeglichNet: 0,
  }),
};

export default async () => {
  await describe("Aufgabe-Anlagen", async () => {
    await it("puts entity, Steuernummer, Stichtag and Bezug in every head", async () => {
      for (const m of [
        aufgabegewinnAnlage(fest, elster),
        aufgabebilanzAnlage(bilanz, elster),
        uebergangsgewinnAnlage(bilanz, elster),
      ]) {
        const v = m.meta.map((x) => x.value);
        expect(v).toContain("Muster & Partner GbR");
        expect(v).toContain("11/222/33333");
        expect(v).toContain("31.10.2025");
        expect(v).toContain("Anlage zur Feststellungserklärung 2025");
      }
    });

    await it("lists every asset as a table row with its Behandlung and warns about the Sperrfrist", async () => {
      const m = aufgabegewinnAnlage(fest, elster);
      const t = m.sections[0].table!;
      expect(t.columns.map((c) => c.header).join("|")).toBe(
        "Gegenstand|Inv.-ID|gemeiner Wert|Restbuchwert|Ergebnis|Übernehmer|Behandlung",
      );
      expect(t.rows.length).toBe(3);
      expect(t.rows.every((r) => r.length === t.columns.length)).toBe(true);
      const byId = (id: string) => t.rows.find((r) => r[1] === id)!;
      expect(byId("inv-1")[6]).toBe("Entnahme (gemeiner Wert)");
      expect(byId("inv-2")[6]).toBe("Realteilung (Buchwert)");
      expect(byId("inv-2")[5]).toBe("Anna Muster");
      expect(byId("inv-3")[6]).toBe("Abgang ohne Wert");
      expect(t.rows.map((r) => r[6]).join()).not.toContain("Entnahme, ohne Wert");
      expect(t.footer![0]).toBe("Summe");
      expect(t.footer![4]).toBe(`${fmtDe(aufgabe.entnahmegewinn)} €`);
      for (const i of [2, 3, 4]) expect(t.columns[i].align).toBe("right");
      expect(m.warnings.join(" ")).toContain("Sperrfrist");
      expect(m.sections[2].rows.length).toBe(2);
    });

    await it("renders the Wirtschaftsgüter as a multi-column Markdown table", async () => {
      const md = steuerblattToMarkdown(aufgabegewinnAnlage(fest, elster));
      expect(md).toContain(
        "| Gegenstand | Inv.-ID | gemeiner Wert | Restbuchwert | Ergebnis | Übernehmer | Behandlung |",
      );
      expect(md).toContain("|---|---|---:|---:|---:|---|---|");
      expect(md).toContain("| **Summe** |");
      expect(md).toContain("Abgang ohne Wert");
    });

    await it("shows equal Summe Aktiva and Summe Passiva", async () => {
      const rows = aufgabebilanzAnlage(bilanz, elster).sections.map(
        (s) => s.rows[s.rows.length - 1].value,
      );
      expect(rows[0]).toBe(rows[1]);
    });

    await it("renders Markdown with a table per section", async () => {
      const md = steuerblattToMarkdown(uebergangsgewinnAnlage(bilanz, elster));
      expect(md).toContain("# Übergangsgewinn zum 31.10.2025");
      expect(md).toContain("| Position | Betrag |");
    });

    await it("refuses without a configured Betriebsaufgabe", async () => {
      let msg = "";
      try {
        aufgabegewinnAnlage({ ...fest, aufgabe: undefined }, elster);
      } catch (e) {
        msg = String(e);
      }
      expect(msg).toContain("Betriebsaufgabe");
    });
  });
};
