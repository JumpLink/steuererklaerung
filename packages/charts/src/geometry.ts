/**
 * Framework-agnostic chart geometry.
 *
 * Pure math over plain numbers — NO DOM, NO GTK, NO node built-ins. The same functions feed:
 *   • the web SVG component (`bh-chart`) — path/point strings + rects,
 *   • the native GTK snapshot widget — the same rects/points drawn via Gsk/Cairo,
 *   • deterministic unit tests.
 *
 * Coordinates are in a caller-defined pixel box (top-left origin, y grows downward — matching both
 * SVG and Gtk.Snapshot). Callers map that box onto an SVG `viewBox` or a widget allocation.
 */

export interface Size {
    width: number;
    height: number;
}

export interface Insets {
    top: number;
    right: number;
    bottom: number;
    left: number;
}

function resolveInsets(p?: Partial<Insets>): Insets {
    return { top: p?.top ?? 0, right: p?.right ?? 0, bottom: p?.bottom ?? 0, left: p?.left ?? 0 };
}

/** Round to 2 decimals — keeps generated path strings compact and deterministic across runs. */
function r(n: number): number {
    return Math.round(n * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouped bar chart (e.g. income vs. expense per month)
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupedBarOptions {
    inset?: Partial<Insets>;
    /** Height reserved below the baseline for group labels (px). Default 18 when labels exist. */
    labelBand?: number;
    /** Fixed bar width (px). When omitted it is derived to fit the group, capped at `maxBarWidth`. */
    barWidth?: number;
    /** Cap for the derived bar width (px). Default 14 (the design's bar width). */
    maxBarWidth?: number;
    /** Gap between the series bars within one group (px). Default 3. */
    barGap?: number;
    /** Minimum drawn height for a non-zero value (px), so tiny values stay visible. Default 1. */
    minBarHeight?: number;
    /** Number of horizontal gridlines (including the 0 baseline). Default 3. */
    gridLines?: number;
}

export interface Bar {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Series index (0-based) — the caller maps it to a colour. */
    series: number;
    /** Group index (0-based). */
    group: number;
    value: number;
}

export interface AxisLabel {
    x: number;
    y: number;
    text: string;
}

export interface GridLine {
    y: number;
    value: number;
}

export interface GroupedBarLayout {
    bars: Bar[];
    labels: AxisLabel[];
    gridLines: GridLine[];
    /** The value mapped to full plot height. */
    max: number;
    /** The y of the value-0 axis. */
    baseline: number;
}

/**
 * Lay out `series` (each an array of magnitudes, one per group) as clustered bars.
 * `labels[g]` names group g; series values are non-negative magnitudes.
 */
export function groupedBarChart(
    labels: string[],
    series: number[][],
    size: Size,
    options: GroupedBarOptions = {},
): GroupedBarLayout {
    const ins = resolveInsets(options.inset);
    const nGroups = labels.length;
    const nSeries = series.length;
    const labelBand = options.labelBand ?? (nGroups > 0 ? 18 : 0);

    const baseline = size.height - ins.bottom - labelBand;
    const plotHeight = Math.max(0, baseline - ins.top);
    const plotWidth = Math.max(0, size.width - ins.left - ins.right);
    const barGap = options.barGap ?? 3;
    const minBarHeight = options.minBarHeight ?? 1;

    let max = 0;
    for (const s of series) for (const v of s) if (v > max) max = v;
    if (max <= 0) max = 1;

    const groupWidth = nGroups > 0 ? plotWidth / nGroups : plotWidth;
    // Derive a bar width that fits the cluster inside ~66% of the group, capped at maxBarWidth.
    const maxBarWidth = options.maxBarWidth ?? 14;
    const derived = nSeries > 0 ? (groupWidth * 0.66 - (nSeries - 1) * barGap) / nSeries : 0;
    const barWidth = Math.max(2, Math.min(options.barWidth ?? maxBarWidth, derived || maxBarWidth));
    const clusterWidth = nSeries * barWidth + (nSeries - 1) * barGap;

    const bars: Bar[] = [];
    const axisLabels: AxisLabel[] = [];
    for (let g = 0; g < nGroups; g++) {
        const centerX = ins.left + groupWidth * (g + 0.5);
        const startX = centerX - clusterWidth / 2;
        for (let s = 0; s < nSeries; s++) {
            const value = series[s][g] ?? 0;
            const h = value <= 0 ? 0 : Math.max(minBarHeight, (value / max) * plotHeight);
            bars.push({
                x: r(startX + s * (barWidth + barGap)),
                y: r(baseline - h),
                width: r(barWidth),
                height: r(h),
                series: s,
                group: g,
                value,
            });
        }
        axisLabels.push({ x: r(centerX), y: r(baseline + 14), text: labels[g] });
    }

    const gridCount = Math.max(2, options.gridLines ?? 3);
    const gridLines: GridLine[] = [];
    for (let i = 0; i < gridCount; i++) {
        const frac = i / (gridCount - 1);
        gridLines.push({ y: r(baseline - frac * plotHeight), value: r(max * frac) });
    }

    return { bars, labels: axisLabels, gridLines, max, baseline: r(baseline) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Line / area (e.g. liquidity over time) and sparklines
// ─────────────────────────────────────────────────────────────────────────────

export interface Point {
    x: number;
    y: number;
}

export interface LineOptions {
    inset?: Partial<Insets>;
    /** Override the value mapped to the bottom of the plot (default: min of values). */
    min?: number;
    /** Override the value mapped to the top of the plot (default: max of values). */
    max?: number;
    /** Fractional vertical padding inside the plot so the line never touches the edges. Default 0.08. */
    pad?: number;
}

/** Map values to evenly-spaced points across the plot box. */
export function plotPoints(values: number[], size: Size, options: LineOptions = {}): Point[] {
    const n = values.length;
    if (n === 0) return [];
    const ins = resolveInsets(options.inset);
    const plotWidth = Math.max(0, size.width - ins.left - ins.right);
    const plotHeight = Math.max(0, size.height - ins.top - ins.bottom);

    let min = options.min ?? Math.min(...values);
    let max = options.max ?? Math.max(...values);
    if (min === max) {
        min -= 1;
        max += 1;
    }
    const pad = options.pad ?? 0.08;
    const usable = plotHeight * (1 - 2 * pad);
    const top = ins.top + plotHeight * pad;

    return values.map((v, i) => {
        const x = ins.left + (n === 1 ? plotWidth / 2 : (plotWidth * i) / (n - 1));
        const y = top + usable * (1 - (v - min) / (max - min));
        return { x: r(x), y: r(y) };
    });
}

export interface LinePath {
    /** SVG path `d` of the line itself. */
    line: string;
    /** SVG path `d` of the filled area from the line down to the baseline. */
    area: string;
    points: Point[];
    min: number;
    max: number;
}

/** Build an area+line path from a value series. */
export function linePath(values: number[], size: Size, options: LineOptions = {}): LinePath {
    const points = plotPoints(values, size, options);
    if (points.length === 0) return { line: '', area: '', points, min: 0, max: 0 };

    const ins = resolveInsets(options.inset);
    const baseline = r(size.height - ins.bottom);
    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
    const first = points[0];
    const last = points[points.length - 1];
    const area = `${line} L${last.x} ${baseline} L${first.x} ${baseline} Z`;

    const min = options.min ?? Math.min(...values);
    const max = options.max ?? Math.max(...values);
    return { line, area, points, min, max };
}

/** Space-separated `x,y` points for an SVG `<polyline>` (sparkline). */
export function sparklinePoints(values: number[], size: Size, options: LineOptions = {}): string {
    return plotPoints(values, size, options)
        .map((p) => `${p.x},${p.y}`)
        .join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Category shares (horizontal breakdown bars) + axis ticks
// ─────────────────────────────────────────────────────────────────────────────

/** Fraction 0..1 of each amount relative to the largest magnitude (for horizontal bar widths). */
export function categoryShares(amounts: number[]): number[] {
    let max = 0;
    for (const a of amounts) {
        const abs = Math.abs(a);
        if (abs > max) max = abs;
    }
    if (max <= 0) return amounts.map(() => 0);
    return amounts.map((a) => Math.round((Math.abs(a) / max) * 10000) / 10000);
}

/**
 * "Nice" axis tick values spanning [min, max] with roughly `count` steps, rounded to 1/2/5×10ⁿ.
 * Returns ascending tick values (inclusive of the rounded bounds).
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
    if (min === max) {
        min -= 1;
        max += 1;
    }
    const span = niceNum(max - min, false);
    const step = niceNum(span / Math.max(1, count - 1), true);
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(r(v));
    return ticks;
}

/** Round a range/step to the nearest 1/2/5×10ⁿ (Heckbert's "nice numbers"). */
function niceNum(range: number, round: boolean): number {
    const exp = Math.floor(Math.log10(range || 1));
    const frac = range / 10 ** exp;
    let niceFrac: number;
    if (round) niceFrac = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
    else niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
    return niceFrac * 10 ** exp;
}
