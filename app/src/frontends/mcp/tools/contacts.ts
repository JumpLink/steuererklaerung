/**
 * Contacts (parties) MCP tools — manual single-record access to the unified contact master.
 * Counterpart to the CLI `contacts` command (src/frontends/cli/contacts.ts). The bulk path
 * (Qonto clients + Paperless correspondents) is `importContacts`, exposed via the web UI's
 * Kontakte tab, not here — these three tools are for the one-off case: adding/checking/removing
 * a single party by hand (e.g. a new point-of-contact at a customer).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../../../core/context.ts';
import { listEntityContacts, removeContact, saveContact } from '../../../core/actions/contacts.ts';
import { mcpErrorFrom, mcpSuccess } from '../types.ts';

const CONTACT_KINDS = ['company', 'individual', 'freelancer', 'organization'] as const;

export function registerContactsTools(server: McpServer, _ctx: AppContext): void {
    // ── save_contact (create, or update with id) ────────────────────────

    server.registerTool(
        'save_contact',
        {
            title: 'Save a Contact (Kontakt anlegen/aktualisieren)',
            description:
                'Create a new contact in the unified contact master, or update one by id (merge — omitted fields are preserved). Without id this always INSERTS a new row; there is no name-based dedup here (that only happens on import from Qonto/Paperless) — call list_contacts first to check for an existing entry. Use for the one-off case, e.g. a new point-of-contact at a customer; bulk sync is importContacts (web UI only, not exposed here).',
            inputSchema: {
                id: z.string().optional().describe('Update this existing contact instead of creating a new one'),
                entity: z.string().describe('Workspace entity id (gbr|jumplink|privat)'),
                kind: z.enum(CONTACT_KINDS).optional().describe('Default: company'),
                name: z.string().optional().describe('Company/display name'),
                first_name: z.string().optional(),
                last_name: z.string().optional(),
                email: z.string().optional(),
                vat_number: z.string().optional().describe('USt-IdNr.'),
                tax_id: z.string().optional(),
                iban: z.string().optional(),
                currency: z.string().optional().describe('Default: EUR'),
                locale: z.string().optional().describe('Default: de'),
                address: z.string().optional(),
                zip: z.string().optional(),
                city: z.string().optional(),
                country_code: z.string().optional(),
                is_customer: z.boolean().optional(),
                is_supplier: z.boolean().optional(),
                notes: z.string().optional().describe('Free text, e.g. role / point-of-contact context'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        },
        async (params) => {
            if (!params.id && !params.name && !params.first_name && !params.last_name) {
                return mcpErrorFrom(new Error('Mindestens name oder first_name/last_name angeben.'));
            }
            try {
                return mcpSuccess(
                    saveContact({
                        id: params.id,
                        entityId: params.entity,
                        kind: params.kind,
                        name: params.name,
                        firstName: params.first_name,
                        lastName: params.last_name,
                        email: params.email,
                        vatNumber: params.vat_number,
                        taxId: params.tax_id,
                        iban: params.iban,
                        currency: params.currency,
                        locale: params.locale,
                        address: params.address,
                        zip: params.zip,
                        city: params.city,
                        countryCode: params.country_code,
                        isCustomer: params.is_customer,
                        isSupplier: params.is_supplier,
                        notes: params.notes,
                    }),
                );
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── list_contacts ─────────────────────────────────────────────────────

    server.registerTool(
        'list_contacts',
        {
            title: 'List Contacts (Kontakte-/Parteienstamm)',
            description: 'List every contact (customer/supplier party) recorded for one workspace entity.',
            inputSchema: {
                entity: z.string().describe('Workspace entity id (gbr|jumplink|privat)'),
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (params) => {
            try {
                return mcpSuccess(listEntityContacts(params.entity));
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );

    // ── remove_contact ───────────────────────────────────────────────────

    server.registerTool(
        'remove_contact',
        {
            title: 'Remove a Contact',
            description: 'Delete a contact (and its external-system links), scoped to its entity.',
            inputSchema: {
                entity: z.string().describe('Workspace entity id'),
                id: z.string().describe('Contact id'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        },
        async (params) => {
            try {
                removeContact(params.entity, params.id);
                return mcpSuccess({ removed: true });
            } catch (err) {
                return mcpErrorFrom(err);
            }
        },
    );
}
