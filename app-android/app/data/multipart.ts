/**
 * Hand-built multipart/form-data body. NativeScript's fetch breaks on FormData with Blob
 * parts and on Uint8Array bodies (spike S3), so the body is assembled here and handed to
 * fetch as an ArrayBuffer.
 */

export interface MultipartBody {
    body: ArrayBuffer;
    contentType: string;
}

export function buildMultipart(
    fields: Array<[string, string]>,
    fileField: string,
    filename: string,
    bytes: Uint8Array,
    fileContentType = 'application/octet-stream',
    boundary = `----steuerBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`,
): MultipartBody {
    const enc = new TextEncoder();
    const quote = (s: string) => s.replace(/[\r\n]/g, ' ').replace(/"/g, '%22');
    const chunks: Uint8Array[] = [];
    for (const [name, value] of fields) {
        chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`));
    }
    chunks.push(
        enc.encode(
            `--${boundary}\r\nContent-Disposition: form-data; name="${quote(fileField)}"; filename="${quote(filename)}"\r\nContent-Type: ${fileContentType}\r\n\r\n`,
        ),
    );
    chunks.push(bytes);
    chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.length;
    }
    return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}
