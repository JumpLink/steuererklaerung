/**
 * <BhUstvaView> — the USt-VA (Umsatzsteuer-Voranmeldung) review view.
 *
 * Shows every quarter of the reporting year that has USt-relevant documents: the headline
 * Kennzahlen (Kz 81 steuerpfl. Umsätze 19 %, Umsatzsteuer, Kz 66 Vorsteuer, Kz 83 Zahllast) and,
 * behind an expander, the included in-/outgoing documents — so the figures the CLI `elster ustva
 * generate-xml` writes can be cross-checked before upload to Mein ELSTER.
 *
 * Above the quarters, „Vor der Abgabe klären" lists the findings to look at before filing (Idee 10).
 *
 * The aggregate is computed by the same aggregator the CLI uses (see data/ustva.ts). That call is
 * async and fetches Paperless, so the view loads with a spinner (loadIntoStack) and drops a stale
 * result if the entity/year changes mid-fetch. Only entities with an ELSTER config reach this view.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './ustva-view.blp';
import { loadUstvaYear, ustvaUploadXml, type UstvaQuarter } from '../data/ustva.ts';
import type { UstvaDocumentDetail } from '../../../core/elster/ustva-aggregate.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { LoadToken, amountLabel, loadIntoStack, markup, saveFileViaDialog } from './util.ts';
import { importBmfRates } from '../../../core/config/bmf-import.ts';
import { errorDialog } from './dialogs.ts';
import { BhGlossaryHelp, lernmodusOn } from '../widgets/glossary-help.ts';
import { appSession } from '../data/session.ts';
import { showToast } from '../toast.ts';
import { loadVorAbgabeHinweise, type YearHinweis } from '../../../core/presenters/hinweise.ts';
import { vorAbgabeGroup } from './vor-abgabe-group.ts';

export class BhUstvaView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _quarters_box: Gtk.Box;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhUstvaView',
                Template,
                InternalChildren: ['stack', 'error_page', 'quarters_box'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private currentEntity: AppEntity | null = null;

    reload(entity: AppEntity, year: number): void {
        this.currentEntity = entity;
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'USt-VA konnte nicht berechnet werden',
            load: () =>
                Promise.all([
                    loadUstvaYear(entity, year),
                    // Fail-soft: a hint that cannot be computed must not hide the Voranmeldung itself.
                    loadVorAbgabeHinweise(appSession(), entity, year).catch(() => [] as YearHinweis[]),
                ]),
            fill: ([quarters, hinweise]) => {
                this.fill(quarters, year);
                const klaeren = vorAbgabeGroup(
                    this,
                    { entity, year, onChanged: () => this.reload(entity, year) },
                    hinweise,
                );
                if (klaeren) this._quarters_box.prepend(klaeren);
            },
        });
    }

    private clearBox(): void {
        let child = this._quarters_box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._quarters_box.remove(child);
            child = next;
        }
    }

    private fill(quarters: UstvaQuarter[], year: number): void {
        this.clearBox();
        const withData = quarters.filter((q) => q.outgoing.length > 0 || q.incoming.length > 0);

        if (withData.length === 0) {
            const group = new Adw.PreferencesGroup({ title: `USt-VA ${year}` });
            group.add(new Adw.ActionRow({ title: 'Keine USt-relevanten Belege in diesem Jahr' }));
            this._quarters_box.append(group);
            return;
        }

        for (const q of withData) this.addQuarter(q, year);

        if (process.env.STEUER_APP_DEBUG) {
            console.error(
                `[app] USt-VA ${year} ok: ${withData.length} Quartal(e) mit Daten ` +
                    `(${withData.map((q) => `Q${q.quarter}=${q.zahllast.toFixed(2)}€`).join(', ')})`,
            );
        }
    }

    private addQuarter(q: UstvaQuarter, year: number): void {
        const a = q.aggregate;
        const group = new Adw.PreferencesGroup({
            title: `Q${q.quarter} ${year}`,
            description: 'Umsatzsteuer-Voranmeldung · Ist-Versteuerung',
        });
        group.set_header_suffix(this.exportButton(q, year));

        // The "?" goes on the ROWS here, not on the group header: that slot already holds the
        // export button, and the terms a stranger stumbles over are the line items anyway.
        const lernmodus = lernmodusOn();
        const summary = (title: string, label: Gtk.Label, term?: string): void => {
            const row = new Adw.ActionRow({ title });
            if (term) row.add_prefix(new BhGlossaryHelp(term, lernmodus));
            row.add_suffix(label);
            group.add(row);
        };
        summary('Steuerpfl. Umsätze 19 % (Kz 81)', amountLabel(eur(a.net_19)));
        if (a.net_7 > 0) summary('Steuerpfl. Umsätze 7 % (Kz 86)', amountLabel(eur(a.net_7)));
        summary('Umsatzsteuer', amountLabel(eur(a.vat_out)), 'vereinnahmte-ust');
        summary('Vorsteuer (Kz 66)', amountLabel(eur(a.vat_in)), 'vorsteuer');
        summary(
            'Zahllast (Kz 83)',
            amountLabel(eur(q.zahllast), { heading: true, accent: q.zahllast < 0 ? 'success' : undefined }),
            'ust-zahllast',
        );

        if (q.missingBmfRates.length > 0) {
            // Missing conversion rates block a correct figure — flag it as a warning (icon + amber) and
            // let the full list wrap rather than truncate, so it can actually be acted on.
            const warn = new Adw.ActionRow({
                title: 'Fehlende BMF-Umrechnungskurse',
                // NOT "in bmf-umrechnungskurse.json ergänzen" any more: naming a file the user must
                // open in an editor is the same dead end as naming a command, and the header now
                // carries a "Kurse laden" button that does it.
                subtitle: markup(
                    q.missingBmfRates.map((m) => `#${m.id} ${m.currency} ${m.month}`).join(', ') +
                        ' — „Kurse laden" holt sie vom Bundesfinanzministerium.',
                ),
            });
            warn.set_subtitle_lines(0);
            warn.add_prefix(
                new Gtk.Image({
                    iconName: 'dialog-warning-symbolic',
                    cssClasses: ['warning'],
                    valign: Gtk.Align.CENTER,
                }),
            );
            group.add(warn);
        }

        const belege = new Adw.ExpanderRow({
            title: 'Belege',
            subtitle: `${q.outgoing.length} Ausgang · ${q.incoming.length} Eingang`,
        });
        for (const d of q.outgoing) belege.add_row(this.docRow(d, 'Ausgang'));
        for (const d of q.incoming) belege.add_row(this.docRow(d, 'Eingang'));
        group.add(belege);

        this._quarters_box.append(group);
    }

    /**
     * A per-quarter "Für Mein ELSTER (XML)" save button — exports the plain `<Anmeldungssteuern>`
     * ISO-8859-15 file (buildUstvaPortalUpload) for the Mein-ELSTER XML-Import. Disabled when BMF
     * conversion rates are missing (foreign-currency docs would be silently excluded → wrong
     * figures) — fix bmf-umrechnungskurse.json first, then re-export.
     */
    private exportButton(q: UstvaQuarter, year: number): Gtk.Widget {
        const blocked = q.missingBmfRates.length > 0;
        if (!blocked) {
            const btn = new Gtk.Button({
                label: 'Für Mein ELSTER (XML)',
                tooltipText: 'Umsatzsteuer-Voranmeldung als XML für den Mein-ELSTER-Upload speichern',
                cssClasses: ['flat'],
                valign: Gtk.Align.CENTER,
            });
            btn.connect('clicked', () => this.exportXml(q, year));
            return btn;
        }

        // The export is blocked because a foreign-currency receipt would be silently dropped from
        // the figures without a conversion rate. The old tooltip named a CLI command — a dead end
        // in a GUI, and the one thing an app must never answer a user with. Now the button DOES the
        // import: the pieces (fetch, parse, write) already existed, they just had no door.
        const btn = new Gtk.Button({
            label: 'Kurse laden',
            tooltipText: `Fehlende BMF-Umrechnungskurse (${q.missingBmfRates.join(', ')}) von bundesfinanzministerium.de laden`,
            valign: Gtk.Align.CENTER,
        });
        btn.add_css_class('suggested-action');
        btn.connect('clicked', () => void this.loadBmfRates(btn, year));
        return btn;
    }

    /** Fetch + write the official rates, then reload so the export unblocks itself. */
    private async loadBmfRates(btn: Gtk.Button, year: number): Promise<void> {
        btn.set_sensitive(false);
        btn.set_label('Lade …');
        try {
            const result = await importBmfRates(year);
            showToast(
                `BMF-Kurse ${result.year} geladen: ${result.added} neu, ${result.updated} aktualisiert ` +
                    `(${result.currencies.length} Währungen)`,
                5,
            );
            const entity = this.currentEntity;
            if (entity) {
                // The rates change what the aggregate computes, not just this button's state.
                appSession().invalidate(entity.id, year);
                this.reload(entity, year);
            }
        } catch (err) {
            btn.set_sensitive(true);
            btn.set_label('Kurse laden');
            void errorDialog(
                this,
                'Kurse konnten nicht geladen werden',
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    private exportXml(q: UstvaQuarter, year: number): void {
        const entity = this.currentEntity;
        if (!entity) return;
        try {
            const { filename, bytes } = ustvaUploadXml(entity, year, q.quarter, q.aggregate);
            saveFileViaDialog(this, filename, bytes, `USt-VA Q${q.quarter} ${year} (XML)`);
        } catch (err) {
            void errorDialog(this, 'XML nicht verfügbar', err instanceof Error ? err.message : String(err));
        }
    }

    private docRow(d: UstvaDocumentDetail, direction: string): Adw.ActionRow {
        const parts = [direction, d.date_used ? deDate(d.date_used) : '—'];
        if (d.total_net != null) parts.push(`netto ${eur(d.total_net)}`);
        if (d.invoice_currency && d.invoice_currency.toUpperCase() !== 'EUR') parts.push(d.invoice_currency);
        const row = new Adw.ActionRow({
            title: markup(d.title ?? `#${d.id}`),
            subtitle: markup(parts.join(' · ')),
        });
        row.add_suffix(amountLabel(eur(d.tax_amount ?? 0)));
        return row;
    }
}
