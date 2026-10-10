/**
 * Einstellungen — Land & Steuern: the entity's country and its German tax features (ADR 0001).
 *
 * The switch hides views, it never deletes data: the `elster` section stays in the manifest and
 * categorisation keeps reading it. Turning the module off still asks first, because the Steuer
 * area, the tax KPIs and the deadlines vanish from the sidebar at once — without a word that reads
 * like data loss. Written through saveEntityCountry, which drops a field that equals its default,
 * so switching back restores the manifest byte for byte.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { saveEntityCountry, type TaxModuleId } from '../../../../core/config/index.ts';
import { countryOf, OTHER_COUNTRY } from '../../../../core/countries/index.ts';
import type { AppEntity } from '../../entities.ts';
import { _ } from '../../i18n.ts';
import { markup } from '../util.ts';
import type { SettingsHost } from './rows.ts';

interface Choice {
    country: string;
    taxModule: TaxModuleId;
}

/** Ask before the tax views go away; resolves true when the person confirms. */
function confirmTaxOff(parent: Gtk.Widget): Promise<boolean> {
    return new Promise((resolve) => {
        const dlg = new Adw.AlertDialog({
            heading: _('Turn off German tax features?'),
            body: _(
                'Tax views will be hidden; your data stays. Bookings, categories, receipts, invoices and ' +
                    'the bookkeeping reports keep working, and you can turn the features back on here at any time.',
            ),
        });
        dlg.add_response('cancel', _('Cancel'));
        dlg.add_response('off', _('Turn off'));
        dlg.set_response_appearance('off', Adw.ResponseAppearance.DESTRUCTIVE);
        dlg.set_close_response('cancel');
        dlg.set_default_response('cancel');
        dlg.choose(parent, null, (_s, res) => resolve(dlg.choose_finish(res) === 'off'));
    });
}

/** Country (Germany / other) and the German tax switch, first group of every entity. */
export function buildLandSteuerGroup(host: SettingsHost, entity: AppEntity): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: markup(_('Country & taxes')),
        description: _('Which country the entity is taxed in, and whether the app prepares German tax returns for it.'),
    });
    const german = countryOf(entity) === 'DE';
    const country = new Adw.ComboRow({
        title: _('Country'),
        model: Gtk.StringList.new([_('Germany'), _('Other (bookkeeping only)')]),
    });
    country.set_selected(german ? 0 : 1);
    const tax = new Adw.SwitchRow({
        title: _('German tax features'),
        subtitle: _('ELSTER returns, tax forecast, tax deadlines and the Tax area'),
    });
    tax.set_active(entity.taxModule === 'de');
    tax.set_sensitive(german);
    group.add(country);
    group.add(tax);

    // Our own revert after a cancelled dialog must not count as a change.
    let reverting = false;
    const revert = () => {
        reverting = true;
        country.set_selected(countryOf(entity) === 'DE' ? 0 : 1);
        tax.set_active(entity.taxModule === 'de');
        reverting = false;
    };

    const apply = async (choice: Choice) => {
        if (choice.taxModule === 'none' && entity.taxModule !== 'none' && !(await confirmTaxOff(group))) {
            revert();
            return;
        }
        host.saveWith(() => saveEntityCountry(entity.id, choice), { clearCache: true });
        // The sidebar, the KPIs and the deadlines are all built from the entity's capabilities.
        group.activate_action('win.workspace-changed', null);
    };

    country.connect('notify::selected', () => {
        if (host.isFilling() || reverting) return;
        const toGermany = country.get_selected() === 0;
        tax.set_sensitive(toGermany);
        void apply(toGermany ? { country: 'DE', taxModule: 'de' } : { country: OTHER_COUNTRY, taxModule: 'none' });
    });
    tax.connect('notify::active', () => {
        if (host.isFilling() || reverting) return;
        void apply({ country: 'DE', taxModule: tax.get_active() ? 'de' : 'none' });
    });
    return group;
}
