/**
 * Node entrypoint: PDF rendering needs the GJS runtime (cairo + Pango), so under Node it is a
 * stub. The model/layout/QR logic is runtime-agnostic and re-exported so tests (which run on
 * Node) can exercise it; only {@link renderInvoicePdf} is unavailable.
 */

export * from './model.ts';
export * from './layout.ts';
export * from './qr.ts';
export * from './umsatz-model.ts';
export * from './steuerblatt-model.ts';
import type { InvoicePdfModel } from './model.ts';
import type { UmsatzPdfModel } from './umsatz-model.ts';
import type { SteuerblattModel } from './steuerblatt-model.ts';

/** Whether {@link renderInvoicePdf} can run in this runtime. Always false on Node. */
export function pdfRenderingAvailable(): boolean {
    return false;
}

/** Not available on Node — the caller must check {@link pdfRenderingAvailable} first. */
export function renderInvoicePdf(_model: InvoicePdfModel): Promise<Uint8Array> {
    return Promise.reject(
        new Error('PDF-Rendering benötigt die GJS-Laufzeit (Cairo/Pango). Nutze den GJS-Build (steuer web / app).'),
    );
}

/** Not available on Node — the caller must check {@link pdfRenderingAvailable} first. */
export function renderUmsatzPdf(_model: UmsatzPdfModel): Promise<Uint8Array> {
    return Promise.reject(
        new Error('PDF-Rendering benötigt die GJS-Laufzeit (Cairo/Pango). Nutze den GJS-Build (steuer web / app).'),
    );
}

/** Not available on Node — the caller must check {@link pdfRenderingAvailable} first. */
export function renderSteuerblattPdf(_model: SteuerblattModel): Promise<Uint8Array> {
    return Promise.reject(
        new Error('PDF-Rendering benötigt die GJS-Laufzeit (Cairo/Pango). Nutze den GJS-Build (steuer web / app).'),
    );
}
