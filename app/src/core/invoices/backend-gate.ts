/**
 * The guard in front of every Qonto invoice call. The Qonto credentials are global (.env, one
 * organisation), so an entity that does not own a `qonto:` account would otherwise list — and
 * could create or send — another entity's invoices. An entity bills through Qonto only when its
 * `invoicing.type` is qonto AND its `accounts` hold a `qonto:` account.
 *
 * Pure apart from the manifest read; shared by the desktop, CLI and MCP through the actions.
 */

import { type EntityInvoicingView, loadEntityInvoicing } from '../config/index.ts';
import { _, fmt } from '../lib/i18n.ts';

/** The explanation shown (desktop notice page, CLI/MCP error) when Qonto is not usable. */
export function qontoUnavailableMessage(entityId: string): string {
    return fmt(
        _(
            'No Qonto account is assigned to “{entity}”, so invoicing through Qonto is blocked (the Qonto ' +
                'credentials apply to the whole installation and would otherwise show another entity’s ' +
                'invoices). Assign a Qonto account under Settings → Connections, or switch invoicing to ' +
                '“Built in”.',
        ),
        { entity: entityId },
    );
}

export class QontoNotConfiguredError extends Error {
    constructor(entityId: string) {
        super(qontoUnavailableMessage(entityId));
        this.name = 'QontoNotConfiguredError';
    }
}

/** The reason Qonto invoicing is blocked for the entity, or null when it is fine (or not Qonto). */
export function invoicingBlock(entityId: string, path?: string): string | null {
    const view = loadEntityInvoicing(entityId, path);
    return view.type === 'qonto' && !view.qontoAccount ? qontoUnavailableMessage(entityId) : null;
}

/** Load the entity's invoicing view, throwing {@link QontoNotConfiguredError} when Qonto is blocked. */
export function requireInvoicingBackend(entityId: string, path?: string): EntityInvoicingView {
    const view = loadEntityInvoicing(entityId, path);
    if (view.type === 'qonto' && !view.qontoAccount) throw new QontoNotConfiguredError(entityId);
    return view;
}
