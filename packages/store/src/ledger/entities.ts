/**
 * The operative entities and the account-key → entity mapping. Pure reference data (no I/O),
 * shared by the ledger seeding (CLI) and the DMS GoBD guard. Keep in sync with the workspace
 * entity ids used by the web layer.
 */

/**
 * The ledger's three entity SLOTS, keyed by how an account reaches the store rather than by who
 * owns it: a closed account imported from CAMT, a live business bank account, a private FinTS
 * account. The display names are generic placeholders — the real entity names live in the
 * workspace manifest (`steuererklaerung.json`), which the web/app layer reads; nothing here may be
 * one particular user's firm.
 */
export const ENTITIES: ReadonlyArray<{ id: string; name: string }> = [
    { id: 'artcode', name: 'Betrieb (CAMT-Import)' },
    { id: 'jumplink', name: 'Betrieb (Geschäftskonto)' },
    { id: 'private', name: 'Privat / Haushalt' },
];

/** Map a store account key to its entity slot: camt → CAMT-Import, qonto → Geschäftskonto, fints → privat. */
export function entityForAccountKey(accountKey: string): string | null {
    if (accountKey.startsWith('camt:')) return 'artcode';
    if (accountKey.startsWith('qonto:')) return 'jumplink';
    if (accountKey.startsWith('fints:')) return 'private';
    return null;
}

// The workspace manifest (web/app) scopes documents/contacts/invoices by ITS OWN entity
// ids (gbr|jumplink|privat) — a free tag, deliberately not FK'd to entities(id). Ledger-
// keyed guards (the periods GoBD lock) must translate before querying.
const WORKSPACE_TO_LEDGER: Readonly<Record<string, string>> = {
    gbr: 'artcode',
    jumplink: 'jumplink',
    privat: 'private',
};

/**
 * Map a WORKSPACE entity id to the ledger entities id, accepting a ledger id as-is
 * (the two namespaces overlap). Unknown ids yield null — callers treat that as
 * "no ledger entity, so no period lock applies".
 */
export function ledgerEntityForWorkspaceEntity(workspaceId: string): string | null {
    const mapped = WORKSPACE_TO_LEDGER[workspaceId];
    if (mapped) return mapped;
    return ENTITIES.some((e) => e.id === workspaceId) ? workspaceId : null;
}

/**
 * All ids that name the SAME entity across the two namespaces — the ledger id
 * (artcode|jumplink|private) and its workspace alias (gbr|jumplink|privat) — accepting
 * either as input and returning both, deduplicated. The register (filings) is keyed by
 * whichever id the user typed (usually the workspace id), while the ELSTER config only
 * carries the ledger `entity_id`; a lookup that wants to match both must widen to the
 * alias set. An unknown id yields just itself.
 */
export function entityIdAliases(id: string): string[] {
    const ledger = ledgerEntityForWorkspaceEntity(id) ?? id;
    const workspace = Object.entries(WORKSPACE_TO_LEDGER).find(([, l]) => l === ledger)?.[0];
    const ids = new Set<string>([id, ledger]);
    if (workspace) ids.add(workspace);
    return [...ids];
}
