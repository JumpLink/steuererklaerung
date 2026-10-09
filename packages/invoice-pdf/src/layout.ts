/**
 * DIN 5008 (Form B) page geometry + item-table pagination. Pure and Node-testable: pagination
 * takes an injected `measure` callback (text → height in points), so the GJS renderer can plug in
 * a PangoLayout-backed measurer while tests use a fake one. All units are PDF points (1 pt = 1/72
 * inch); A4 = 595.28 × 841.89 pt.
 */

import type { PdfItemRow } from './model.ts';

/** A4 in points. */
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;

const MM = 72 / 25.4; // millimetres → points

/** DIN 5008 Form B margins + address-window / fold-mark geometry. */
export const LAYOUT = {
    marginLeft: 25 * MM,
    marginRight: 20 * MM,
    marginTop: 20 * MM,
    marginBottom: 20 * MM,
    /** Address field: top of the recipient window from the page top (Form B ≈ 45 mm). */
    addressTop: 45 * MM,
    addressWidth: 85 * MM,
    addressHeight: 40 * MM,
    /** Sender return-address line sits just above the recipient window. */
    senderTop: 40 * MM,
    /** Info block (right of the address window). */
    infoTop: 45 * MM,
    infoLeft: 125 * MM,
    /** Footer band height reserved at the bottom for contact/bank/tax columns + QR. */
    footerHeight: 40 * MM,
    /** GiroCode square size. */
    qrSize: 28 * MM,
} as const;

/** Usable content width between the left/right margins. */
export function contentWidth(): number {
    return PAGE_WIDTH - LAYOUT.marginLeft - LAYOUT.marginRight;
}

/** Item-table column x-offsets (from marginLeft) + widths, tuned for A4 Form B. */
export function itemColumns(): { key: keyof PdfItemRow | 'x'; x: number; width: number; align: 'left' | 'right' }[] {
    const w = contentWidth();
    // pos | title (flex) | quantity | unitPrice | vat | net
    const posW = 32;
    const qtyW = 60;
    const priceW = 78;
    const vatW = 48;
    const netW = 78;
    const titleW = w - posW - qtyW - priceW - vatW - netW;
    let x = 0;
    const col = (width: number, align: 'left' | 'right', key: keyof PdfItemRow | 'x') => {
        const c = { key, x, width, align };
        x += width;
        return c;
    };
    return [
        col(posW, 'left', 'position'),
        col(titleW, 'left', 'title'),
        col(qtyW, 'right', 'quantity'),
        col(priceW, 'right', 'unitPrice'),
        col(vatW, 'right', 'vatRate'),
        col(netW, 'right', 'net'),
    ];
}

/** One paginated page: the slice of item rows plus whether the totals block fits on it. */
export interface ItemPage {
    rows: PdfItemRow[];
    /** True on the LAST page — the totals + note + footer render here. */
    isLast: boolean;
}

export interface PaginateOptions {
    /** Y where the first page's table body starts (below the info block + intro). */
    firstBodyTop: number;
    /** Y where a continuation page's table body starts. */
    contBodyTop: number;
    /** Height (pt) the totals + note block needs on the last page. */
    totalsHeight: number;
    /** Measure the rendered height of one item row at the given title width. */
    measure: (row: PdfItemRow, titleWidth: number) => number;
}

/**
 * Split item rows across pages so nothing overlaps the footer band. The totals block must fit
 * under the last page's rows; if it doesn't, the totals spill onto one more page (rows empty).
 */
export function paginateItems(rows: PdfItemRow[], opts: PaginateOptions): ItemPage[] {
    const bodyBottom = PAGE_HEIGHT - LAYOUT.marginBottom - LAYOUT.footerHeight;
    const titleWidth = itemColumns().find((c) => c.key === 'title')?.width ?? 200;
    const pages: ItemPage[] = [];
    let current: PdfItemRow[] = [];
    let y = opts.firstBodyTop;

    const flush = (isLast: boolean) => {
        pages.push({ rows: current, isLast });
        current = [];
        y = opts.contBodyTop;
    };

    for (const row of rows) {
        const h = opts.measure(row, titleWidth);
        if (y + h > bodyBottom && current.length > 0) {
            flush(false);
        }
        current.push(row);
        y += h;
    }
    // Last page holds the remaining rows; ensure the totals block fits, else add a spill page.
    if (y + opts.totalsHeight > bodyBottom && current.length > 0) {
        pages.push({ rows: current, isLast: false });
        pages.push({ rows: [], isLast: true });
    } else {
        pages.push({ rows: current, isLast: true });
    }
    return pages;
}
