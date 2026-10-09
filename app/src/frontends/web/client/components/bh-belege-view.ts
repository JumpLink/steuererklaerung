// <bh-belege-view> — "Belege": an actionable inbox of the Vorsteuer-bearing expenses that
// still have no linked invoice (the audit-relevant Beleg gap), grouped by month with a
// running total. A row click opens the full transaction detail; a link jumps to Paperless.
// Read-only; reuses /api/transactions + the shared <bh-tx-detail> modal.

import { api, type TxRow } from '../lib/api.ts';
import { eur, deDate, esc } from '../lib/format.ts';
import { MONTHS, isVstNoBeleg, openTxDetail } from '../lib/view-helpers.ts';

export class BhBelegeView extends HTMLElement {
    private rows: TxRow[] = [];
    private base: string | null = null;

    async connectedCallback() {
        const entity = this.getAttribute('entity') ?? '';
        const year = Number(this.getAttribute('year')) || 2025;
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade Belege ${year}…</div>`;
        try {
            const [meta, tx] = await Promise.all([api.meta().catch(() => null), api.transactions(entity, year)]);
            this.base = meta?.paperlessUrl ?? null;
            this.rows = tx.rows;
            this.render();
        } catch (err) {
            this.innerHTML = `<adw-card class="bh-error">Fehler: ${esc(err instanceof Error ? err.message : err)}</adw-card>`;
        }
    }

    private render() {
        const withVat = this.rows.filter((r) => r.kind === 'expense' && Math.abs(r.vat) > 0.005);
        const gap = this.rows.filter(isVstNoBeleg);
        const gapSum = gap.reduce((s, r) => s + Math.abs(r.vat), 0);
        const withReceipt = withVat.length - gap.length;

        const summary = `<adw-card class="bh-summary"><div class="bh-stats">
        <div class="bh-stat"><span class="bh-stat-n">${withReceipt}/${withVat.length}</span><span class="bh-stat-l">Vorsteuer-Ausgaben mit Beleg</span></div>
        <div class="bh-stat ${gap.length ? 'warn' : ''}"><span class="bh-stat-n">${gap.length}</span><span class="bh-stat-l">ohne Beleg</span></div>
        <div class="bh-stat ${gap.length ? 'warn' : ''}"><span class="bh-stat-n">${eur(gapSum)}</span><span class="bh-stat-l">Vorsteuer ohne Beleg</span></div>
      </div></adw-card>`;

        let body: string;
        if (!gap.length) {
            body = `<div class="bh-banner ok">✓ Alle Vorsteuer-Ausgaben haben einen verknüpften Beleg.</div>`;
        } else {
            const byMonth = new Map<number, TxRow[]>();
            for (const r of gap) {
                const m = Number(r.bookingDate.slice(5, 7));
                const list = byMonth.get(m) ?? [];
                list.push(r);
                byMonth.set(m, list);
            }
            body = [...byMonth.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([m, items]) => {
                    const sum = items.reduce((s, r) => s + Math.abs(r.vat), 0);
                    const rows = items
                        .map(
                            (r) => `
            <div class="bh-beleg" data-id="${esc(r.id)}">
              <span class="bh-beleg-date">${esc(deDate(r.bookingDate))}</span>
              <span class="bh-beleg-cp"><strong>${esc(r.counterparty || '—')}</strong><small>${esc((r.purpose || '').slice(0, 70))}</small></span>
              <span class="bh-beleg-amt bh-amt neg">${eur(r.amount)}</span>
              <span class="bh-beleg-vst">Vorsteuer ${eur(Math.abs(r.vat))}</span>
            </div>`,
                        )
                        .join('');
                    return `<div class="bh-beleg-month"><div class="bh-subhead">${MONTHS[m] ?? m} · ${items.length} · Vorsteuer ${eur(sum)}</div><div class="bh-hinweise">${rows}</div></div>`;
                })
                .join('');
        }

        this.innerHTML = `
      <header class="bh-view-head">
        <div class="bh-result bh-muted">Ausgaben mit Vorsteuer, denen noch eine Rechnung fehlt <bh-help term="vst-ohne-beleg"></bh-help>${this.base ? ` · <a class="bh-link" href="${esc(this.base)}" target="_blank" rel="noreferrer">Paperless öffnen ↗</a>` : ''}</div>
      </header>
      ${summary}
      ${body}
      <p class="bh-muted bh-bwa-note">Belege werden nicht an ELSTER übermittelt (Belegvorhaltepflicht). Für den Vorsteuerabzug die Rechnungen aufbewahren und auf Anforderung des Finanzamts vorlegen. Klick auf eine Buchung öffnet die Details.</p>`;

        this.addEventListener('click', (e) => {
            const el = (e.target as HTMLElement).closest('.bh-beleg[data-id]') as HTMLElement | null;
            const row = el && this.rows.find((r) => r.id === el.dataset.id);
            if (row) openTxDetail(row, this.base);
        });
    }
}

customElements.define('bh-belege-view', BhBelegeView);

declare global {
    interface HTMLElementTagNameMap {
        'bh-belege-view': BhBelegeView;
    }
}
