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
        this.dialog = new Adw.Dialog({ title: 'Projekt', contentWidth: 600, contentHeight: 720 });

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        const edit = new Gtk.Button({ label: 'Bearbeiten' });
        edit.set_tooltip_text('Name, Kunde, Domains und Kontaktperson des Projekts ändern');
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
                'Projekt konnte nicht geladen werden',
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
            title: `Projektergebnis ${a.year}`,
            description: markup('Interne Auswertung, keine Steuerzahl. Netto, ohne Umsatzsteuer.'),
        });
        ergebnis.set_header_suffix(new BhGlossaryHelp('projektergebnis', lernmodusOn()));
        const zeile = (title: string, subtitle: string, value: number, accent?: 'success' | 'error') => {
            const row = new Adw.ActionRow({ title, subtitle: markup(subtitle) });
            row.add_suffix(amountLabel(eur(value), { accent }));
            ergebnis.add(row);
        };
        zeile('Umsatz', p.rechnungen.length === 1 ? '1 Rechnung' : `${p.rechnungen.length} Rechnungen`, p.umsatz);
        zeile(
            'Kosten',
            p.ausgaben.length === 1 ? '1 Ausgabe' : `${p.ausgaben.length} Ausgaben`,
            p.kosten === 0 ? 0 : -p.kosten,
        );
        zeile('Ergebnis', 'Umsatz − Kosten', p.ergebnis, p.ergebnis >= 0 ? 'success' : 'error');
        if (p.stunden != null) {
            const h = new Adw.ActionRow({
                title: 'Stunden',
                subtitle: markup(`${fmtDe(p.stunden)} h erfasst`),
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
            title: 'Kosten',
            description: markup('Zugeordnete Ausgaben, netto. Private und neutrale Teile zählen nicht.'),
        });
        if (p.ausgaben.length === 0) {
            kosten.add(
                new Adw.ActionRow({
                    title: 'Noch keine Ausgaben zugeordnet',
                    subtitle: markup('In „Buchungen“ mit „Auswählen“ markieren und „Projekt zuordnen“ wählen.'),
                }),
            );
        }
        const sorted = [...p.ausgaben].sort((x, y) => y.bookingDate.localeCompare(x.bookingDate));
        for (const k of sorted) {
            const wer = k.counterparty?.trim() || k.purpose?.trim() || k.category;
            const teil = k.teilNr != null ? ` · Teil ${k.teilNr}` : '';
            const row = new Adw.ActionRow({
                title: markup(wer),
                subtitle: markup(`${deDate(k.bookingDate)} · ${k.category}${teil} · ${k.herkunft.label}`),
            });
            row.set_title_lines(1);
            row.add_suffix(amountLabel(eur(-k.net), { accent: 'error' }));
            const manuell = k.herkunft.art === 'manuell';
            const button = new Gtk.Button({
                label: manuell ? 'Zurücknehmen' : 'Entfernen',
                valign: Gtk.Align.CENTER,
                cssClasses: ['flat'],
            });
            button.set_tooltip_text(
                `${manuell ? 'Zuordnung zurücknehmen' : 'Aus dem Projekt nehmen'}: ${k.counterparty?.trim() || k.purpose?.trim() || k.txId}`,
            );
            button.connect('clicked', () => void this.nimmHeraus(k.txId, k.teilNr, manuell));
            row.add_suffix(button);
            kosten.add(row);
        }
        add(kosten);

        if (p.rechnungen.length > 0 || p.rechnungenOhneProjekt > 0) {
            const rechnungen = new Adw.PreferencesGroup({ title: 'Rechnungen' });
            if (p.rechnungenOhneProjekt > 0) {
                rechnungen.set_description(
                    markup(
                        `${p.rechnungenOhneProjekt === 1 ? '1 Rechnung' : `${p.rechnungenOhneProjekt} Rechnungen`} ohne Projekt dieses Kunden — in der Rechnung unter „Projekt“ zuordnen.`,
                    ),
                );
            }
            for (const r of p.rechnungen) {
                const anteil = r.anteil < 1 ? ` · ${Math.round(r.anteil * 100)} % der Stunden` : '';
                const row = new Adw.ActionRow({
                    title: markup(r.nummer ?? '(Entwurf)'),
                    subtitle: markup(
                        `${deDate(r.datum)} · ${r.herkunft === 'direkt' ? 'direkt zugeordnet' : 'über Zeiten'}${anteil}`,
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
                showToast(r.zurueckgenommen[0]?.danach ?? 'Zuordnung zurückgenommen');
            } else {
                await weiseProjektZu(session, this.entity, this.year, [txId], null, { decidedBy: 'app' });
                showToast('Aus dem Projekt genommen — die Regel lässt diese Ausgabe jetzt aus');
            }
            this.onChanged();
            await this.refresh();
        } catch (err) {
            void errorDialog(this.dialog, 'Konnte nicht ändern', err instanceof Error ? err.message : String(err));
        }
    }

    private regelGroup(a: ProjektAnsicht, projectId: string): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: 'Projektregeln',
            description: markup(
                'Eine Ausgabe, deren Gegenseite, Zweck oder Referenz das Muster enthält, gehört zu diesem Projekt. ' +
                    'Eine Zuordnung von Hand gewinnt.',
            ),
        });
        const eigene = a.regeln.filter((r) => r.projekt === projectId);
        for (const r of eigene) {
            const aus = r.ausnahmen?.length ? ` · ${r.ausnahmen.length} Ausnahme(n)` : '';
            const row = new Adw.ActionRow({
                title: markup(`„${r.muster}“`),
                subtitle: markup(`ordnet ${r.treffer} Ausgabe(n) zu${aus}`),
            });
            const button = new Gtk.Button({ label: 'Regel entfernen', valign: Gtk.Align.CENTER, cssClasses: ['flat'] });
            button.set_tooltip_text(`Regel entfernen: ${r.muster}`);
            button.connect('clicked', () => {
                try {
                    loeseProjektRegel(appSession(), this.entity, r.muster, projectId);
                    showToast('Regel entfernt — Zuordnungen von Hand bleiben');
                    this.onChanged();
                    void this.refresh();
                } catch (err) {
                    void errorDialog(
                        this.dialog,
                        'Konnte nicht entfernen',
                        err instanceof Error ? err.message : String(err),
                    );
                }
            });
            row.add_suffix(button);
            group.add(row);
        }
        const neu = new Adw.EntryRow({ title: 'Neue Regel: Muster', showApplyButton: true });
        neu.connect('apply', () => {
            const muster = neu.get_text().trim();
            if (!muster) return;
            try {
                const r = legeProjektRegelAn(appSession(), this.entity, muster, projectId);
                showToast(r.added ? `Regel gemerkt: „${markup(muster)}“` : 'Diese Regel gab es schon');
                this.onChanged();
                void this.refresh();
            } catch (err) {
                void errorDialog(
                    this.dialog,
                    'Konnte nicht speichern',
                    err instanceof Error ? err.message : String(err),
                );
            }
        });
        group.add(neu);
        return group;
    }
}
