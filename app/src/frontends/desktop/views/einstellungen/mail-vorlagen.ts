/**
 * Einstellungen → Anbindungen → E-Mail-Vorlagen: the named subject + text templates an entity mails
 * its invoices with ("Hosting", "Dienstleistung"), each with an optional Sie variant, and which one
 * is the entity's default. A contract or project may name another one; the send dialog can switch.
 *
 * The whole list is written at once (replace, not patch), so the manifest never holds a half-edited
 * template. Texts use the `{placeholders}` of `core/mail/invoice-mail.ts`; the editor lists them and
 * a click inserts one at the cursor.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import type { MailTemplate } from '../../../../core/config/index.ts';
import { MAIL_PLACEHOLDERS, unknownMailPlaceholders } from '../../../../core/mail/invoice-mail.ts';
import { loadInvoicing, saveInvoicing } from '../../data/settings.ts';
import type { AppEntity } from '../../entities.ts';
import { confirmDialog, errorDialog } from '../dialogs.ts';
import type { SettingsHost } from './rows.ts';

const NONE = '— Standardtext —';

const slug = (name: string, taken: readonly string[]): string => {
    const base =
        name
            .toLowerCase()
            .replace(/ä/g, 'ae')
            .replace(/ö/g, 'oe')
            .replace(/ü/g, 'ue')
            .replace(/ß/g, 'ss')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'vorlage';
    let id = base;
    for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
    return id;
};

/** A multi-line text field in a framed scroller. */
function textArea(text: string): Gtk.TextView {
    const view = new Gtk.TextView({
        wrapMode: Gtk.WrapMode.WORD_CHAR,
        topMargin: 8,
        bottomMargin: 8,
        leftMargin: 12,
        rightMargin: 12,
    });
    view.get_buffer().set_text(text, -1);
    return view;
}

const readArea = (view: Gtk.TextView): string => {
    const buffer = view.get_buffer();
    return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false).trim();
};

function frame(view: Gtk.TextView): Gtk.Frame {
    return new Gtk.Frame({
        child: new Gtk.ScrolledWindow({
            hscrollbarPolicy: Gtk.PolicyType.NEVER,
            minContentHeight: 140,
            child: view,
        }),
    });
}

/** Edit one template in a dialog; resolves with the result, or null when cancelled. */
function editTemplate(parent: Gtk.Widget, existing: MailTemplate | null): Promise<Omit<MailTemplate, 'id'> | null> {
    return new Promise((resolve) => {
        const dialog = new Adw.Dialog({ title: existing ? 'Vorlage bearbeiten' : 'Neue Vorlage' });
        dialog.set_content_width(560);
        dialog.set_content_height(860);
        let done = false;
        const finish = (value: Omit<MailTemplate, 'id'> | null): void => {
            if (done) return;
            done = true;
            resolve(value);
        };
        dialog.connect('closed', () => finish(null));

        const page = new Adw.PreferencesPage();
        const name = new Adw.EntryRow({ title: 'Name (z. B. Hosting)', text: existing?.name ?? '' });
        const head = new Adw.PreferencesGroup();
        head.add(name);
        page.add(head);

        const duSubject = new Adw.EntryRow({ title: 'Betreff (Du)', text: existing?.subject ?? '' });
        const duBody = textArea(existing?.body ?? '');
        const du = new Adw.PreferencesGroup({ title: 'Du-Variante' });
        du.add(duSubject);
        du.add(frame(duBody));
        page.add(du);

        const sieSubject = new Adw.EntryRow({ title: 'Betreff (Sie)', text: existing?.subjectSie ?? '' });
        const sieBody = textArea(existing?.bodySie ?? '');
        const sie = new Adw.PreferencesGroup({
            title: 'Sie-Variante',
            description: 'Leer = die Du-Variante gilt auch für Sie.',
        });
        sie.add(sieSubject);
        sie.add(frame(sieBody));
        page.add(sie);

        let focus: Gtk.TextView | null = duBody;
        for (const view of [duBody, sieBody]) {
            const ctrl = new Gtk.EventControllerFocus();
            ctrl.connect('enter', () => (focus = view));
            view.add_controller(ctrl);
        }
        const holders = new Adw.ExpanderRow({
            title: 'Platzhalter',
            subtitle: 'Klick fügt den Platzhalter im zuletzt bearbeiteten Textfeld ein',
        });
        for (const [key, what] of Object.entries(MAIL_PLACEHOLDERS)) {
            const row = new Adw.ActionRow({ title: `{${key}}`, subtitle: what, activatable: true });
            row.connect('activated', () => focus?.get_buffer().insert_at_cursor(`{${key}}`, -1));
            holders.add_row(row);
        }
        const hg = new Adw.PreferencesGroup();
        hg.add(holders);
        page.add(hg);

        const actions = new Adw.PreferencesGroup();
        const save = new Adw.ButtonRow({ title: 'Übernehmen' });
        save.add_css_class('suggested-action');
        save.connect('activated', () => {
            const fields = {
                name: name.get_text().trim(),
                subject: duSubject.get_text().trim(),
                body: readArea(duBody),
                subjectSie: sieSubject.get_text().trim(),
                bodySie: readArea(sieBody),
            };
            if (!fields.name || !fields.subject || !fields.body) {
                void errorDialog(dialog, 'Vorlage unvollständig', 'Name, Betreff und Text (Du) sind nötig.');
                return;
            }
            const unknown = unknownMailPlaceholders(Object.values(fields).join('\n'));
            if (unknown.length) {
                void errorDialog(
                    dialog,
                    'Unbekannte Platzhalter',
                    `${unknown.map((u) => `{${u}}`).join(', ')} gibt es nicht. Eine solche Vorlage lässt sich nicht senden.`,
                );
                return;
            }
            finish({
                name: fields.name,
                subject: fields.subject,
                body: fields.body,
                ...(fields.subjectSie ? { subjectSie: fields.subjectSie } : {}),
                ...(fields.bodySie ? { bodySie: fields.bodySie } : {}),
            });
            dialog.close();
        });
        actions.add(save);
        page.add(actions);

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        toolbar.set_content(page);
        dialog.set_child(toolbar);
        dialog.present(parent);
    });
}

export function buildMailTemplatesGroup(
    host: SettingsHost,
    entity: AppEntity,
    parent: Gtk.Widget,
): Adw.PreferencesGroup {
    const inv = loadInvoicing(entity);
    const templates = [...inv.mailTemplates];

    const group = new Adw.PreferencesGroup({
        title: 'E-Mail-Vorlagen',
        description:
            'Benannte Texte für den Rechnungsversand. Ohne Vorlage gilt der eingebaute Text. Ein Vertrag oder Projekt kann eine andere wählen.',
    });

    const persist = (next: MailTemplate[], defaultId: string): void => {
        host.saveWith(() => {
            saveInvoicing(entity, {
                type: inv.type,
                mailTemplates: next,
                defaultMailTemplate: next.some((t) => t.id === defaultId) ? defaultId : '',
            });
        });
        host.reloadEntityGroups();
    };

    const defaultRow = new Adw.ComboRow({
        title: 'Standard der Entität',
        model: Gtk.StringList.new([NONE, ...templates.map((t) => t.name)]),
    });
    defaultRow.set_selected(Math.max(0, templates.findIndex((t) => t.id === inv.defaultMailTemplate) + 1));
    defaultRow.connect('notify::selected', () => {
        if (host.isFilling()) return;
        const picked = templates[defaultRow.get_selected() - 1];
        persist(templates, picked?.id ?? '');
    });
    if (templates.length) group.add(defaultRow);

    for (const t of templates) {
        const row = new Adw.ActionRow({ title: t.name, subtitle: t.subject, activatable: true });
        const del = new Gtk.Button({ iconName: 'user-trash-symbolic', valign: Gtk.Align.CENTER });
        del.add_css_class('flat');
        del.set_tooltip_text('Vorlage löschen');
        del.connect('clicked', () => {
            void (async () => {
                const ok = await confirmDialog(parent, {
                    heading: `Vorlage „${t.name}“ löschen?`,
                    body: 'Verträge und Projekte, die sie nennen, fallen auf die nächste Stufe zurück.',
                    confirmLabel: 'Löschen',
                    destructive: true,
                });
                if (ok)
                    persist(
                        templates.filter((x) => x.id !== t.id),
                        inv.defaultMailTemplate ?? '',
                    );
            })();
        });
        row.add_suffix(del);
        row.connect('activated', () => {
            void (async () => {
                const edited = await editTemplate(parent, t);
                if (!edited) return;
                persist(
                    templates.map((x) => (x.id === t.id ? { id: t.id, ...edited } : x)),
                    inv.defaultMailTemplate ?? '',
                );
            })();
        });
        group.add(row);
    }

    const add = new Adw.ButtonRow({ title: 'Vorlage hinzufügen …' });
    add.connect('activated', () => {
        void (async () => {
            const created = await editTemplate(parent, null);
            if (!created) return;
            const id = slug(
                created.name,
                templates.map((t) => t.id),
            );
            persist([...templates, { id, ...created }], inv.defaultMailTemplate ?? '');
        })();
    });
    group.add(add);
    return group;
}
