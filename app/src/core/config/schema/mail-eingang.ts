/**
 * Manifest section schema: the mail folder an entity's built-in DMS fetches receipts from
 * (`dms.mailEingang`, Idee 15).
 *
 * Like the SMTP account in `mail.ts`, the PASSWORD is deliberately not a field: it lives in the OS
 * keyring (`core/mail/mail-eingang-secret.ts`) and reaches the fetch as a parameter for one call.
 * Only reading is configurable — no option deletes, moves or marks a message on the server.
 */

import { z } from 'zod';

export const MailEingangSchema = z.object({
    /** IMAP server host name. */
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(993),
    /** `tls`: TLS from the first byte (993). `none`: loopback only — a password never crosses a network in the clear. */
    security: z.enum(['tls', 'none']).default('tls'),
    /** Login name. */
    username: z.string().min(1),
    /** Mailbox to read; the person points the app at a dedicated folder, so only receipts land here. */
    folder: z.string().min(1).default('INBOX'),
    /** Only messages whose From header contains this text (case-insensitive) are imported; empty = all. */
    sender: z.string().optional(),
    /** Fetch once when the app starts. Off by default: it needs the keyring open before anything is shown. */
    onStart: z.boolean().optional(),
});
export type MailEingangConfig = z.infer<typeof MailEingangSchema>;
