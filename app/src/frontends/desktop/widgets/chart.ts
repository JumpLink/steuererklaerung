/**
 * Native chart widget (grouped bars · area+line · sparkline), the GTK counterpart of the web
 * `bh-chart`. Both draw from the SAME framework-agnostic geometry in `@steuererklaerung/charts` — only
 * the render shell differs. Here we subclass `Gtk.DrawingArea` and paint with Cairo, sizing the
 * geometry to the real widget allocation (so it is naturally responsive).
 *
 * Theme-awareness: gridlines + axis labels use the widget's current foreground colour
 * (`get_color()`), so they track light/dark automatically. Series/line colours are passed in as
 * hex by the caller (the view picks the Adwaita accent + a complementary expense colour).
 */

import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';
import type cairo from 'cairo';
import { groupedBarChart, plotPoints } from '@steuererklaerung/charts';

export interface NativeBarsSpec {
    type: 'bars';
    labels: string[];
    series: { values: number[]; color: string }[];
}
export interface NativeAreaSpec {
    type: 'area';
    values: number[];
    color: string;
}
export interface NativeSparklineSpec {
    type: 'sparkline';
    values: number[];
    color: string;
}
export type NativeChartSpec = NativeBarsSpec | NativeAreaSpec | NativeSparklineSpec;

/** Default drawing heights per chart type (px); width always expands to the allocation. */
const HEIGHTS: Record<NativeChartSpec['type'], number> = { bars: 190, area: 150, sparkline: 34 };

interface Rgb {
    r: number;
    g: number;
    b: number;
}

/** Parse `#rrggbb` (or `#rgb`) to 0..1 components; falls back to the Adwaita accent blue. */
function hexToRgb(hex: string): Rgb {
    let h = hex.trim().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = Number.parseInt(h, 16);
    if (h.length !== 6 || Number.isNaN(n)) return { r: 0.208, g: 0.518, b: 0.894 };
    return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
}

export class BhChart extends Gtk.DrawingArea {
    private spec?: NativeChartSpec;

    static {
        GObject.registerClass({ GTypeName: 'BhChart' }, this);
    }

    constructor() {
        super();
        this.set_hexpand(true);
        this.set_content_height(HEIGHTS.bars);
        this.set_draw_func(this.draw.bind(this) as Gtk.DrawingAreaDrawFunc);
    }

    /** Replace the data + redraw. Also sizes the widget height to suit the chart type. */
    setData(spec: NativeChartSpec): void {
        this.spec = spec;
        this.set_content_height(HEIGHTS[spec.type]);
        this.queue_draw();
    }

    private draw(_area: Gtk.DrawingArea, cr: cairo.Context, width: number, height: number): void {
        const spec = this.spec;
        if (!spec || width <= 0 || height <= 0) return;
        const size = { width, height };
        const fg = this.get_color(); // Gdk.RGBA, components 0..1 — tracks the theme.

        if (spec.type === 'bars') {
            const layout = groupedBarChart(
                spec.labels,
                spec.series.map((s) => s.values),
                size,
                { maxBarWidth: 16, gridLines: 3 },
            );
            for (let i = 0; i < layout.gridLines.length; i++) {
                const g = layout.gridLines[i];
                cr.setSourceRGBA(fg.red, fg.green, fg.blue, i === 0 ? 0.15 : 0.07);
                cr.setLineWidth(1);
                cr.moveTo(0, g.y + 0.5);
                cr.lineTo(width, g.y + 0.5);
                cr.stroke();
            }
            for (const b of layout.bars) {
                const c = hexToRgb(spec.series[b.series]?.color ?? '#3584e4');
                cr.setSourceRGBA(c.r, c.g, c.b, 1);
                cr.rectangle(b.x, b.y, b.width, b.height);
                cr.fill();
            }
            cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.5);
            cr.setFontSize(11);
            for (const l of layout.labels) {
                const ext = cr.textExtents(l.text);
                cr.moveTo(l.x - ext.width / 2, l.y);
                cr.showText(l.text);
            }
            return;
        }

        const color = hexToRgb(spec.color);
        const inset =
            spec.type === 'area' ? { top: 10, bottom: 8, left: 2, right: 2 } : { top: 3, bottom: 3, left: 2, right: 2 };
        const pts = plotPoints(spec.values, size, { inset });
        if (pts.length === 0) return;

        if (spec.type === 'area') {
            // Filled area down to the baseline …
            cr.moveTo(pts[0].x, pts[0].y);
            for (const p of pts) cr.lineTo(p.x, p.y);
            cr.lineTo(pts[pts.length - 1].x, height);
            cr.lineTo(pts[0].x, height);
            cr.closePath();
            cr.setSourceRGBA(color.r, color.g, color.b, 0.14);
            cr.fill();
        }

        // … then the line itself (both area + sparkline draw this).
        cr.moveTo(pts[0].x, pts[0].y);
        for (const p of pts) cr.lineTo(p.x, p.y);
        cr.setSourceRGBA(color.r, color.g, color.b, spec.type === 'sparkline' ? 0.9 : 1);
        cr.setLineWidth(spec.type === 'sparkline' ? 2 : 2.5);
        cr.stroke();
    }
}
