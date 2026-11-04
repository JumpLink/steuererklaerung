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

import type { ElsterBetriebsaufgabe } from '../../../../core/config/index.ts';
import { mutateElster, type ElsterConfig } from '../../data/settings.ts';
import type { AppEntity } from '../../entities.ts';
import { entryRow, removeRow, spinRow, spliceRow, toggleRow, type SettingsHost } from './rows.ts';
import { helpFor } from '../../widgets/glossary-help.ts';
import { _ } from '../../i18n.ts';

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
            title: _('Gewerbesteuer'),
            description: _('The levying municipality and the Hebesatz for the GewSt 1 A.'),
        }),
        'gewerbesteuer',
    );

    group.add(
        entryRow(host, _('Municipality'), g?.gemeinde ?? '', (t) => saveGewerbe(host, entity, { gemeinde: t.trim() })),
    );
    // The AGS is what the Gemeinde is called in the ELSTER form; the name above is what a person
    // calls it. Both are stored, because neither can be derived from the other offline.
    group.add(
        entryRow(host, _('Official municipality key (AGS)'), g?.ags ?? '', (t) => {
            const ags = t.trim();
            if (ags && !/^\d{8}$/.test(ags)) {
                host.banner(_('The AGS has 8 digits (e.g. 03459015). Leave it empty if it is not known.'));
                return;
            }
            saveGewerbe(host, entity, { ags: ags || undefined });
        }),
    );
    group.add(
        spinRow(host, _('Hebesatz (%)'), g?.hebesatz ?? 0, { digits: 0, lower: 0, upper: 1000 }, (v) =>
            saveGewerbe(host, entity, { hebesatz: Math.round(v) }),
        ),
    );

    const hinzu = new Adw.ExpanderRow({
        title: _('Add-backs (§ 8 GewStG)'),
        subtitle: _('Only fill in if there were such items — otherwise 0.'),
    });
    for (const [key, title] of [
        ['finanzierungsanteile', _('Financing shares (consideration for debts, rents, licences)')],
        ['streubesitzdividenden', _('Free-float dividends')],
        ['verlustanteile_pers_ges', _('Loss shares from partnerships')],
        ['sonstige', _('Other add-backs')],
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
        title: _('Reductions (§ 9 GewStG)'),
        subtitle: _('Only fill in if there were such items — otherwise 0.'),
    });
    for (const [key, title] of [
        ['grundbesitz', _('Real property (1.2 % of the assessed value)')],
        ['gewinnanteile_pers_ges', _('Profit shares from partnerships')],
        ['spenden', _('Donations and membership dues')],
        ['sonstige', _('Other reductions')],
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
    bezeichnung: Adw.EntryRow;
    /** 0 = the whole asset (stored as no `anteil`). */
    anteil: Adw.SpinRow;
    uebernehmer: Adw.EntryRow;
    realteilung: Adw.SwitchRow;
}

type GemeinerWert = ElsterBetriebsaufgabe['gemeine_werte'][number];

/** Aufgabedatum, Aufgabekosten and the per-asset gemeine Werte behind the §16/§34 Aufgabegewinn. */
export function buildAufgabeGroup(host: SettingsHost, entity: AppEntity, elster: ElsterConfig): Adw.PreferencesGroup {
    const a = elster.adjustments?.betriebsaufgabe;
    const group = helpFor(
        new Adw.PreferencesGroup({
            title: _('Business cessation'),
            description: _(
                'Only when the business ceases: the remaining fixed assets move into private assets at their fair value.',
            ),
        }),
        'aufgabe',
    );

    group.add(
        entryRow(host, _('Cessation date (YYYY-MM-DD)'), a?.datum ?? '', (t) => {
            const datum = t.trim();
            if (datum && !/^\d{4}-\d{2}-\d{2}$/.test(datum)) {
                host.banner(_('The cessation date must be YYYY-MM-DD, e.g. 2025-12-31.'));
                return;
            }
            saveAufgabe(host, entity, { datum: datum || undefined });
        }),
    );
    group.add(
        spinRow(
            host,
            _('Cessation costs (€)'),
            a?.aufgabekosten ?? 0,
            { digits: 2, lower: 0, upper: 100_000_000 },
            (v) => saveAufgabe(host, entity, { aufgabekosten: v }),
        ),
    );

    const werte: WertRowWidgets[] = [];
    const persist = () =>
        saveAufgabe(host, entity, {
            gemeine_werte: werte.map((w) => {
                const bezeichnung = (w.bezeichnung.get_text() ?? '').trim();
                const uebernehmer = (w.uebernehmer.get_text() ?? '').trim();
                const anteil = w.anteil.get_value();
                return {
                    anlagegut_id: (w.anlagegut_id.get_text() ?? '').trim(),
                    gemeiner_wert: w.gemeiner_wert.get_value(),
                    ...(bezeichnung ? { bezeichnung } : {}),
                    ...(anteil > 0 ? { anteil } : {}),
                    ...(uebernehmer ? { uebernehmer } : {}),
                    ...(w.realteilung.get_active() ? { realteilung: true } : {}),
                };
            }),
        });

    const addWert = (w0: Partial<GemeinerWert>) => {
        const id = w0.anlagegut_id ?? '';
        const row = new Adw.ExpanderRow({ title: w0.bezeichnung || id || _('New asset') });
        const idRow = entryRow(host, _('Asset ID'), id, (t) => {
            row.set_title(t.trim() || _('New asset'));
            persist();
        });
        const wertRow = spinRow(
            host,
            _('Fair value (€)'),
            w0.gemeiner_wert ?? 0,
            { digits: 2, lower: 0, upper: 100_000_000 },
            persist,
        );
        const bezRow = entryRow(host, _('Name of this part'), w0.bezeichnung ?? '', persist);
        const anteilRow = spinRow(
            host,
            _('Share of the book value (0 = whole asset)'),
            w0.anteil ?? 0,
            { digits: 2, lower: 0, upper: 1 },
            persist,
        );
        const uebRow = entryRow(host, _('Taken over by (partner ID)'), w0.uebernehmer ?? '', persist);
        const realRow = toggleRow(
            host,
            _('Into the partner’s own business'),
            _('Realteilung: the book value carries over, no cessation gain'),
            w0.realteilung ?? false,
            persist,
        );
        const w: WertRowWidgets = {
            row,
            anlagegut_id: idRow,
            gemeiner_wert: wertRow,
            bezeichnung: bezRow,
            anteil: anteilRow,
            uebernehmer: uebRow,
            realteilung: realRow,
        };
        for (const r of [idRow, wertRow, bezRow, anteilRow, uebRow, realRow]) row.add_row(r);
        row.add_row(removeRow(_('Remove'), () => spliceRow(werte, w, group, row)));
        werte.push(w);
        group.add(row);
        return row;
    };

    for (const w of a?.gemeine_werte ?? []) addWert(w);

    // Without a value here an asset is withdrawn at its Restbuchwert — which is a DEFAULT, not a
    // measurement, so the subtitle says so rather than leaving an empty list looking complete.
    const add = new Adw.ButtonRow({ title: _('＋ Add fair value') });
    add.connect('activated', () => {
        addWert({});
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
