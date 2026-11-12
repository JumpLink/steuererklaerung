/**
 * Which approval each write tool of this app's MCP server needs when the lotsman assistant calls it
 * (ADR 0005). Every tool annotated `readOnlyHint: false` is in exactly ONE of the two lists below;
 * `dev/check-assistant-tiers.js` (`check:assistant-tiers`) fails the build for a write tool in
 * neither, so adding one forces the decision in the commit that adds it.
 *
 * The lists are the one thing maintained by hand. The catalogue of readable tools is not: it is
 * `mcp.groups` plus each tool's own `readOnlyHint` (ADR 0003), so there is no second list of reads
 * to drift. A tier is a judgement about consequences and cannot be derived from an annotation.
 *
 * Plain data on purpose — no `@lotsman/*` import, so this file is not an AI site for `check:ai` and
 * the gate script can read the arrays without loading TypeScript. {@link TIER_A_HOST_CONFIRMED}
 * is shaped like lotsman's `HostToolMatch` so the pane can hand it over as `hostTools.hostConfirmed`.
 */

import { MCP_SERVER_NAME } from '../mcp-clients.ts';

/**
 * Tier A — the app's own dialog, one call, never an always. Lotsman may never approve these, not from
 * its dialog and not from an always-allow left over from earlier in the session.
 *
 * What lands here is irreversible or in someone's name: a submission (the keystore PIN is the app's
 * to ask for and is never handed to an agent), a Festschreibung, a signature, and every deletion the
 * change log cannot reconstruct. A tool that moves money belongs here the day it exists; the app has
 * none (`generate_sepa_qr` only draws a code the person scans, and an agent's TAN prompt is refused).
 */
export const TIER_A_TOOLS = [
    'submit_filing',
    'elster_lock_period',
    'sign_off_filing',
    'revoke_signoff',
    'remove_filing',
    'remove_contact',
    'invoices_delete_draft',
    'invoices_cancel',
    'detach_filing_document',
] as const;

/**
 * Tier B — lotsman's dialog, approval per call, an always-allow only for the rest of the session.
 * The daily work: confirmations, splits, links, metadata, drafts and classifications.
 */
export const TIER_B_TOOLS = [
    'save_contact',
    'contracts_save',
    'contracts_archive',
    'contracts_link_transaction',
    'contracts_link_document',
    'match_transaction_to_document',
    'push_document_to_qonto',
    'dms_apply_metadata',
    'dms_set_payment_status',
    'dms_apply_reconcile_open_items',
    'dms_apply_fints_statements',
    'link_documents',
    'dokumentregel_merken',
    'dokumentregel_entfernen',
    'belege_mail_abrufen',
    'hinweise_ok',
    'buchung_bestaetigen',
    'erstattung_entscheiden',
    'buchung_aufteilen',
    'projekt_zuordnen',
    'laufende_kosten_entscheiden',
    'record_classification',
    'create_filing_snapshot',
    'record_web_filing',
    'invoices_create_draft',
    'invoices_project_set',
    'invoices_finalize',
    'invoices_mark_paid',
    'invoices_doppelzahlung_decide',
    'forderungen_mahnung_versandt',
    'paperless_update_document',
    'paperless_upload_document',
    'paperless_create_correspondent',
    'create_outgoing_invoice_draft',
    'qonto_finalize_invoice',
    'match_document_to_store_transaction',
    'record_filing',
    'attach_filing_document',
] as const;

export type WriteTier = 'A' | 'B';

const TIER_OF: ReadonlyMap<string, WriteTier> = new Map<string, WriteTier>([
    ...TIER_A_TOOLS.map((name): [string, WriteTier] => [name, 'A']),
    ...TIER_B_TOOLS.map((name): [string, WriteTier] => [name, 'B']),
]);

/** Prefixes an agent may put in front of a tool name: `steuererklaerung.x` (ACP) or `steuererklaerung_x` (opencode). */
const SERVER_PREFIXES = [`${MCP_SERVER_NAME}.`, `${MCP_SERVER_NAME}_`];

/**
 * The tier of a tool, or `null` when the name is not a write tool of this app (a read, or something
 * that is not ours at all). The name arrives from the agent, so case, padding and the server prefix
 * must not decide the answer.
 */
export function writeTierOf(name: string): WriteTier | null {
    let key = name.trim().toLowerCase();
    for (const prefix of SERVER_PREFIXES) {
        if (key.startsWith(prefix)) {
            key = key.slice(prefix.length);
            break;
        }
    }
    return TIER_OF.get(key) ?? null;
}

/** Tier A by the MCP name lotsman matches on (`steuererklaerung.submit_filing`), for `hostTools.hostConfirmed`. */
export const TIER_A_HOST_CONFIRMED: readonly { readonly name: string }[] = TIER_A_TOOLS.map((tool) => ({
    name: `${MCP_SERVER_NAME}.${tool}`,
}));
