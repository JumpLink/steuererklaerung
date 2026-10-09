/**
 * Manifest section schema: the SMTP account an entity sends its invoice mail through
 * (`invoicing.mail`).
 *
 * The PASSWORD is deliberately not a field here. The manifest is a plain file that gets copied,
 * backed up and attached to bug reports; the password lives in the OS keyring (see the desktop
 * `mail-secret.ts`) and reaches the sender as a parameter only for the duration of one call.
 */

import { z } from 'zod';

export const MailAccountSchema = z.object({
    /** SMTP server host name. */
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(465),
    /** `tls`: TLS from the first byte (465). `starttls`: upgrade is required (587). `none`: loopback only. */
    security: z.enum(['tls', 'starttls', 'none']).default('tls'),
    /** Login name. */
    username: z.string().min(1),
    /** Sender address (`local@host`) written into the From header. */
    from: z.string().min(3),
});
export type MailAccountConfig = z.infer<typeof MailAccountSchema>;

/**
 * A named mail template of an entity ("Hosting", "Dienstleistung"). `subject`/`body` are the du text;
 * the `*Sie` fields are the formal variant and fall back to the du text when unset, so a template
 * that only knows one form still works for every customer. Text uses the `{placeholders}` of
 * `core/mail/invoice-mail.ts`.
 */
export const MailTemplateSchema = z.object({
    /** Stable slug that contracts, projects and the entity default refer to. */
    id: z.string().min(1),
    /** Display name in the picker. */
    name: z.string().min(1),
    subject: z.string().min(1),
    body: z.string().min(1),
    subjectSie: z.string().optional(),
    bodySie: z.string().optional(),
});
export type MailTemplate = z.infer<typeof MailTemplateSchema>;
