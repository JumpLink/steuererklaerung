// <bh-fristen-view> — read-only "Fristen & offene Posten" overview. Three layers:
//   • reactive: every Paperless document marked payment_status=offen, grouped by urgency;
//   • proactive: recurring statutory Steuertermine (Regelfristen) derived from the ELSTER configs;
//   • payments: filed-but-unpaid tax amounts from the filing register, with estimated due dates.
// Mirrors the CLI `fristen`, the MCP `list_open_items` / `list_upcoming_deadlines` /
// `list_open_tax_payments` and the app view.

import { api } from '../lib/api.ts';
import { eur, esc } from '../lib/format.ts';
import type { OpenItem } from '../../../../core/actions/fristen.ts';
import type { SteuerTermin } from '../../../../core/elster/steuertermine.ts';
import type { OffeneSteuerzahlung } from '../../../../core/elster/steuerzahlungen.ts';

function fristText(dueDate: string | null, daysUntil: number | null): string {
    if (dueDate == null || daysUntil == null) return 'ohne Frist';
    const n = daysUntil;
    if (n > 0) return `fällig in ${n} Tag${n === 1 ? '' : 'en'} · ${dueDate}`;
    if (n === 0) return `heute fällig · ${dueDate}`;
    return `überfällig seit ${-n} Tag${n === -1 ? '' : 'en'} · ${dueDate}`;
}

export class BhFristenView extends HTMLElement {
    async connectedCallback() {
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade Fristen…</div>`;
        let items: OpenItem[];
        let termine: SteuerTermin[];
        let zahlungen: OffeneSteuerzahlung[];
        try {
            [items, termine, zahlungen] = await Promise.all([
                api.openItems(),
                api.steuertermine(),
                api.steuerzahlungen(),
            ]);
        } catch (e) {
            this.innerHTML = `<div class="bh-error">${esc(String(e))}</div>`;
            return;
        }

        const today = new Date().toISOString().slice(0, 10);
        const overdue = items.filter((i) => i.overdue);
        const due = items.filter((i) => !i.overdue && i.dueDate != null);
        const undated = items.filter((i) => i.dueDate == null);
        this.innerHTML = `
      <header class="bh-view-head">
        <div class="bh-result bh-muted">Read-only · Stand ${today}</div>
      </header>

      <h2 class="bh-section-title">Offene Posten <small class="bh-muted">· payment_status=offen</small></h2>
      ${
          items.length
              ? `<div class="bh-cards">${this.group('Überfällig', overdue)}${this.group('Fällig', due)}${this.group('Ohne Frist', undated)}</div>`
              : `<adw-card class="bh-taxcard"><div class="bh-muted">Keine offenen Posten 🎉</div></adw-card>`
      }

      <h2 class="bh-section-title">Offene Steuerzahlungen <small class="bh-muted">· eingereicht, aber noch nicht überwiesen</small></h2>
      ${
          zahlungen.length
              ? `<div class="bh-cards">${this.zahlungenGroup('Zu überweisen', zahlungen)}</div>`
              : `<adw-card class="bh-taxcard"><div class="bh-muted">Keine offenen Steuerzahlungen 🎉</div></adw-card>`
      }

      <h2 class="bh-section-title">Kommende Steuertermine <small class="bh-muted">· Regelfrist-Schätzung, gegen den Bescheid prüfen</small></h2>
      ${
          termine.length
              ? `<div class="bh-cards">${this.termineGroup(
                    'Überfällig',
                    termine.filter((t) => !t.status && t.overdue),
                )}${this.termineGroup(
                    'Bald fällig (≤ 30 Tage)',
                    termine.filter((t) => !t.status && !t.overdue && t.daysUntil <= 30),
                )}${this.termineGroup(
                    'Geplant',
                    termine.filter((t) => !t.status && !t.overdue && t.daysUntil > 30),
                )}${this.termineGroup(
                    'Erledigt',
                    termine.filter((t) => t.status),
                )}</div>`
              : `<adw-card class="bh-taxcard"><div class="bh-muted">Keine anstehenden Steuertermine.</div></adw-card>`
      }`;
    }

    private group(title: string, items: OpenItem[]): string {
        if (items.length === 0) return '';
        const sum = items.reduce((s, i) => s + (i.amount ?? 0), 0);
        const rows = items
            .map((i) => {
                const scope = i.dataScope ? `[${esc(i.dataScope)}] ` : '';
                const detail = i.title && i.title !== i.correspondent ? ` · ${esc(i.title)}` : '';
                return `<div class="bh-line"><dt>${esc(i.correspondent ?? i.title ?? `#${i.id}`)} <small>${scope}${esc(fristText(i.dueDate, i.daysUntil))}${detail}</small></dt><dd>${i.amount != null ? eur(i.amount) : ''}</dd></div>`;
            })
            .join('');
        return `<adw-card class="bh-taxcard">
      <div class="bh-card-head"><h2>${esc(title)}</h2><span class="bh-pill">${items.length} · ${eur(sum)}</span></div>
      <dl class="bh-dl">${rows}</dl>
    </adw-card>`;
    }

    private zahlungenGroup(title: string, zahlungen: OffeneSteuerzahlung[]): string {
        if (zahlungen.length === 0) return '';
        const sum = zahlungen.reduce((s, z) => s + z.amount, 0);
        const rows = zahlungen
            .map(
                (z) =>
                    `<div class="bh-line"><dt>${esc(z.entityName)}: ${esc(z.label)} <small>${esc(
                        fristText(z.dueDate, z.daysUntil),
                    )} · ${esc(z.note)}</small></dt><dd>${eur(z.amount)}</dd></div>`,
            )
            .join('');
        return `<adw-card class="bh-taxcard">
      <div class="bh-card-head"><h2>${esc(title)}</h2><span class="bh-pill">${zahlungen.length} · ${eur(sum)}</span></div>
      <dl class="bh-dl">${rows}</dl>
    </adw-card>`;
    }

    private termineGroup(title: string, termine: SteuerTermin[]): string {
        if (termine.length === 0) return '';
        const rows = termine
            .map((t) => {
                const info = t.status
                    ? `${t.status === 'bezahlt' ? 'bezahlt' : 'eingereicht'}${(t.paidAt ?? t.filedAt) ? ` ${t.paidAt ?? t.filedAt}` : ''} · ${t.dueDate}`
                    : `${fristText(t.dueDate, t.daysUntil)}${t.note ? ` · ${esc(t.note)}` : ''}`;
                return `<div class="bh-line"><dt>${esc(t.entityName)}: ${esc(t.label)} <small>${info}</small></dt></div>`;
            })
            .join('');
        return `<adw-card class="bh-taxcard">
      <div class="bh-card-head"><h2>${esc(title)}</h2><span class="bh-pill">${termine.length}</span></div>
      <dl class="bh-dl">${rows}</dl>
    </adw-card>`;
    }
}

customElements.define('bh-fristen-view', BhFristenView);
