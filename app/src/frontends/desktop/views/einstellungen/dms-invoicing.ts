/**
 * Einstellungen — Beleg-Verwaltung (DMS) + Rechnungsstellung (invoicing) section, built per entity.
 *
 * Both groups persist through the shared `data/settings.ts` wrappers (loadDms/saveDms,
 * loadInvoicing/saveInvoicing) via the host's save contract; a save failure surfaces in the banner.
 * The widgets are held in local closures (rebuilt each reload), so the section carries no view state.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { setupPaperlessFields } from '../../../../core/actions/paperless/setup.ts';
import { loadDms, saveDms, loadInvoicing, saveInvoicing, type IssuerConfig } from '../../data/settings.ts';
import type { AppEntity } from '../../entities.ts';
import { comboRow, entryRow, spinRow, toggleRow, type SettingsHost } from './rows.ts';

// ── Beleg-Verwaltung (DMS) ────────────────────────────────────────────────────────────────────────

/** The DMS back-end selector: built-in DMS vs Paperless-ngx (with URL + token when Paperless). */
export function buildDmsGroup(host: SettingsHost, entity: AppEntity): Adw.PreferencesGroup {
    const dms = loadDms(entity);
    const group = new Adw.PreferencesGroup({
        title: 'Beleg-Verwaltung',
        description: 'Woher die Belege dieser Entität stammen.',
    });

    const tokenRow = new Adw.PasswordEntryRow({
        title: dms.hasToken ? 'Paperless-Token (hinterlegt — leer lassen zum Beibehalten)' : 'Paperless-Token',
    });
    const save = () => {
        const type = typeCombo.get_selected() === 1 ? 'paperless' : 'builtin';
        const paperlessUrl = (urlRow.get_text() ?? '').trim() || undefined;
        const paperlessToken = (tokenRow.get_text() ?? '').trim() || undefined;
        host.saveWith(() => saveDms(entity, { type, paperlessUrl, paperlessToken }));
        // Clear the token field after a successful save so it isn't resubmitted (blank = keep).
        if (paperlessToken) tokenRow.set_text('');
    };

    const typeCombo = comboRow(
        host,
        'Typ',
        ['Integriertes DMS', 'Paperless-ngx'],
        dms.type === 'paperless' ? 1 : 0,
        save,
    );
    const urlRow = entryRow(host, 'Paperless-URL', dms.paperlessUrl ?? '', save);
    tokenRow.set_show_apply_button(true);
    tokenRow.connect('apply', () => {
        if (!host.isFilling()) save();
    });

    const setupRow = buildSetupRow(host);

    // Hide the Paperless-only rows entirely for the built-in DMS (cleaner than greying them out).
    const syncPaperlessRows = () => {
        const paperless = typeCombo.get_selected() === 1;
        urlRow.set_visible(paperless);
        tokenRow.set_visible(paperless);
        setupRow.set_visible(paperless);
    };
    typeCombo.connect('notify::selected', syncPaperlessRows);
    syncPaperlessRows();

    group.add(typeCombo);
    group.add(urlRow);
    group.add(tokenRow);
    group.add(setupRow);
    return group;
}

/**
 * The one door to `setupPaperlessFields` outside the CLI.
 *
 * Without the document types and custom fields registered in Paperless, the Beleg pipeline and the
 * USt-VA aggregate both refuse to run — and until now the only way to create them was
 * `paperless setup-fields` in a terminal. Every surface that hit the condition told the user to go
 * find a command line, which is the definition of a dead end in an app.
 *
 * Idempotent by construction: the action skips every resource that already carries an id, so
 * pressing this twice creates nothing twice.
 */
function buildSetupRow(host: SettingsHost): Adw.ActionRow {
    const row = new Adw.ActionRow({
        title: 'Felder in Paperless anlegen',
        subtitle: 'Legt Dokumenttypen, Zusatzfelder und Tags an, die für Belege und USt-VA gebraucht werden.',
    });
    const button = new Gtk.Button({ label: 'Einrichten', valign: Gtk.Align.CENTER });
    button.connect('clicked', () => {
        button.set_sensitive(false);
        button.set_label('Richte ein …');
        setupPaperlessFields()
            .then((result) => {
                host.banner(
                    result.updated
                        ? `Paperless eingerichtet: ${result.lines.filter((l) => l.startsWith('Created')).length} Felder angelegt.`
                        : 'Paperless war bereits vollständig eingerichtet.',
                );
            })
            .catch((err: unknown) => {
                host.banner(`Einrichten fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
            })
            .finally(() => {
                button.set_sensitive(true);
                button.set_label('Einrichten');
            });
    });
    row.add_suffix(button);
    return row;
}

// ── Rechnungsstellung (invoicing) ───────────────────────────────────────────────────────────────

/** The invoicing back-end selector: Qonto vs self (with IBAN, payment term and number prefix). */
export function buildInvoicingGroup(host: SettingsHost, entity: AppEntity): Adw.PreferencesGroup {
    const inv = loadInvoicing(entity);
    const group = new Adw.PreferencesGroup({
        title: 'Rechnungsstellung',
        description: 'Wie ausgehende Rechnungen dieser Entität erzeugt werden.',
    });
    const save = () => {
        const type = typeCombo.get_selected() === 1 ? 'self' : 'qonto';
        const iban = (ibanRow.get_text() ?? '').trim();
        const paymentTermsDays = Math.round(termRow.get_value());
        const selfNumberPrefix = prefixRow.get_text() ?? '';
        const selfIssuer = issuerReaders.get(entity.id)?.();
        const defaultHeader = headerText();
        const defaultClosing = (closingRow.get_text() ?? '').trim();
        const defaultHeaderSie = headerSieText();
        const defaultClosingSie = (closingSieRow.get_text() ?? '').trim();
        host.saveWith(() =>
            saveInvoicing(entity, {
                type,
                iban,
                paymentTermsDays,
                defaultHeader,
                defaultClosing,
                defaultHeaderSie,
                defaultClosingSie,
                selfNumberPrefix,
                selfIssuer,
            }),
        );
    };
    const typeCombo = comboRow(host, 'Anbieter', ['Qonto', 'Selbst'], inv.type === 'self' ? 1 : 0, save);
    const ibanRow = entryRow(host, 'IBAN (Zahlungsempfang)', inv.iban ?? '', save);
    const termRow = spinRow(
        host,
        'Zahlungsziel (Tage)',
        inv.paymentTermsDays ?? 14,
        { digits: 0, lower: 0, upper: 365 },
        save,
    );
    const prefixRow = entryRow(host, 'Rechnungsnummer-Präfix', inv.selfNumberPrefix ?? '', save);
    const closingRow = entryRow(host, 'Standard-Gruß (z. B. „Beste Grüße")', inv.defaultClosing ?? '', save);
    const closingSieRow = entryRow(
        host,
        'Standard-Gruß (Sie) (z. B. „Mit freundlichen Grüßen")',
        inv.defaultClosingSie ?? '',
        save,
    );
    const newHeaderView = (text: string) => {
        const view = new Gtk.TextView({
            wrapMode: Gtk.WrapMode.WORD_CHAR,
            topMargin: 8,
            bottomMargin: 8,
            leftMargin: 8,
            rightMargin: 8,
        });
        view.get_buffer().set_text(text, -1);
        return view;
    };
    const textOf = (view: Gtk.TextView) => {
        const b = view.get_buffer();
        return b.get_text(b.get_start_iter(), b.get_end_iter(), false);
    };
    const headerView = newHeaderView(inv.defaultHeader ?? '');
    const headerSieView = newHeaderView(inv.defaultHeaderSie ?? '');
    const headerText = () => textOf(headerView);
    const headerSieText = () => textOf(headerSieView);
    const apply = () => {
        if (!host.isFilling()) save();
    };
    group.add(headerRow('Standard-Anschreiben', headerView, apply));
    group.add(headerRow('Standard-Anschreiben (Sie)', headerSieView, apply));
    for (const r of [typeCombo, ibanRow, termRow, prefixRow, closingRow, closingSieRow]) group.add(r);
    group.add(issuerRow(host, entity, inv.selfIssuer, () => save()));
    return group;
}

/** Standard cover letter (multi-line, so no EntryRow): saved with the button, not on every keystroke. */
function headerRow(title: string, view: Gtk.TextView, onApply: () => void): Adw.ExpanderRow {
    const row = new Adw.ExpanderRow({
        title,
        subtitle:
            'Text über den Positionen für Rechnungen ohne eigenen Text. Platzhalter: {anrede} {kunde} {domain} {periode} {vorperiode} {paket} {gruss} {aussteller}',
    });
    const scroller = new Gtk.ScrolledWindow({ minContentHeight: 160, hasFrame: true, marginTop: 6, marginBottom: 6 });
    scroller.set_child(view);
    const apply = new Gtk.Button({ label: 'Übernehmen', halign: Gtk.Align.END, marginBottom: 6 });
    apply.add_css_class('suggested-action');
    apply.connect('clicked', onApply);
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, marginStart: 12, marginEnd: 12 });
    box.append(scroller);
    box.append(apply);
    row.add_row(box);
    return row;
}

/**
 * The §14-UStG Aussteller block for the `self` provider — the identity PRINTED on an invoice.
 *
 * It is not optional decoration: §14 requires the issuer's name and address and either the
 * Steuernummer or the USt-IdNr, and the §19 flag decides whether the invoice shows VAT at all. All
 * of it was reachable only by editing the manifest, which meant the one provider that generates a
 * legally usable invoice locally could not be configured from the app that generates it.
 *
 * The whole block is re-serialised on every apply and handed to the invoicing save, which prunes
 * empty fields — so clearing a row removes the key rather than writing an empty string into a form.
 */
function issuerRow(
    host: SettingsHost,
    entity: AppEntity,
    issuer: IssuerConfig | null,
    onChange: () => void,
): Adw.ExpanderRow {
    const row = new Adw.ExpanderRow({
        title: 'Aussteller (§ 14 UStG)',
        subtitle: 'Name, Anschrift und Steuernummer/USt-IdNr, die auf der Rechnung stehen.',
    });
    const i = issuer ?? {};
    const bank = i.bank ?? {};
    const text: Record<string, Adw.EntryRow> = {};
    const mk = (key: string, title: string, value: string | undefined) => {
        const r = entryRow(host, title, value ?? '', onChange);
        text[key] = r;
        row.add_row(r);
    };
    mk('name', 'Name', i.name);
    mk('signature', 'Signatur unter Anschreiben (leer = Name)', i.signature);
    mk('address', 'Straße und Hausnummer', i.address);
    mk('zip', 'PLZ', i.zip);
    mk('city', 'Ort', i.city);
    mk('countryCode', 'Ländercode (DE)', i.countryCode);
    mk('email', 'E-Mail', i.email);
    mk('phone', 'Telefon', i.phone);
    mk('website', 'Website', i.website);
    mk('taxNumber', 'Steuernummer (Anzeigeformat)', i.taxNumber);
    mk('vatId', 'USt-IdNr', i.vatId);
    mk('bankName', 'Bank', bank.bankName);
    mk('accountHolder', 'Kontoinhaber', bank.accountHolder);
    mk('bankIban', 'IBAN (auf der Rechnung)', bank.iban);
    mk('bic', 'BIC', bank.bic);

    const klein = toggleRow(
        host,
        'Kleinunternehmer (§ 19 UStG)',
        'Rechnungen weisen keine Umsatzsteuer aus und tragen den § 19-Hinweis.',
        i.kleinunternehmer ?? false,
        onChange,
    );
    row.add_row(klein);

    // Read back by the invoicing group's own save, so one apply writes one manifest revision.
    issuerReaders.set(entity.id, () => ({
        name: text.name?.get_text() ?? '',
        signature: text.signature?.get_text() ?? '',
        address: text.address?.get_text() ?? '',
        zip: text.zip?.get_text() ?? '',
        city: text.city?.get_text() ?? '',
        countryCode: text.countryCode?.get_text() ?? '',
        email: text.email?.get_text() ?? '',
        phone: text.phone?.get_text() ?? '',
        website: text.website?.get_text() ?? '',
        taxNumber: text.taxNumber?.get_text() ?? '',
        vatId: text.vatId?.get_text() ?? '',
        kleinunternehmer: klein.get_active(),
        bank: {
            iban: text.bankIban?.get_text() ?? '',
            bic: text.bic?.get_text() ?? '',
            bankName: text.bankName?.get_text() ?? '',
            accountHolder: text.accountHolder?.get_text() ?? '',
        },
    }));
    return row;
}

/** Per-entity reader for the Aussteller block, set when the row is built and read by the group save. */
const issuerReaders = new Map<string, () => IssuerConfig>();
