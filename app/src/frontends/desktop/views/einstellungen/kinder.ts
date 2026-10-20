/**
 * Einstellungen — Kinder (Anlage Kind).
 *
 * Children are not a detail of the computation: each carries a Kinderfreibetrag, a Kindergeld claim
 * set against it, and possibly Schulgeld and Betreuungskosten. Leaving them out moves the assessed
 * tax by four figures.
 *
 * They were nonetheless the one input of the private return with no way in. The §24b group already
 * READS `est.kinder` to fill its "Kind (Grundbetrag)" chooser — and that chooser was empty for
 * everybody, forever, because nothing wrote the list.
 *
 * Per child a dialog, not inline rows: the identity fields plus the year figures are more than a
 * settings row can hold, and they are entered once and then corrected rarely.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { kindKey, listKinder, removeKind, upsertKind, type EstKind } from '../../../../core/actions/est-kinder.ts';
import type { AppEntity } from '../../entities.ts';
import { markup } from '../util.ts';
import type { SettingsHost } from './rows.ts';
import { _, fmt } from '../../i18n.ts';
import { errorText } from '../../error-text.ts';

/** `kindschaftsverhaeltnis` as the schema spells it, in the order the form offers. */
const VERHAELTNIS: Array<{ value: '1' | '2' | '3'; label: string }> = [
    { value: '1', label: _('Biological or adopted child') },
    { value: '2', label: _('Foster child') },
    { value: '3', label: _('Grandchild or stepchild') },
];

export function buildKinderGroup(
    host: SettingsHost,
    entity: AppEntity,
    year: number,
    parent: Gtk.Widget,
): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: _('Children'),
        description: _(
            'One Anlage Kind block per child. The Kinderfreibetrag and the Kindergeld claim act directly on the assessed tax.',
        ),
    });

    let kinder: EstKind[] = [];
    try {
        kinder = listKinder(entity.id);
    } catch (err) {
        host.banner(fmt(_('Children not readable: {error}'), { error: errorText(err) }));
        return group;
    }

    for (const kind of kinder) {
        const jahr = kind.jahre?.find((j) => j.jahr === year);
        const parts = [
            kind.geburtsdatum,
            kind.idnr ? fmt(_('IdNr {id}'), { id: kind.idnr }) : _('no IdNr'),
            jahr
                ? fmt(_('Kindergeld {year}: {amount} €'), { year, amount: jahr.kindergeld_anspruch })
                : fmt(_('no details for {year}'), { year }),
        ];
        const row = new Adw.ActionRow({
            title: markup([kind.vorname, kind.nachname].filter(Boolean).join(' ')),
            subtitle: markup(parts.join(' · ')),
        });
        const edit = new Gtk.Button({ iconName: 'document-edit-symbolic', valign: Gtk.Align.CENTER });
        edit.add_css_class('flat');
        edit.set_tooltip_text(_('Edit child'));
        edit.connect('clicked', () => presentKindDialog(parent, host, entity, year, kind));
        row.add_suffix(edit);

        const remove = new Gtk.Button({ iconName: 'user-trash-symbolic', valign: Gtk.Align.CENTER });
        remove.add_css_class('flat');
        remove.set_tooltip_text(_('Remove child — changes the tax calculation for the year'));
        remove.connect('clicked', () => {
            host.saveWith(() => removeKind(entity.id, kindKey(kind)), { clearCache: true });
            host.reloadEntityGroups();
        });
        row.add_suffix(remove);
        row.set_activatable_widget(edit);
        group.add(row);
    }

    const add = new Adw.ActionRow({ title: _('+ Add child') });
    add.set_activatable(true);
    add.connect('activated', () => presentKindDialog(parent, host, entity, year, null));
    group.add(add);
    return group;
}

/** The per-child form. `existing` null creates one. */
function presentKindDialog(
    parent: Gtk.Widget,
    host: SettingsHost,
    entity: AppEntity,
    year: number,
    existing: EstKind | null,
): void {
    const dialog = new Adw.Dialog();
    dialog.set_title(existing ? _('Edit child') : _('Add child'));
    dialog.set_content_width(560);
    dialog.set_content_height(620);

    const banner = new Adw.Banner({ revealed: false });
    const warn = (message: string): void => {
        banner.set_title(markup(message));
        banner.set_revealed(true);
    };

    const vorname = new Adw.EntryRow({ title: _('First name') });
    const nachname = new Adw.EntryRow({ title: _('Surname (only if different)') });
    const geburtsdatum = new Adw.EntryRow({ title: _('Date of birth (YYYY-MM-DD)') });
    const idnr = new Adw.EntryRow({ title: _('The child’s Steuer-IdNr (11 digits)') });
    const familienkasse = new Adw.EntryRow({ title: _('Familienkasse') });
    const verhaeltnis = new Adw.ComboRow({
        title: _('Relationship to the child'),
        model: Gtk.StringList.new(VERHAELTNIS.map((v) => v.label)),
    });
    const kindergeld = new Adw.EntryRow({ title: fmt(_('Kindergeld claim {year} (€ per year)'), { year }) });

    if (existing) {
        vorname.set_text(existing.vorname);
        nachname.set_text(existing.nachname ?? '');
        geburtsdatum.set_text(existing.geburtsdatum);
        idnr.set_text(existing.idnr ?? '');
        familienkasse.set_text(existing.familienkasse ?? '');
        verhaeltnis.set_selected(
            Math.max(
                0,
                VERHAELTNIS.findIndex((v) => v.value === existing.kindschaftsverhaeltnis),
            ),
        );
        const jahr = existing.jahre?.find((j) => j.jahr === year);
        if (jahr) kindergeld.set_text(String(jahr.kindergeld_anspruch));
    }

    const page = new Adw.PreferencesPage();
    const bannerGroup = new Adw.PreferencesGroup();
    bannerGroup.add(banner);
    page.add(bannerGroup);

    const who = new Adw.PreferencesGroup({ title: _('Child') });
    for (const row of [vorname, nachname, geburtsdatum, idnr, familienkasse, verhaeltnis]) who.add(row);
    page.add(who);

    const yearGroup = new Adw.PreferencesGroup({
        title: fmt(_('Details {year}'), { year }),
        description: _(
            'The yearly Kindergeld claim — with a halved Kinderfreibetrag the HALF claim, exactly as in the previous year’s filed return.',
        ),
    });
    yearGroup.add(kindergeld);
    page.add(yearGroup);

    const scroller = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true });
    scroller.set_child(page);
    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(new Adw.HeaderBar());
    toolbar.set_content(scroller);

    const bottom = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        halign: Gtk.Align.END,
        marginTop: 10,
        marginBottom: 12,
        marginStart: 12,
        marginEnd: 12,
    });
    const save = new Gtk.Button({ label: _('Save') });
    save.add_css_class('suggested-action');
    save.add_css_class('pill');
    save.connect('clicked', () => {
        const name = (vorname.get_text() ?? '').trim();
        if (!name) return warn(_('The first name is missing.'));
        const born = (geburtsdatum.get_text() ?? '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(born)) return warn(_('The date of birth must be in YYYY-MM-DD format.'));
        const id = (idnr.get_text() ?? '').trim();
        // Checked here rather than at save time in the core: an IdNr that is almost right is the
        // kind of thing ELSTER rejects months later, and the person who can fix it is looking at
        // the letter right now.
        if (id && !/^\d{11}$/.test(id)) return warn(_('The child’s Steuer-IdNr has exactly 11 digits.'));
        const anspruch = Number((kindergeld.get_text() ?? '').trim().replace(',', '.'));
        if ((kindergeld.get_text() ?? '').trim() && !Number.isFinite(anspruch)) {
            return warn(_('The Kindergeld claim is not a number.'));
        }

        // The year block is MERGED, never replaced: a child may carry Schulgeld or Betreuungskosten
        // for this year that this form does not show, and rewriting the entry would drop them.
        const previousJahre = existing?.jahre ?? [];
        const others = previousJahre.filter((j) => j.jahr !== year);
        const thisYear = previousJahre.find((j) => j.jahr === year);
        const jahre = (kindergeld.get_text() ?? '').trim()
            ? [...others, { ...thisYear, jahr: year, kindergeld_anspruch: anspruch }]
            : previousJahre;

        const kind = {
            ...existing,
            vorname: name,
            geburtsdatum: born,
            kindschaftsverhaeltnis: VERHAELTNIS[verhaeltnis.get_selected()]?.value ?? '1',
            ...((nachname.get_text() ?? '').trim() ? { nachname: (nachname.get_text() ?? '').trim() } : {}),
            ...(id ? { idnr: id } : {}),
            ...((familienkasse.get_text() ?? '').trim()
                ? { familienkasse: (familienkasse.get_text() ?? '').trim() }
                : {}),
            jahre,
        } as EstKind;

        try {
            host.saveWith(() => upsertKind(entity.id, kind), { clearCache: true });
            host.reloadEntityGroups();
            dialog.close();
        } catch (err) {
            warn(fmt(_('Could not save: {error}'), { error: errorText(err) }));
        }
    });
    bottom.append(save);
    toolbar.add_bottom_bar(bottom);
    dialog.set_child(toolbar);
    dialog.present(parent);
}
