/**
 * Einstellungen — private-ESt section (the privat entity, hasEst): Person + the active year's
 * Lohnsteuerbescheinigung / Vorsorgeaufwendungen / Werbungskosten / Entlastungsbetrag (§24b).
 *
 * Person persists field-by-field (the Steuer-IdNr is validated + never logged); the year blocks write
 * through saveEstJahr for the flat Lohn figures and through the raw mutateEst seam for the nested
 * vorsorge / werbungskosten / entlastung_alleinerziehende blocks. Every write drops the EÜR cache via
 * the host's save contract.
 */

import Adw from '@girs/adw-1';

import { saveEstPerson, saveEstJahr, mutateEst, estJahr, type EstConfig } from '../../data/settings.ts';
import type { AppEntity } from '../../entities.ts';
import { entlastungBetrag } from '../../../../core/actions/elster/est-intake-topics.ts';
import { comboRow, entryRow, spinRow, toggleRow, type SettingsHost } from './rows.ts';
import { markup } from '../util.ts';
import { _, _n, fmt } from '../../i18n.ts';

/** Church-tax rate options (fraction) ⇄ the ComboRow index. */
const KIRCHENSTEUER_RATES = [0, 0.08, 0.09];

/** Amtliche Religionsschlüssel (`E0100402`) ⇄ the ComboRow index — codes nobody knows by heart. */
const RELIGIONEN: ReadonlyArray<readonly [code: string, label: string]> = [
    ['11', _('None / not liable for church tax')],
    ['02', _('Protestant')],
    ['03', _('Roman Catholic')],
    ['04', _('Old Catholic')],
    ['05', _('Free religious')],
    ['06', _('Jewish')],
];

/** The Religionsschlüssel as a combo over its meanings, storing the two-digit code. */
function religionRow(host: SettingsHost, entity: AppEntity, current: string | undefined): Adw.ComboRow {
    const codes = RELIGIONEN.map(([code]) => code);
    const index = Math.max(0, codes.indexOf(current ?? '11'));
    return comboRow(
        host,
        _('Religion (church tax)'),
        RELIGIONEN.map(([, label]) => label),
        index,
        (i) => host.saveWith(() => saveEstPerson(entity, { religion: codes[i] ?? '11' }), { clearCache: true }),
    );
}

// ── Person ────────────────────────────────────────────────────────────────────────────────────

export function buildPersonGroup(host: SettingsHost, entity: AppEntity, est: EstConfig): Adw.PreferencesGroup {
    const p = est.person;
    const group = new Adw.PreferencesGroup({ title: _('Person') });
    const name = entryRow(host, _('Name'), p.name ?? '', (t) =>
        host.saveWith(() => saveEstPerson(entity, { name: t.trim() }), { clearCache: true }),
    );
    const steuerId = entryRow(host, _('Steuer-IdNr (11 digits)'), p.steuer_id ?? '', (t) =>
        saveSteuerId(host, entity, t),
    );
    // The rest of the E10 Hauptvordruck identity. Every one of these is a field the XML asks for and
    // the app could not set — a return prepared entirely in this window came out with no Finanzamt,
    // no Beruf and no Religionsschlüssel, and nothing in the window said anything was missing.
    const person = (
        title: string,
        value: string | undefined,
        key: 'steuernummer' | 'finanzamt' | 'bundesland' | 'beruf' | 'telefon',
    ) =>
        entryRow(host, title, value ?? '', (t) =>
            host.saveWith(() => saveEstPerson(entity, { [key]: t.trim() || undefined }), { clearCache: true }),
        );
    const steuernummer = person(_('Steuernummer (FF/BBB/UUUUP)'), p.steuernummer, 'steuernummer');
    const finanzamt = person(_('Finanzamt'), p.finanzamt, 'finanzamt');
    const bundesland = person(_('Federal state'), p.bundesland, 'bundesland');
    const beruf = person(_('Occupation'), p.beruf, 'beruf');
    const telefon = person(_('Phone (for queries)'), p.telefon, 'telefon');
    const religion = religionRow(host, entity, p.religion);
    const veranlagung = comboRow(
        host,
        _('Assessment'),
        [_('Individual assessment'), _('Joint assessment (splitting)')],
        est.veranlagung === 'splitting' ? 1 : 0,
        (i) =>
            host.saveWith(
                () =>
                    mutateEst(entity, (raw) => {
                        raw.veranlagung = i === 1 ? 'splitting' : 'einzel';
                    }),
                { clearCache: true },
            ),
    );
    const abgabeExtern = toggleRow(
        host,
        _('Files their own return'),
        _(
            'This person files their income tax return themselves — then no income tax deadline is reminded here. The calculation stays usable.',
        ),
        est.abgabe_extern === true,
        (on) =>
            host.saveWith(
                () =>
                    mutateEst(entity, (raw) => {
                        raw.abgabe_extern = on;
                    }),
                { clearCache: true },
            ),
    );
    const kinder = spinRow(host, _('Children'), p.kinder ?? 0, { digits: 0, lower: 0, upper: 20 }, (v) =>
        host.saveWith(() => saveEstPerson(entity, { kinder: Math.round(v) }), { clearCache: true }),
    );
    const kirche = comboRow(
        host,
        _('Church tax rate'),
        ['0 %', '8 %', '9 %'],
        kirchensteuerIndex(p.kirchensteuersatz),
        (i) =>
            host.saveWith(() => saveEstPerson(entity, { kirchensteuersatz: KIRCHENSTEUER_RATES[i] ?? 0 }), {
                clearCache: true,
            }),
    );
    for (const r of [
        name,
        steuerId,
        steuernummer,
        finanzamt,
        bundesland,
        beruf,
        telefon,
        religion,
        veranlagung,
        abgabeExtern,
        kinder,
        kirche,
    ]) {
        group.add(r);
    }
    return group;
}

/** Validate the 11-digit Steuer-IdNr before saving; blank clears it. Never logged (private data). */
function saveSteuerId(host: SettingsHost, entity: AppEntity, text: string): void {
    const value = text.trim();
    if (value === '') {
        host.saveWith(() => saveEstPerson(entity, { steuer_id: undefined }), { clearCache: true });
        return;
    }
    if (!/^\d{11}$/.test(value)) {
        host.banner(_('The Steuer-IdNr must have 11 digits.'));
        return;
    }
    host.saveWith(() => saveEstPerson(entity, { steuer_id: value }), { clearCache: true });
}

// ── Lohnsteuerbescheinigung «year» ──────────────────────────────────────────────────────────────

export function buildLohnGroup(
    host: SettingsHost,
    entity: AppEntity,
    est: EstConfig,
    year: number,
): Adw.PreferencesGroup {
    const j = estJahr(est, year);
    const group = new Adw.PreferencesGroup({ title: fmt(_('Lohnsteuerbescheinigung {year}'), { year }) });
    const money = (title: string, value: number | undefined, save: (v: number) => void, allowNeg = false) =>
        spinRow(host, title, value ?? 0, { digits: 2, lower: allowNeg ? -100_000_000 : 0, upper: 100_000_000 }, (v) =>
            host.saveWith(() => save(v), { clearCache: true }),
        );
    const brutto = money(_('Gross wages (€)'), j?.bruttoarbeitslohn, (v) =>
        saveEstJahr(entity, year, { bruttoarbeitslohn: v }),
    );
    const lohnsteuer = money(_('Wage tax (€)'), j?.lohnsteuer, (v) => saveEstJahr(entity, year, { lohnsteuer: v }));
    const soli = money(_('Solidarity surcharge (€)'), j?.soli, (v) => saveEstJahr(entity, year, { soli: v }));
    const kirche = money(_('Church tax (€)'), j?.kirchensteuer, (v) => saveEstJahr(entity, year, { kirchensteuer: v }));
    const gewerbe = money(
        _('Income from a trade or business (EÜR profit) (€)'),
        j?.einkuenfte_gewerbe,
        (v) => saveEstJahr(entity, year, { einkuenfte_gewerbe: v }),
        true,
    );
    // Mandatory in the XML as soon as there is a figure above them: the Steuerklasse for the Lohn line,
    // the Bezeichnung for the Gewerbe. ERiC rejects both when missing — and both were settable only in
    // the manifest.
    const steuerklasse = comboRow(
        host,
        _('Tax class'),
        [_('(not specified)'), 'I', 'II', 'III', 'IV', 'V', 'VI'],
        j?.steuerklasse ?? 0,
        (i) => host.saveWith(() => saveEstJahr(entity, year, { steuerklasse: i || undefined }), { clearCache: true }),
    );
    const vorauszahlung = money(_('Income tax prepayments made (€)'), j?.est_vorauszahlung, (v) =>
        saveEstJahr(entity, year, { est_vorauszahlung: v }),
    );
    const bezeichnung = entryRow(host, _('Name of the trade or business'), j?.gewerbe_bezeichnung ?? '', (t) =>
        host.saveWith(() => saveEstJahr(entity, year, { gewerbe_bezeichnung: t.trim() || undefined }), {
            clearCache: true,
        }),
    );
    // Declares WHICH entity's Anlage EÜR the figure above is a copy of, so the cross-checks can compare
    // the two instead of letting the copy go stale.
    const quelle = entryRow(host, _('Source of the EÜR profit (entity ID)'), j?.einkuenfte_gewerbe_quelle ?? '', (t) =>
        host.saveWith(() => saveEstJahr(entity, year, { einkuenfte_gewerbe_quelle: t.trim() || undefined }), {
            clearCache: true,
        }),
    );
    for (const r of [brutto, steuerklasse, lohnsteuer, soli, kirche, vorauszahlung, gewerbe, quelle, bezeichnung]) {
        group.add(r);
    }
    return group;
}

// ── Vorsorgeaufwendungen «year» ─────────────────────────────────────────────────────────────────

export function buildVorsorgeGroup(
    host: SettingsHost,
    entity: AppEntity,
    est: EstConfig,
    year: number,
): Adw.PreferencesGroup {
    const v = estJahr(est, year)?.vorsorge;
    const group = new Adw.PreferencesGroup({ title: fmt(_('Insurance contributions {year}'), { year }) });
    const money = (title: string, value: number | undefined, key: string) =>
        spinRow(host, title, value ?? 0, { digits: 2, lower: 0, upper: 100_000_000 }, (val) =>
            mutateJahrBlock(host, entity, year, 'vorsorge', { [key]: val }),
        );
    const rv = money(_('Pension insurance (employee) (€)'), v?.rv_arbeitnehmer, 'rv_arbeitnehmer');
    const kv = money(_('Health insurance (basic) (€)'), v?.kv_basis, 'kv_basis');
    const pv = money(_('Long-term care insurance (basic) (€)'), v?.pv_basis, 'pv_basis');
    const rvAg = money(
        _('Pension insurance (tax-free employer share) (€)'),
        v?.rv_arbeitgeber_steuerfrei,
        'rv_arbeitgeber_steuerfrei',
    );
    const av = money(_('Unemployment insurance (employee) (€)'), v?.av_arbeitnehmer, 'av_arbeitnehmer');
    const sonstige = money(_('Other insurance contributions (€)'), v?.sonstige, 'sonstige');
    const agZuschuss = toggleRow(host, _('Employer subsidy'), null, v?.ag_zuschuss ?? true, (on) =>
        mutateJahrBlock(host, entity, year, 'vorsorge', { ag_zuschuss: on }),
    );
    for (const r of [rv, rvAg, kv, pv, av, sonstige, agZuschuss]) group.add(r);
    return group;
}

// ── Werbungskosten «year» ───────────────────────────────────────────────────────────────────────

export function buildWerbungGroup(
    host: SettingsHost,
    entity: AppEntity,
    est: EstConfig,
    year: number,
): Adw.PreferencesGroup {
    const wk = estJahr(est, year)?.werbungskosten;
    const group = new Adw.PreferencesGroup({
        title: fmt(_('Work-related expenses {year}'), { year }),
        description: _(
            'Individual work-expense items and the commuting allowance are currently maintained through the configuration / the assistant.',
        ),
    });
    const homeoffice = spinRow(
        host,
        _('Home-office days'),
        wk?.homeoffice_tage ?? 0,
        { digits: 0, lower: 0, upper: 365 },
        (v) => mutateJahrBlock(host, entity, year, 'werbungskosten', { homeoffice_tage: Math.round(v) }),
    );
    group.add(homeoffice);
    // Two legally different E10 lines, not a nuance: E0204507 with another workplace available,
    // E0206206 without. The XML needs the answer as soon as there is a single Homeoffice day.
    group.add(
        toggleRow(
            host,
            _('Another workplace was available'),
            _('Off for “permanently no other workplace” — that is a line of its own on the form.'),
            wk?.homeoffice_anderer_arbeitsplatz ?? true,
            (on) => mutateJahrBlock(host, entity, year, 'werbungskosten', { homeoffice_anderer_arbeitsplatz: on }),
        ),
    );
    // Compact read-only summary of the posten array + Pendel (no array editor this pass).
    const postenCount = wk?.posten?.length ?? 0;
    const pendel = wk?.pendel;
    const pendelText = pendel
        ? fmt(_('{days} days × {km} km'), { days: pendel.arbeitstage, km: pendel.km_einfach })
        : _('not set');
    group.add(
        new Adw.ActionRow({
            title: _('Further items'),
            subtitle: markup(
                [
                    fmt(_n('{n} individual item', '{n} individual items', postenCount), { n: postenCount }),
                    fmt(_('Commuting allowance: {pendel}'), { pendel: pendelText }),
                ].join(' · '),
            ),
        }),
    );
    return group;
}

// ── Sonderausgaben · außergewöhnliche Belastungen · §35a «year» ─────────────────────────────────

/**
 * The deductions a person claims by ASSERTING them — no employer sends a certificate for a donation,
 * a Handwerker invoice or a school fee.
 *
 * They were reachable only through the manifest or the assistant, which made the app's own claim
 * ("usable without AI") false in the place it matters most: these are the entries that move the
 * refund, and every one of them left at 0 is money the return does not ask for. The bounds are
 * deliberately generous — a plausibility limit here would be this program deciding what a person's
 * medical bills are allowed to be.
 */
export function buildAbzuegeGroup(
    host: SettingsHost,
    entity: AppEntity,
    est: EstConfig,
    year: number,
): Adw.PreferencesGroup {
    const j = estJahr(est, year);
    const group = new Adw.PreferencesGroup({
        title: fmt(_('Special expenses and burdens {year}'), { year }),
        description: _('Amounts nobody reports — donations, medical costs, tradespeople, school fees.'),
    });
    const money = (title: string, value: number | undefined, save: (v: number) => void) =>
        spinRow(host, title, value ?? 0, { digits: 2, lower: 0, upper: 100_000_000 }, (v) =>
            host.saveWith(() => save(v), { clearCache: true }),
        );
    const jahr = (
        title: string,
        value: number | undefined,
        key:
            | 'gezahlte_kirchensteuer'
            | 'spenden'
            | 'krankheitskosten'
            | 'schulgeld'
            | 'kinderbetreuung'
            | 'parteibeitrag',
    ) => money(title, value, (v) => saveEstJahr(entity, year, { [key]: v }));

    group.add(jahr(_('Church tax paid (§10 (1) no. 4) (€)'), j?.gezahlte_kirchensteuer, 'gezahlte_kirchensteuer'));
    group.add(jahr(_('Donations (in addition to detected bookings) (€)'), j?.spenden, 'spenden'));
    group.add(jahr(_('Party dues and donations (§34g) (€)'), j?.parteibeitrag, 'parteibeitrag'));
    group.add(jahr(_('School fees (§10 (1) no. 9, the tuition share only) (€)'), j?.schulgeld, 'schulgeld'));
    group.add(jahr(_('Childcare costs (§10 (1) no. 5) (€)'), j?.kinderbetreuung, 'kinderbetreuung'));
    group.add(
        jahr(
            _('Medical costs (extraordinary burden, in addition to detected bookings) (€)'),
            j?.krankheitskosten,
            'krankheitskosten',
        ),
    );

    // §35a amounts with no transaction of their own — typically the service share of a
    // Nebenkostenabrechnung, which arrives as one line on a statement and is not a payment.
    const par35a = new Adw.ExpanderRow({
        title: _('Household-related services (§35a) without a booking of their own'),
        subtitle: _('For example the service shares from a service-charge statement.'),
    });
    const p35 = j?.par35a_manuell;
    for (const [key, title] of [
        ['handwerker', _('Tradesperson services (labour share) (€)')],
        ['haushaltsnah', _('Household-related services (€)')],
        ['minijob', _('Household-related mini-jobs (€)')],
    ] as const) {
        par35a.add_row(
            spinRow(host, title, p35?.[key] ?? 0, { digits: 2, lower: 0, upper: 100_000_000 }, (v) =>
                mutateJahrBlock(host, entity, year, 'par35a_manuell', { [key]: v }),
            ),
        );
    }
    group.add(par35a);

    // Progressionsvorbehalt: the repayment is a separate field on purpose (§11 Abflussprinzip), and
    // netting it into one number by hand is how a repayment year gets filed as a smaller receipt.
    const ersatz = new Adw.ExpanderRow({
        title: _('Wage replacement benefits (§32b)'),
        subtitle: _('Parental, unemployment, sickness and maternity benefits — they change the tax rate.'),
    });
    for (const [key, title] of [
        ['erhalten', _('Received during the year (€)')],
        ['zurueckgezahlt', _('Repaid during the year (€)')],
    ] as const) {
        ersatz.add_row(
            spinRow(host, title, j?.lohnersatz?.[key] ?? 0, { digits: 2, lower: 0, upper: 100_000_000 }, (v) =>
                mutateJahrBlock(host, entity, year, 'lohnersatz', { [key]: v }),
            ),
        );
    }
    group.add(ersatz);
    return group;
}

// ── Entlastungsbetrag für Alleinerziehende (§24b) «year» ───────────────────────────────────────

export function buildEntlastungGroup(
    host: SettingsHost,
    entity: AppEntity,
    est: EstConfig,
    year: number,
): Adw.PreferencesGroup {
    const e = estJahr(est, year)?.entlastung_alleinerziehende;
    const monate = e?.monate ?? 0;
    const weitereKinder = e?.weitere_kinder ?? 0;
    const group = new Adw.PreferencesGroup({
        title: fmt(_('Single-parent allowance (§24b) {year}'), { year }),
        description: _(
            'For single people with at least one child in the household (no second adult): 4,260 € + 240 € per further child, pro rata per month.',
        ),
    });
    // Live preview: saveWith() does NOT reload the view, so recompute the amount in the row handlers
    // (§24b since VZ 2023: 4.260 € Grundbetrag + 240 € per further child, pro rata monate/12).
    let curMonate = monate;
    let curWeitere = weitereKinder;
    const preview = new Adw.ActionRow({ title: _('Expected allowance') });
    const refreshPreview = () => {
        preview.set_subtitle(markup(`${entlastungBetrag(curMonate, curWeitere)} € (${curMonate}/12)`));
    };
    refreshPreview();
    const monateRow = spinRow(host, _('Months as a single parent'), monate, { digits: 0, lower: 0, upper: 12 }, (v) => {
        curMonate = Math.round(v);
        refreshPreview();
        mutateEntlastung(host, entity, year, { monate: curMonate });
    });
    monateRow.set_subtitle(_('e.g. from when the other parent moved out; 0 = no entitlement'));
    const weitereRow = spinRow(
        host,
        _('Further children in the household'),
        weitereKinder,
        { digits: 0, lower: 0, upper: 20 },
        (v) => {
            curWeitere = Math.round(v);
            refreshPreview();
            mutateEntlastung(host, entity, year, { weitere_kinder: curWeitere });
        },
    );
    const kindOptions = ['—', ...est.kinder.map((k) => (k.idnr ? `${k.vorname} (${k.idnr})` : k.vorname))];
    const kindIndex = e?.kind_idnr ? est.kinder.findIndex((k) => k.idnr === e.kind_idnr) + 1 : 0;
    const kindRow = comboRow(host, _('Child (base amount)'), kindOptions, Math.max(0, kindIndex), (i) =>
        mutateEntlastung(host, entity, year, { kind_idnr: i > 0 ? est.kinder[i - 1]?.idnr : undefined }),
    );
    for (const r of [monateRow, weitereRow, kindRow, preview]) group.add(r);
    return group;
}

/**
 * Merge a partial patch into `jahre[year].entlastung_alleinerziehende` via the same raw mutation seam
 * as {@link mutateJahrBlock} — preserves the other fields (monate/weitere_kinder/kind_idnr) instead of
 * replacing the whole object. Seeds a minimal year row (bruttoarbeitslohn required) if none exists yet.
 */
function mutateEntlastung(host: SettingsHost, entity: AppEntity, year: number, patch: Record<string, unknown>): void {
    host.saveWith(
        () =>
            mutateEst(entity, (raw) => {
                const jahre = Array.isArray(raw.jahre) ? (raw.jahre as Array<Record<string, unknown>>) : [];
                raw.jahre = jahre;
                let entry = jahre.find((j) => (j as { jahr?: number }).jahr === year);
                if (!entry) {
                    entry = { jahr: year, bruttoarbeitslohn: 0 };
                    jahre.push(entry);
                }
                entry.entlastung_alleinerziehende = {
                    ...(entry.entlastung_alleinerziehende as Record<string, unknown> | undefined),
                    ...patch,
                };
            }),
        { clearCache: true },
    );
}

/**
 * Merge a partial patch into `jahre[year].<block>` via the raw mutation seam — used for the nested
 * vorsorge/werbungskosten blocks whose normalised (defaulted) shape saveEstJahr's Partial can't
 * express. Seeds a minimal year row (bruttoarbeitslohn required) if none exists yet.
 */
function mutateJahrBlock(
    host: SettingsHost,
    entity: AppEntity,
    year: number,
    block: 'vorsorge' | 'werbungskosten' | 'par35a_manuell' | 'lohnersatz',
    patch: Record<string, unknown>,
): void {
    host.saveWith(
        () =>
            mutateEst(entity, (raw) => {
                const jahre = Array.isArray(raw.jahre) ? (raw.jahre as Array<Record<string, unknown>>) : [];
                raw.jahre = jahre;
                let entry = jahre.find((j) => (j as { jahr?: number }).jahr === year);
                if (!entry) {
                    entry = { jahr: year, bruttoarbeitslohn: 0 };
                    jahre.push(entry);
                }
                entry[block] = { ...(entry[block] as Record<string, unknown> | undefined), ...patch };
            }),
        { clearCache: true },
    );
}

/** The ComboRow index for a church-tax fraction (0 / 0.08 / 0.09). */
function kirchensteuerIndex(rate: number): number {
    if (Math.abs(rate - 0.09) < 1e-6) return 2;
    if (Math.abs(rate - 0.08) < 1e-6) return 1;
    return 0;
}
