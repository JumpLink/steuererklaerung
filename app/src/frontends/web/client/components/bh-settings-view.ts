// <bh-settings-view> — "Einstellungen": toggle the built-in web assistant and configure
// which MCP tool groups are exposed to external clients (ChatGPT, Claude Code …), plus a
// write-access switch. Each group expands to list its actual tools + descriptions (from
// /api/mcp-tools). Saving writes steuererklaerung.json (server side) and updates the in-memory
// settings; the assistant toggle takes effect immediately.

import type { Adw } from '@gjsify/adwaita-web';
import {
    api,
    type AppSettings,
    type McpGroupTools,
    type McpToolInfo,
    type EntityDms,
    type EntityInvoicing,
} from '../lib/api.ts';
import { esc } from '../lib/format.ts';
import { q } from '../lib/dom.ts';

const GROUP_LABELS: Record<string, string> = {
    paperless: 'Paperless',
    qonto: 'Qonto',
    transactions: 'Transactions (Store)',
    reconcile: 'Reconciliation',
    documentWorkflow: 'Dokument-Workflow',
    crossSystem: 'Cross-System',
    elster: 'ELSTER',
    contacts: 'Kontakte (Parteienstamm)',
};

export class BhSettingsView extends HTMLElement {
    private s: AppSettings | null = null;
    private catalog: McpGroupTools[] = [];
    private entity = '';
    private entityName = '';
    private dms: EntityDms | null = null;
    private invoicing: EntityInvoicing | null = null;

    async connectedCallback() {
        this.entity = this.getAttribute('entity') ?? '';
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade Einstellungen …</div>`;
        try {
            const [s, catalog, dms, invoicing, meta] = await Promise.all([
                api.settings(),
                api.mcpTools().catch(() => []),
                this.entity ? api.entityDms(this.entity).catch(() => null) : Promise.resolve(null),
                this.entity ? api.entityInvoicing(this.entity).catch(() => null) : Promise.resolve(null),
                api.meta().catch(() => null),
            ]);
            this.s = s;
            this.catalog = catalog;
            this.dms = dms;
            this.invoicing = invoicing;
            this.entityName = meta?.entities.find((e) => e.id === this.entity)?.name ?? this.entity;
            this.render();
        } catch (err) {
            this.innerHTML = `<adw-card class="bh-error">Fehler: ${esc(err instanceof Error ? err.message : err)}</adw-card>`;
        }
    }

    /** Per-entity document store: built-in (default) vs a Paperless instance (URL + token). */
    private dmsSection(): string {
        if (!this.dms) return '';
        const paperless = this.dms.type === 'paperless';
        return `
      <div class="bh-subhead">Dokumentenspeicher · ${esc(this.entityName)}</div>
      <p class="bh-muted bh-set-note">Wo die Belege dieser Firma liegen. „Eingebaut" speichert lokal (kein Server nötig — Standard);
        die KI liest hochgeladene Belege aus. „Paperless" bindet eine bestehende Paperless-ngx-Instanz an. Wirkt nach Neu-Aufbau des Index.</p>
      <adw-preferences-group>
        <adw-combo-row data-dms="type" title="Typ" model='["Eingebaut (lokal)","Paperless-ngx"]' selected="${paperless ? 1 : 0}"></adw-combo-row>
        <adw-entry-row data-pf data-dms="url" title="Paperless-URL" text="${esc(this.dms.paperlessUrl ?? '')}"${paperless ? '' : ' style="display:none"'}></adw-entry-row>
        <adw-password-entry-row data-pf data-dms="token" title="API-Token${this.dms.hasToken ? ' (gespeichert — leer = behalten)' : ''}"${paperless ? '' : ' style="display:none"'}></adw-password-entry-row>
        <adw-button-row data-act="save-dms" class="suggested-action" title="Speichern"></adw-button-row>
      </adw-preferences-group>
      <p class="bh-set-status bh-muted bh-set-note" data-el="dms-status"></p>`;
    }

    /** Per-entity outgoing-invoice back-end (Qonto draft vs self). The due-list lives in Rechnungen. */
    private invoicingSection(): string {
        if (!this.invoicing) return '';
        const inv = this.invoicing;
        const isSelf = inv.type === 'self';
        const iss = inv.selfIssuer ?? {};
        const bank = iss.bank ?? {};
        return `
      <div class="bh-subhead">Rechnungsstellung · ${esc(this.entityName)}</div>
      <p class="bh-muted bh-set-note">Wie ausgehende (wiederkehrende) Rechnungen erstellt werden. „Qonto" legt einen Entwurf über die Qonto-API an — du prüfst &amp; sendest ihn dort. „Eigene Erstellung" erzeugt Nummer, PDF und XRechnung selbst. Die fälligen Rechnungen siehst du im Tab <strong>Rechnungen</strong>; die Termine pflegst du in <code>recurring-invoices.json</code>.</p>
      <adw-preferences-group>
        <adw-combo-row data-inv="type" title="Back-End" model='["Qonto (Entwurf via API)","Eigene Erstellung (self)"]' selected="${isSelf ? 1 : 0}"></adw-combo-row>
        <adw-entry-row data-inv="iban" title="Zahlungs-IBAN" text="${esc(inv.iban ?? '')}"></adw-entry-row>
        <adw-spin-row data-inv="terms" title="Zahlungsziel (Tage)" adjustment='{"lower":0,"upper":120,"stepIncrement":1}' value="${inv.paymentTermsDays ?? 15}"></adw-spin-row>
      </adw-preferences-group>
      <adw-preferences-group title="Aussteller (für „Eigene Erstellung")" description="Erscheint auf PDF + XRechnung. Steuernummer ODER USt-IdNr. ist zum Festschreiben erforderlich.">
        <adw-entry-row data-iss="numberPrefix" title="Rechnungsnummer-Präfix" text="${esc(inv.selfNumberPrefix ?? 'RE-')}"></adw-entry-row>
        <adw-entry-row data-iss="name" title="Name / Firma" text="${esc(iss.name ?? '')}"></adw-entry-row>
        <adw-entry-row data-iss="address" title="Straße + Nr." text="${esc(iss.address ?? '')}"></adw-entry-row>
        <adw-entry-row data-iss="zip" title="PLZ" text="${esc(iss.zip ?? '')}"></adw-entry-row>
        <adw-entry-row data-iss="city" title="Ort" text="${esc(iss.city ?? '')}"></adw-entry-row>
        <adw-entry-row data-iss="taxNumber" title="Steuernummer" text="${esc(iss.taxNumber ?? '')}"></adw-entry-row>
        <adw-entry-row data-iss="vatId" title="USt-IdNr." text="${esc(iss.vatId ?? '')}"></adw-entry-row>
        <adw-entry-row data-iss="email" title="E-Mail" text="${esc(iss.email ?? '')}"></adw-entry-row>
        <adw-switch-row data-iss="kleinunternehmer" title="Kleinunternehmer (§ 19 UStG)" subtitle="Keine USt ausweisen"${iss.kleinunternehmer ? ' active' : ''}></adw-switch-row>
      </adw-preferences-group>
      <adw-preferences-group title="Bankverbindung" description="Für die Fußzeile + den SEPA-GiroCode (Scan-to-pay). IBAN = die Zahlungs-IBAN oben.">
        <adw-entry-row data-iss="bic" title="BIC" text="${esc(bank.bic ?? '')}"></adw-entry-row>
        <adw-entry-row data-iss="bankName" title="Bank" text="${esc(bank.bankName ?? '')}"></adw-entry-row>
        <adw-entry-row data-iss="accountHolder" title="Kontoinhaber" text="${esc(bank.accountHolder ?? '')}"></adw-entry-row>
        <adw-entry-row data-iss="logoPath" title="Logo-Pfad (PNG, optional)" text="${esc(iss.logoPath ?? '')}"></adw-entry-row>
        <adw-button-row data-act="save-invoicing" class="suggested-action" title="Speichern"></adw-button-row>
      </adw-preferences-group>
      <p class="bh-set-status bh-muted bh-set-note" data-el="invoicing-status"></p>`;
    }

    /** A boolean setting as an adw-switch-row (value read back via .active in collect()). */
    private row(label: string, sub: string, checked: boolean, key: string): string {
        return `<adw-switch-row data-k="${esc(key)}" title="${esc(label)}"${sub ? ` subtitle="${esc(sub)}"` : ''}${
            checked ? ' active' : ''
        }></adw-switch-row>`;
    }

    private toolsFor(group: string): McpToolInfo[] {
        return this.catalog.find((c) => c.group === group)?.tools ?? [];
    }

    /** A tool group as an adw-expander-row: the enable-switch exposes the group to MCP
     * (read back via .enableExpansion); the disclosure reveals its tools as action-rows. */
    private groupRow(key: string, label: string, checked: boolean): string {
        const tools = this.toolsFor(key);
        const writeN = tools.filter((t) => !t.readOnly).length;
        const sub = tools.length
            ? `${tools.length} Tools${writeN ? ` · ${writeN} schreibend` : ' · read-only'}`
            : 'keine Tools';
        const toolRows = tools
            .map(
                (t) =>
                    `<adw-action-row title="${esc(t.name)}" subtitle="${esc(t.description)}">${
                        t.readOnly ? '' : '<span slot="suffix" class="bh-tool-write">schreibt</span>'
                    }</adw-action-row>`,
            )
            .join('');
        return `<adw-expander-row data-k="mcp.groups.${esc(key)}" title="${esc(label)}" subtitle="${esc(sub)}" show-enable-switch enable-expansion="${checked ? 'true' : 'false'}">${toolRows}</adw-expander-row>`;
    }

    private render() {
        if (!this.s) return;
        const s = this.s;
        const groups = Object.entries(GROUP_LABELS)
            .map(([k, label]) => this.groupRow(k, label, (s.mcp.groups as Record<string, boolean>)[k] ?? false))
            .join('');
        const total = this.catalog.reduce((n, c) => n + c.tools.length, 0);

        this.innerHTML = `

      <div class="bh-subhead">Integrierter Assistent</div>
      <adw-preferences-group>
        ${this.row('Eingebauter KI-Assistent', 'Fragen zu deinen Zahlen, persönliche Einstellung. Aus = Tab ausgeblendet, /api/chat gesperrt. Unabhängig vom MCP-Server.', s.assistant.enabled, 'assistant.enabled')}
      </adw-preferences-group>

      ${this.dmsSection()}

      ${this.invoicingSection()}

      <div class="bh-subhead">MCP-Server für externe Agenten <bh-help term="mcp"></bh-help></div>
      <p class="bh-muted bh-set-note">Steuert, welche Tools der MCP-Server für externe Assistenten (ChatGPT, Claude Code, eigene Clients) offenlegt — per stdio oder HTTP. Externe Änderungen wirken beim nächsten Start des MCP-Servers.</p>
      <adw-preferences-group>
        ${this.row('MCP-Server für externe Agenten', 'Aus = keine Tools nach außen. Der eingebaute Assistent braucht ihn nicht.', s.mcp.enabled, 'mcp.enabled')}
        ${this.row('Schreibzugriff erlauben', 'Mutierende Tools (update · link · push · sync · lock). Standard: aus — read-only.', s.mcp.allowWrite, 'mcp.allowWrite')}
      </adw-preferences-group>

      <div class="bh-subhead">Tool-Gruppen${total ? ` · ${total} Tools` : ''}</div>
      <adw-preferences-group>${groups}</adw-preferences-group>

      <div class="bh-set-actions">
        <button class="adw-button suggested-action" data-act="save">Speichern</button>
        <span class="bh-set-status bh-muted" data-el="status"></span>
      </div>`;

        this.querySelector('[data-act="save"]')?.addEventListener('click', () => void this.save());

        // Per-entity DMS section: the Typ combo reveals/hides the Paperless rows; its own save row.
        this.querySelector('adw-combo-row[data-dms="type"]')?.addEventListener('notify::selected', (e) => {
            const paperless = (e as CustomEvent<{ selected: number }>).detail.selected === 1;
            this.querySelectorAll('[data-pf]').forEach((el) => {
                (el as HTMLElement).style.display = paperless ? '' : 'none';
            });
        });
        this.querySelector('[data-act="save-dms"]')?.addEventListener('activated', () => void this.saveDms());

        // Per-entity invoicing section: its own save row (the due-list + creation live in Rechnungen).
        this.querySelector('[data-act="save-invoicing"]')?.addEventListener(
            'activated',
            () => void this.saveInvoicing(),
        );
    }

    private async saveInvoicing() {
        const status = this.querySelector('[data-el="invoicing-status"]') as HTMLElement;
        const typeRow = q<Adw.ComboRow>(this, 'adw-combo-row[data-inv="type"]');
        const type = typeRow?.selected === 1 ? 'self' : 'qonto';
        const iban = q<Adw.EntryRow>(this, 'adw-entry-row[data-inv="iban"]')?.text.trim();
        const paymentTermsDays = q<Adw.SpinRow>(this, 'adw-spin-row[data-inv="terms"]')?.value;
        // Issuer fields (self back-end).
        const iss = (n: string) => q<Adw.EntryRow>(this, `adw-entry-row[data-iss="${n}"]`)?.text.trim() ?? '';
        const kleinunternehmer = q<Adw.SwitchRow>(this, 'adw-switch-row[data-iss="kleinunternehmer"]')?.active ?? false;
        const selfIssuer = {
            name: iss('name'),
            address: iss('address'),
            zip: iss('zip'),
            city: iss('city'),
            taxNumber: iss('taxNumber'),
            vatId: iss('vatId'),
            email: iss('email'),
            kleinunternehmer,
            logoPath: iss('logoPath'),
            // The bank IBAN is the payment IBAN above; bic/name/holder come from the bank group.
            bank: { iban: iban ?? '', bic: iss('bic'), bankName: iss('bankName'), accountHolder: iss('accountHolder') },
        };
        status.textContent = 'Speichere …';
        try {
            await api.saveEntityInvoicing({
                entity: this.entity,
                type,
                iban: iban || undefined,
                paymentTermsDays,
                selfNumberPrefix: iss('numberPrefix') || undefined,
                selfIssuer,
            });
            this.invoicing = await api.entityInvoicing(this.entity).catch(() => this.invoicing);
            status.textContent = '✓ Gespeichert';
        } catch (err) {
            status.textContent = `Fehler: ${err instanceof Error ? err.message : err}`;
        }
    }

    private async saveDms() {
        const status = this.querySelector('[data-el="dms-status"]') as HTMLElement;
        const typeRow = q<Adw.ComboRow>(this, 'adw-combo-row[data-dms="type"]');
        const type = typeRow?.selected === 1 ? 'paperless' : 'builtin';
        const url = q<Adw.EntryRow>(this, 'adw-entry-row[data-dms="url"]')?.text.trim();
        const tokenRow = q<Adw.PasswordEntryRow>(this, 'adw-password-entry-row[data-dms="token"]');
        status.textContent = 'Speichere …';
        try {
            await api.saveEntityDms({
                entity: this.entity,
                type,
                paperlessUrl: url || undefined,
                paperlessToken: tokenRow?.text || undefined,
            });
            if (tokenRow) tokenRow.text = ''; // never keep the secret in the DOM after saving
            this.dms = await api.entityDms(this.entity).catch(() => this.dms);
            status.textContent = '✓ Gespeichert — Beleg-Index wird neu aufgebaut.';
        } catch (err) {
            status.textContent = `Fehler: ${err instanceof Error ? err.message : err}`;
        }
    }

    private collect(): AppSettings {
        // Read whichever control backs a given key: the top-level toggles are adw-switch-rows
        // (.active); the MCP tool-groups are adw-expander-rows whose enable-switch is the
        // group's "exposed to MCP" flag (.enableExpansion).
        const cb = (k: string) =>
            q<Adw.SwitchRow>(this, `adw-switch-row[data-k="${k}"]`)?.active ??
            q<Adw.ExpanderRow>(this, `adw-expander-row[data-k="${k}"]`)?.enableExpansion ??
            false;
        const groups = Object.fromEntries(Object.keys(GROUP_LABELS).map((g) => [g, cb(`mcp.groups.${g}`)]));
        return {
            assistant: { enabled: cb('assistant.enabled') },
            mcp: {
                enabled: cb('mcp.enabled'),
                allowWrite: cb('mcp.allowWrite'),
                groups: groups as AppSettings['mcp']['groups'],
            },
            // Lernmodus has no web control yet (native setting); preserve the loaded value on save.
            lernmodus: this.s?.lernmodus ?? false,
            // Sync has no web control either (native setting); preserve the loaded value on save.
            sync: this.s?.sync ?? { enabled: true, invoicesMinutes: 15, transactionsMinutes: 60, paperlessMinutes: 30 },
        };
    }

    private async save() {
        const status = this.querySelector('[data-el="status"]') as HTMLElement;
        const btn = this.querySelector('[data-act="save"]') as HTMLButtonElement;
        btn.disabled = true;
        status.textContent = 'Speichere …';
        try {
            this.s = await api.saveSettings(this.collect());
            status.textContent = '✓ Gespeichert';
            document.dispatchEvent(new CustomEvent('bh-settings-saved'));
        } catch (err) {
            status.textContent = `Fehler: ${err instanceof Error ? err.message : err}`;
        } finally {
            btn.disabled = false;
        }
    }
}

customElements.define('bh-settings-view', BhSettingsView);

declare global {
    interface HTMLElementTagNameMap {
        'bh-settings-view': BhSettingsView;
    }
}
