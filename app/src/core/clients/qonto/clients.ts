/**
 * Qonto API – Clients (customers for outgoing invoices).
 * GET /v2/clients, POST /v2/clients.
 * A client needs currency, locale and a billing address to be usable for invoicing.
 */

import { get, listAll, post } from './request.ts';
import type { Client, CreateClientBody } from './types.ts';

function idempotencyKey(): string {
    return crypto.randomUUID();
}

export interface ListClientsParams {
    /** Filter to a single page (API default) instead of fetching all pages. */
    perPage?: number;
    maxPages?: number;
}

/**
 * List all clients (all pages by default).
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function listClients(params: ListClientsParams = {}): Promise<Client[]> {
    return listAll<Client>('clients', {}, { perPage: params.perPage, maxPages: params.maxPages });
}

/**
 * Get a single client by id.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function getClient(clientId: string): Promise<Client> {
    const res = await get<{ client: Client }>(`clients/${clientId}`);
    return res.client;
}

/** Display name for a client regardless of kind (company name or "First Last"). */
export function clientDisplayName(client: Client): string {
    if (client.name) return client.name;
    return [client.first_name, client.last_name].filter(Boolean).join(' ').trim();
}

/**
 * Find an existing client by exact (case-insensitive) display name. Returns undefined if none match.
 */
export async function findClientByName(name: string): Promise<Client | undefined> {
    const target = name.trim().toLowerCase();
    const clients = await listClients();
    return clients.find((c) => clientDisplayName(c).trim().toLowerCase() === target);
}

/**
 * Create a new client.
 * For invoicing, pass currency, locale and billing_address.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function createClient(body: CreateClientBody): Promise<Client> {
    const res = await post<{ client: Client }>('clients', body, {
        'X-Qonto-Idempotency-Key': idempotencyKey(),
    });
    return res.client;
}

/**
 * Resolve a client by name, creating it if it does not exist yet.
 * @returns the client plus whether it was newly created (for dry-run / logging).
 */
export async function findOrCreateClient(body: CreateClientBody): Promise<{ client: Client; created: boolean }> {
    const name = body.name ?? [body.first_name, body.last_name].filter(Boolean).join(' ');
    if (name) {
        const existing = await findClientByName(name);
        if (existing) return { client: existing, created: false };
    }
    const client = await createClient(body);
    return { client, created: true };
}
