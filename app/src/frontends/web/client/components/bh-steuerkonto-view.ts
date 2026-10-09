// <bh-steuerkonto-view> — read-only tax-payment overview: what actually flowed to/from
// the tax authorities in the year, split by entity (GbR vs JumpLink vs personal), tax
// type and reference period. Mirrors `elster steuerkonto`. NOT the authoritative
// Finanzamt-Steuerkonto — a sanity-check against Mein ELSTER.

import { api } from '../lib/api.ts';
import { eur, esc } from '../lib/format.ts';

export class BhSteuerkontoView extends HTMLElement {
    async connectedCallback() {
        const entity = this.getAttribute('entity') ?? '';
        const year = Number(this.getAttribute('year')) || 2025;
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade Steuer-Zahlungen ${year}…</div>`;
        let r: Awaited<ReturnType<typeof api.steuerkonto>>;
        try {
            r = await api.steuerkonto(entity, year);
        } catch (err) {
            this.innerHTML = `<adw-card class="bh-error">Fehler: ${esc(err instanceof Error ? err.message : err)}</adw-card>`;
            return;
        }

        // One card per entity, the tax types as rows inside.
        const byEntity = new Map<string, typeof r.groups>();
        for (const g of r.groups) {
            const arr = byEntity.get(g.entity) ?? [];
            arr.push(g);
            byEntity.set(g.entity, arr);
        }

        const cards = [...byEntity.entries()].map(([entity, groups]) => this.entityCard(entity, groups)).join('');
        const reserve = r.internalReserve.count
            ? `<div class="bh-banner info">${r.internalReserve.count} interne Umbuchungen zwischen eigenen Konten (z. B. „Gewerbesteuer Vorauszahlung" aufs Steuerkonto, ${eur(r.internalReserve.out)} raus / gegengebucht → netto 0). <strong>Keine</strong> Zahlung an eine Behörde.</div>`
            : '';

        this.innerHTML = `
      <header class="bh-view-head">
        <div class="bh-result bh-muted">Tatsächliche Flüsse über die Konten · Abgleich für Mein ELSTER (kein amtlicher FA-Stand)</div>
      </header>
      ${reserve}
      <div class="bh-cards">${cards || '<adw-card class="bh-muted">Keine Steuerzahlungen gefunden.</adw-card>'}</div>`;
    }

    private entityCard(entity: string, groups: Awaited<ReturnType<typeof api.steuerkonto>>['groups']): string {
        // With a single tax type the per-row net equals the card header total, so we drop the
        // redundant per-row tag (avoids showing "gezahlt X" twice); multi-type cards keep it.
        const single = groups.length === 1;
        const rows = groups
            .map((g) => {
                const refund = g.netto >= 0;
                const tag = refund ? `Erstattung ${eur(g.netto)}` : `gezahlt ${eur(-g.netto)}`;
                // per reference year (e.g. 2024 settlements vs 2025)
                const byYear = new Map<string, number>();
                for (const it of g.items) {
                    const k = it.bezugsjahr ? `Bezug ${it.bezugsjahr}` : 'Bezug ?';
                    byYear.set(k, (byYear.get(k) ?? 0) + it.amount);
                }
                const yearChips = [...byYear.entries()]
                    .sort()
                    .map(([k, v]) => `<span class="bh-chip-static">${esc(k)}: ${eur(v)}</span>`)
                    .join(' ');
                return `<div class="bh-line">
            <dt>${esc(g.art)} <small>${g.items.length} Buchungen · gezahlt ${eur(g.gezahlt)} / erstattet ${eur(g.erstattet)}</small><div class="bh-chips">${yearChips}</div></dt>
            <dd class="${refund ? 'pos' : 'neg'}">${single ? '' : tag}</dd>
          </div>`;
            })
            .join('');
        const net = groups.reduce((s, g) => s + g.netto, 0);
        const badge = net >= 0 ? `Erstattung ${eur(net)}` : `gezahlt ${eur(-net)}`;
        return `<adw-card class="bh-taxcard">
      <div class="bh-card-head"><h2>${esc(entity)}</h2><span class="bh-pill">${esc(badge)}</span></div>
      <dl class="bh-dl">${rows}</dl>
    </adw-card>`;
    }
}

customElements.define('bh-steuerkonto-view', BhSteuerkontoView);

declare global {
    interface HTMLElementTagNameMap {
        'bh-steuerkonto-view': BhSteuerkontoView;
    }
}
