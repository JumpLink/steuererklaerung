/**
 * First-page PDF → PNG thumbnail via Poppler + cairo, GJS only.
 *
 * The built-in DMS has no thumbnailer; under GJS we rasterize the first page with the
 * system Poppler (poppler-glib typelib) onto a cairo surface. Accessed through the GJS
 * `imports.gi` / `imports.cairo` runtime (cast, like the GLib main-loop in cli/src/index.ts)
 * so there is NO static `gi://` import — on Node (the test build) `imports` is absent and the
 * function returns `null`, keeping the package Node + GJS clean.
 */

interface CairoContext {
    setSourceRGB(r: number, g: number, b: number): void;
    paint(): void;
    scale(x: number, y: number): void;
}
interface CairoSurface {
    flush(): void;
    writeToPNG(path: string): void;
}
interface PopplerPage {
    get_size(): [number, number];
    render(ctx: CairoContext): void;
}
interface PopplerDocument {
    get_n_pages(): number;
    get_page(index: number): PopplerPage;
}
interface GjsRuntime {
    imports?: {
        cairo: {
            Format: { ARGB32: number };
            ImageSurface: new (format: number, width: number, height: number) => CairoSurface;
            Context: new (surface: CairoSurface) => CairoContext;
        };
        gi: {
            versions: Record<string, string>;
            GLib: {
                Bytes: new (data: Uint8Array) => unknown;
                build_filenamev(parts: string[]): string;
                get_tmp_dir(): string;
                file_get_contents(path: string): [boolean, Uint8Array];
                unlink(path: string): number;
            };
            Poppler: {
                Document: { new_from_bytes(bytes: unknown, password: string | null): PopplerDocument };
            };
        };
    };
}

let tmpCounter = 0;

/**
 * Render page 1 of a PDF to a PNG thumbnail (longest edge ≈ `maxWidth`px). Returns the PNG
 * bytes, or `null` when not running under GJS / Poppler is unavailable / the PDF is unreadable.
 */
export function renderPdfThumbnail(pdfBytes: Uint8Array, maxWidth = 400): Uint8Array | null {
    const runtime = globalThis as unknown as GjsRuntime;
    const imports = runtime.imports;
    if (!imports?.gi || !imports.cairo) return null; // not GJS
    try {
        const { gi, cairo } = imports;
        gi.versions.Poppler = '0.18';
        const { GLib, Poppler } = gi;
        const doc = Poppler.Document.new_from_bytes(new GLib.Bytes(pdfBytes), null);
        if (doc.get_n_pages() < 1) return null;
        const page = doc.get_page(0);
        const [w, h] = page.get_size();
        if (!(w > 0 && h > 0)) return null;
        const scale = maxWidth / w;
        const pw = Math.max(1, Math.round(w * scale));
        const ph = Math.max(1, Math.round(h * scale));
        const surface = new cairo.ImageSurface(cairo.Format.ARGB32, pw, ph);
        const ctx = new cairo.Context(surface);
        ctx.setSourceRGB(1, 1, 1); // white page background (PDFs are transparent)
        ctx.paint();
        ctx.scale(scale, scale);
        page.render(ctx);
        surface.flush();
        const tmp = GLib.build_filenamev([GLib.get_tmp_dir(), `bh-pdfthumb-${tmpCounter++}.png`]);
        surface.writeToPNG(tmp);
        const [ok, data] = GLib.file_get_contents(tmp);
        GLib.unlink(tmp);
        return ok ? new Uint8Array(data) : null;
    } catch {
        return null;
    }
}
