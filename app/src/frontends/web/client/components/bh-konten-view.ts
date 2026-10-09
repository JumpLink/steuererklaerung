// <bh-konten-view> — "Konten": manage account connections. Lists existing connections
// (Qonto · FinTS · CAMT · PayPal) with entity, transaction count, range and balance; imports
// supported transaction exports (file → store); and disconnects an account (delete all, or
// just stop syncing). This is the web UI's first WRITE path. After a mutation the tax views
// are refreshed via a server-side cache rebuild (polled here).

import { api, type AccountsResponse, type ConnectionInfo, type ImportFormat } from '../lib/api.ts';
import { type AlertChoice, alertDialog } from '../lib/dialogs.ts';
import { eur, esc, deDate, humanizeKey } from '../lib/format.ts';
import { readBase64 } from '../lib/view-helpers.ts';

const SOURCE_LABEL: Record<string, string> = {
    qonto: 'Qonto',
    fints: 'FinTS',
    camt: 'CAMT · Datei',
    paypal: 'PayPal',
};
const FORMATS: { value: ImportFormat; label: string; accept: string }[] = [
    { value: 'camt', label: 'CAMT.052/053 (XML)', accept: '.xml' },
    { value: 'paypal', label: 'PayPal-Aktivitätsbericht (CSV)', accept: '.csv' },
    { value: 'qonto-xls', label: 'Qonto Datenexport (XLS)', accept: '.xls,.xlsx' },
    { value: 'amazon', label: 'Amazon Bestellungen (CSV)', accept: '.csv' },
];
const EXT_FORMAT: Record<string, ImportFormat> = { xml: 'camt', xls: 'qonto-xls', xlsx: 'qonto-xls', csv: 'paypal' };

export class BhKontenView extends HTMLElement {
    private data: AccountsResponse | null = null;
    private poll = 0;
    private syncPoll = 0;
    private hideTimer = 0;

    async connectedCallback() {
        await this.load();
    }
    disconnectedCallback() {
        if (this.poll) clearInterval(this.poll);
        if (this.syncPoll) clearInterval(this.syncPoll);
        if (this.hideTimer) clearTimeout(this.hideTimer);
    }

    private async load() {
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade Konten …</div>`;
        try {
            this.data = await api.accounts();
            this.render();
        } catch (err) {
            this.innerHTML = `<adw-card class="bh-error">Fehler: ${esc(err instanceof Error ? err.message : err)}</adw-card>`;
        }
    }

    private accountRow(a: ConnectionInfo): string {
        const range = a.firstDate ? `${deDate(a.firstDate)} – ${deDate(a.lastDate)}` : '—';
        const badge = a.live
            ? '<span class="bh-konto-badge live">live</span>'
            : '<span class="bh-konto-badge">Datei</span>';
        return `<div class="bh-konto" data-key="${esc(a.accountKey)}">
        <div class="bh-konto-main">
          <div class="bh-konto-h"><strong>${esc(SOURCE_LABEL[a.source] ?? humanizeKey(a.source))}</strong> ${badge}
            ${a.entityName ? `<span class="bh-konto-entity">${esc(a.entityName)}</span>` : ''}</div>
          <div class="bh-konto-sub"><code>${esc(a.ref)}</code> · ${a.count} Buchungen · ${esc(range)}${a.lastSyncedAt ? ` · Sync ${esc(deDate(a.lastSyncedAt.slice(0, 10)))}` : ''}</div>
        </div>
        <div class="bh-konto-net">${eur(a.net)}</div>
        <button class="bh-konto-trennen" data-act="trennen" data-key="${esc(a.accountKey)}" data-live="${a.live}" data-count="${a.count}">Trennen</button>
      </div>`;
    }

    private render() {
        if (!this.data) return;
        const { accounts, connectors } = this.data;
        const fintsList = connectors.fints.accounts.length ? connectors.fints.accounts.join(', ') : 'keine';
        const formatOpts = FORMATS.map((f) => `<option value="${f.value}">${esc(f.label)}</option>`).join('');

        this.innerHTML = `
      <header class="bh-view-head">
        <div class="bh-result bh-muted">Anbindungen verwalten · ${accounts.length} Konten</div>
      </header>

      <div class="bh-rebuild" data-el="rebuild" hidden></div>

      <div class="bh-subhead">Angebundene Konten</div>
      <div class="bh-setlist bh-konten">${accounts.length ? accounts.map((a) => this.accountRow(a)).join('') : '<div class="bh-konto bh-muted">Noch keine Konten — importiere unten einen Export.</div>'}</div>

      <div class="bh-subhead">Export importieren</div>
      <adw-card class="bh-import">
        <div class="bh-import-row">
          <input type="file" data-el="file" class="bh-file" accept=".xml,.csv,.xls,.xlsx" aria-label="Export-Datei">
          <select class="bh-select" data-el="format" aria-label="Import-Format">${formatOpts}</select>
        </div>
        <label class="bh-import-full"><input type="checkbox" data-el="full"> Vollständig importieren (Überlappung nicht überspringen)</label>
        <div class="bh-set-actions">
          <button class="adw-button suggested-action" data-act="import">Importieren</button>
          <span class="bh-set-status bh-muted" data-el="import-status"></span>
        </div>
      </adw-card>

      <div class="bh-subhead">Live-Anbindungen</div>
      <adw-card class="bh-import">
        <div class="bh-konto-sub" style="margin-bottom:0.6rem">Qonto: ${connectors.qonto.configured ? `verbunden (${esc(connectors.qonto.env)})` : 'nicht konfiguriert'} · FinTS: ${esc(fintsList)}</div>
        <div class="bh-set-actions">
          <button class="adw-button suggested-action" data-act="sync">Jetzt synchronisieren</button>
          <span class="bh-set-status bh-muted" data-el="sync-status"></span>
        </div>
      </adw-card>

      <details class="bh-connect">
        <summary>＋ Qonto verbinden</summary>
        <div class="bh-connect-body">
          <label class="bh-field"><span>Login</span><input class="bh-input" data-q="login" autocomplete="off"></label>
          <label class="bh-field"><span>SecretKey</span><input class="bh-input" type="password" data-q="secretKey" autocomplete="off"></label>
          <label class="bh-field"><span>Umgebung</span><select class="bh-select" data-q="env"><option value="production">production</option><option value="staging">staging</option></select></label>
          <label class="bh-field"><span>Bank-Konto-ID (optional)</span><input class="bh-input" data-q="bankAccountId" autocomplete="off"></label>
          <div class="bh-set-actions"><button class="adw-button suggested-action" data-act="connect-qonto">In .env speichern</button><span class="bh-muted" data-el="q-status"></span></div>
          <p class="bh-muted bh-set-note">Wird in .env gespeichert (nur lokal). Danach „Jetzt synchronisieren".</p>
        </div>
      </details>

      <details class="bh-connect">
        <summary>＋ FinTS-Konto hinzufügen</summary>
        <div class="bh-connect-body">
          <label class="bh-field"><span>Name</span><input class="bh-input" data-f="name" placeholder="z. B. musterbank-privat"></label>
          <label class="bh-field"><span>FinTS-URL</span><input class="bh-input" data-f="url"></label>
          <label class="bh-field"><span>BLZ</span><input class="bh-input" data-f="blz"></label>
          <label class="bh-field"><span>Benutzer</span><input class="bh-input" data-f="user_id"></label>
          <label class="bh-field"><span>Produkt-ID</span><input class="bh-input" data-f="product_id"></label>
          <label class="bh-field"><span>PIN</span><input class="bh-input" type="password" data-f="pin" autocomplete="off"></label>
          <div class="bh-set-actions"><button class="adw-button suggested-action" data-act="connect-fints">Speichern</button><span class="bh-muted" data-el="f-status"></span></div>
          <p class="bh-muted bh-set-note">Speichert fints-config.json + PIN in .env. Die Erstanmeldung inkl. TAN bitte einmalig per CLI: <code>steuer fints sync</code>.</p>
        </div>
      </details>`;

        this.querySelector('[data-act="import"]')?.addEventListener('click', () => void this.doImport());
        this.querySelector('[data-el="file"]')?.addEventListener('change', () => this.guessFormat());
        this.querySelector('[data-act="sync"]')?.addEventListener('click', () => void this.doSync());
        this.querySelector('[data-act="connect-qonto"]')?.addEventListener('click', () => void this.connectQonto());
        this.querySelector('[data-act="connect-fints"]')?.addEventListener('click', () => void this.connectFints());
        this.bindTrennen();
    }

    private async doSync() {
        const status = this.querySelector('[data-el="sync-status"]') as HTMLElement;
        status.textContent = 'Sync gestartet …';
        try {
            await api.syncAccounts();
            this.watchSync();
        } catch (err) {
            status.textContent = `Fehler: ${err instanceof Error ? err.message : err}`;
        }
    }

    /** Poll `fetchFn` every 2s until `onUpdate` returns 'stop' (or a ~5 min cap). Returns the timer id. */
    private pollUntil<T extends { status: string }>(
        fetchFn: () => Promise<T>,
        onUpdate: (s: T) => 'continue' | 'stop',
    ): number {
        let n = 0;
        const id = window.setInterval(async () => {
            if (++n > 150) {
                clearInterval(id);
                return;
            }
            let s: T;
            try {
                s = await fetchFn();
            } catch {
                return; // transient — keep polling
            }
            if (onUpdate(s) === 'stop') clearInterval(id);
        }, 2000);
        return id;
    }

    private watchSync() {
        const status = this.querySelector('[data-el="sync-status"]') as HTMLElement | null;
        if (!status) return;
        if (this.syncPoll) clearInterval(this.syncPoll);
        this.syncPoll = this.pollUntil(api.syncStatus, (s) => {
            if (s.status === 'done') {
                const reports = s.reports ?? [];
                const sum = reports.map((r) => `${r.accountKey}: +${r.added}`).join(' · ') || 'keine neuen';
                const failed = reports.filter((r) => r.error);
                status.textContent = failed.length
                    ? `⚠ ${sum} · Fehler bei ${failed.map((r) => r.accountKey).join(', ')}`
                    : `✓ ${sum}`;
                this.watchRebuild();
                void this.refreshList();
                return 'stop';
            }
            if (s.status === 'error') {
                status.textContent = `Fehler: ${s.error ?? ''}`;
                return 'stop';
            }
            status.textContent = 'Synchronisiere …';
            return 'continue';
        });
    }

    /** Shared connect-form submit: validate required fields, call the API, clear secrets, refresh. */
    private async submitConnect(
        attr: 'q' | 'f',
        required: string[],
        statusSel: string,
        call: (v: (k: string) => string) => Promise<unknown>,
        okMsg: string,
        secretKeys: string[],
    ) {
        const v = (s: string) =>
            (
                (this.querySelector(`[data-${attr}="${s}"]`) as HTMLInputElement | HTMLSelectElement | null)?.value ??
                ''
            ).trim();
        const status = this.querySelector(statusSel) as HTMLElement;
        if (required.some((k) => !v(k))) {
            status.textContent = 'Bitte alle Pflichtfelder ausfüllen.';
            return;
        }
        status.textContent = 'Speichere …';
        try {
            await call(v);
            for (const k of secretKeys) {
                const el = this.querySelector(`[data-${attr}="${k}"]`) as HTMLInputElement | null;
                if (el) el.value = ''; // don't leave the SecretKey/PIN in the DOM
            }
            status.textContent = okMsg;
            await this.refreshList();
        } catch (err) {
            status.textContent = `Fehler: ${err instanceof Error ? err.message : err}`;
        }
    }

    private connectQonto() {
        return this.submitConnect(
            'q',
            ['login', 'secretKey'],
            '[data-el="q-status"]',
            (v) =>
                api.connectQonto({
                    login: v('login'),
                    secretKey: v('secretKey'),
                    env: v('env') || 'production',
                    bankAccountId: v('bankAccountId') || undefined,
                }),
            '✓ gespeichert — jetzt synchronisieren',
            ['secretKey'],
        );
    }

    private connectFints() {
        return this.submitConnect(
            'f',
            ['name', 'url', 'blz', 'user_id', 'product_id', 'pin'],
            '[data-el="f-status"]',
            (v) =>
                api.connectFints({
                    name: v('name'),
                    url: v('url'),
                    blz: v('blz'),
                    user_id: v('user_id'),
                    product_id: v('product_id'),
                    pin: v('pin'),
                }),
            '✓ gespeichert. TAN-Erstanmeldung per CLI.',
            ['pin'],
        );
    }

    private bindTrennen() {
        this.querySelectorAll('[data-act="trennen"]').forEach((b) =>
            b.addEventListener('click', () => void this.askTrennen(b as HTMLElement)),
        );
    }

    private guessFormat() {
        const file = (this.querySelector('[data-el="file"]') as HTMLInputElement).files?.[0];
        if (!file) return;
        const ext = file.name.toLowerCase().split('.').pop() ?? '';
        const fmt = EXT_FORMAT[ext];
        if (fmt) (this.querySelector('[data-el="format"]') as HTMLSelectElement).value = fmt;
    }

    private async doImport() {
        const fileEl = this.querySelector('[data-el="file"]') as HTMLInputElement;
        const status = this.querySelector('[data-el="import-status"]') as HTMLElement;
        const file = fileEl.files?.[0];
        if (!file) {
            status.textContent = 'Bitte eine Datei wählen.';
            return;
        }
        const format = (this.querySelector('[data-el="format"]') as HTMLSelectElement).value as ImportFormat;
        const full = (this.querySelector('[data-el="full"]') as HTMLInputElement).checked;
        status.textContent = 'Importiere …';
        try {
            const contentBase64 = await readBase64(file);
            const r = await api.importAccount({ format, filename: file.name, contentBase64, full });
            const summary = r.reports
                ? r.reports.map((x) => `${x.accountKey}: +${x.added}/${x.updated} (${x.total})`).join(' · ')
                : r.enrich
                  ? `${r.enrich.matched} gematcht, ${r.enrich.updated} aktualisiert (${r.enrich.accounts} Konten)`
                  : 'fertig';
            status.textContent = `✓ ${summary}`;
            this.watchRebuild();
            await this.refreshList();
        } catch (err) {
            status.textContent = `Fehler: ${err instanceof Error ? err.message : err}`;
        }
    }

    private async askTrennen(btn: HTMLElement) {
        const key = btn.dataset.key ?? '';
        const live = btn.dataset.live === 'true';
        const count = btn.dataset.count ?? '0';
        const choices: AlertChoice[] = [];
        if (live) choices.push({ id: 'stop-sync', label: 'Nur Sync stoppen (Daten behalten)' });
        choices.push({ id: 'delete-all', label: 'Alles löschen', appearance: 'destructive' });
        choices.push({ id: 'cancel', label: 'Abbrechen' });
        const choice = await alertDialog({
            heading: 'Konto trennen',
            body: `${key} — ${count} Buchungen. Wähle, was passieren soll:`,
            choices,
            closeId: 'cancel',
            defaultId: 'cancel',
        });
        if (choice === 'cancel') return;
        await this.doTrennen(key, choice as 'delete-all' | 'stop-sync');
    }

    private async doTrennen(key: string, mode: 'delete-all' | 'stop-sync') {
        try {
            const r = await api.removeAccount(key, mode);
            if (r.rebuilding) this.watchRebuild();
            await this.refreshList();
        } catch (err) {
            await alertDialog({
                heading: 'Trennen fehlgeschlagen',
                body: err instanceof Error ? err.message : String(err),
                choices: [{ id: 'ok', label: 'OK', appearance: 'suggested' }],
            });
        }
    }

    private async refreshList() {
        try {
            this.data = await api.accounts();
            const list = this.querySelector('.bh-konten');
            if (list && this.data)
                list.innerHTML = this.data.accounts.length
                    ? this.data.accounts.map((a) => this.accountRow(a)).join('')
                    : '<div class="bh-konto bh-muted">Noch keine Konten — importiere unten einen Export.</div>';
            this.bindTrennen();
        } catch {
            /* keep the old list on a refresh error */
        }
    }

    private watchRebuild() {
        const banner = this.querySelector('[data-el="rebuild"]') as HTMLElement | null;
        if (!banner) return;
        banner.hidden = false;
        banner.textContent = '⟳ Auswertungen werden neu berechnet …';
        if (this.poll) clearInterval(this.poll);
        this.poll = this.pollUntil(api.rebuildStatus, (s) => {
            if (s.status === 'done') {
                banner.textContent = '✓ Auswertungen aktualisiert.';
                if (this.hideTimer) clearTimeout(this.hideTimer);
                this.hideTimer = window.setTimeout(() => {
                    banner.hidden = true;
                }, 4000);
                return 'stop';
            }
            if (s.status === 'error') {
                banner.textContent = `Fehler beim Aktualisieren: ${s.error ?? ''}`;
                return 'stop';
            }
            return 'continue';
        });
    }
}

customElements.define('bh-konten-view', BhKontenView);

declare global {
    interface HTMLElementTagNameMap {
        'bh-konten-view': BhKontenView;
    }
}
