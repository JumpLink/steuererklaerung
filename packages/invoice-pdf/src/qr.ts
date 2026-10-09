/**
 * QR module matrix for the SEPA GiroCode, using qrcode's CORE encoder only. The full `qrcode`
 * entrypoint pulls in a PNG renderer (pngjs → node:zlib streams) whose module init throws under
 * GJS (see cli/src/lib/sepa-qr.ts), so we import just `qrcode/lib/core/qrcode.js` and paint the
 * modules ourselves (as cairo rectangles in the renderer). Pure matrix generation → Node-testable.
 */

// The core encoder has no type declarations; treat it structurally.
interface BitMatrix {
    size: number;
    get(row: number, col: number): number;
}
interface QrSymbol {
    modules: BitMatrix;
}
interface QrCore {
    create(data: string, options?: { errorCorrectionLevel?: string }): QrSymbol;
}

/** A square QR matrix: `size` modules per side, `dark(r,c)` = true for a filled module. */
export interface QrMatrix {
    size: number;
    dark(row: number, col: number): boolean;
}

/**
 * Encode a payload into a QR module matrix (error-correction level M, the EPC069-12 default).
 * Async because the core encoder is imported lazily to keep GJS module init clean.
 */
export async function qrMatrix(payload: string): Promise<QrMatrix> {
    // qrcode's core submodule ships no type declarations; imported for its structural shape only.
    // @ts-expect-error - no types for 'qrcode/lib/core/qrcode.js'
    const core = (await import('qrcode/lib/core/qrcode.js')) as unknown as QrCore;
    const symbol = core.create(payload, { errorCorrectionLevel: 'M' });
    const m = symbol.modules;
    return {
        size: m.size,
        dark: (row: number, col: number) => (m.get(row, col) & 1) === 1,
    };
}
