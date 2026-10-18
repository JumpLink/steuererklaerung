/**
 * <BhProjektDetailDialog> — one project with what it earned (Idee 14): the Projektergebnis of the year
 * (Umsatz − Kosten, hours and the result per hour), the issued invoices behind the Umsatz, the expenses
 * assigned to it with where each assignment comes from, and the project's rules.
 *
 * Every figure is the core's (`presenters/projekt.ts`); the dialog reads it again after each change, so
 * what it shows is what the CLI and the MCP tool would answer. The result is an internal evaluation, not
 * a tax figure — the header says so.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { deDate, eur } from '../../../core/lib/format.ts';
import { fmtDe } from '../../../core/lib/money.ts';
import {
    legeProjektRegelAn,
    loadProjektAnsicht,
    loeseProjektRegel,
    nimmProjektZuordnungZurueck,
    weiseProjektZu,
    type ProjektAnsicht,
} from '../../../core/presenters/projekt.ts';
import { appSession } from '../data/session.ts';
import { _, _n, _p, fmt } from '../i18n.ts';
import type { AppEntity } from '../entities.ts';
import { showToast } from '../toast.ts';
import { BhGlossaryHelp, lernmodusOn } from '../widgets/glossary-help.ts';
import { errorDialog } from './dialogs.ts';
import { amountLabel, markup } from './util.ts';

export class BhProjektDetailDialog {
    private dialog!: Adw.Dialog;
    private entity!: AppEntity;
    private year = 0;
    private projectId = '';
    private onChanged: () => void = () => {};
    private page: Adw.PreferencesPage | null = null;
    private shownGroups: Adw.PreferencesGroup[] = [];

    open(
        parent: Gtk.Widget,
        entity: AppEntity,
        year: number,
        projectId: string,
        hooks: { onEdit: () => void; onChanged: () => void },
    ): void {
        this.entity = entity;
        this.year = year;
        this.projectId = projectId;
        this.onChanged = hooks.onChanged;
        this.dialog = new Adw.Dialog({ title: _('Project'), contentWidth: 600, contentHeight: 720 });

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        const edit = new Gtk.Button({ label: _('Edit') });
        edit.set_tooltip_text(_('Change the name, customer, domains and contact person of the project'));
        edit.connect('clicked', () => {
            this.dialog.close();
            hooks.onEdit();
        });
        header.pack_start(edit);
        toolbar.add_top_bar(header);
        this.page = new Adw.PreferencesPage();
        toolbar.set_content(this.page);
        this.dialog.set_child(toolbar);
        this.dialog.present(parent);
        void this.refresh();
    }

    /** Re-read the figures and rebuild the groups — after every write, so the dialog never shows stale costs. */
    private async refresh(): Promise<void> {
        try {
            const a = await loadProjektAnsicht(appSession(), this.entity, this.year);
            this.render(a);
        } catch (err) {
            void errorDialog(
                this.dialog,
                _('The project could not be loaded'),
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    private render(a: ProjektAnsicht): void {
        const page = this.page;
        if (!page) return;
        for (const g of this.shownGroups) page.remove(g);
        this.shownGroups = [];
        const add = (g: Adw.PreferencesGroup) => {
            page.add(g);
            this.shownGroups.push(g);
        };
        const p = a.projekte.find((x) => x.projectId === this.projectId);
        if (!p) {
            this.dialog.close();
            return;
        }
        this.dialog.set_title(p.name);

        const ergebnis = new Adw.PreferencesGroup({
            // markup-ok: numbers / catalogue text only
            title: fmt(_('Project result {year}'), { year: a.year }),
            description: markup(_('Internal evaluation, not a tax figure. Net, without VAT.')),
        });
        ergebnis.set_header_suffix(new BhGlossaryHelp('projektergebnis', lernmodusOn()));
        const zeile = (title: string, subtitle: string, value: number, accent?: 'success' | 'error') => {
            const row = new Adw.ActionRow({ title, subtitle: markup(subtitle) });
            row.add_suffix(amountLabel(eur(value), { accent }));
            ergebnis.add(row);
        };
        zeile(
            _('Revenue'),
            fmt(_n('{n} invoice', '{n} invoices', p.rechnungen.length), { n: p.rechnungen.length }),
            p.umsatz,
        );
        zeile(
            _('Costs'),
            fmt(_n('{n} expense', '{n} expenses', p.ausgaben.length), { n: p.ausgaben.length }),
            p.kosten === 0 ? 0 : -p.kosten,
        );
        zeile(_('Result'), _('Revenue − costs'), p.ergebnis, p.ergebnis >= 0 ? 'success' : 'error');
        if (p.stunden != null) {
            const h = new Adw.ActionRow({
                title: _('Hours'),
                subtitle: markup(fmt(_('{hours} h recorded'), { hours: fmtDe(p.stunden) })),
            });
            h.add_suffix(
                amountLabel(`${eur(p.ergebnisProStunde ?? 0)} / h`, {
                    accent: (p.ergebnisProStunde ?? 0) >= 0 ? 'success' : 'error',
                }),
            );
            ergebnis.add(h);
        }
        add(ergebnis);

        const kosten = new Adw.PreferencesGroup({
            title: _('Costs'),
            description: markup(_('Assigned expenses, net. Private and neutral parts do not count.')),
        });
        if (p.ausgaben.length === 0) {
            kosten.add(
                new Adw.ActionRow({
                    title: _('No expenses assigned yet'),
                    subtitle: markup(_('In “Bookings”, mark them with “Select” and choose “Assign to project”.')),
                }),
            );
        }
        const sorted = [...p.ausgaben].sort((x, y) => y.bookingDate.localeCompare(x.bookingDate));
        for (const k of sorted) {
            const wer = k.counterparty?.trim() || k.purpose?.trim() || k.category;
            const teil = k.teilNr != null ? ` · ${fmt(_('Part {n}'), { n: k.teilNr })}` : '';
            const row = new Adw.ActionRow({
                title: markup(wer),
                subtitle: markup(`${deDate(k.bookingDate)} · ${k.category}${teil} · ${k.herkunft.label}`),
            });
            row.set_title_lines(1);
            row.add_suffix(amountLabel(eur(-k.net), { accent: 'error' }));
            const manuell = k.herkunft.art === 'manuell';
            const button = new Gtk.Button({
                label: manuell ? _('Take back') : _('Remove'),
                valign: Gtk.Align.CENTER,
                cssClasses: ['flat'],
            });
            button.set_tooltip_text(
                fmt(manuell ? _('Take the assignment back: {what}') : _('Take out of the project: {what}'), {
                    what: k.counterparty?.trim() || k.purpose?.trim() || k.txId,
                }),
            );
            button.connect('clicked', () => void this.nimmHeraus(k.txId, k.teilNr, manuell));
            row.add_suffix(button);
            kosten.add(row);
        }
        add(kosten);

        if (p.rechnungen.length > 0 || p.rechnungenOhneProjekt > 0) {
            const rechnungen = new Adw.PreferencesGroup({ title: _('Invoices') });
            if (p.rechnungenOhneProjekt > 0) {
                rechnungen.set_description(
                    markup(
                        fmt(
                            _n(
                                '{n} invoice of this customer without a project — assign it in the invoice under “Project”.',
                                '{n} invoices of this customer without a project — assign them in the invoice under “Project”.',
                                p.rechnungenOhneProjekt,
                            ),
                            { n: p.rechnungenOhneProjekt },
                        ),
                    ),
                );
            }
            for (const r of p.rechnungen) {
                const anteil =
                    r.anteil < 1
                        ? ` · ${fmt(_('{percent} % of the hours'), { percent: Math.round(r.anteil * 100) })}`
                        : '';
                const row = new Adw.ActionRow({
                    title: markup(r.nummer ?? _('(draft)')),
                    subtitle: markup(
                        `${deDate(r.datum)} · ${r.herkunft === 'direkt' ? _('assigned directly') : _('via time entries')}${anteil}`,
                    ),
                });
                row.add_suffix(amountLabel(eur(r.netto)));
                rechnungen.add(row);
            }
            add(rechnungen);
        }

        add(this.regelGroup(a, p.projectId));
    }

    /** Take an expense out of the project: a decision is taken back, a rule's hit is told „kein Projekt". */
    private async nimmHeraus(txId: string, teilNr: number | undefined, manuell: boolean): Promise<void> {
        try {
            const session = appSession();
            if (manuell) {
                const r = await nimmProjektZuordnungZurueck(session, this.entity, this.year, [txId], { teilNr });
                showToast(r.zurueckgenommen[0]?.danach ?? _('Assignment taken back'));
            } else {
                await weiseProjektZu(session, this.entity, this.year, [txId], null, { decidedBy: 'app' });
                showToast(_('Taken out of the project — the rule now leaves this expense alone'));
            }
            this.onChanged();
            await this.refresh();
        } catch (err) {
            void errorDialog(this.dialog, _('Could not change'), err instanceof Error ? err.message : String(err));
        }
    }

    private regelGroup(a: ProjektAnsicht, projectId: string): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: _('Project rules'),
            description: markup(
                _(
                    'An expense whose counterparty, purpose or reference contains the pattern belongs to this project. An assignment by hand wins.',
                ),
            ),
        });
        const eigene = a.regeln.filter((r) => r.projekt === projectId);
        for (const r of eigene) {
            const aus = r.ausnahmen?.length
                ? ` · ${fmt(_n('{n} exception', '{n} exceptions', r.ausnahmen.length), { n: r.ausnahmen.length })}`
                : '';
            const row = new Adw.ActionRow({
                title: markup(fmt(_('“{pattern}”'), { pattern: r.muster })),
                subtitle: markup(
                    `${fmt(_n('assigns {n} expense', 'assigns {n} expenses', r.treffer), { n: r.treffer })}${aus}`,
                ),
            });
            const button = new Gtk.Button({ label: _('Remove rule'), valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
            button.set_tooltip_text(fmt(_('Remove rule: {pattern}'), { pattern: r.muster }));
            button.connect('clicked', () => {
                try {
                    loeseProjektRegel(appSession(), this.entity, r.muster, projectId);
                    showToast(_('Rule removed — assignments by hand stay'));
                    this.onChanged();
                    void this.refresh();
                } catch (err) {
                    void errorDialog(
                        this.dialog,
                        _p('rule', 'Could not remove'),
                        err instanceof Error ? err.message : String(err),
                    );
                }
            });
            row.add_suffix(button);
            group.add(row);
        }
        const neu = new Adw.EntryRow({ title: _('New rule: pattern'), showApplyButton: true });
        neu.connect('apply', () => {
            const muster = neu.get_text().trim();
            if (!muster) return;
            try {
                const r = legeProjektRegelAn(appSession(), this.entity, muster, projectId);
                showToast(
                    r.added
                        ? fmt(_('Rule remembered: “{pattern}”'), { pattern: markup(muster) })
                        : _('This rule already existed'),
                );
                this.onChanged();
                void this.refresh();
            } catch (err) {
                void errorDialog(this.dialog, _('Could not save'), err instanceof Error ? err.message : String(err));
            }
        });
        group.add(neu);
        return group;
    }
}
