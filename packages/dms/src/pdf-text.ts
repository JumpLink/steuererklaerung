/**
 * Text layer of a PDF via Poppler, GJS only — the same runtime access as `pdf-thumb.ts` (no static
 * `gi://` import, so Node and the test build stay clean). Used to cross-check a hybrid e-invoice's
 * PDF against its embedded XML. Returns `null` when not on GJS, Poppler is missing or the PDF is
 * unreadable; an empty string means the PDF simply has no text layer.
 */

interface PopplerPage {
    get_text(): string | null;
}
interface PopplerDocument {
    get_n_pages(): number;
    get_page(index: number): PopplerPage;
}
interface GjsRuntime {
    imports?: {
        gi: {
            versions: Record<string, string>;
            GLib: { Bytes: new (data: Uint8Array) => unknown };
            Poppler: {
                Document: { new_from_bytes(bytes: unknown, password: string | null): PopplerDocument };
            };
        };
    };
}

/** Upper bound on pages read: an invoice's totals are on the first pages, a 400-page PDF is not one. */
const MAX_PAGES = 10;

export function extractPdfText(pdfBytes: Uint8Array): string | null {
    const imports = (globalThis as unknown as GjsRuntime).imports;
    if (!imports?.gi) return null;
    try {
        imports.gi.versions.Poppler = '0.18';
        const { GLib, Poppler } = imports.gi;
        const doc = Poppler.Document.new_from_bytes(new GLib.Bytes(pdfBytes), null);
        const pages = Math.min(doc.get_n_pages(), MAX_PAGES);
        let text = '';
        for (let i = 0; i < pages; i++) text += `${doc.get_page(i).get_text() ?? ''}\n`;
        return text;
    } catch {
        return null;
    }
}
