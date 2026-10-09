/**
 * „Gehört das zu dieser Zahlung?" (Idee 9) — the group the booking detail and the „Zu prüfen" queue
 * show for an incoming payment that may refund an earlier debit: the best candidate beside the
 * question, Ja / Nein, and „Andere Zahlung wählen …" when there is more than one. „Ja" makes the
 * refund inherit the original's category and VAT rate; „Nein" hides that candidate for good.
 *
 * The group fills itself asynchronously and stays hidden while there is nothing to ask.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import {
    erstattungFrage,
    lehneErstattungAb,
    verknuepfeErstattung,
    type ErstattungKandidatView,
} from '../../../core/presenters/erstattungen.ts';
import { fmtDe } from '../../../core/lib/money.ts';
import { appSession } from '../data/session.ts';
import type { AppEntity } from '../entities.ts';
import { showToast } from '../toast.ts';
import { errorDialog } from './dialogs.ts';
import { markup } from './util.ts';
import { BhGlossaryHelp, lernmodusOn } from '../widgets/glossary-help.ts';

function kandidatSub(k: ErstattungKandidatView): string {
    const art = k.exakt ? 'gleicher Betrag' : `Teilerstattung — offen ${fmtDe(k.offen)} €`;
    return `${k.category} · ${art}${k.zweckTreffer ? ' · Verwendungszweck passt' : ''}`;
}

/** A list of the candidates; picking one links it. */
function pickKandidat(
    parent: Gtk.Widget,
    kandidaten: ErstattungKandidatView[],
    onPick: (k: ErstattungKandidatView) => void,
) {
    const dlg = new Adw.Dialog({ contentWidth: 520, contentHeight: 480 });
    const header = new Adw.HeaderBar();
    header.set_title_widget(new Adw.WindowTitle({ title: 'Zu welcher Zahlung gehört die Erstattung?', subtitle: '' }));
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup();
    for (const k of kandidaten) {
        const row = new Adw.ActionRow({ title: markup(k.zeile), subtitle: markup(kandidatSub(k)), activatable: true });
        row.set_subtitle_lines(0);
        row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
        row.connect('activated', () => {
            dlg.close();
            onPick(k);
        });
        group.add(row);
    }
    page.add(group);
    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(header);
    toolbar.set_content(page);
    dlg.set_child(toolbar);
    dlg.present(parent);
}

/**
 * The group for one booking. `onChanged` runs after „Ja" or „Nein" (the caller reloads; the EÜR
 * changed on „Ja"). Returns the group at once; it shows up once a candidate is found.
 */
export function erstattungGroup(
    parent: Gtk.Widget,
    entity: AppEntity,
    year: number,
    txId: string,
    onChanged: (what: string) => void,
): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: 'Gehört das zu dieser Zahlung?',
        description: '„Ja" übernimmt Kategorie und Steuersatz der Zahlung und mindert deren Ausgabe samt Vorsteuer.',
        visible: false,
    });
    group.set_header_suffix(new BhGlossaryHelp('erstattung', lernmodusOn()));
    let busy = false;
    const run = (what: string, fn: () => Promise<unknown>) => {
        if (busy) return;
        busy = true;
        fn()
            .then(() => {
                showToast(what);
                onChanged(what);
            })
            .catch((err) => errorDialog(parent, 'Erstattung', err instanceof Error ? err.message : String(err)))
            .finally(() => {
                busy = false;
            });
    };
    const ja = (k: ErstattungKandidatView) =>
        run(`Erstattung zugeordnet: ${k.category}`, () => verknuepfeErstattung(appSession(), entity, year, txId, k.id));

    erstattungFrage(appSession(), entity, year, txId)
        .then((frage) => {
            const best = frage.kandidaten[0];
            if (!best) return;
            const row = new Adw.ActionRow({ title: markup(best.zeile), subtitle: markup(kandidatSub(best)) });
            row.set_subtitle_lines(0);
            const nein = new Gtk.Button({ label: 'Nein', valign: Gtk.Align.CENTER });
            nein.set_tooltip_text(`Gehört nicht zu: ${best.zeile}`);
            nein.connect('clicked', () =>
                run('Nicht zugeordnet', () => lehneErstattungAb(appSession(), entity, year, txId, best.id)),
            );
            const jaBtn = new Gtk.Button({ label: 'Ja', valign: Gtk.Align.CENTER, cssClasses: ['suggested-action'] });
            jaBtn.set_tooltip_text(`Gehört zu: ${best.zeile}`);
            jaBtn.connect('clicked', () => ja(best));
            const box = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
            box.append(nein);
            box.append(jaBtn);
            row.add_suffix(box);
            group.add(row);
            if (frage.kandidaten.length > 1) {
                const andere = new Adw.ActionRow({
                    title: 'Andere Zahlung wählen …',
                    subtitle: `${frage.kandidaten.length} Kandidaten`,
                    activatable: true,
                });
                andere.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
                andere.connect('activated', () => pickKandidat(parent, frage.kandidaten, ja));
                group.add(andere);
            }
            group.set_visible(true);
        })
        .catch((err: unknown) => {
            console.error(`[app] Erstattung ${txId}: ${err instanceof Error ? err.message : err}`);
        });
    return group;
}
