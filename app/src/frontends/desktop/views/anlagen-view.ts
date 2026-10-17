/**
 * <BhAnlagenView> — the "Anlagen" tab (Anlageverzeichnis / Anlage AVEÜR) in the tax hub.
 *
 * Shows the Anlageverzeichnis computed from the config: per Wirtschaftsgut the year's linear AfA +
 * the Restbuchwert, grouped by AVEÜR asset class (bewegliche WG / Gebäude), with the grand totals
 * (Σ AfA des Jahres, Σ Restbuchwert 31.12.). The computation is PURE and synchronous — it calls the
 * same {@link computeAfa}/{@link afaGroupTotals} core as the EÜR (read-only for the display), no
 * Paperless fetch. Hence no spinner/loadIntoStack: the view rebuilds its page directly on every
 * `reload` (same pattern as BhSteuerAssistentView).
 *
 * Erfassen: the "＋ Wirtschaftsgut erfassen" button writes through the SAME path as the Einstellungen
 * editor ({@link saveAnlageverzeichnis} in abschluss.ts) — it appends the new Anlagegut to the list,
 * keeps the in-memory model (`entity.elster`) fresh and drops the EÜR aggregate cache so the tax
 * views recompute. That way the list stays the one source for `adjustments.anlageverzeichnis`.
 *
 * GJS GUI → not verifiable headless (sandbox Exit 144); build-verified, visually by the user.
 */

import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';
import Adw from '@girs/adw-1';

import type { AppEntity } from '../entities.ts';
import { appSession } from '../data/session.ts';
import { loadElster, type ElsterAnlagegut, type ElsterConfig } from '../data/settings.ts';
import { appendAnlagegut, newAnlage } from './einstellungen/abschluss.ts';
import {
    afaGroupTotals,
    computeAfa,
    type AfaAssetResult,
    type AfaResult,
    type Anlagegut,
    type AnlagegutArt,
} from '../../../core/elster/afa.ts';
import type { AnlagegutVorbelegung } from '../../../core/elster/hinweise.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { _, _n, fmt } from '../i18n.ts';
import { amountLabel, markup } from './util.ts';
import { wrapButtonLabel } from '../widgets/responsive.ts';
import { errorDialog } from './dialogs.ts';
import { showToast } from '../toast.ts';

/** AVEÜR asset classes in display order. */
const ART_ORDER: AnlagegutArt[] = ['beweglich', 'gebaeude'];

/**
 * Group heading and description per asset class.
 *
 * Functions, not `Record` constants: a constant is built at import time, which can be before the
 * frontend registers its translator — and a label resolved too early stays English for good.
 */
function artTitle(art: AnlagegutArt): string {
    return art === 'beweglich' ? _('Movable assets') : _('Buildings / fixtures');
}

function artDesc(art: AnlagegutArt): string {
    return art === 'beweglich'
        ? _('Depreciable movable assets — straight-line AfA (§7 (1) EStG).')
        : _('Immovable assets — building AfA.');
}

/**
 * Map the config Anlagegut (snake_case) to the AfA engine's camelCase shape. Kept local (mirrors the
 * mappers in the EÜR/XML builders) so the view needn't pull the Paperless-heavy actions module just
 * for a pure field rename.
 */
function toAnlagegut(a: ElsterAnlagegut): Anlagegut {
    return {
        id: a.id,
        bezeichnung: a.bezeichnung,
        anschaffung: a.anschaffung,
        ahk: a.ahk,
        nutzungsdauerJahre: a.nutzungsdauer_jahre,
        restbuchwertAnfang: a.restbuchwert_anfang,
        erinnerungswert: a.erinnerungswert,
        art: a.art,
    };
}

export class BhAnlagenView extends Adw.Bin {
    private currentEntity?: AppEntity;
    private currentYear = 0;
    /** Per asset id: the bookings an „Anlagegut?" hint captured it from (`buchung_ids`). */
    private buchungIds = new Map<string, string[]>();

    static {
        GObject.registerClass({ GTypeName: 'BhAnlagenView' }, this);
    }

    reload(entity: AppEntity, year: number): void {
        this.currentEntity = entity;
        this.currentYear = year;
        // A business entity without an ELSTER config can't have an Anlageverzeichnis — `loadElster`
        // throws, so show a friendly note instead of an error page (the hub already hides this tab for
        // `privat` entities via `businessOnly`).
        let config: ElsterConfig;
        try {
            config = loadElster(entity);
        } catch {
            this.set_child(this.noConfigPage());
            return;
        }
        this.render(config, year);
    }

    /** Compute the AfA plan for `config`/`year` and (re)build the page — content or empty state. */
    private render(config: ElsterConfig, year: number): void {
        const list = config.adjustments?.anlageverzeichnis ?? [];
        this.buchungIds = new Map(list.map((a) => [a.id, a.buchung_ids ?? []]));
        const assets = list.map(toAnlagegut);
        const result = computeAfa(assets, year, config.business_end_date);
        this.set_child(result.assets.length === 0 ? this.emptyPage(year) : this.contentPage(result, year));
        if (process.env.STEUER_APP_DEBUG) {
            console.error(
                `[app] Anlagen ${year} ok: ${result.assets.length} Anlagegut/-güter, ` +
                    `Σ AfA ${result.totalAfa.toFixed(2)}€, Σ RBW ${result.restbuchwertEnde.toFixed(2)}€`,
            );
        }
    }

    // ── Content ─────────────────────────────────────────────────────────────────────────────────────

    private contentPage(result: AfaResult, year: number): Gtk.Widget {
        const page = new Adw.PreferencesPage();

        // Summary group with the two grand totals + the "Erfassen" action in the header.
        const summary = new Adw.PreferencesGroup({
            title: fmt(_('Asset register {year}'), { year }),
            description: _('Anlage AVEÜR · straight-line AfA (§7 EStG). A yearly entry that moves no money.'),
        });
        summary.set_header_suffix(this.erfassenButton());
        const afaRow = new Adw.ActionRow({ title: _('Σ AfA for the year') });
        // A Betriebsaufgabe depreciates pro rata temporis — flag it so a below-annual Σ reads right.
        if (result.assets.some((a) => a.months < 12)) afaRow.set_subtitle(_('pro rata until business cessation'));
        afaRow.add_suffix(amountLabel(eur(result.totalAfa), { heading: true }));
        summary.add(afaRow);
        const rbwRow = new Adw.ActionRow({ title: _('Σ Residual book value (31.12.)') });
        rbwRow.add_suffix(amountLabel(eur(result.restbuchwertEnde), { heading: true }));
        summary.add(rbwRow);
        page.add(summary);

        // One detail group per present asset class. Per-group subtotals only when BOTH classes exist —
        // with a single class the subtotal would just repeat the grand Σ above.
        const present = ART_ORDER.filter((art) => result.assets.some((a) => a.art === art));
        const showSubtotals = present.length > 1;
        for (const art of present) page.add(this.artGroup(result, art, showSubtotals));

        return page;
    }

    /** A detail group for one asset class: one expander per asset (+ an optional Σ subtotal). */
    private artGroup(result: AfaResult, art: AnlagegutArt, showSubtotal: boolean): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({ title: artTitle(art), description: artDesc(art) });
        for (const a of result.assets.filter((x) => x.art === art)) group.add(this.assetRow(a));
        if (showSubtotal) {
            const t = afaGroupTotals(result, art);
            const sub = new Adw.ActionRow({
                title: _('Interim total'),
                subtitle: _('AfA for the year · residual book value (31.12.)'),
            });
            sub.add_suffix(amountLabel(eur(t.afa)));
            sub.add_suffix(amountLabel(eur(t.buchwertEnde)));
            group.add(sub);
        }
        return group;
    }

    /**
     * One asset as an expander: title = Bezeichnung, the AfA des Jahres as the collapsed suffix, and
     * the full line (AHK · Anschaffung · Nutzungsdauer · Restbuchwerte) inside.
     */
    private assetRow(a: AfaAssetResult): Adw.ExpanderRow {
        const row = new Adw.ExpanderRow({
            title: markup(a.bezeichnung.trim() || _('(no designation)')),
            subtitle: markup(
                fmt(_('AHK {ahk} · {date} · useful life {years} y.'), {
                    ahk: eur(a.ahk),
                    date: a.anschaffung ? deDate(a.anschaffung) : _('no date'),
                    years: a.nutzungsdauerJahre,
                }),
            ),
        });
        row.add_suffix(amountLabel(eur(a.afa)));
        row.add_row(this.detailRow(_('Acquisition/production cost (AHK)'), amountLabel(eur(a.ahk))));
        row.add_row(this.detailRow(_('Acquisition'), this.textValue(a.anschaffung ? deDate(a.anschaffung) : '—')));
        row.add_row(
            this.detailRow(
                _('Useful life'),
                this.textValue(fmt(_n('{n} year', '{n} years', a.nutzungsdauerJahre), { n: a.nutzungsdauerJahre })),
            ),
        );
        row.add_row(this.detailRow(_('Residual book value at 01.01.'), amountLabel(eur(a.restbuchwertAnfang))));
        const afa = new Adw.ActionRow({ title: _('AfA for the year') });
        if (a.months < 12) afa.set_subtitle(fmt(_('pro rata · {months}/12 months'), { months: a.months }));
        afa.add_suffix(amountLabel(eur(a.afa)));
        row.add_row(afa);
        row.add_row(this.detailRow(_('Residual book value at 31.12.'), amountLabel(eur(a.restbuchwertEnde))));
        const ids = this.buchungIds.get(a.id);
        if (ids?.length) {
            row.add_row(
                this.detailRow(
                    _('Paid with'),
                    this.textValue(fmt(_n('{n} booking', '{n} bookings', ids.length), { n: ids.length })),
                ),
            );
        }
        return row;
    }

    /** A read-only detail row: title left, the given value widget right-aligned. */
    private detailRow(title: string, value: Gtk.Widget): Adw.ActionRow {
        const row = new Adw.ActionRow({ title });
        row.add_suffix(value);
        return row;
    }

    /** A dim, right-aligned plain-text value (dates / durations — not a currency amount). */
    private textValue(text: string): Gtk.Label {
        return new Gtk.Label({ label: text, cssClasses: ['dim-label'], valign: Gtk.Align.CENTER });
    }

    // ── Erfassen (shared write path) ─────────────────────────────────────────────────────────────────

    /** The "＋ Record an asset" flat header action (opens the capture dialog). */
    private erfassenButton(): Gtk.Button {
        const btn = new Gtk.Button({
            label: _('＋ Record an asset'),
            cssClasses: ['flat'],
            valign: Gtk.Align.CENTER,
            tooltipText: _('Add a depreciable asset to the asset register'),
        });
        btn.connect('clicked', () => this.openErfassen());
        // As a group header suffix the caption sits beside the title and the description: on one
        // line it claimed 200 of 360 px, which cut the title to "Anlageverzeic…" and squeezed the
        // description into a column one word wide. Wrapped, it gives that space back when crowded.
        return wrapButtonLabel(btn);
    }

    private openErfassen(): void {
        const entity = this.currentEntity;
        if (!entity) return;
        openAnlagegutErfassen(this, entity, undefined, (updated) => this.render(updated, this.currentYear));
    }

    // ── Empty / no-config states ─────────────────────────────────────────────────────────────────────

    /** Friendly empty view for an entity with no assets yet — offers the first "Erfassen". */
    private emptyPage(year: number): Gtk.Widget {
        const status = new Adw.StatusPage({
            iconName: 'view-list-symbolic',
            title: _('No assets yet'),
            description:
                fmt(_('No asset is recorded in the asset register for {year}.'), { year }) +
                ' ' +
                _('Record a depreciable asset (AHK, useful life) for the Anlage AVEÜR.'),
        });
        const btn = new Gtk.Button({
            label: _('＋ Record an asset'),
            halign: Gtk.Align.CENTER,
            cssClasses: ['suggested-action', 'pill'],
        });
        btn.connect('clicked', () => this.openErfassen());
        status.set_child(btn);
        return status;
    }

    /** A business entity without an ELSTER config: no Anlageverzeichnis to show. */
    private noConfigPage(): Gtk.Widget {
        return new Adw.StatusPage({
            iconName: 'dialog-information-symbolic',
            title: _('No ELSTER configuration'),
            description:
                _('The asset register belongs to the Anlage AVEÜR (EÜR/business entities only).') +
                ' ' +
                _('No ELSTER configuration is stored for this entity.'),
        });
    }
}

/**
 * Capture a new asset in a small form dialog, then persist it through the shared {@link appendAnlagegut}
 * write path (append to the on-disk list). `vorbelegung` comes from an „Anlagegut?" hint (Idee 10): the
 * fields start filled and the paying bookings are stored with the asset (`buchung_ids`), so the hint
 * knows it is captured; every field stays editable. On success the in-memory `entity.elster` is
 * refreshed and the session cache dropped so the EÜR/tax views recompute.
 */
export function openAnlagegutErfassen(
    parent: Gtk.Widget,
    entity: AppEntity,
    vorbelegung?: AnlagegutVorbelegung,
    onSaved?: (updated: ElsterConfig) => void,
): void {
    const dialog = new Adw.PreferencesDialog();
    dialog.set_title(_('Record an asset'));
    const page = new Adw.PreferencesPage();

    const group = new Adw.PreferencesGroup({
        title: _('Asset'),
        description: vorbelegung
            ? fmt(
                  _n(
                      'Prefilled from {n} booking — check the useful life and the designation.',
                      'Prefilled from {n} bookings — check the useful life and the designation.',
                      vorbelegung.buchungIds.length,
                  ),
                  { n: vorbelegung.buchungIds.length },
              )
            : _('Depreciable asset for the Anlage AVEÜR (straight-line AfA).'),
    });
    const bezeichnung = new Adw.EntryRow({ title: _('Designation'), text: vorbelegung?.bezeichnung ?? '' });
    const anschaffung = new Adw.EntryRow({
        title: _('Acquisition (YYYY-MM-DD)'),
        text: vorbelegung?.anschaffung ?? '',
    });
    const ahk = new Adw.SpinRow({
        title: _('Acquisition cost AHK (€)'),
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 100_000_000, stepIncrement: 0.01, pageIncrement: 100 }),
        digits: 2,
    });
    const nutzungsdauer = new Adw.SpinRow({
        title: _('Useful life (years)'),
        adjustment: new Gtk.Adjustment({ lower: 1, upper: 100, stepIncrement: 1, pageIncrement: 5 }),
        digits: 0,
    });
    // Set after construction: a `value` among the constructor props is clamped against the default
    // upper bound 0 before `upper` applies, and the row showed 0 — which the schema then refused.
    nutzungsdauer.set_value(1);
    const restbuchwert = new Adw.SpinRow({
        title: _('Residual book value at 01.01. (€)'),
        subtitle: _('Book value at the start of the year — in the year of acquisition = AHK'),
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 100_000_000, stepIncrement: 0.01, pageIncrement: 100 }),
        digits: 2,
    });
    if (vorbelegung) {
        ahk.set_value(vorbelegung.ahk);
        restbuchwert.set_value(vorbelegung.ahk);
    }
    const artModel = new Gtk.StringList();
    for (const l of [_('Movable'), _('Building')]) artModel.append(l);
    const art = new Adw.ComboRow({ title: _('Type'), model: artModel });
    for (const r of [bezeichnung, anschaffung, ahk, nutzungsdauer, restbuchwert, art]) group.add(r);
    page.add(group);

    const actions = new Adw.PreferencesGroup();
    const erfassen = new Adw.ButtonRow({ title: _('Record') });
    erfassen.add_css_class('suggested-action');
    erfassen.connect('activated', () => {
        void persistErfassen(entity, dialog, erfassen, onSaved, {
            bezeichnung: bezeichnung.get_text()?.trim() ?? '',
            anschaffung: anschaffung.get_text()?.trim() ?? '',
            ahk: money2(ahk.get_value()),
            nutzungsdauer_jahre: Math.round(nutzungsdauer.get_value()),
            restbuchwert_anfang: money2(restbuchwert.get_value()),
            art: art.get_selected() === 1 ? 'gebaeude' : 'beweglich',
            ...(vorbelegung?.buchungIds.length ? { buchung_ids: vorbelegung.buchungIds } : {}),
        });
    });
    actions.add(erfassen);
    page.add(actions);

    dialog.add(page);
    dialog.present(parent);
}

/** Validate + append one captured asset, persist via the shared path, refresh model + caller. */
async function persistErfassen(
    entity: AppEntity,
    dialog: Adw.PreferencesDialog,
    button: Adw.ButtonRow,
    onSaved: ((updated: ElsterConfig) => void) | undefined,
    fields: Pick<
        ElsterAnlagegut,
        'bezeichnung' | 'anschaffung' | 'ahk' | 'nutzungsdauer_jahre' | 'restbuchwert_anfang' | 'art' | 'buchung_ids'
    >,
): Promise<void> {
    if (!fields.bezeichnung) {
        await errorDialog(dialog, _('Designation missing'), _('Please give the asset a designation.'));
        return;
    }
    // `newAnlage()` supplies a fresh id + the schema defaults (erinnerungswert) the form omits.
    const item: ElsterAnlagegut = { ...newAnlage(), ...fields };
    button.set_sensitive(false);
    button.set_title(_('Recording …'));
    try {
        const updated = appendAnlagegut(entity, item); // append on the authoritative on-disk list
        entity.elster = updated; // keep the shared in-memory model in sync with disk for later reloads
        appSession().invalidate(entity.id); // drop the EÜR aggregate cache so the tax views recompute
        dialog.close();
        showToast(_('Asset recorded'));
        onSaved?.(updated);
    } catch (err) {
        button.set_sensitive(true);
        button.set_title(_('Record'));
        await errorDialog(dialog, _('Recording failed'), err instanceof Error ? err.message : String(err));
    }
}

/** Round a money value to 2 decimals — SpinRow stepping can accumulate float noise (see abschluss.ts). */
function money2(value: number): number {
    return Math.round(value * 100) / 100;
}
