/**
 * Einstellungen — Vorsteuer ohne Zahlung (business entities): incoming invoices settled by Verrechnung
 * (e.g. a Sachwertabfindung), which no bank payment backs and the USt-VA / USt-Jahr therefore never see.
 * Same shape as the Privatanteile group: one ExpanderRow per item + an add button, every edit re-serialises
 * the WHOLE list onto raw.adjustments.vorsteuer_ohne_zahlung and leaves its sibling blocks untouched.
 */

import Adw from '@girs/adw-1';

import { mutateElster, type ElsterConfig, type ElsterVorsteuerOhneZahlung } from '../../data/settings.ts';
import type { AppEntity } from '../../entities.ts';
import { entryRow, removeRow, spinRow, spliceRow, type SettingsHost } from './rows.ts';
import { _ } from '../../i18n.ts';
import { plainExpanderRow } from '../plain-rows.ts';

interface RowWidgets {
    row: Adw.ExpanderRow;
    datum: Adw.EntryRow;
    bezeichnung: Adw.EntryRow;
    netto: Adw.SpinRow;
    vorsteuer: Adw.SpinRow;
    rechnungsnummer: Adw.EntryRow;
    dokumentId: Adw.EntryRow;
}

const MONEY = { digits: 2, lower: 0, upper: 100_000_000 };

/** Round a money value to 2 decimals — SpinRow stepping can accumulate float noise. */
function money2(value: number): number {
    return Math.round(value * 100) / 100;
}

function newItem(): ElsterVorsteuerOhneZahlung {
    return { datum: new Date().toISOString().slice(0, 10), bezeichnung: '', netto: 0, vorsteuer: 0 };
}

export function buildVorsteuerOhneZahlungGroup(
    host: SettingsHost,
    entity: AppEntity,
    elster: ElsterConfig,
): Adw.PreferencesGroup {
    const rows: RowWidgets[] = [];
    const group = new Adw.PreferencesGroup({
        title: _('Input VAT without payment'),
        description: _('Invoices settled by offset — deductible when service and invoice are received.'),
    });
    for (const item of elster.adjustments?.vorsteuer_ohne_zahlung ?? []) addRow(host, entity, group, rows, item);
    const addBtn = new Adw.ButtonRow({ title: _('＋ Add invoice without payment') });
    addBtn.connect('activated', () => {
        addRow(host, entity, group, rows, newItem());
        group.remove(addBtn);
        group.add(addBtn);
        save(host, entity, rows);
    });
    group.add(addBtn);
    return group;
}

function addRow(
    host: SettingsHost,
    entity: AppEntity,
    group: Adw.PreferencesGroup,
    rows: RowWidgets[],
    item: ElsterVorsteuerOhneZahlung,
): void {
    const row = plainExpanderRow({ title: item.bezeichnung.trim() || _('New invoice without payment') });
    const onChange = () => save(host, entity, rows);
    const w: RowWidgets = {
        row,
        datum: entryRow(host, _('Invoice received (YYYY-MM-DD)'), item.datum, onChange),
        bezeichnung: entryRow(host, _('Designation'), item.bezeichnung, onChange),
        netto: spinRow(host, _('Net (€)'), item.netto, MONEY, onChange),
        vorsteuer: spinRow(host, _('Input VAT (€)'), item.vorsteuer, MONEY, onChange),
        rechnungsnummer: entryRow(host, _('Invoice number'), item.rechnungsnummer ?? '', onChange),
        dokumentId: entryRow(host, _('Document ID'), item.dokument_id ?? '', onChange),
    };
    w.bezeichnung.connect('apply', () =>
        row.set_title(w.bezeichnung.get_text()?.trim() || _('New invoice without payment')),
    );
    const remove = removeRow(_('Remove invoice without payment'), () => {
        spliceRow(rows, w, group, row);
        save(host, entity, rows);
    });
    for (const r of [w.datum, w.bezeichnung, w.netto, w.vorsteuer, w.rechnungsnummer, w.dokumentId, remove]) {
        row.add_row(r);
    }
    rows.push(w);
    group.add(row);
}

function save(host: SettingsHost, entity: AppEntity, rows: RowWidgets[]): void {
    if (host.isFilling()) return;
    const list = rows.map((w) => {
        const rechnungsnummer = (w.rechnungsnummer.get_text() ?? '').trim();
        const dokumentId = (w.dokumentId.get_text() ?? '').trim();
        return {
            datum: (w.datum.get_text() ?? '').trim(),
            bezeichnung: (w.bezeichnung.get_text() ?? '').trim(),
            netto: money2(w.netto.get_value()),
            vorsteuer: money2(w.vorsteuer.get_value()),
            ...(rechnungsnummer ? { rechnungsnummer } : {}),
            ...(dokumentId ? { dokument_id: dokumentId } : {}),
        };
    });
    host.saveWith(
        () =>
            mutateElster(entity, (raw) => {
                const adj = (raw.adjustments as Record<string, unknown> | undefined) ?? {};
                raw.adjustments = adj;
                adj.vorsteuer_ohne_zahlung = list;
            }),
        { clearCache: true },
    );
}
