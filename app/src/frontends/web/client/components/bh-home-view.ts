// <bh-home-view> — the "Übersicht" dashboard: KPI cards (with a profit sparkline), an
// income-vs-expense bar chart, an expense-by-category breakdown, a liquidity area chart, and an
// "Als Nächstes" action list. Data from /api/home; charts via <bh-chart> (shared geometry).

import { api } from '../lib/api.ts';
import { esc, eur } from '../lib/format.ts';
import type { BhChart } from './bh-chart.ts';

type Model = Awaited<ReturnType<typeof api.home>>;

const ACCENT = 'var(--accent-bg-color)';
const EXPENSE = '#c25d52';

export class BhHomeView extends HTMLElement {
    async connectedCallback() {
        const entity = this.getAttribute('entity') ?? '';
        const year = Number(this.getAttribute('year')) || 2025;
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade Übersicht ${year}…</div>`;
        let m: Model;
        try {
            m = await api.home(entity, year);
        } catch (err) {
            this.innerHTML = `<adw-card class="bh-error">Fehler: ${esc(err instanceof Error ? err.message : String(err))}</adw-card>`;
            return;
        }
        this.renderModel(m, year);
        this.wireCharts(m);
    }

    private renderModel(m: Model, year: number) {
        const k = m.kpis;
        const taxCard = k.tax
            ? `<div class="bh-kpi">
                 <div class="bh-kpi-l">Steuer-Prognose ${year}</div>
                 <div class="bh-kpi-n ${k.tax.total >= 0 ? 'neg' : 'pos'}">${eur(Math.abs(k.tax.total))}</div>
                 <div class="bh-kpi-s">${esc(k.tax.label)}</div>
               </div>`
            : '';

        const tasks = m.tasks.length
            ? `<section class="bh-home-section">
                 <h2 class="bh-home-h2">Als Nächstes</h2>
                 <div class="bh-tasklist">
                   ${m.tasks
                       .map(
                           (t, i) =>
                               `<div class="bh-task t-${esc(t.tone)}"><span class="bh-task-n">${i + 1}</span><div class="bh-task-body"><div class="bh-task-title">${esc(t.title)}</div><div class="bh-task-sub">${esc(t.sub)}</div></div></div>`,
                       )
                       .join('')}
                 </div>
               </section>`
            : '';

        const catMax = m.categories[0]?.amount || 1;
        const cats = m.categories.length
            ? m.categories
                  .map(
                      (c) =>
                          `<div class="bh-catbar"><div class="bh-catbar-head"><span>${esc(c.name)}</span><span class="bh-num">${eur(c.amount)}</span></div><div class="bh-catbar-track"><div class="bh-catbar-fill" style="width:${((c.amount / catMax) * 100).toFixed(1)}%"></div></div></div>`,
                  )
                  .join('')
            : `<div class="bh-muted">Keine Ausgaben erfasst</div>`;

        const accounts = m.liquidity.accounts
            .map(
                (a) =>
                    `<div class="bh-liq-acc"><span class="bh-liq-ini">${esc(a.initials)}</span><span class="bh-liq-name">${esc(a.name)}</span><span class="bh-num">${eur(a.balance)}</span></div>`,
            )
            .join('');

        this.innerHTML = `
      <div class="bh-home">
        <div class="bh-kpi-grid">
          <div class="bh-kpi">
            <div class="bh-kpi-l">Gewinn ${year}</div>
            <div class="bh-kpi-row">
              <div class="bh-kpi-n ${k.profit >= 0 ? 'pos' : 'neg'}">${eur(k.profit)}</div>
              <bh-chart class="bh-kpi-spark" data-chart="spark"></bh-chart>
            </div>
            <div class="bh-kpi-s">Einnahmen − Ausgaben</div>
          </div>
          <div class="bh-kpi"><div class="bh-kpi-l">Einnahmen</div><div class="bh-kpi-n">${eur(k.income)}</div><div class="bh-kpi-s">netto ${year}</div></div>
          <div class="bh-kpi"><div class="bh-kpi-l">Ausgaben</div><div class="bh-kpi-n">${eur(k.expense)}</div><div class="bh-kpi-s">netto ${year}</div></div>
          ${taxCard}
        </div>

        ${tasks}

        <section class="bh-home-card">
          <div class="bh-card-head">
            <h2 class="bh-home-h2">Einnahmen und Ausgaben</h2>
            <div class="bh-legend"><span class="bh-legend-i"><span class="bh-dot" style="background:${ACCENT}"></span>Einnahmen</span><span class="bh-legend-i"><span class="bh-dot" style="background:${EXPENSE}"></span>Ausgaben</span></div>
          </div>
          <bh-chart data-chart="bars"></bh-chart>
        </section>

        <div class="bh-home-2col">
          <section class="bh-home-card"><h2 class="bh-home-h2">Ausgaben nach Kategorie</h2><div class="bh-catbars">${cats}</div></section>
          <section class="bh-home-card">
            <div class="bh-card-head"><h2 class="bh-home-h2">Liquidität</h2><span class="bh-pill">${eur(m.liquidity.now)}</span></div>
            <bh-chart data-chart="area"></bh-chart>
            <div class="bh-liq-accts">${accounts}</div>
          </section>
        </div>
      </div>`;
    }

    private wireCharts(m: Model) {
        const spark = this.querySelector('[data-chart="spark"]') as BhChart | null;
        if (spark)
            spark.data = {
                type: 'sparkline',
                values: m.profitSparkline,
                color: m.kpis.profit >= 0 ? 'var(--bh-pos)' : 'var(--bh-neg)',
            };
        const bars = this.querySelector('[data-chart="bars"]') as BhChart | null;
        if (bars)
            bars.data = {
                type: 'bars',
                labels: m.monthly.labels,
                series: [
                    { name: 'Einnahmen', values: m.monthly.income, color: ACCENT },
                    { name: 'Ausgaben', values: m.monthly.expense, color: EXPENSE },
                ],
            };
        const area = this.querySelector('[data-chart="area"]') as BhChart | null;
        if (area) area.data = { type: 'area', values: m.liquidity.series, color: ACCENT };
    }
}

customElements.define('bh-home-view', BhHomeView);

declare global {
    interface HTMLElementTagNameMap {
        'bh-home-view': BhHomeView;
    }
}
