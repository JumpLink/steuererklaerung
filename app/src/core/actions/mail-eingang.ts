/**
 * Belege aus einem Mail-Ordner holen (Idee 15): PDF and e-invoice attachments of new messages land
 * in the Beleg-Eingang of the built-in DMS.
 *
 * The import goes through {@link storeReceipt} — the path every other way of adding a receipt takes —
 * so an e-invoice is read (Idee 2) and the Dokumentregeln (Idee 11) apply on arrival, before any AI.
 * Nothing here calls a model.
 *
 * What it promises:
 *   - **Read-only.** The folder is opened with EXAMINE and bodies are fetched with BODY.PEEK: no mail
 *     is marked, moved or deleted, and no option exists that would.
 *   - **Once per message.** The cursor (UIDVALIDITY + highest UID) lives in the ledger; the DMS id is
 *     the SHA-256 of the file, so the same attachment arriving twice — in two mails, or again after
 *     the server renumbered the folder — is recognised and not stored a second time.
 *   - **No mail content kept.** The receipt records the sender and date of the message
 *     ({@link DmsOrigin}); subject and text are never read into the ledger.
 *   - **Built-in DMS only.** Paperless fetches mail itself (Einstellungen → Mail-Regeln in
 *     Paperless); with it this action refuses and says where to look.
 *
 * The connection, the DMS and the cursor arrive as {@link MailEingangDeps}; {@link defaultMailEingangDeps}
 * wires the manifest, the keyring and the ledger.
 */

import { createHash } from 'node:crypto';
import {
    getMailEingangLastRun,
    getMailEingangState,
    ledgerDbPath,
    migrate,
    openLedger,
    recordMailEingangRun,
    saveMailEingangState,
    type MailEingangState,
} from '@steuererklaerung/store';
import type { DmsOrigin, DmsProvider } from '@steuererklaerung/dms';
import { createAppContext } from '../context.ts';
import { loadManifest, loadMailEingang, resolveWorkspaceEntities } from '../config/index.ts';
import type { MailEingangConfig } from '../config/schema/mail-eingang.ts';
import { dmsProviderForEntity } from '../dms-provider.ts';
import { _, _n, fmt } from '../lib/i18n.ts';
import { getLogger } from '../lib/logger.ts';
import type { MailConnector, MailSource } from '../clients/imap/client.ts';
import { selectAttachments } from '../mail-eingang/anhaenge.ts';
import { pruefeMailEingang, planeAbruf } from '../mail-eingang/abruf-plan.ts';
import { parseMail } from '../mail-eingang/mime.ts';
import { lookupMailEingangPassword } from '../mail/mail-eingang-secret.ts';
import { MAX_RECEIPT_BYTES, storeReceipt } from './documents.ts';
import type { DokumentRegel } from './dokumentregeln.ts';

const log = getLogger('mail-eingang');

/** A message larger than this is skipped, not downloaded: the biggest receipt we store is smaller. */
export const MAX_MESSAGE_BYTES = MAX_RECEIPT_BYTES * 2;

/** At most this many messages per run, so the first fetch of a big folder cannot run for minutes. */
export const MAX_MESSAGES_PER_RUN = 100;

/** How the Beleg-Eingang and the CLI tell where Paperless users find the same function. */
/** A function, not a constant: a module-level literal would be translated before the locale is known. */
export function paperlessMailHint(): string {
    return _(
        'With Paperless-ngx, Paperless fetches the receipts from the mailbox itself: in Paperless under „Mail“ add an account and a rule (action „Dokument verarbeiten“). There is nothing to set up here.',
    );
}

export interface MailEingangDeps {
    connector: MailConnector;
    /** The entity's DMS; only the built-in one takes files. */
    provider: DmsProvider;
    config: MailEingangConfig | null;
    /** Null = no password in the keyring (and none in the environment). */
    password: string | null;
    /** The cursor, keyed by folder. */
    state: {
        get(folder: string): MailEingangState | null;
        save(state: MailEingangState): void;
        /** A run that moved nothing (an error) — recorded without touching the cursor. */
        recordRun(folder: string, at: string, result: string): void;
    };
    entityId: string;
    now?(): Date;
    /** Dokumentregeln to apply instead of the entity's stored ones — the seam tests use. */
    rules?: readonly DokumentRegel[];
}

export interface AbrufOptions {
    /** Look and count, store nothing, move no cursor. */
    dryRun?: boolean;
}

export type AbrufRefusal = 'paperless' | 'nicht-konfiguriert' | 'kein-passwort' | 'ungueltig' | 'verbindung';

export interface AbrufBeleg {
    filename: string;
    sender: string;
    date: string;
    /** `neu` was (or, in a dry run, would be) stored; `vorhanden` was recognised by its content hash. */
    status: 'neu' | 'vorhanden';
}

export type AbrufErgebnis =
    | {
          ok: true;
          dryRun: boolean;
          /** Messages looked at in this run. */
          nachrichten: number;
          neu: number;
          vorhanden: number;
          /** Messages without a receipt, over the size limit, vanished, or unreadable. */
          uebersprungen: number;
          /** Messages beyond the per-run limit, still waiting. */
          offen: number;
          /** The numbering of the folder changed; stored UIDs were discarded and everything re-checked. */
          neuNummeriert: boolean;
          fehler: string[];
          belege: AbrufBeleg[];
          /** One line with counts only. */
          zusammenfassung: string;
      }
    | { ok: false; grund: AbrufRefusal; meldung: string };

function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function summary(r: {
    nachrichten: number;
    neu: number;
    vorhanden: number;
    offen: number;
    neuNummeriert: boolean;
    dryRun: boolean;
}): string {
    if (r.nachrichten === 0) return r.neuNummeriert ? _('Folder renumbered, no messages') : _('No new messages');
    const parts = [
        fmt(_n('{count} message checked', '{count} messages checked', r.nachrichten), { count: r.nachrichten }),
        r.dryRun
            ? fmt(_n('{count} new receipt would be imported', '{count} new receipts would be imported', r.neu), {
                  count: r.neu,
              })
            : fmt(_n('{count} new receipt', '{count} new receipts', r.neu), { count: r.neu }),
    ];
    if (r.vorhanden > 0) parts.push(fmt(_('{count} already there'), { count: r.vorhanden }));
    if (r.offen > 0) parts.push(fmt(_('{count} more waiting'), { count: r.offen }));
    if (r.neuNummeriert) parts.push(_('Folder renumbered, everything checked again'));
    return parts.join(' · ');
}

/** Fetch the new mail of the entity's configured folder and import its receipts. */
export async function belegeAusMailAbrufen(deps: MailEingangDeps, options: AbrufOptions = {}): Promise<AbrufErgebnis> {
    const dryRun = options.dryRun === true;
    const now = deps.now ?? (() => new Date());
    const refuse = (grund: AbrufRefusal, meldung: string): AbrufErgebnis => ({ ok: false, grund, meldung });

    if (deps.provider.kind !== 'builtin') return refuse('paperless', paperlessMailHint());
    const config = deps.config;
    if (!config) {
        return refuse('nicht-konfiguriert', _('No mailbox set up (Settings → Receipts from mail).'));
    }
    const invalid = pruefeMailEingang(config);
    if (invalid) return refuse('ungueltig', invalid);
    if (!deps.password) {
        return refuse(
            'kein-passwort',
            _('No password for the mailbox in the keyring (Settings → Receipts from mail → Save mailbox).'),
        );
    }

    const folderName = config.folder;
    let source: MailSource | null = null;
    try {
        source = await deps.connector.connect(config, deps.password);
        const folder = await source.openFolder(folderName);
        const state = deps.state.get(folderName);
        const plan = planeAbruf(state, folder);

        const all = await source.uidsAbove(plan.since, config.sender);
        const uids = all.slice(0, MAX_MESSAGES_PER_RUN);
        const offen = all.length - uids.length;

        const belege: AbrufBeleg[] = [];
        const fehler: string[] = [];
        let neu = 0;
        let vorhanden = 0;
        let uebersprungen = 0;
        let geprueft = 0;
        let lastUid = plan.since;

        for (const uid of uids) {
            const fetched = await source.fetchMessage(uid, MAX_MESSAGE_BYTES);
            if (fetched.kind !== 'ok') {
                uebersprungen++;
                geprueft++;
                lastUid = uid;
                continue;
            }
            const mail = parseMail(fetched.bytes);
            const sender = mail.from ?? 'unbekannt';
            const date = mail.date ?? now().toISOString().slice(0, 10);
            const attachments = selectAttachments(mail.parts, `mail-${uid}`);
            if (config.sender?.trim() && !sender.toLowerCase().includes(config.sender.trim().toLowerCase())) {
                // The server already filtered; this keeps a transport that does not honest to the contract.
                uebersprungen++;
                geprueft++;
                lastUid = uid;
                continue;
            }
            if (attachments.length === 0) uebersprungen++;

            let failed = false;
            for (const att of attachments) {
                if (att.bytes.length > MAX_RECEIPT_BYTES) {
                    fehler.push(fmt(_('„{file}“ is too large.'), { file: att.filename }));
                    continue;
                }
                const exists = await deps.provider.get(sha256(att.bytes));
                if (exists) {
                    vorhanden++;
                    belege.push({ filename: att.filename, sender, date, status: 'vorhanden' });
                    continue;
                }
                if (!dryRun) {
                    const origin: DmsOrigin = { kind: 'mail', from: sender, date };
                    try {
                        await storeReceipt(deps.provider, {
                            bytes: att.bytes,
                            filename: att.filename,
                            mimeType: att.mimeType,
                            entityId: deps.entityId,
                            origin,
                            created: date,
                            ...(deps.rules ? { rules: deps.rules } : {}),
                        });
                    } catch (err) {
                        // Stop here: the cursor stays before this message, so the next run tries it again.
                        fehler.push(`„${att.filename}“: ${errorText(err)}`);
                        failed = true;
                        break;
                    }
                }
                neu++;
                belege.push({ filename: att.filename, sender, date, status: 'neu' });
            }
            if (failed) break;
            geprueft++;
            lastUid = uid;
        }

        const zusammenfassung = summary({
            nachrichten: geprueft,
            neu,
            vorhanden,
            offen,
            neuNummeriert: plan.neuNummeriert,
            dryRun,
        });
        if (!dryRun) {
            deps.state.save({
                entityId: deps.entityId,
                folder: folderName,
                uidValidity: folder.uidValidity,
                lastUid,
                lastRunAt: now().toISOString(),
                lastResult: fehler.length
                    ? `${zusammenfassung} · ${fmt(_n('{count} error', '{count} errors', fehler.length), { count: fehler.length })}`
                    : zusammenfassung,
            });
        }
        return {
            ok: true,
            dryRun,
            nachrichten: geprueft,
            neu,
            vorhanden,
            uebersprungen,
            offen,
            neuNummeriert: plan.neuNummeriert,
            fehler,
            belege,
            zusammenfassung,
        };
    } catch (err) {
        const meldung = errorText(err);
        log.warn(`mail fetch for ${deps.entityId} failed: ${meldung}`);
        if (!dryRun)
            deps.state.recordRun(folderName, now().toISOString(), fmt(_('Error: {message}'), { message: meldung }));
        return refuse('verbindung', meldung);
    } finally {
        await source?.close();
    }
}

// ── Status (read-only) ───────────────────────────────────────────────────────────────────────────

export interface MailEingangStatus {
    /** `builtin`, `paperless`. */
    dms: 'builtin' | 'paperless';
    konfiguriert: boolean;
    host: string | null;
    folder: string | null;
    sender: string | null;
    beimStart: boolean;
    passwortGespeichert: boolean;
    /** When and what the last run said; null before the first. */
    letzterAbruf: { at: string | null; ergebnis: string | null } | null;
    /** Set for Paperless: where to look instead. */
    hinweis: string | null;
}

// ── Wiring ───────────────────────────────────────────────────────────────────────────────────────

function entityDms(entityId: string) {
    return resolveWorkspaceEntities([], loadManifest()).find((e) => e.id === entityId)?.dms;
}

function ledgerState(entityId: string): MailEingangDeps['state'] {
    const withDb = <T>(fn: (db: ReturnType<typeof openLedger>) => T): T => {
        const db = openLedger(ledgerDbPath());
        try {
            migrate(db);
            return fn(db);
        } finally {
            db.close();
        }
    };
    return {
        get: (folder) => withDb((db) => getMailEingangState(db, entityId, folder)),
        save: (state) => withDb((db) => saveMailEingangState(db, state)),
        recordRun: (folder, at, result) => withDb((db) => recordMailEingangRun(db, entityId, folder, at, result)),
    };
}

/** The dependencies for an entity from the manifest, the keyring and the ledger; the connector is the surface's. */
export function defaultMailEingangDeps(entityId: string, connector: MailConnector): MailEingangDeps {
    return {
        connector,
        provider: dmsProviderForEntity(entityId, entityDms(entityId), createAppContext().config),
        config: loadMailEingang(entityId),
        password: lookupMailEingangPassword(entityId)?.password ?? null,
        state: ledgerState(entityId),
        entityId,
    };
}

/** Status of an entity's mail fetch, without a connection and without the password. */
export function mailEingangStatus(entityId: string, hasPassword: boolean): MailEingangStatus {
    const dms = entityDms(entityId);
    const config = loadMailEingang(entityId);
    const db = openLedger(ledgerDbPath());
    let last: ReturnType<typeof getMailEingangLastRun> = null;
    try {
        migrate(db);
        last = getMailEingangLastRun(db, entityId);
    } finally {
        db.close();
    }
    return {
        dms: dms?.type === 'paperless' ? 'paperless' : 'builtin',
        konfiguriert: config != null,
        host: config?.host ?? null,
        folder: config?.folder ?? null,
        sender: config?.sender ?? null,
        beimStart: config?.onStart === true,
        passwortGespeichert: hasPassword,
        letzterAbruf: last ? { at: last.lastRunAt, ergebnis: last.lastResult } : null,
        hinweis: dms?.type === 'paperless' ? paperlessMailHint() : null,
    };
}

/** Fetch for an entity with the manifest, keyring and ledger wired in — what CLI, MCP and desktop call. */
export function belegeAusMailAbrufenFuer(
    entityId: string,
    connector: MailConnector,
    options: AbrufOptions = {},
): Promise<AbrufErgebnis> {
    return belegeAusMailAbrufen(defaultMailEingangDeps(entityId, connector), options);
}

/** Receipts of an entity that arrived by mail and are still without a booking — the Beleg-Eingang's count. */
export function neueBelegeAusMailZaehlen(
    docs: ReadonlyArray<{ origin?: DmsOrigin | null; linkedTxIds: string[] }>,
): number {
    return docs.filter((d) => d.origin?.kind === 'mail' && d.linkedTxIds.length === 0).length;
}
