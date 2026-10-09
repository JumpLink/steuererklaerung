// <bh-chart> — presentational SVG chart (grouped bars · area+line · sparkline) driven entirely by
// the shared, framework-agnostic geometry in @steuererklaerung/charts (the SAME math the native GTK
// snapshot widget uses). Styled with Adwaita CSS variables + `currentColor`, so it tracks
// light/dark and the accent automatically. Assign the `data` property; it re-renders on set.

import { groupedBarChart, linePath, sparklinePoints } from '@steuererklaerung/charts';

export interface BarsSpec {
    type: 'bars';
    labels: string[];
    series: { name?: string; values: number[]; color: string }[];
}
export interface AreaSpec {
    type: 'area';
    values: number[];
    color?: string;
}
export interface SparklineSpec {
    type: 'sparkline';
    values: number[];
    color?: string;
}
export type ChartSpec = BarsSpec | AreaSpec | SparklineSpec;

const ACCENT = 'var(--accent-bg-color)';

function escapeText(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class BhChart extends HTMLElement {
    private spec?: ChartSpec;

    set data(spec: ChartSpec | undefined) {
        this.spec = spec;
        this.render();
    }
    get data(): ChartSpec | undefined {
        return this.spec;
    }

    connectedCallback(): void {
        if (this.spec) this.render();
    }

    private render(): void {
        if (!this.spec) {
            this.innerHTML = '';
            return;
        }
        if (this.spec.type === 'bars') this.innerHTML = this.renderBars(this.spec);
        else if (this.spec.type === 'area') this.innerHTML = this.renderArea(this.spec);
        else this.innerHTML = this.renderSparkline(this.spec);
    }

    private renderBars(spec: BarsSpec): string {
        const W = 560;
        const H = 200;
        const layout = groupedBarChart(
            spec.labels,
            spec.series.map((s) => s.values),
            { width: W, height: H },
            { maxBarWidth: 14, gridLines: 3 },
        );
        const grid = layout.gridLines
            .map(
                (g, i) =>
                    `<line x1="0" y1="${g.y}" x2="${W}" y2="${g.y}" stroke="currentColor" opacity="${i === 0 ? 0.15 : 0.07}"/>`,
            )
            .join('');
        const bars = layout.bars
            .map(
                (b) =>
                    `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="3" fill="${spec.series[b.series]?.color ?? ACCENT}"/>`,
            )
            .join('');
        const labels = layout.labels
            .map(
                (l) =>
                    `<text x="${l.x}" y="${l.y}" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.5">${escapeText(l.text)}</text>`,
            )
            .join('');
        return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;overflow:visible" role="img" aria-hidden="true">${grid}${bars}${labels}</svg>`;
    }

    private renderArea(spec: AreaSpec): string {
        const W = 560;
        const H = 150;
        const color = spec.color ?? ACCENT;
        const p = linePath(spec.values, { width: W, height: H }, { inset: { top: 10, bottom: 6, left: 2, right: 2 } });
        return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-hidden="true"><path d="${p.area}" fill="${color}" opacity="0.14"/><path d="${p.line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
    }

    private renderSparkline(spec: SparklineSpec): string {
        const W = 120;
        const H = 36;
        const color = spec.color ?? ACCENT;
        const pts = sparklinePoints(
            spec.values,
            { width: W, height: H },
            { inset: { top: 4, bottom: 4, left: 2, right: 2 } },
        );
        return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMaxYMid meet" style="width:100%;max-width:110px;height:30px;display:block" role="img" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/></svg>`;
    }
}

customElements.define('bh-chart', BhChart);

declare global {
    interface HTMLElementTagNameMap {
        'bh-chart': BhChart;
    }
}
