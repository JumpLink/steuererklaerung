/**
 * <BhTxDetailDialog> — the transaction detail sheet, opened from a row click in the Buchungen view.
 * The native counterpart of the web <bh-tx-detail>: ALL available info for one booking, grouped —
 * Überblick, EÜR-Klassifizierung, the linked Paperless receipt, PayPal/Umbuchung links, and the raw
 * bank fields, in an Adw.Dialog of Adw.PreferencesGroups (a value is skipped when empty).
 *
 * It used to be READ-ONLY, and said so — which made the Buchungen list, the view a person actually
 * scrolls when they think "that one is booked wrong", a dead end. Reclassifying was reachable only
 * from a figure in the EÜR, through the Herleitung drill-down. Now the classification group carries
 * an Umbuchen button — and „Aufteilen" (Idee 13) for a booking that belongs to several categories.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import Gio from '@girs/gio-2.0';

import type { EnrichedTxRow } from '../../../core/presenters/buchungen.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { markup } from './util.ts';
import type { AppEntity } from '../entities.ts';
import { showToast } from '../toast.ts';
import { BhUmbuchenDialog } from './umbuchen-dialog.ts';
import { removeDecision } from '../data/decisions.ts';
import { appSession } from '../data/session.ts';
import { herkunftText, istAufteilung, istErstattung, wasGiltDanach } from '../../../core/elster/zu-pruefen.ts';
import { BhAufteilenDialog, aufteilungAufheben } from './aufteilen-dialog.ts';
import { loeseErstattung } from '../../../core/presenters/erstattungen.ts';
import { erstattungGroup } from './erstattung-group.ts';
import { errorDialog } from './dialogs.ts';
import { nimmProjektZuordnungZurueck, type BuchungProjektAnsicht } from '../../../core/presenters/projekt.ts';
import { BhProjektZuordnenDialog, type ProjektOption } from './projekt-zuordnen-dialog.ts';

/** ClassSource → German label (mirrors the web view-helpers SOURCE_LABEL). */
const SOURCE_LABEL: Record<string, string> = {
    document: 'Beleg',
    rule: 'Regel',
    manual: 'manuell',
    unclassified: 'unklassifiziert',
    transfer: 'Umbuchung',
};
const KIND_LABEL: Record<string, string> = {
    income: 'Einnahme',
    expense: 'Ausgabe',
    neutral: 'neutral',
};

export class BhTxDetailDialog {
    /** Present the detail for one booking. `paperlessBase` (if set) enables the "open document" link. */
    open(
        parent: Gtk.Widget,
        row: EnrichedTxRow,
        paperlessBase?: string | null,
        edit?: {
            entity: AppEntity;
            year: number;
            onChanged: () => void;
            /** The entity's projects and this booking's assignment (business entities). */
            projekt?: { projekte: ProjektOption[]; ansicht: BuchungProjektAnsicht | null };
        },
    ): void {
        const dialog = new Adw.Dialog({ title: 'Buchung', contentWidth: 540, contentHeight: 680 });

        const page = new Adw.PreferencesPage();
        page.add(this.overviewGroup(row));
        // The EÜR classification only applies to a business entity; a raw privat row has no category.
        // An incoming payment may refund an earlier debit — asked right under the booking, because the
        // answer decides the classification below. Hidden while there is no candidate.
        if (edit && row.category && row.amount > 0 && !istErstattung(row)) {
            page.add(
                erstattungGroup(dialog, edit.entity, edit.year, row.id, () => {
                    dialog.close();
                    edit.onChanged();
                }),
            );
        }
        if (row.category) page.add(this.classGroup(row, dialog, edit));
        if (edit?.projekt && row.category && row.amount < 0) page.add(this.projektGroup(row, dialog, edit));
        const beleg = this.belegGroup(row, paperlessBase);
        if (beleg) page.add(beleg);
        const links = this.linksGroup(row);
        if (links) page.add(links);
        page.add(this.bankGroup(row));

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        toolbar.set_content(page);
        dialog.set_child(toolbar);
        dialog.present(parent);
    }

    /** One "label → value" row; returns null (skipped) when the value is empty. */
    private row(label: string, value: string | null | undefined): Adw.ActionRow | null {
        if (value == null || value === '') return null;
        const r = new Adw.ActionRow({ title: label, subtitle: value });
        r.set_subtitle_selectable(true);
        r.set_subtitle_lines(0);
        return r;
    }

    private fill(group: Adw.PreferencesGroup, rows: (Adw.ActionRow | null)[]): Adw.PreferencesGroup | null {
        const present = rows.filter((r): r is Adw.ActionRow => r != null);
        if (present.length === 0) return null;
        for (const r of present) group.add(r);
        return group;
    }

    private overviewGroup(r: EnrichedTxRow): Adw.PreferencesGroup {
        // Hero header (mirrors the web <bh-modal-amt>): counterparty · date+account · big signed amount.
        const account = r.account?.trim();
        const group = new Adw.PreferencesGroup({
            title: r.counterparty?.trim() || '—',
            description: [deDate(r.bookingDate), account].filter(Boolean).join('  ·  '),
        });
        const accent = r.amount < 0 ? 'error' : r.amount > 0 ? 'success' : undefined;
        group.set_header_suffix(
            new Gtk.Label({
                label: eur(r.amount),
                cssClasses: ['title-2', 'numeric', ...(accent ? [accent] : [])],
                valign: Gtk.Align.CENTER,
            }),
        );
        // The hero already carries counterparty + date + amount, so the body only adds the extras.
        this.fill(group, [
            this.row('Wertstellung', r.raw?.valueDate ? deDate(r.raw.valueDate) : ''),
            this.row('Verwendungszweck', r.purpose),
        ]);
        return group;
    }

    private classGroup(
        r: EnrichedTxRow,
        dialog: Adw.Dialog,
        edit?: { entity: AppEntity; year: number; onChanged: () => void },
    ): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({ title: 'Klassifizierung (EÜR)' });
        const geteilt = istAufteilung(r);
        if (edit) {
            const buttons = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
            const aufteilen = new Gtk.Button({ label: geteilt ? 'Aufteilung ändern' : 'Aufteilen' });
            aufteilen.set_tooltip_text('Die Buchung in Teile mit eigener Kategorie und eigenem Steuersatz zerlegen');
            aufteilen.connect('clicked', () =>
                new BhAufteilenDialog(edit.entity, edit.year, r.id, () => {
                    dialog.close();
                    edit.onChanged();
                }).present(dialog),
            );
            buttons.append(aufteilen);
            const button = new Gtk.Button({ label: 'Umbuchen', valign: Gtk.Align.CENTER, visible: !geteilt });
            button.connect('clicked', () => {
                const umbuchen = new BhUmbuchenDialog(
                    edit.entity,
                    edit.year,
                    {
                        transactionId: r.id,
                        category: r.category,
                        source: r.source,
                        counterparty: r.counterparty,
                        purpose: r.purpose,
                        note: r.note,
                        danach: wasGiltDanach(r) ?? undefined,
                    },
                    (message, changed) => {
                        showToast(message);
                        if (!changed) return;
                        // The category is what the EÜR sums, so both the list and the shared
                        // aggregate behind it are stale — close and let the caller reload.
                        dialog.close();
                        edit.onChanged();
                    },
                );
                umbuchen.present(dialog);
            });
            buttons.append(button);
            group.set_header_suffix(buttons);
        }
        this.fill(group, [
            this.row('Kategorie', r.category),
            this.row('Herkunft', r.matchedRule || r.source !== 'rule' ? herkunftText(r) : SOURCE_LABEL[r.source]),
            r.matchedRule ? null : this.row('Regel', r.rule),
        ]);
        // The parts of a split booking, each with what it books (Idee 13).
        for (const p of r.aufteilung ?? []) {
            const part = new Adw.ActionRow({
                title: `Teil ${p.nr}${p.rest ? ' · Rest' : ''}`,
                subtitle: `${p.category} · ${Math.round(p.vatRate * 100)} %${p.betrieblich ? '' : ' · privat, keine Vorsteuer'}`,
            });
            part.set_subtitle_lines(0);
            part.add_suffix(new Gtk.Label({ label: eur(p.betrag), cssClasses: ['numeric'], valign: Gtk.Align.CENTER }));
            group.add(part);
        }
        // Right under „Herkunft: manuell" — where the question „and without my Umbuchung?" arises.
        const undo = edit ? this.undoRow(r, dialog, edit) : null;
        if (undo) group.add(undo);
        this.fill(group, [
            this.row('Kennzahl', r.kz ? `Kz ${r.kz}` : ''),
            this.row('Art', KIND_LABEL[r.kind] ?? r.kind),
            this.row('Netto', eur(r.net)),
            this.row('Umsatzsteuer', eur(r.vat)),
            this.row('Brutto', eur(r.gross)),
        ]);
        return group;
    }

    /**
     * The booking's project (Idee 14): the project and where the assignment comes from, a button to set
     * it, and „Zuordnung zurücknehmen“ with the sentence what applies afterwards when the person decided.
     */
    private projektGroup(
        r: EnrichedTxRow,
        dialog: Adw.Dialog,
        edit: {
            entity: AppEntity;
            year: number;
            onChanged: () => void;
            projekt?: { projekte: ProjektOption[]; ansicht: BuchungProjektAnsicht | null };
        },
    ): Adw.PreferencesGroup {
        const projekt = edit.projekt!;
        const group = new Adw.PreferencesGroup({ title: 'Projekt' });
        const zuordnen = new Gtk.Button({ label: 'Projekt zuordnen', valign: Gtk.Align.CENTER });
        zuordnen.set_tooltip_text('Diese Ausgabe einem Projekt zuordnen');
        zuordnen.connect('clicked', () =>
            new BhProjektZuordnenDialog(edit.entity, edit.year, [r.id], projekt.projekte, true, (message) => {
                showToast(message);
                dialog.close();
                edit.onChanged();
            }).present(dialog),
        );
        group.set_header_suffix(zuordnen);

        const a = projekt.ansicht;
        for (const p of a?.projekte ?? []) {
            const teil = r.aufteilung && p.teilNr > 0 ? `Teil ${p.teilNr} · ` : '';
            group.add(new Adw.ActionRow({ title: markup(p.projektName), subtitle: markup(`${teil}${p.herkunft}`) }));
        }
        if (!a?.projekte.length) {
            group.add(
                new Adw.ActionRow({
                    title: 'Kein Projekt',
                    subtitle: a?.ausgenommen ? 'manuell: kein Projekt' : 'Keine Zuordnung und keine Regel',
                }),
            );
        }
        if (a?.hatEntscheidung && a.danach) {
            const row = new Adw.ActionRow({ title: 'Zuordnung zurücknehmen', subtitle: markup(a.danach) });
            row.set_subtitle_lines(0);
            const button = new Gtk.Button({ label: 'Zurücknehmen', valign: Gtk.Align.CENTER });
            button.add_css_class('destructive-action');
            button.set_tooltip_text(`Zuordnung zurücknehmen: ${r.counterparty?.trim() || r.purpose?.trim() || r.id}`);
            button.connect('clicked', () => {
                void nimmProjektZuordnungZurueck(appSession(), edit.entity, edit.year, [r.id])
                    .then((res) => {
                        showToast(res.zurueckgenommen[0]?.danach ?? 'Zuordnung zurückgenommen');
                        dialog.close();
                        edit.onChanged();
                    })
                    .catch((err: unknown) =>
                        errorDialog(
                            dialog,
                            'Konnte nicht zurücknehmen',
                            err instanceof Error ? err.message : String(err),
                        ),
                    );
            });
            row.add_suffix(button);
            group.add(row);
        }
        return group;
    }

    /**
     * „Umbuchung zurücknehmen" right at the booking, with the sentence what applies afterwards — only
     * when there is a manual decision to take back.
     */
    private undoRow(
        r: EnrichedTxRow,
        dialog: Adw.Dialog,
        edit: { entity: AppEntity; year: number; onChanged: () => void },
    ): Adw.ActionRow | null {
        const danach = wasGiltDanach(r);
        if (!danach) return null;
        if (istAufteilung(r)) {
            const row = new Adw.ActionRow({ title: 'Aufteilung aufheben', subtitle: danach });
            row.set_subtitle_lines(0);
            const button = new Gtk.Button({ label: 'Aufheben', valign: Gtk.Align.CENTER });
            button.add_css_class('destructive-action');
            button.connect('clicked', () => {
                void aufteilungAufheben(dialog, edit.entity, edit.year, r.id, danach, () => {
                    dialog.close();
                    edit.onChanged();
                });
            });
            row.add_suffix(button);
            return row;
        }
        // A linked Erstattung is undone by lifting the link; the sentence says what applies then.
        const erstattung = istErstattung(r);
        const title = erstattung ? 'Verknüpfung lösen' : 'Umbuchung zurücknehmen';
        const row = new Adw.ActionRow({ title, subtitle: danach });
        row.set_subtitle_lines(0);
        const button = new Gtk.Button({ label: erstattung ? 'Lösen' : 'Zurücknehmen', valign: Gtk.Align.CENTER });
        button.add_css_class('destructive-action');
        button.set_tooltip_text(`${title}: ${r.counterparty?.trim() || r.purpose?.trim() || r.id}`);
        button.connect('clicked', () => {
            try {
                if (erstattung) loeseErstattung(appSession(), edit.entity, r.id);
                else removeDecision(edit.entity, r.id);
                appSession().invalidate(edit.entity.id, edit.year);
                showToast(erstattung ? 'Verknüpfung gelöst' : 'Umbuchung zurückgenommen');
                dialog.close();
                edit.onChanged();
            } catch (err) {
                void errorDialog(dialog, 'Konnte nicht zurücknehmen', err instanceof Error ? err.message : String(err));
            }
        });
        row.add_suffix(button);
        return row;
    }

    private belegGroup(r: EnrichedTxRow, base?: string | null): Adw.PreferencesGroup | null {
        if (!r.receipt) return null;
        const group = new Adw.PreferencesGroup({ title: 'Beleg (Paperless)' });
        this.fill(group, [
            this.row('Rechnungsnummer', r.receipt.invoiceNumber),
            this.row('Titel', r.receipt.title),
            this.row('Netto (Beleg)', r.receipt.net != null ? eur(r.receipt.net) : ''),
            this.row('Brutto (Beleg)', r.receipt.gross != null ? eur(r.receipt.gross) : ''),
            this.row('USt (Beleg)', r.receipt.vat != null ? eur(r.receipt.vat) : ''),
        ]);
        // A tappable row that opens the document in Paperless (when the base URL is known).
        const docId = r.receipt.docId;
        if (base) {
            const open = new Adw.ActionRow({ title: 'In Paperless öffnen', subtitle: `Dokument #${docId}` });
            open.add_suffix(new Gtk.Image({ iconName: 'external-link-symbolic', valign: Gtk.Align.CENTER }));
            open.set_activatable(true);
            const uri = `${base.replace(/\/+$/, '')}/documents/${docId}`;
            open.connect('activated', () => {
                Gio.AppInfo.launch_default_for_uri(uri, null);
            });
            group.add(open);
        } else {
            group.add(new Adw.ActionRow({ title: 'Dokument', subtitle: `#${docId}` }));
        }
        return group;
    }

    private linksGroup(r: EnrichedTxRow): Adw.PreferencesGroup | null {
        const group = new Adw.PreferencesGroup({ title: 'Verknüpfungen' });
        return this.fill(group, [
            r.paypal ? this.row('PayPal-Händler', r.paypal.merchant) : null,
            r.paypal ? this.row('PayPal-Posten', r.paypal.item) : null,
            r.transfer
                ? this.row('Umbuchung', `${r.transfer.direction === 'out' ? 'an' : 'von'} ${r.transfer.partner}`)
                : null,
        ]);
    }

    private bankGroup(r: EnrichedTxRow): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({ title: 'Bank-Details' });
        this.fill(group, [
            this.row('Konto', r.account),
            this.row('Konto-Schlüssel', r.accountKey),
            this.row('IBAN (eigen)', r.raw?.iban),
            this.row('IBAN (Gegenseite)', r.raw?.counterpartyIban),
            this.row('Währung', r.raw?.currency),
            this.row('Referenz', r.raw?.reference),
            this.row('Buchungstext / Typ', r.raw?.type),
            this.row('Quelle (Import)', r.raw?.source),
            this.row('Transaktions-ID', r.id),
        ]);
        return group;
    }
}
