/**
 * Interactive mode for sync match-qonto-paperless: step through transactions and match results.
 * For unmatched attachments, offers "Import [filename] to Paperless".
 */

import { interactivePrompts } from '../../../core/lib/interactive-prompts.ts';
import type {
    MatchQontoPaperlessReport,
    TransactionMatchItem,
} from '../../../core/actions/sync/match-qonto-paperless.ts';
import type { MatchCandidate } from '../../../core/actions/sync/match.ts';
import { importAttachmentToPaperless, updateExistingDocumentQontoMetadata } from '../../../core/actions/sync/import.ts';
import { DEFAULTS } from '../../../core/constants.ts';
import { getDocument, getCustomFieldValue, parseMonetaryValue } from '@steuererklaerung/paperless';
import { getLogger } from '../../../core/lib/logger.ts';
import type { SyncConfig } from '../../../core/config/index.ts';
import { loadPaperlessConfig } from '../../../core/config/index.ts';

const log = getLogger('sync-import');

const AMOUNT_MISMATCH_TOLERANCE = DEFAULTS.AMOUNT_TOLERANCE_EUR;

/**
 * When a Qonto transaction has multiple attachments (e.g. duplicate receipts with different
 * filenames), the same Paperless document can be matched by filename to more than one transaction.
 * We only apply Qonto metadata if the transaction amount matches the document's invoice amount,
 * so we don't overwrite the correct link with the wrong transaction.
 *
 * Returns { skip: true, reason } when document has an invoice amount and it doesn't match the
 * transaction amount (same currency). Otherwise returns { skip: false }.
 */
export async function shouldSkipLinkBecauseAmountMismatch(
    documentId: number,
    amountCents: number,
    amountCurrency: string,
    config: SyncConfig,
    /** For Sammelrechnungen: all transactions sharing this attachment (amounts in cents). */
    sharedTransactions?: Array<{ amount_cents: number; side: 'credit' | 'debit' }>,
): Promise<{ skip: boolean; reason?: string }> {
    const cf = config.custom_field_ids;
    if (cf.total_gross <= 0) return { skip: false };

    const doc = await getDocument(documentId);
    const grossParsed = parseMonetaryValue(getCustomFieldValue(doc, cf.total_gross));
    if (!grossParsed) return { skip: false };

    const docAmount = grossParsed.amount;
    const docCurrency = (grossParsed.currency || 'EUR').toUpperCase();
    const txCurrency = (amountCurrency || 'EUR').trim().toUpperCase();
    if (docCurrency !== txCurrency) return { skip: false };

    // Single-transaction check
    const txAmount = Math.abs(amountCents) / 100;
    if (Math.abs(txAmount - docAmount) <= AMOUNT_MISMATCH_TOLERANCE) return { skip: false };

    // Sammelrechnung: check if the SUM of all shared transactions matches the invoice total
    if (sharedTransactions && sharedTransactions.length > 1) {
        const sumAmount = sharedTransactions.reduce((s, t) => s + Math.abs(t.amount_cents) / 100, 0);
        if (Math.abs(sumAmount - docAmount) <= AMOUNT_MISMATCH_TOLERANCE) {
            return { skip: false }; // Sum matches → it's a valid Sammelrechnung
        }
    }

    return {
        skip: true,
        reason: `Document #${documentId} has invoice amount ${docAmount.toFixed(2)} ${docCurrency}, transaction is ${txAmount.toFixed(2)} ${txCurrency} – skip to avoid wrong link (e.g. duplicate attachments).`,
    };
}

/** Returns a message if import is not possible (missing config); null if ready. */
function getImportBlockReason(config: SyncConfig): string | null {
    if (!config.custom_field_ids.qonto_transaction_id || !config.custom_field_ids.qonto_attachment_id) {
        return 'Bitte zuerst "paperless setup-fields" ausführen, um Custom-Field-IDs in sync-config.json zu setzen.';
    }
    if (!config.document_type_ids.incoming_invoice || !config.document_type_ids.outgoing_invoice) {
        return 'Bitte zuerst "paperless setup-fields" ausführen, um Document-Type-IDs in sync-config.json zu setzen.';
    }
    return null;
}

function formatDate(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatAmount(cents: number, side: 'credit' | 'debit'): string {
    const amount = (cents / 100).toFixed(2);
    return side === 'credit' ? `+${amount}` : `-${amount}`;
}

function formatCandidates(candidates: MatchCandidate[]): string {
    if (candidates.length === 0) return '';
    return candidates
        .map(
            (c) =>
                `    • Paperless #${c.id}: ${c.original_file_name ?? c.title ?? '—'} (${formatDate(c.created)})${c.needsUpdate ? ' → update available' : ''}`,
        )
        .join('\n');
}

function renderTransaction(tx: TransactionMatchItem, index: number, total: number): void {
    const lines: string[] = [
        '',
        `--- Transaction ${index} of ${total} ---`,
        `  ID:       ${tx.transaction_id}`,
        `  Date:     ${formatDate(tx.settled_at ?? tx.emitted_at)}`,
        `  Amount:   ${formatAmount(tx.amount_cents, tx.side)} ${tx.amount_currency || 'EUR'} (${tx.side})`,
        `  Belege:   ${tx.attachments.length}`,
        '',
    ];

    for (let i = 0; i < tx.attachments.length; i++) {
        const att = tx.attachments[i];
        const hasUpdate = att.matched && att.candidates.some((c) => c.needsUpdate);
        const hasLink = att.matched && !hasUpdate && att.candidates.some((c) => c.needsLink);
        const matchStatus = att.matched
            ? hasUpdate
                ? '✓ In Paperless (update available)'
                : hasLink
                  ? '✓ In Paperless (Qonto not linked)'
                  : '✓ In Paperless'
            : '✗ No match in Paperless';
        lines.push(`  [Beleg ${i + 1}] ${att.file_name ?? att.attachment_id}`);
        lines.push(`            ${matchStatus}`);
        if (att.candidates.length > 0) {
            lines.push('  Kandidaten:');
            lines.push(formatCandidates(att.candidates));
        }
        lines.push('');
    }

    console.log(lines.join('\n'));
}

function transactionChoiceLabel(tx: TransactionMatchItem, index: number): string {
    const date = formatDate(tx.settled_at ?? tx.emitted_at);
    const amount = formatAmount(tx.amount_cents, tx.side);
    const firstFile = tx.attachments[0]?.file_name ?? '—';
    const short = firstFile.length > 40 ? firstFile.slice(0, 37) + '...' : firstFile;
    return `${index + 1}. ${date}  ${amount} EUR  ${short}`;
}

/** Params to write Qonto metadata to a Paperless document (shared by update and link). */
function qontoMetadataParams(
    tx: TransactionMatchItem,
    att: TransactionMatchItem['attachments'][0],
    config: SyncConfig,
): Parameters<typeof updateExistingDocumentQontoMetadata>[1] {
    return {
        transactionId: tx.transaction_id,
        attachmentId: att.attachment_id,
        side: tx.side,
        amount_cents: tx.amount_cents,
        settled_at: tx.settled_at,
        amount_currency: tx.amount_currency,
        label: tx.label,
        reference: tx.reference,
        vat_amount: tx.vat_amount,
        config,
    };
}

export interface AutoMatchResult {
    imported: number;
    updated: number;
    skipped: number;
    errors: number;
}

/**
 * Run match in automatic mode: import all unmatched attachments and update all matched with needsUpdate.
 * No prompts; suitable for scripts and non-TTY.
 */
export async function runAutoMatch(report: MatchQontoPaperlessReport): Promise<AutoMatchResult> {
    const result: AutoMatchResult = { imported: 0, updated: 0, skipped: 0, errors: 0 };
    const config = loadPaperlessConfig({ strict: false });
    const blockReason = getImportBlockReason(config);
    if (blockReason) {
        console.error(blockReason);
        throw new Error(blockReason);
    }

    for (const tx of report.transactions) {
        for (const att of tx.attachments) {
            const hasUpdate = att.matched && att.candidates.some((c) => c.needsUpdate);
            const hasLink = att.matched && att.candidates.some((c) => c.needsLink);
            const docId = att.matched
                ? (att.candidates.find((c) => c.needsUpdate) ?? att.candidates[0])?.id
                : undefined;

            if (att.matched && (hasUpdate || hasLink) && docId != null) {
                const { skip, reason } = await shouldSkipLinkBecauseAmountMismatch(
                    docId,
                    tx.amount_cents,
                    tx.amount_currency || 'EUR',
                    config,
                    tx.shared_attachment_transactions,
                );
                if (skip) {
                    result.skipped += 1;
                    const msg = reason ?? 'amount mismatch';
                    log.info(msg);
                    console.warn(`Skipped #${docId}: ${att.file_name ?? att.attachment_id} – ${msg}`);
                    continue;
                }
                const verb = hasUpdate ? 'Updated' : 'Linked';
                try {
                    await updateExistingDocumentQontoMetadata(docId, qontoMetadataParams(tx, att, config));
                    result.updated += 1;
                    console.log(`${verb} document #${docId}: ${att.file_name ?? att.attachment_id}`);
                } catch (err) {
                    result.errors += 1;
                    const msg = err instanceof Error ? err.message : String(err);
                    log.error(`${verb} failed for document #${docId}: ${msg}`, err);
                    console.error(`${verb} failed #${docId}: ${msg}`);
                }
                continue;
            }

            if (att.matched) {
                result.skipped += 1;
                continue;
            }

            if (!att.matched) {
                try {
                    const importResult = await importAttachmentToPaperless({
                        transactionId: tx.transaction_id,
                        attachmentId: att.attachment_id,
                        side: tx.side,
                        amount_cents: tx.amount_cents,
                        settled_at: tx.settled_at,
                        amount_currency: tx.amount_currency,
                        label: tx.label,
                        reference: tx.reference,
                        vat_amount: tx.vat_amount,
                        config,
                    });
                    result.imported += 1;
                    console.log(
                        importResult.created
                            ? `Imported (new document #${importResult.documentId}): ${att.file_name ?? att.attachment_id}`
                            : `Imported (duplicate → #${importResult.documentId}): ${att.file_name ?? att.attachment_id}`,
                    );
                } catch (err) {
                    result.errors += 1;
                    const msg = err instanceof Error ? err.message : String(err);
                    log.error(`Import failed for ${att.file_name ?? att.attachment_id}: ${msg}`, err);
                    console.error(`Import failed: ${att.file_name ?? att.attachment_id}: ${msg}`);
                }
            }
        }
    }

    return result;
}

export async function runInteractiveMatch(report: MatchQontoPaperlessReport): Promise<void> {
    const transactions = report.transactions;
    if (transactions.length === 0) {
        console.log('No transactions with attachments found.');
        return;
    }

    const { input, select } = await interactivePrompts();
    let currentIndex = 0;

    for (;;) {
        const tx = transactions[currentIndex];
        const indexOneBased = currentIndex + 1;
        const total = transactions.length;

        console.clear();
        console.log('Belege-Match (interaktiv) – Transaktion anzeigen, Pfeiltasten + Enter zum Navigieren\n');
        renderTransaction(tx, indexOneBased, total);

        const choices: Array<{ name: string; value: string }> = [];
        const metadataActions = tx.attachments
            .map((att, i) => ({
                att,
                i,
                hasUpdate: att.candidates.some((c) => c.needsUpdate),
                hasLink: att.candidates.some((c) => c.needsLink),
            }))
            .filter(({ att, hasUpdate, hasLink }) => att.matched && (hasUpdate || hasLink));
        for (const { att, i, hasUpdate } of metadataActions) {
            const docId = (att.candidates.find((c) => c.needsUpdate) ?? att.candidates[0])?.id;
            if (docId == null) continue;
            const label = att.file_name ?? att.attachment_id;
            const actionLabel = hasUpdate
                ? `Update document #${docId} in Paperless ("${label}")`
                : `Link Qonto to document #${docId} ("${label}")`;
            choices.push({ name: actionLabel, value: `update:${i}:${docId}` });
        }
        const unmatchedAttachments = tx.attachments.map((att, i) => ({ att, i })).filter(({ att }) => !att.matched);
        for (const { att, i } of unmatchedAttachments) {
            const label = att.file_name ?? att.attachment_id;
            choices.push({
                name: `Import "${label}" to Paperless`,
                value: `import:${i}`,
            });
        }
        if (currentIndex < total - 1) {
            choices.push({ name: 'Next transaction (→)', value: 'next' });
        }
        if (currentIndex > 0) {
            choices.push({ name: 'Previous transaction (←)', value: 'prev' });
        }
        choices.push({ name: 'Jump to transaction...', value: 'jump' });
        choices.push({ name: 'Quit', value: 'quit' });

        const action = await select({
            message: 'Action',
            choices,
            pageSize: 12,
        });

        if (action === 'quit') {
            console.log('Bye.');
            return;
        }
        if (action === 'next') {
            currentIndex = Math.min(currentIndex + 1, total - 1);
            continue;
        }
        if (action === 'prev') {
            currentIndex = Math.max(currentIndex - 1, 0);
            continue;
        }
        if (action === 'jump') {
            const jumpChoice = await select({
                message: 'Select transaction',
                choices: transactions.map((t, i) => ({
                    name: transactionChoiceLabel(t, i),
                    value: String(i),
                })),
                pageSize: 15,
            });
            currentIndex = Number.parseInt(jumpChoice, 10);
            continue;
        }
        if (action.startsWith('update:')) {
            const rest = action.slice(7);
            const [attIndexStr, docIdStr] = rest.split(':');
            const attIndex = Number.parseInt(attIndexStr, 10);
            const documentId = Number.parseInt(docIdStr, 10);
            const att = tx.attachments[attIndex];
            if (!att || Number.isNaN(documentId)) {
                console.log('Invalid update selection.');
                continue;
            }
            try {
                const config = loadPaperlessConfig({ strict: false });
                const blockReason = getImportBlockReason(config);
                if (blockReason) {
                    console.log(blockReason);
                    await input({ message: 'Press Enter to continue', default: '' });
                    continue;
                }
                const { skip, reason } = await shouldSkipLinkBecauseAmountMismatch(
                    documentId,
                    tx.amount_cents,
                    tx.amount_currency || 'EUR',
                    config,
                    tx.shared_attachment_transactions,
                );
                if (skip && reason) {
                    console.log(reason);
                    const answer = await input({
                        message: 'Trotzdem verknüpfen? (j/n)',
                        default: 'n',
                    });
                    if (answer.trim().toLowerCase() !== 'j' && answer.trim().toLowerCase() !== 'ja') {
                        await input({ message: 'Press Enter to continue', default: '' });
                        continue;
                    }
                }
                await updateExistingDocumentQontoMetadata(documentId, qontoMetadataParams(tx, att, config));
                log.info(`Update succeeded: document #${documentId}`);
                console.log(`Dokument #${documentId} mit aktuellen Qonto-Daten aktualisiert.`);
                await input({ message: 'Press Enter to continue', default: '' });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                log.error(`Update failed for document #${documentId}: ${message}`, err);
                console.error(message);
                await input({ message: 'Press Enter to continue', default: '' });
            }
            continue;
        }
        if (action.startsWith('import:')) {
            const attIndex = Number.parseInt(action.slice(7), 10);
            const att = tx.attachments[attIndex];
            if (!att) {
                console.log('Invalid attachment index.');
                continue;
            }
            const fileLabel = att.file_name ?? att.attachment_id;
            try {
                const config = loadPaperlessConfig({ strict: false });
                const blockReason = getImportBlockReason(config);
                if (blockReason) {
                    log.info(`Import skipped (config): ${blockReason}`);
                    console.log(blockReason);
                    await input({ message: 'Press Enter to continue', default: '' });
                    continue;
                }
                const result = await importAttachmentToPaperless({
                    transactionId: tx.transaction_id,
                    attachmentId: att.attachment_id,
                    side: tx.side,
                    amount_cents: tx.amount_cents,
                    settled_at: tx.settled_at,
                    amount_currency: tx.amount_currency,
                    config,
                });
                if (result.created) {
                    const msg = `Importiert und verknüpft (Paperless-Dokument #${result.documentId}).`;
                    log.info(`Import succeeded: documentId=${result.documentId} created=true`);
                    console.log(msg);
                } else {
                    const msg = `Duplikat erkannt, bestehendes Dokument #${result.documentId} mit Qonto-IDs aktualisiert.`;
                    log.info(`Import succeeded (duplicate): documentId=${result.documentId} created=false`);
                    console.log(msg);
                }
                await input({ message: 'Press Enter to continue', default: '' });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                log.error(`Import failed for ${fileLabel}: ${message}`, err);
                console.error(message);
                await input({ message: 'Press Enter to continue', default: '' });
            }
        }
    }
}
