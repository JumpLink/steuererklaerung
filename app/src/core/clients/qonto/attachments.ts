/**
 * Qonto API – Attachments.
 * GET/POST /v2/attachments, GET/POST/DELETE /v2/transactions/:id/attachments.
 * Download URLs are short-lived; consume immediately.
 */

import { get, getBinaryPreSignedUrl, post, postMultipart, deleteRequest } from './request.ts';
import type { Attachment } from './types.ts';

function idempotencyKey(): string {
    return crypto.randomUUID();
}

/**
 * Get attachment metadata including download_url (short-lived).
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function getAttachment(attachmentId: string): Promise<Attachment> {
    const res = await get<{ attachment: Attachment }>(`attachments/${attachmentId}`);
    return res.attachment;
}

/**
 * Resolve the download URL from an attachment (API may return "url" or "download_url"; valid 30 minutes).
 */
function getAttachmentDownloadUrl(attachment: Attachment): string | undefined {
    return attachment.url ?? attachment.download_url;
}

/**
 * Download attachment file bytes from Qonto using the short-lived pre-signed URL.
 * Call getAttachment() first to obtain a fresh URL (valid 30 minutes). The URL is pre-signed, so
 * we must not send auth headers (otherwise S3 returns "Only one auth mechanism allowed").
 */
export async function downloadAttachmentContent(attachment: Attachment): Promise<Buffer> {
    const downloadUrl = getAttachmentDownloadUrl(attachment);
    if (!downloadUrl) {
        throw new Error(
            'Attachment has no download URL (url/download_url). Fetch attachment metadata first; the URL is valid 30 minutes.',
        );
    }
    const arrayBuffer = await getBinaryPreSignedUrl(downloadUrl);
    return Buffer.from(arrayBuffer);
}

/**
 * Upload an attachment (standalone). Returns attachment id(s) for use in transfers etc.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function uploadAttachment(fileBase64: string, filename: string): Promise<{ attachments: Attachment[] }> {
    const body = {
        attachments: [{ file: fileBase64, filename }],
    };
    return post<{ attachments: Attachment[] }>('attachments', body, {
        'X-Qonto-Idempotency-Key': idempotencyKey(),
    });
}

/**
 * List attachments linked to a transaction.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function listTransactionAttachments(transactionId: string): Promise<Attachment[]> {
    const res = await get<{ attachments: Attachment[] }>(`transactions/${transactionId}/attachments`);
    return res.attachments ?? [];
}

/**
 * Upload a file to a transaction (multipart/form-data). Qonto may return empty body on success.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function uploadAttachmentToTransaction(
    transactionId: string,
    fileBuffer: Buffer | Uint8Array,
    filename: string,
    mimeType: string = 'application/octet-stream',
): Promise<unknown> {
    const form = new FormData();
    const blob = new Blob([fileBuffer as BlobPart], { type: mimeType });
    form.append('file', blob, filename);
    const path = `transactions/${transactionId}/attachments`;
    return postMultipart<unknown>(path, form, {
        'X-Qonto-Idempotency-Key': idempotencyKey(),
    });
}

/**
 * Remove one attachment from a transaction.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function removeAttachmentFromTransaction(transactionId: string, attachmentId: string): Promise<void> {
    await deleteRequest<unknown>(`transactions/${transactionId}/attachments/${attachmentId}`);
}
