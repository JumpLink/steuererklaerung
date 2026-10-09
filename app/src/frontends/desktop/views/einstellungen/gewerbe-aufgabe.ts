/**
 * Einstellungen — Gewerbesteuer + Betriebsaufgabe sections (business entities).
 *
 * Both blocks decide a tax number the app then files. The Hebesatz alone moves the Gewerbesteuer by
 * the full ratio between two towns, and the Betriebsaufgabe splits a year's profit into a laufender
 * Gewinn and a §16/§34-begünstigter Aufgabegewinn — and until now both could only be entered by
 * opening the manifest in a text editor. A number that only a text editor can set is not a setting;
 * it is a value that silently keeps whatever it was.
 *
 * Written through mutateElster onto `raw.gewerbe` / `raw.adjustments.betriebsaufgabe`, the same
 * read-modify-write the Anpassungen groups use, so the neighbouring blocks survive untouched.
 */

import Adw from '@girs/adw-1';

import { mutateElster, type ElsterConfig } from '../../data/settings.ts';
import type { AppEntity } from '../../entities.ts';
import { entryRow, removeRow, spinRow, spliceRow, type SettingsHost } from './rows.ts';
import { helpFor } from '../../widgets/glossary-help.ts';

// ── Gewerbesteuer ───────────────────────────────────────────────────────────────────────────────

/** Read-modify-write one key of `raw.gewerbe`, creating the block if the manifest has none. */
function saveGewerbe(host: SettingsHost, entity: AppEntity, patch: Record<string, unknown>): void {
    host.saveWith(
        () =>
            mutateElster(entity, (raw) => {
                const block = (raw.gewerbe ?? {}) as Record<string, unknown>;
                Object.assign(block, patch);
                raw.gewerbe = block;
            }),
        { clearCache: true },
    );
}

/** Read-modify-write one key of `raw.gewerbe.<section>` (Hinzurechnungen / Kürzungen). */
function saveGewerbeSection(
    host: SettingsHost,
    entity: AppEntity,
    section: 'hinzurechnungen' | 'kuerzungen',
    key: string,
    value: number,
): void {
    host.saveWith(
        () =>
            mutateElster(entity, (raw) => {
                const block = (raw.gewerbe ?? {}) as Record<string, unknown>;
                const inner = (block[section] ?? {}) as Record<string, unknown>;
                inner[key] = value;
                block[section] = inner;
                raw.gewerbe = block;
            }),
        { clearCache: true },
    );
}

/** Gemeinde, Hebesatz and the §8/§9 Hinzurechnungen/Kürzungen behind the GewSt 1 A. */
export function buildGewerbeGroup(host: SettingsHost, entity: AppEntity, elster: ElsterConfig): Adw.PreferencesGroup {
    const g = elster.gewerbe;
    const group = helpFor(
        new Adw.PreferencesGroup({
            title: 'Gewerbesteuer',
            description: 'Hebende Gemeinde und Hebesatz für die GewSt 1 A.',
        }),
        'gewerbesteuer',
    );

    group.add(entryRow(host, 'Gemeinde', g?.gemeinde ?? '', (t) => saveGewerbe(host, entity, { gemeinde: t.trim() })));
    // The AGS is what the Gemeinde is called in the ELSTER form; the name above is what a person
    // calls it. Both are stored, because neither can be derived from the other offline.
    group.add(
        entryRow(host, 'Amtlicher Gemeindeschlüssel (AGS)', g?.ags ?? '', (t) => {
            const ags = t.trim();
            if (ags && !/^\d{8}$/.test(ags)) {
                host.banner('Der AGS ist 8-stellig (z. B. 03459015). Leer lassen, wenn er nicht bekannt ist.');
                return;
            }
            saveGewerbe(host, entity, { ags: ags || undefined });
        }),
    );
    group.add(
        spinRow(host, 'Hebesatz (%)', g?.hebesatz ?? 0, { digits: 0, lower: 0, upper: 1000 }, (v) =>
            saveGewerbe(host, entity, { hebesatz: Math.round(v) }),
        ),
    );

    const hinzu = new Adw.ExpanderRow({
        title: 'Hinzurechnungen (§ 8 GewStG)',
        subtitle: 'Nur ausfüllen, wenn es solche Posten gab — sonst 0.',
    });
    for (const [key, title] of [
        ['finanzierungsanteile', 'Finanzierungsanteile (Entgelte für Schulden, Mieten, Lizenzen)'],
        ['streubesitzdividenden', 'Streubesitzdividenden'],
        ['verlustanteile_pers_ges', 'Verlustanteile aus Personengesellschaften'],
        ['sonstige', 'Sonstige Hinzurechnungen'],
    ] as const) {
        const value = (g?.hinzurechnungen as Record<string, number> | undefined)?.[key] ?? 0;
        hinzu.add_row(
            spinRow(host, title, value, { digits: 2, lower: 0, upper: 100_000_000 }, (v) =>
                saveGewerbeSection(host, entity, 'hinzurechnungen', key, v),
            ),
        );
    }
    group.add(hinzu);

    const kuerz = new Adw.ExpanderRow({
        title: 'Kürzungen (§ 9 GewStG)',
        subtitle: 'Nur ausfüllen, wenn es solche Posten gab — sonst 0.',
    });
    for (const [key, title] of [
        ['grundbesitz', 'Grundbesitz (1,2 % des Einheitswerts)'],
        ['gewinnanteile_pers_ges', 'Gewinnanteile aus Personengesellschaften'],
        ['spenden', 'Spenden und Mitgliedsbeiträge'],
        ['sonstige', 'Sonstige Kürzungen'],
    ] as const) {
        const value = (g?.kuerzungen as Record<string, number> | undefined)?.[key] ?? 0;
        kuerz.add_row(
            spinRow(host, title, value, { digits: 2, lower: 0, upper: 100_000_000 }, (v) =>
                saveGewerbeSection(host, entity, 'kuerzungen', key, v),
            ),
        );
    }
    group.add(kuerz);
    return group;
}

// ── Betriebsaufgabe ─────────────────────────────────────────────────────────────────────────────

/** The widgets backing one gemeiner-Wert expander (kept in a parallel array, like abschluss.ts). */
interface WertRowWidgets {
    row: Adw.ExpanderRow;
    anlagegut_id: Adw.EntryRow;
    gemeiner_wert: Adw.SpinRow;
}

/** Aufgabedatum, Aufgabekosten and the per-asset gemeine Werte behind the §16/§34 Aufgabegewinn. */
export function buildAufgabeGroup(host: SettingsHost, entity: AppEntity, elster: ElsterConfig): Adw.PreferencesGroup {
    const a = elster.adjustments?.betriebsaufgabe;
    const group = helpFor(
        new Adw.PreferencesGroup({
            title: 'Betriebsaufgabe',
            description:
                'Nur bei Aufgabe des Betriebs: das restliche Anlagevermögen geht zum gemeinen Wert ins Privatvermögen.',
        }),
        'aufgabe',
    );

    group.add(
        entryRow(host, 'Aufgabedatum (JJJJ-MM-TT)', a?.datum ?? '', (t) => {
            const datum = t.trim();
            if (datum && !/^\d{4}-\d{2}-\d{2}$/.test(datum)) {
                host.banner('Das Aufgabedatum muss JJJJ-MM-TT sein, z. B. 2025-12-31.');
                return;
            }
            saveAufgabe(host, entity, { datum: datum || undefined });
        }),
    );
    group.add(
        spinRow(host, 'Aufgabekosten (€)', a?.aufgabekosten ?? 0, { digits: 2, lower: 0, upper: 100_000_000 }, (v) =>
            saveAufgabe(host, entity, { aufgabekosten: v }),
        ),
    );

    const werte: WertRowWidgets[] = [];
    const persist = () =>
        saveAufgabe(host, entity, {
            gemeine_werte: werte.map((w) => ({
                anlagegut_id: (w.anlagegut_id.get_text() ?? '').trim(),
                gemeiner_wert: w.gemeiner_wert.get_value(),
            })),
        });

    const addWert = (id: string, wert: number) => {
        const row = new Adw.ExpanderRow({ title: id || 'Neues Anlagegut' });
        const idRow = entryRow(host, 'Anlagegut-ID', id, (t) => {
            row.set_title(t.trim() || 'Neues Anlagegut');
            persist();
        });
        const wertRow = spinRow(host, 'Gemeiner Wert (€)', wert, { digits: 2, lower: 0, upper: 100_000_000 }, persist);
        const w: WertRowWidgets = { row, anlagegut_id: idRow, gemeiner_wert: wertRow };
        row.add_row(idRow);
        row.add_row(wertRow);
        row.add_row(removeRow('Entfernen', () => spliceRow(werte, w, group, row)));
        werte.push(w);
        group.add(row);
        return row;
    };

    for (const w of a?.gemeine_werte ?? []) addWert(w.anlagegut_id, w.gemeiner_wert);

    // Without a value here an asset is withdrawn at its Restbuchwert — which is a DEFAULT, not a
    // measurement, so the subtitle says so rather than leaving an empty list looking complete.
    const add = new Adw.ButtonRow({ title: '＋ Gemeinen Wert hinzufügen' });
    add.connect('activated', () => {
        addWert('', 0);
        persist();
    });
    group.add(add);
    return group;
}

/** Read-modify-write `raw.adjustments.betriebsaufgabe`, leaving the other adjustment blocks alone. */
function saveAufgabe(host: SettingsHost, entity: AppEntity, patch: Record<string, unknown>): void {
    host.saveWith(
        () =>
            mutateElster(entity, (raw) => {
                const adjustments = (raw.adjustments ?? {}) as Record<string, unknown>;
                const block = (adjustments.betriebsaufgabe ?? {}) as Record<string, unknown>;
                Object.assign(block, patch);
                adjustments.betriebsaufgabe = block;
                raw.adjustments = adjustments;
            }),
        { clearCache: true },
    );
}
