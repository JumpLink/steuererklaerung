/**
 * Einstellungen — Betrieb (Stammdaten) + Umsatzsteuer section, built for business entities (hasElster)
 * from the entity's ELSTER config.
 *
 * Betrieb re-serialises the whole address block on every field apply (with PLZ / W-IdNr / USt-IdNr
 * validation → banner), the Umsatzsteuer rows persist one flag/value each. Every write drops the EÜR
 * cache (clearCache) so the tax views recompute, via the host's save contract.
 */

import Adw from '@girs/adw-1';

import {
    mutateElster,
    saveBetrieb,
    saveTaxNumber,
    saveUste,
    saveFlags,
    type ElsterBetrieb,
    type ElsterConfig,
} from '../../data/settings.ts';
import type { AppEntity } from '../../entities.ts';
import { comboRow, entryRow, spinRow, toggleRow, type SettingsHost } from './rows.ts';
import { validateSteuernummer } from '../../../../core/actions/validate-steuernummer.ts';
import { helpFor } from '../../widgets/glossary-help.ts';

// ── Betrieb (Stammdaten) ────────────────────────────────────────────────────────────────────────

/** The Betrieb entry-row widget bundle (rebuilt each reload; read back to serialise the block). */
interface BetriebWidgets {
    name: Adw.EntryRow;
    strasse: Adw.EntryRow;
    hausnummer: Adw.EntryRow;
    plz: Adw.EntryRow;
    ort: Adw.EntryRow;
    art: Adw.EntryRow;
    widnr: Adw.EntryRow;
    ustIdnr: Adw.EntryRow;
    rechtsform: Adw.ComboRow;
    einkunftsart: Adw.ComboRow;
}

/** The Betrieb address/identifier block for the Anlage-EÜR / Steuererklärung. */
export function buildBetriebGroup(host: SettingsHost, entity: AppEntity, elster: ElsterConfig): Adw.PreferencesGroup {
    const b = elster.betrieb;
    const group = new Adw.PreferencesGroup({
        title: 'Betrieb (Stammdaten)',
        description: 'Angaben für die Anlage-EÜR / Steuererklärung.',
    });

    const save = () => saveBetriebFromRows(host, entity, w);
    const mk = (title: string, text: string | undefined) => entryRow(host, title, text ?? '', save);
    const name = mk('Name', b?.name);
    const strasse = mk('Straße', b?.strasse);
    const hausnummer = mk('Hausnummer', b?.hausnummer);
    const plz = mk('PLZ', b?.plz);
    const ort = mk('Ort', b?.ort);
    const art = mk('Art der Tätigkeit', b?.art);
    // Two identifiers that usually carry the SAME value (see elster-config.ts): ELSTER's W-IdNr
    // fields take the 11-character core `DE`+9 digits — never the -00001 Unterscheidungsmerkmal.
    const widnr = mk('W-IdNr, 11-stellig ohne -00001 (DE123456789)', b?.widnr);
    const ustIdnr = mk('USt-IdNr (DE123456789)', b?.ust_idnr);
    // Two ELSTER code fields the form REQUIRES and nobody knows by heart. They are stored as the
    // codes ELSTER wants and shown as what they mean; the defaults (GbR / Gewerbebetrieb) are what
    // the config falls back to, so an untouched combo files the same value it always did.
    const rechtsform = codeRow(host, 'Rechtsform', RECHTSFORMEN, b?.rechtsform ?? DEFAULT_RECHTSFORM, save);
    const einkunftsart = codeRow(host, 'Einkunftsart', EINKUNFTSARTEN, b?.einkunftsart ?? DEFAULT_EINKUNFTSART, save);
    const w: BetriebWidgets = { name, strasse, hausnummer, plz, ort, art, widnr, ustIdnr, rechtsform, einkunftsart };
    for (const r of [name, strasse, hausnummer, plz, ort, art, widnr, ustIdnr, rechtsform, einkunftsart]) group.add(r);
    group.add(steuernummerRow(host, entity, elster));
    // The Unternehmereigenschaft window. The END date already had a row (it drives the closing
    // year); the START date decides which years the program may file at all and had none.
    group.add(
        entryRow(host, 'Betrieb eröffnet am (JJJJ-MM-TT)', elster.business_start_date ?? '', (t) => {
            const date = t.trim();
            if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                host.banner('Das Eröffnungsdatum muss JJJJ-MM-TT sein, z. B. 2019-04-01.');
                return;
            }
            host.saveWith(
                () =>
                    mutateElster(entity, (raw) => {
                        if (date) raw.business_start_date = date;
                        else delete raw.business_start_date;
                    }),
                { clearCache: true },
            );
        }),
    );
    return group;
}

/** ELSTER Rechtsform codes (E6000602) — the ones a user of this program plausibly is. */
const RECHTSFORMEN: ReadonlyArray<readonly [code: string, label: string]> = [
    // Short forms on purpose: the row renders `label (code)` in a ComboRow whose value column
    // ellipsises, and „Gesellschaft bürgerlichen Rechts (270)" came out as „Gesellschaft
    // bürgerlich…" — the code, the part that decides the filing, was the half that got cut.
    ['110', 'Einzelunternehmen'],
    ['270', 'GbR'],
    ['271', 'OHG'],
    ['280', 'KG'],
    ['290', 'GmbH & Co. KG'],
    ['141', 'PartG'],
];
const DEFAULT_RECHTSFORM = '270';

/** ELSTER Einkunftsart codes (E6000603). */
const EINKUNFTSARTEN: ReadonlyArray<readonly [code: string, label: string]> = [
    ['1', 'Land- und Forstwirtschaft'],
    ['2', 'Gewerbebetrieb'],
    ['3', 'Selbständige Arbeit'],
];
const DEFAULT_EINKUNFTSART = '2';

/**
 * A combo over (code, label) pairs that stores the CODE.
 *
 * A code the manifest already holds and this list does not is appended rather than dropped: the
 * list is the codes a user of this program plausibly needs, not the whole ELSTER catalogue, and
 * silently resetting an unknown code to the default would file a different Rechtsform than last year.
 */
function codeRow(
    host: SettingsHost,
    title: string,
    codes: ReadonlyArray<readonly [string, string]>,
    current: string,
    onChange: () => void,
): Adw.ComboRow {
    const known = codes.some(([code]) => code === current);
    const all = known ? [...codes] : [...codes, [current, `Code ${current}`] as const];
    const row = comboRow(
        host,
        title,
        all.map(([code, label]) => `${label} (${code})`),
        all.findIndex(([code]) => code === current),
        onChange,
    );
    // The code list travels with the row so the serialiser reads a code, not a label index.
    codeLists.set(
        row,
        all.map(([code]) => code),
    );
    return row;
}

/** Per-row code list for {@link codeRow}, so reading a row back yields the ELSTER code. */
const codeLists = new WeakMap<Adw.ComboRow, string[]>();

/** The ELSTER code a {@link codeRow} currently shows. */
function selectedCode(row: Adw.ComboRow, fallback: string): string {
    return codeLists.get(row)?.[row.get_selected()] ?? fallback;
}

/**
 * The Steuernummer — editable, and checked against ERiC where ERiC is installed.
 *
 * It gates every filing this program does, and it could be entered exactly ONCE, in the first-run
 * assistant, with no validation. A typo there was discovered by ELSTER rejecting a transmission
 * months later; a move to a different Finanzamt could not be recorded at all without opening the
 * manifest in an editor.
 *
 * The check runs on apply and reports WHO answered: ERiC's verdict is conclusive, a format check
 * is a shape check. Calling the latter "valid" would be a promise it cannot keep.
 */
function steuernummerRow(host: SettingsHost, entity: AppEntity, elster: ElsterConfig): Adw.EntryRow {
    const row = new Adw.EntryRow({ title: 'Steuernummer' });
    row.set_show_apply_button(true);
    row.set_text(elster.tax_number ?? '');
    row.connect('apply', () => {
        if (host.isFilling()) return;
        const value = (row.get_text() ?? '').trim();
        void validateSteuernummer(value).then((check) => {
            if (!check.ok) {
                // NOT saved on a failed check: an unusable Steuernummer in the manifest is worse
                // than the old one, because everything downstream keeps believing it.
                host.banner(`Steuernummer nicht übernommen — ${check.message}`);
                return;
            }
            host.saveWith(() => saveTaxNumber(entity, value), { clearCache: true });
            if (check.checked === 'format') host.banner(check.message);
        });
    });
    return row;
}

function saveBetriebFromRows(host: SettingsHost, entity: AppEntity, w: BetriebWidgets): void {
    const plz = (w.plz.get_text() ?? '').trim();
    if (!/^\d{5}$/.test(plz)) {
        host.banner('PLZ muss 5-stellig sein.');
        return;
    }
    const hausnummer = (w.hausnummer.get_text() ?? '').trim();
    const widnr = (w.widnr.get_text() ?? '').trim();
    const ustIdnr = (w.ustIdnr.get_text() ?? '').trim();
    if (widnr && !/^DE\d{9}$/.test(widnr)) {
        host.banner(
            'W-IdNr muss DE + 9 Ziffern sein (11 Zeichen) — ELSTER nimmt das Unterscheidungsmerkmal „-00001" nicht.',
        );
        return;
    }
    if (ustIdnr && !/^DE\d{9}$/.test(ustIdnr)) {
        host.banner('USt-IdNr muss DE + 9 Ziffern sein.');
        return;
    }
    const betrieb: ElsterBetrieb = {
        name: (w.name.get_text() ?? '').trim(),
        strasse: (w.strasse.get_text() ?? '').trim(),
        plz,
        ort: (w.ort.get_text() ?? '').trim(),
        art: (w.art.get_text() ?? '').trim(),
        ...(hausnummer ? { hausnummer } : {}),
        ...(widnr ? { widnr } : {}),
        ...(ustIdnr ? { ust_idnr: ustIdnr } : {}),
        rechtsform: selectedCode(w.rechtsform, DEFAULT_RECHTSFORM),
        einkunftsart: selectedCode(w.einkunftsart, DEFAULT_EINKUNFTSART),
    };
    host.saveWith(() => saveBetrieb(entity, betrieb), { clearCache: true });
}

// ── Umsatzsteuer ────────────────────────────────────────────────────────────────────────────────

/** The Umsatzsteuer flags/values: prepaid VAT, taxation basis, test mode, Dauerfristverlängerung. */
export function buildUstGroup(host: SettingsHost, entity: AppEntity, elster: ElsterConfig): Adw.PreferencesGroup {
    const group = helpFor(new Adw.PreferencesGroup({ title: 'Umsatzsteuer' }), 'ust-zahllast');
    const prepaid = spinRow(
        host,
        'Bereits gezahlte USt-Vorauszahlungen (€)',
        elster.uste?.prepaid_vat ?? 0,
        { digits: 2, lower: -100_000_000, upper: 100_000_000 },
        (v) => host.saveWith(() => saveUste(entity, { prepaid_vat: v }), { clearCache: true }),
    );
    const basis = comboRow(
        host,
        'Versteuerungsart',
        ['Ist-Versteuerung', 'Soll-Versteuerung'],
        elster.taxation_basis === 'soll' ? 1 : 0,
        (i) =>
            host.saveWith(() => saveFlags(entity, { taxation_basis: i === 1 ? 'soll' : 'ist' }), {
                clearCache: true,
            }),
    );
    const testMode = toggleRow(
        host,
        'Test-Modus (ELSTER Testmerker)',
        'Übermittlungen gehen an den ELSTER-Testserver.',
        elster.test_mode,
        (on) => host.saveWith(() => saveFlags(entity, { test_mode: on }), { clearCache: true }),
    );
    const dfv = toggleRow(host, 'USt-Dauerfristverlängerung', null, elster.ust_dauerfristverlaengerung, (on) =>
        host.saveWith(() => saveFlags(entity, { ust_dauerfristverlaengerung: on }), { clearCache: true }),
    );
    const months = spinRow(
        host,
        'Fristverlängerung (Monate)',
        elster.deadline_extension_months ?? 0,
        { digits: 0, lower: 0, upper: 12 },
        (v) =>
            host.saveWith(() => saveFlags(entity, { deadline_extension_months: Math.round(v) }), {
                clearCache: true,
            }),
    );
    for (const r of [prepaid, basis, testMode, dfv, months]) group.add(r);
    return group;
}
