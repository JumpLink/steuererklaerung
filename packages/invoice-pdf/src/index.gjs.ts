/**
 * GJS entrypoint: render the invoice model to a PDF via cairo (PDFSurface) + Pango (text layout).
 *
 * Runtime access mirrors packages/dms/src/pdf-thumb.ts — the GJS `imports.cairo` / `imports.gi`
 * are reached through a cast (no static `gi://` import) so the same source type-checks and the
 * Node build stays clean; on Node this module isn't selected (package "exports" maps node → the
 * stub). cairo's PDFSurface has no in-memory target under GJS, so we write to a temp file and read
 * the bytes back (as pdf-thumb does for PNG). The model + layout math are pure (model.ts/layout.ts).
 */

export * from './model.ts';
export * from './layout.ts';
export * from './qr.ts';
export * from './umsatz-model.ts';
export * from './steuerblatt-model.ts';

import { contentWidth, itemColumns, LAYOUT, PAGE_HEIGHT, PAGE_WIDTH, paginateItems } from './layout.ts';
import type { InvoicePdfModel, PdfItemRow } from './model.ts';
import type { UmsatzPdfModel } from './umsatz-model.ts';
import type { SteuerblattModel } from './steuerblatt-model.ts';
import { qrMatrix } from './qr.ts';

// ── Minimal structural typings for the GJS cairo + Pango runtime we use ──────────────
interface CairoContext {
    setSourceRGB(r: number, g: number, b: number): void;
    setLineWidth(w: number): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    rectangle(x: number, y: number, w: number, h: number): void;
    stroke(): void;
    fill(): void;
    save(): void;
    restore(): void;
    translate(x: number, y: number): void;
    setSource(surface: CairoSurface, x: number, y: number): void;
    paint(): void;
    showPage(): void;
}
interface CairoSurface {
    flush(): void;
    finish(): void;
    getWidth?(): number;
    getHeight?(): number;
}
interface PangoLayout {
    set_text(text: string, len: number): void;
    set_markup(markup: string, len: number): void;
    set_width(w: number): void;
    set_alignment(a: number): void;
    set_font_description(desc: unknown): void;
    get_pixel_size(): [number, number];
}
interface GjsRuntime {
    imports?: {
        cairo: {
            PDFSurface: new (filename: string, width: number, height: number) => CairoSurface;
            Context: new (surface: CairoSurface) => CairoContext;
            ImageSurface: { createFromPNG(path: string): CairoSurface };
        };
        gi: {
            GLib: {
                build_filenamev(parts: string[]): string;
                get_tmp_dir(): string;
                file_get_contents(path: string): [boolean, Uint8Array];
                unlink(path: string): number;
            };
            Pango: {
                SCALE: number;
                Alignment: { LEFT: number; RIGHT: number; CENTER: number };
                FontDescription: { from_string(s: string): unknown };
            };
            PangoCairo: {
                create_layout(ctx: CairoContext): PangoLayout;
                show_layout(ctx: CairoContext, layout: PangoLayout): void;
            };
        };
    };
}

function runtime(): NonNullable<GjsRuntime['imports']> {
    const imports = (globalThis as unknown as GjsRuntime).imports;
    if (!imports?.cairo || !imports.gi) throw new Error('PDF-Rendering benötigt die GJS-Laufzeit.');
    return imports;
}

/** Whether {@link renderInvoicePdf} can run. True under GJS (cairo + Pango present). */
export function pdfRenderingAvailable(): boolean {
    const imports = (globalThis as unknown as GjsRuntime).imports;
    return !!imports?.cairo && !!imports.gi?.PangoCairo;
}

const INK = { black: [0, 0, 0], grey: [0.4, 0.4, 0.4], line: [0.75, 0.75, 0.75] } as const;

let tmpCounter = 0;
// Per-process token so two processes (native app + `steuer web`) rendering at the same time
// don't collide on a shared temp path like bh-invoice-0.pdf (the counter alone resets to 0 in each).
const PROC_TOKEN = Math.floor(Math.random() * 1e12).toString(36);

/** Render the invoice model to PDF bytes (A4, DIN 5008). Async: the QR encoder loads lazily. */
export async function renderInvoicePdf(model: InvoicePdfModel): Promise<Uint8Array> {
    const { cairo, gi } = runtime();
    const { GLib, Pango, PangoCairo } = gi;

    const tmp = GLib.build_filenamev([GLib.get_tmp_dir(), `bh-invoice-${PROC_TOKEN}-${tmpCounter++}.pdf`]);
    const surface = new cairo.PDFSurface(tmp, PAGE_WIDTH, PAGE_HEIGHT);
    const ctx = new cairo.Context(surface);

    const qr = model.qrPayload ? await qrMatrix(model.qrPayload) : null;

    // ── text helper: lay out `text` at (x,y), return the block height in points ──────
    const setInk = (rgb: readonly number[]) => ctx.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    const text = (
        x: number,
        y: number,
        str: string,
        o: { size?: number; bold?: boolean; width?: number; align?: 'left' | 'right'; color?: readonly number[] } = {},
    ): number => {
        const layout = PangoCairo.create_layout(ctx);
        const desc = `Sans ${o.bold ? 'Bold ' : ''}${o.size ?? 9}`;
        layout.set_font_description(Pango.FontDescription.from_string(desc));
        if (o.width != null) layout.set_width(o.width * Pango.SCALE);
        layout.set_alignment(o.align === 'right' ? Pango.Alignment.RIGHT : Pango.Alignment.LEFT);
        layout.set_text(str, -1);
        setInk(o.color ?? INK.black);
        ctx.moveTo(x, y);
        PangoCairo.show_layout(ctx, layout);
        return layout.get_pixel_size()[1];
    };
    const measureRow = (row: PdfItemRow, titleWidth: number): number => {
        const layout = PangoCairo.create_layout(ctx);
        layout.set_font_description(Pango.FontDescription.from_string('Sans 9'));
        layout.set_width(titleWidth * Pango.SCALE);
        layout.set_text(row.description ? `${row.title}\n${row.description}` : row.title, -1);
        return layout.get_pixel_size()[1] + 6; // + row padding
    };

    const left = LAYOUT.marginLeft;
    const cols = itemColumns();
    const titleCol = cols.find((c) => c.key === 'title');

    // Height budget for the totals + note block on the last page (rough, generous).
    const totalsHeight = 24 * (model.vatRows.length + 3) + (model.note ? 40 : 0);
    // Table body starts below the intro on page 1.
    const introHeight = model.intro ? 40 : 0;
    const firstBodyTop = LAYOUT.addressTop + LAYOUT.addressHeight + 30 + introHeight + 22;
    const contBodyTop = LAYOUT.marginTop + 22;

    const pages = paginateItems(model.items, {
        firstBodyTop,
        contBodyTop,
        totalsHeight,
        measure: measureRow,
    });

    pages.forEach((page, pageIndex) => {
        const isFirstPage = pageIndex === 0;

        if (isFirstPage) {
            renderHead(model, { text, ctx, cairo, GLib });
        }

        // Table header row.
        let y = isFirstPage ? firstBodyTop - 20 : contBodyTop - 20;
        renderTableHeader(model, cols, left, y, text);
        y += 18;
        setInk(INK.line);
        ctx.setLineWidth(0.5);
        ctx.moveTo(left, y);
        ctx.lineTo(left + contentWidth(), y);
        ctx.stroke();
        y += 4;

        // Item rows.
        for (const row of page.rows) {
            const rowH = renderItemRow(row, cols, left, y, titleCol?.width ?? 200, text);
            y += rowH;
        }

        if (page.isLast) {
            renderTotals(model, left, y + 8, text, ctx);
            renderFooter(model, left, text, qr, ctx);
        }
        ctx.showPage();
    });

    surface.flush();
    surface.finish();
    const [ok, data] = GLib.file_get_contents(tmp);
    GLib.unlink(tmp);
    if (!ok) throw new Error('PDF konnte nicht gelesen werden.');
    return new Uint8Array(data);

    // ── local render blocks (closures capture ctx/text) ─────────────────────────────
    function renderHead(
        m: InvoicePdfModel,
        deps: { text: typeof text; ctx: CairoContext; cairo: typeof cairo; GLib: typeof GLib },
    ): void {
        // Optional logo, top-right.
        if (m.logoPath) {
            try {
                const img = deps.cairo.ImageSurface.createFromPNG(m.logoPath);
                deps.ctx.save();
                deps.ctx.translate(PAGE_WIDTH - LAYOUT.marginRight - 120, LAYOUT.marginTop);
                deps.ctx.setSource(img, 0, 0);
                deps.ctx.paint();
                deps.ctx.restore();
            } catch {
                /* logo optional — skip on any decode error */
            }
        }
        // Sender return line above the recipient window.
        deps.text(left, LAYOUT.senderTop - 12, m.address.senderLine, { size: 7, color: INK.grey, width: LAYOUT.addressWidth });
        // Recipient address window.
        deps.text(left, LAYOUT.addressTop, m.address.recipientLines.join('\n'), { size: 11, width: LAYOUT.addressWidth });
        // Info block (right).
        let iy = LAYOUT.infoTop;
        for (const row of m.info) {
            deps.text(LAYOUT.infoLeft, iy, row.label, { size: 8, color: INK.grey });
            deps.text(LAYOUT.infoLeft, iy + 9, row.value, { size: 9, bold: true });
            iy += 24;
        }
        // Title + intro.
        const titleY = LAYOUT.addressTop + LAYOUT.addressHeight + 6;
        deps.text(left, titleY, m.title, { size: 15, bold: true });
        if (m.intro) deps.text(left, titleY + 24, m.intro, { size: 9, width: contentWidth() });
    }

    function renderTableHeader(
        m: InvoicePdfModel,
        columns: ReturnType<typeof itemColumns>,
        x0: number,
        y: number,
        t: typeof text,
    ): void {
        const labels: Record<string, string> = {
            position: m.itemColumns.pos,
            title: m.itemColumns.title,
            quantity: m.itemColumns.quantity,
            unitPrice: m.itemColumns.unitPrice,
            vatRate: m.itemColumns.vat,
            net: m.itemColumns.net,
        };
        for (const c of columns) {
            t(x0 + c.x, y, labels[c.key as string] ?? '', {
                size: 8,
                bold: true,
                color: INK.grey,
                width: c.width,
                align: c.align,
            });
        }
    }

    function renderItemRow(
        row: PdfItemRow,
        columns: ReturnType<typeof itemColumns>,
        x0: number,
        y: number,
        titleWidth: number,
        t: typeof text,
    ): number {
        const value = (key: string): string => {
            switch (key) {
                case 'position':
                    return String(row.position);
                case 'title':
                    return row.description ? `${row.title}\n${row.description}` : row.title;
                case 'quantity':
                    return row.unit ? `${row.quantity} ${row.unit}` : row.quantity;
                case 'unitPrice':
                    return row.unitPrice;
                case 'vatRate':
                    return row.vatRate;
                case 'net':
                    return row.net;
                default:
                    return '';
            }
        };
        let maxH = 0;
        for (const c of columns) {
            const h = t(x0 + c.x, y, value(c.key as string), { size: 9, width: c.width, align: c.align });
            if (c.key === 'title') maxH = Math.max(maxH, h);
        }
        void titleWidth;
        return Math.max(maxH, 12) + 6;
    }

    function renderTotals(m: InvoicePdfModel, x0: number, y0: number, t: typeof text, c: CairoContext): number {
        const w = contentWidth();
        const labelX = x0 + w - 200;
        const valX = x0 + w - 90;
        let y = y0;
        t(labelX, y, 'Nettobetrag', { size: 9, width: 110, align: 'right' });
        t(valX, y, m.totalNet, { size: 9, width: 90, align: 'right' });
        y += 16;
        for (const v of m.vatRows) {
            t(labelX, y, v.label, { size: 9, width: 110, align: 'right' });
            t(valX, y, v.vat, { size: 9, width: 90, align: 'right' });
            y += 16;
        }
        setInk(INK.line);
        c.setLineWidth(0.5);
        c.moveTo(labelX, y + 2);
        c.lineTo(valX + 90, y + 2);
        c.stroke();
        y += 8;
        t(labelX, y, `${m.grossLabel} (${m.currency})`, { size: 11, bold: true, width: 110, align: 'right' });
        t(valX, y, m.totalGross, { size: 11, bold: true, width: 90, align: 'right' });
        y += 24;
        if (m.note) t(x0, y, m.note, { size: 8, color: INK.grey, width: w });
        return y;
    }

    function renderFooter(
        m: InvoicePdfModel,
        x0: number,
        t: typeof text,
        matrix: Awaited<ReturnType<typeof qrMatrix>> | null,
        c: CairoContext,
    ): void {
        const footerY = PAGE_HEIGHT - LAYOUT.marginBottom - LAYOUT.footerHeight + 6;
        const w = contentWidth();
        setInk(INK.line);
        c.setLineWidth(0.5);
        c.moveTo(x0, footerY - 6);
        c.lineTo(x0 + w, footerY - 6);
        c.stroke();

        const qrW = matrix ? LAYOUT.qrSize : 0;
        const colArea = w - qrW - (qrW ? 12 : 0);
        const colWidth = colArea / Math.max(1, m.footerColumns.length);
        m.footerColumns.forEach((col, i) => {
            const cx = x0 + i * colWidth;
            t(cx, footerY, col.heading, { size: 7, bold: true, color: INK.grey, width: colWidth - 6 });
            t(cx, footerY + 10, col.lines.join('\n'), { size: 7, color: INK.grey, width: colWidth - 6 });
        });

        if (matrix) {
            const qx = x0 + w - qrW;
            const module = qrW / matrix.size;
            setInk(INK.black);
            for (let r = 0; r < matrix.size; r++) {
                for (let col = 0; col < matrix.size; col++) {
                    if (matrix.dark(r, col)) c.rectangle(qx + col * module, footerY + r * module, module, module);
                }
            }
            c.fill();
            t(qx, footerY + qrW + 2, 'Scan-to-pay (GiroCode)', { size: 6, color: INK.grey, width: qrW });
        }
    }
}

/**
 * Render an Umsatzaufstellung (revenue listing) to PDF bytes (A4). A formal, tabular proof of an
 * entity's taxable turnover for a year — title + metadata + optional coverage warning + a paginated
 * table (Datum · Beleg · Gegenpartei · Netto · USt · Brutto) + a net-by-rate summary. Reuses the
 * same cairo/Pango runtime as {@link renderInvoicePdf}.
 */
export async function renderUmsatzPdf(model: UmsatzPdfModel): Promise<Uint8Array> {
    const { cairo, gi } = runtime();
    const { GLib, Pango, PangoCairo } = gi;

    const tmp = GLib.build_filenamev([GLib.get_tmp_dir(), `bh-umsatz-${PROC_TOKEN}-${tmpCounter++}.pdf`]);
    const surface = new cairo.PDFSurface(tmp, PAGE_WIDTH, PAGE_HEIGHT);
    const ctx = new cairo.Context(surface);

    const setInk = (rgb: readonly number[]) => ctx.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    const text = (
        x: number,
        y: number,
        str: string,
        o: { size?: number; bold?: boolean; width?: number; align?: 'left' | 'right'; color?: readonly number[] } = {},
    ): number => {
        const layout = PangoCairo.create_layout(ctx);
        layout.set_font_description(Pango.FontDescription.from_string(`Sans ${o.bold ? 'Bold ' : ''}${o.size ?? 9}`));
        if (o.width != null) layout.set_width(o.width * Pango.SCALE);
        layout.set_alignment(o.align === 'right' ? Pango.Alignment.RIGHT : Pango.Alignment.LEFT);
        layout.set_text(str, -1);
        setInk(o.color ?? INK.black);
        ctx.moveTo(x, y);
        PangoCairo.show_layout(ctx, layout);
        return layout.get_pixel_size()[1];
    };
    const hline = (x0: number, x1: number, y: number, rgb: readonly number[] = INK.line) => {
        setInk(rgb);
        ctx.setLineWidth(0.5);
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
    };

    const left = LAYOUT.marginLeft;
    const w = contentWidth();
    const right = left + w;
    // Column x-offsets (from left) + right edges of the numeric columns.
    const colDate = left;
    const colRef = left + 70;
    const colParty = left + 160;
    const netR = right - 200; // right edge of Netto column
    const vatR = right - 100; // right edge of USt column
    const grossR = right; // right edge of Brutto column
    const partyWidth = netR - colParty - 90;
    const numW = 95;

    const rowHeight = 15;
    const bottomLimit = PAGE_HEIGHT - LAYOUT.marginBottom - 20;

    // Draw the header block (page 1 only); return the y where the table may start.
    const drawHeader = (): number => {
        let y = LAYOUT.marginTop;
        y += text(left, y, model.title, { size: 15, bold: true }) + 4;
        y += text(left, y, model.subtitle, { size: 9, color: INK.grey }) + 10;
        for (const m of model.meta) {
            text(left, y, m.label, { size: 8, color: INK.grey, width: 150 });
            text(left + 155, y, m.value, { size: 9, bold: true, width: w - 155 });
            y += 15;
        }
        if (model.warning) {
            y += 6;
            const h = text(left, y, model.warning, { size: 8.5, bold: true, color: INK.grey, width: w });
            y += h + 6;
        }
        return y + 6;
    };

    const drawTableHeader = (y: number): number => {
        text(colDate, y, 'Datum', { size: 8, bold: true, color: INK.grey });
        text(colRef, y, 'Beleg', { size: 8, bold: true, color: INK.grey });
        text(colParty, y, 'Gegenpartei', { size: 8, bold: true, color: INK.grey, width: partyWidth });
        text(netR - numW, y, 'Netto', { size: 8, bold: true, color: INK.grey, width: numW, align: 'right' });
        text(vatR - numW, y, 'USt', { size: 8, bold: true, color: INK.grey, width: numW, align: 'right' });
        text(grossR - numW, y, 'Brutto', { size: 8, bold: true, color: INK.grey, width: numW, align: 'right' });
        hline(left, right, y + 13);
        return y + 17;
    };

    let y = drawHeader();
    y = drawTableHeader(y);
    for (const r of model.rows) {
        if (y + rowHeight > bottomLimit) {
            ctx.showPage();
            y = drawTableHeader(LAYOUT.marginTop);
        }
        text(colDate, y, r.date, { size: 8 });
        text(colRef, y, r.ref, { size: 8, width: colParty - colRef - 4 });
        text(colParty, y, r.party, { size: 8, width: partyWidth });
        text(netR - numW, y, r.net, { size: 8, width: numW, align: 'right' });
        text(vatR - numW, y, r.vat, { size: 8, width: numW, align: 'right' });
        text(grossR - numW, y, r.gross, { size: 8, width: numW, align: 'right' });
        y += rowHeight;
    }

    // Summary block (keep on the current page if it fits, else a fresh page).
    const summaryHeight = 24 + model.summary.length * 15 + 40;
    if (y + summaryHeight > bottomLimit) {
        ctx.showPage();
        y = LAYOUT.marginTop;
    }
    hline(left, right, y);
    y += 8;
    text(left, y, 'Zusammenfassung (Netto nach Steuersatz)', { size: 9, bold: true });
    y += 16;
    for (const s of model.summary) {
        text(left, y, s.label, { size: 9, width: 200 });
        text(netR - numW, y, s.net, { size: 9, width: numW, align: 'right' });
        text(vatR - numW, y, s.vat, { size: 9, width: numW, align: 'right' });
        y += 15;
    }
    hline(netR - numW, grossR, y + 2);
    y += 8;
    text(left, y, 'Summe', { size: 11, bold: true, width: 200 });
    text(netR - numW, y, model.totalNet, { size: 11, bold: true, width: numW, align: 'right' });
    text(vatR - numW, y, model.totalVat, { size: 11, bold: true, width: numW, align: 'right' });
    text(grossR - numW, y, model.totalGross, { size: 11, bold: true, width: numW, align: 'right' });
    y += 24;
    if (model.note) text(left, y, model.note, { size: 8, color: INK.grey, width: w });
    ctx.showPage();

    surface.flush();
    surface.finish();
    const [ok, data] = GLib.file_get_contents(tmp);
    GLib.unlink(tmp);
    if (!ok) throw new Error('PDF konnte nicht gelesen werden.');
    return new Uint8Array(data);
}

/**
 * Render a tax-return review datasheet ({@link SteuerblattModel}) to a PDF (A4). Same cairo/Pango
 * runtime as {@link renderInvoicePdf}; a generic label/value layout with section headings, one
 * level of indent, emphasis for totals, warnings and page breaks. Used to eyeball a return before
 * the ERiC XML is uploaded to Mein ELSTER.
 */
export async function renderSteuerblattPdf(model: SteuerblattModel): Promise<Uint8Array> {
    const { cairo, gi } = runtime();
    const { GLib, Pango, PangoCairo } = gi;

    const tmp = GLib.build_filenamev([GLib.get_tmp_dir(), `bh-steuerblatt-${PROC_TOKEN}-${tmpCounter++}.pdf`]);
    const surface = new cairo.PDFSurface(tmp, PAGE_WIDTH, PAGE_HEIGHT);
    const ctx = new cairo.Context(surface);

    const setInk = (rgb: readonly number[]) => ctx.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    const text = (
        x: number,
        y: number,
        str: string,
        o: { size?: number; bold?: boolean; width?: number; align?: 'left' | 'right'; color?: readonly number[] } = {},
    ): number => {
        const layout = PangoCairo.create_layout(ctx);
        layout.set_font_description(Pango.FontDescription.from_string(`Sans ${o.bold ? 'Bold ' : ''}${o.size ?? 9}`));
        if (o.width != null) layout.set_width(o.width * Pango.SCALE);
        layout.set_alignment(o.align === 'right' ? Pango.Alignment.RIGHT : Pango.Alignment.LEFT);
        layout.set_text(str, -1);
        setInk(o.color ?? INK.black);
        ctx.moveTo(x, y);
        PangoCairo.show_layout(ctx, layout);
        return layout.get_pixel_size()[1];
    };
    const hline = (x0: number, x1: number, y: number, rgb: readonly number[] = INK.line) => {
        setInk(rgb);
        ctx.setLineWidth(0.5);
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
    };

    const left = LAYOUT.marginLeft;
    const w = contentWidth();
    const right = left + w;
    const valueW = 150; // right-aligned value column
    const bottomLimit = PAGE_HEIGHT - LAYOUT.marginBottom - 20;

    let y = LAYOUT.marginTop;
    const breakIfNeeded = (needed: number) => {
        if (y + needed > bottomLimit) {
            ctx.showPage();
            y = LAYOUT.marginTop;
        }
    };

    // Give the title/subtitle the content width so long headings (e.g. a USt-VA period title)
    // wrap onto a second line instead of overrunning the right margin.
    y += text(left, y, model.title, { size: 15, bold: true, width: w }) + 4;
    y += text(left, y, model.subtitle, { size: 9, color: INK.grey, width: w }) + 10;
    for (const m of model.meta) {
        text(left, y, m.label, { size: 8, color: INK.grey, width: 150 });
        text(left + 155, y, m.value, { size: 9, bold: true, width: w - 155 });
        y += 15;
    }
    y += 6;

    for (const section of model.sections) {
        breakIfNeeded(44);
        hline(left, right, y);
        y += 8;
        y += text(left, y, section.heading, { size: 10, bold: true }) + 6;
        for (const r of section.rows) {
            breakIfNeeded(18);
            const x = left + (r.indent ? 16 : 0);
            const h = text(x, y, r.label, { size: 9, bold: r.emphasis, width: w - valueW - 20 - (r.indent ? 16 : 0) });
            if (r.value) text(right - valueW, y, r.value, { size: 9, bold: r.emphasis, width: valueW, align: 'right' });
            y += Math.max(h, 14);
        }
        y += 6;
    }

    if (model.warnings.length) {
        breakIfNeeded(20 + model.warnings.length * 14);
        y += 4;
        for (const wtext of model.warnings) {
            y += text(left, y, `⚠ ${wtext}`, { size: 8.5, bold: true, color: INK.grey, width: w }) + 4;
        }
    }

    if (model.note) {
        breakIfNeeded(30);
        y += 6;
        text(left, y, model.note, { size: 8, color: INK.grey, width: w });
    }
    ctx.showPage();

    surface.flush();
    surface.finish();
    const [okS, dataS] = GLib.file_get_contents(tmp);
    GLib.unlink(tmp);
    if (!okS) throw new Error('PDF konnte nicht gelesen werden.');
    return new Uint8Array(dataS);
}
