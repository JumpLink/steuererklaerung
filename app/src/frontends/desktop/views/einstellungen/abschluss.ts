/**
 * Einstellungen — Jahresabschluss-Anpassungen section (business entities): the three non-cash
 * adjustment lists behind the tax "Anpassungen" screen — Anlagegüter (AfA), Privatanteile,
 * Sonderbetriebsausgaben.
 *
 * Each is a PreferencesGroup of one ExpanderRow per item + a "Hinzufügen" ButtonRow. Every field edit
 * (and add/remove) re-serialises the WHOLE list from its widgets and writes it via mutateElster onto
 * raw.adjustments.<key>, so the other adjustment blocks (afa_override, betriebsaufgabe,
 * nachtraegliche_posten, doppelzahlungen, …) survive untouched. Programmatic fills are gated by the
 * host's `isFilling`; on save the host drops the EÜR cache + toasts, errors go to the banner.
 */

import Adw from '@girs/adw-1';

import {
    mutateElster,
    type ElsterConfig,
    type ElsterAnlagegut,
    type ElsterPrivatanteil,
    type ElsterSonderbetriebsausgabe,
} from '../../data/settings.ts';
import type { AppEntity } from '../../entities.ts';
import { comboRow, entryRow, removeRow, spinRow, spliceRow, type SettingsHost } from './rows.ts';
import { helpFor } from '../../widgets/glossary-help.ts';

/** The widgets backing one Anlagegut expander (kept in a parallel array, not stashed on the row). */
interface AnlageRowWidgets {
    row: Adw.ExpanderRow;
    /** Non-UI field carried through so a save never drops it (Erinnerungswert of kept assets). */
    erinnerungswert: number;
    /** Carried through too: the bookings an „Anlagegut?" hint captured it from (no widget). */
    buchung_ids?: string[];
    id: Adw.EntryRow;
    bezeichnung: Adw.EntryRow;
    anschaffung: Adw.EntryRow;
    ahk: Adw.SpinRow;
    nutzungsdauer: Adw.SpinRow;
    restbuchwert: Adw.SpinRow;
    art: Adw.ComboRow;
}

/** The widgets backing one Privatanteil expander. */
interface PrivatanteilRowWidgets {
    row: Adw.ExpanderRow;
    bezeichnung: Adw.EntryRow;
    netto: Adw.SpinRow;
    ustSatz: Adw.ComboRow;
}

/** The widgets backing one Sonderbetriebsausgabe expander. */
interface SonderRowWidgets {
    row: Adw.ExpanderRow;
    gesellschafter: Adw.ComboRow;
    bezeichnung: Adw.EntryRow;
    betrag: Adw.SpinRow;
}

/** A GbR partner reduced to what the Sonderbetriebsausgabe picker needs. */
type Partner = { id: string; name: string };

// ── Anlagegüter (AfA) ───────────────────────────────────────────────────────────────────────────

export function buildAnlagenGroup(host: SettingsHost, entity: AppEntity, elster: ElsterConfig): Adw.PreferencesGroup {
    const rows: AnlageRowWidgets[] = [];
    const group = helpFor(
        new Adw.PreferencesGroup({
            title: 'Anlagegüter (AfA)',
            description: 'Abschreibbare Wirtschaftsgüter (lineare AfA) für die Anlage AVEÜR.',
        }),
        'afa',
    );
    for (const a of elster.adjustments?.anlageverzeichnis ?? []) addAnlageRow(host, entity, group, rows, a);
    const addBtn = new Adw.ButtonRow({ title: '＋ Anlagegut hinzufügen' });
    addBtn.connect('activated', () => {
        addAnlageRow(host, entity, group, rows, newAnlage());
        group.remove(addBtn); // keep the add button at the bottom, below the new expander
        group.add(addBtn);
        saveAnlagen(host, entity, rows);
    });
    group.add(addBtn);
    return group;
}

function addAnlageRow(
    host: SettingsHost,
    entity: AppEntity,
    group: Adw.PreferencesGroup,
    rows: AnlageRowWidgets[],
    item: ElsterAnlagegut,
): void {
    const row = new Adw.ExpanderRow({ title: item.bezeichnung.trim() || 'Neues Anlagegut' });
    const save = () => saveAnlagen(host, entity, rows);
    const w: AnlageRowWidgets = {
        row,
        erinnerungswert: item.erinnerungswert,
        buchung_ids: item.buchung_ids,
        id: entryRow(host, 'Kennung (id)', item.id, save),
        bezeichnung: entryRow(host, 'Bezeichnung', item.bezeichnung, save),
        anschaffung: entryRow(host, 'Anschaffung (JJJJ-MM-TT)', item.anschaffung, save),
        ahk: spinRow(host, 'Anschaffungskosten AHK (€)', item.ahk, MONEY, save),
        nutzungsdauer: spinRow(host, 'Nutzungsdauer (Jahre)', item.nutzungsdauer_jahre, YEARS, save),
        restbuchwert: spinRow(host, 'Restbuchwert 01.01. (€)', item.restbuchwert_anfang, MONEY, save),
        art: comboRow(host, 'Art', ['beweglich', 'Gebäude'], item.art === 'gebaeude' ? 1 : 0, save),
    };
    w.bezeichnung.connect('apply', () => row.set_title(w.bezeichnung.get_text()?.trim() || 'Neues Anlagegut'));
    const remove = removeRow('Anlagegut entfernen', () => {
        spliceRow(rows, w, group, row);
        saveAnlagen(host, entity, rows);
    });
    for (const r of [w.id, w.bezeichnung, w.anschaffung, w.ahk, w.nutzungsdauer, w.restbuchwert, w.art, remove])
        row.add_row(r);
    rows.push(w);
    group.add(row);
}

function saveAnlagen(host: SettingsHost, entity: AppEntity, rows: AnlageRowWidgets[]): void {
    if (host.isFilling()) return;
    // Typed map (not `unknown[]`) so the shared writer validates the shape; the widgets don't surface
    // `vorsteuerabzug`, so it's omitted here exactly as before (setAdjArray dropped it too).
    const list = rows.map((w): ElsterAnlagegut => ({
        id: (w.id.get_text() ?? '').trim(),
        bezeichnung: (w.bezeichnung.get_text() ?? '').trim(),
        anschaffung: (w.anschaffung.get_text() ?? '').trim(),
        ahk: money2(w.ahk.get_value()),
        nutzungsdauer_jahre: Math.round(w.nutzungsdauer.get_value()),
        restbuchwert_anfang: money2(w.restbuchwert.get_value()),
        erinnerungswert: w.erinnerungswert,
        art: w.art.get_selected() === 1 ? 'gebaeude' : 'beweglich',
        ...(w.buchung_ids?.length ? { buchung_ids: w.buchung_ids } : {}),
    }));
    host.saveWith(() => saveAnlageverzeichnis(entity, list), { clearCache: true });
}

/**
 * Persist the whole Anlageverzeichnis onto the entity's ELSTER config — the ONE write path for
 * `adjustments.anlageverzeichnis`, shared by this Einstellungen editor and the Steuer-Hub "Anlagen"
 * tab so both surfaces mutate the same list through {@link setAdjArray} (every sibling adjustment
 * block survives untouched). Returns the freshly validated config for the caller to render.
 */
export function saveAnlageverzeichnis(entity: AppEntity, list: ElsterAnlagegut[]): ElsterConfig {
    return mutateElster(entity, (raw) => setAdjArray(raw, 'anlageverzeichnis', list));
}

/**
 * Append ONE asset to the Anlageverzeichnis — the Steuer-Hub "Anlagen" tab's "Erfassen" write. Reads
 * the CURRENT list from the on-disk raw config inside the mutate transaction (not a possibly-stale
 * in-memory snapshot), so a concurrent edit in the Einstellungen editor is never clobbered. Shares the
 * same {@link setAdjArray} path as {@link saveAnlageverzeichnis}.
 */
export function appendAnlagegut(entity: AppEntity, item: ElsterAnlagegut): ElsterConfig {
    return mutateElster(entity, (raw) => {
        const adj = raw.adjustments as { anlageverzeichnis?: unknown } | undefined;
        const current = Array.isArray(adj?.anlageverzeichnis) ? (adj.anlageverzeichnis as ElsterAnlagegut[]) : [];
        setAdjArray(raw, 'anlageverzeichnis', [...current, item]);
    });
}

// ── Privatanteile ─────────────────────────────────────────────────────────────────────────────

export function buildPrivatanteileGroup(
    host: SettingsHost,
    entity: AppEntity,
    elster: ElsterConfig,
): Adw.PreferencesGroup {
    const rows: PrivatanteilRowWidgets[] = [];
    const group = helpFor(
        new Adw.PreferencesGroup({
            title: 'Privatanteile',
            description: 'Unentgeltliche Wertabgaben — als fiktive Betriebseinnahme angesetzt.',
        }),
        'privatentnahme',
    );
    for (const p of elster.adjustments?.privatanteile ?? []) addPrivatanteilRow(host, entity, group, rows, p);
    const addBtn = new Adw.ButtonRow({ title: '＋ Privatanteil hinzufügen' });
    addBtn.connect('activated', () => {
        addPrivatanteilRow(host, entity, group, rows, newPrivatanteil());
        group.remove(addBtn);
        group.add(addBtn);
        savePrivatanteile(host, entity, rows);
    });
    group.add(addBtn);
    return group;
}

function addPrivatanteilRow(
    host: SettingsHost,
    entity: AppEntity,
    group: Adw.PreferencesGroup,
    rows: PrivatanteilRowWidgets[],
    item: ElsterPrivatanteil,
): void {
    const row = new Adw.ExpanderRow({ title: item.bezeichnung.trim() || 'Neuer Privatanteil' });
    const save = () => savePrivatanteile(host, entity, rows);
    const w: PrivatanteilRowWidgets = {
        row,
        bezeichnung: entryRow(host, 'Bezeichnung', item.bezeichnung, save),
        netto: spinRow(host, 'Netto (€)', item.netto, MONEY_SIGNED, save),
        ustSatz: comboRow(host, 'USt-Satz', UST_SATZ_LABELS, ustSatzIndex(item.ust_satz), save),
    };
    w.bezeichnung.connect('apply', () => row.set_title(w.bezeichnung.get_text()?.trim() || 'Neuer Privatanteil'));
    const remove = removeRow('Privatanteil entfernen', () => {
        spliceRow(rows, w, group, row);
        savePrivatanteile(host, entity, rows);
    });
    for (const r of [w.bezeichnung, w.netto, w.ustSatz, remove]) row.add_row(r);
    rows.push(w);
    group.add(row);
}

function savePrivatanteile(host: SettingsHost, entity: AppEntity, rows: PrivatanteilRowWidgets[]): void {
    if (host.isFilling()) return;
    const list = rows.map((w) => ({
        bezeichnung: (w.bezeichnung.get_text() ?? '').trim(),
        netto: money2(w.netto.get_value()),
        ust_satz: UST_SATZ_RATES[w.ustSatz.get_selected()] ?? 0.19,
    }));
    host.saveWith(() => mutateElster(entity, (raw) => setAdjArray(raw, 'privatanteile', list)), {
        clearCache: true,
    });
}

// ── Sonderbetriebsausgaben ────────────────────────────────────────────────────────────────────

export function buildSonderbetriebGroup(
    host: SettingsHost,
    entity: AppEntity,
    elster: ElsterConfig,
): Adw.PreferencesGroup {
    const rows: SonderRowWidgets[] = [];
    const partners: Partner[] = elster.gesellschafter.map((g) => ({ id: g.id, name: g.name }));
    const group = helpFor(
        new Adw.PreferencesGroup({
            title: 'Sonderbetriebsausgaben',
            description: 'Aufwendungen einzelner Gesellschafter (z. B. häusliches Arbeitszimmer).',
        }),
        'sonderbetriebsausgaben',
    );
    for (const s of elster.adjustments?.sonderbetriebsausgaben ?? [])
        addSonderRow(host, entity, group, rows, partners, s);
    const addBtn = new Adw.ButtonRow({ title: '＋ Sonderbetriebsausgabe hinzufügen' });
    if (partners.length === 0) {
        addBtn.set_sensitive(false);
        group.set_description(
            'Aufwendungen einzelner Gesellschafter — erst Gesellschafter in der Konfiguration anlegen.',
        );
    }
    addBtn.connect('activated', () => {
        addSonderRow(host, entity, group, rows, partners, newSonder(partners));
        group.remove(addBtn);
        group.add(addBtn);
        saveSonder(host, entity, rows, partners);
    });
    group.add(addBtn);
    return group;
}

function addSonderRow(
    host: SettingsHost,
    entity: AppEntity,
    group: Adw.PreferencesGroup,
    rows: SonderRowWidgets[],
    partners: Partner[],
    item: ElsterSonderbetriebsausgabe,
): void {
    const row = new Adw.ExpanderRow({ title: item.bezeichnung.trim() || 'Neue Sonderbetriebsausgabe' });
    const save = () => saveSonder(host, entity, rows, partners);
    const idx = Math.max(
        0,
        partners.findIndex((p) => p.id === item.gesellschafter_id),
    );
    const w: SonderRowWidgets = {
        row,
        gesellschafter: comboRow(
            host,
            'Gesellschafter',
            partners.map((p) => p.name),
            idx,
            save,
        ),
        bezeichnung: entryRow(host, 'Bezeichnung', item.bezeichnung, save),
        betrag: spinRow(host, 'Betrag (€)', item.betrag, MONEY, save),
    };
    w.bezeichnung.connect('apply', () =>
        row.set_title(w.bezeichnung.get_text()?.trim() || 'Neue Sonderbetriebsausgabe'),
    );
    const remove = removeRow('Sonderbetriebsausgabe entfernen', () => {
        spliceRow(rows, w, group, row);
        saveSonder(host, entity, rows, partners);
    });
    for (const r of [w.gesellschafter, w.bezeichnung, w.betrag, remove]) row.add_row(r);
    rows.push(w);
    group.add(row);
}

function saveSonder(host: SettingsHost, entity: AppEntity, rows: SonderRowWidgets[], partners: Partner[]): void {
    if (host.isFilling()) return;
    const list = rows.map((w) => ({
        gesellschafter_id: partners[w.gesellschafter.get_selected()]?.id ?? '',
        bezeichnung: (w.bezeichnung.get_text() ?? '').trim(),
        betrag: money2(w.betrag.get_value()),
    }));
    host.saveWith(() => mutateElster(entity, (raw) => setAdjArray(raw, 'sonderbetriebsausgaben', list)), {
        clearCache: true,
    });
}

// ── SpinRow presets + value maps + list helpers ─────────────────────────────────────────────────

/** SpinRow presets: money (2 decimals, ≥0), signed money, whole years (≥1). */
const MONEY = { digits: 2, lower: 0, upper: 100_000_000 };
const MONEY_SIGNED = { digits: 2, lower: -100_000_000, upper: 100_000_000 };
const YEARS = { digits: 0, lower: 1, upper: 100 };

/** Privatanteil USt-Satz options (labels ⇄ fraction) for the ComboRow. */
const UST_SATZ_LABELS = ['0 %', '7 %', '19 %'];
const UST_SATZ_RATES = [0, 0.07, 0.19];

/** The ComboRow index for a USt-Satz fraction (0 / 0.07 / 0.19). */
function ustSatzIndex(rate: number): number {
    if (Math.abs(rate - 0.19) < 1e-6) return 2;
    if (Math.abs(rate - 0.07) < 1e-6) return 1;
    return 0;
}

/** Round a money value to 2 decimals — SpinRow stepping can accumulate float noise. */
function money2(value: number): number {
    return Math.round(value * 100) / 100;
}

/** Replace one `adjustments.<key>` array in the raw config, creating `adjustments` if absent and
 *  preserving every sibling adjustment block untouched. */
function setAdjArray(raw: Record<string, unknown>, key: string, value: unknown[]): void {
    const adj = (raw.adjustments as Record<string, unknown> | undefined) ?? {};
    raw.adjustments = adj;
    adj[key] = value;
}

/** Fresh, schema-valid default items for the "Hinzufügen" buttons. */
export function newAnlage(): ElsterAnlagegut {
    return {
        id: `anlage-${Date.now().toString(36)}`,
        bezeichnung: '',
        anschaffung: '',
        ahk: 0,
        nutzungsdauer_jahre: 1,
        restbuchwert_anfang: 0,
        erinnerungswert: 0,
        art: 'beweglich',
    };
}
function newPrivatanteil(): ElsterPrivatanteil {
    return { bezeichnung: '', netto: 0, ust_satz: 0.19 };
}
function newSonder(partners: Partner[]): ElsterSonderbetriebsausgabe {
    return { gesellschafter_id: partners[0]?.id ?? '', bezeichnung: '', betrag: 0 };
}
