/**
 * The guard in front of every Qonto invoice call. The Qonto credentials are global (.env, one
 * organisation), so an entity that does not own a `qonto:` account would otherwise list — and
 * could create or send — another entity's invoices. An entity bills through Qonto only when its
 * `invoicing.type` is qonto AND its `accounts` hold a `qonto:` account.
 *
 * Pure apart from the manifest read; shared by the desktop, CLI and MCP through the actions.
 */

import { type EntityInvoicingView, loadEntityInvoicing } from '../config/index.ts';

/** The German explanation shown (desktop notice page, CLI/MCP error) when Qonto is not usable. */
export function qontoUnavailableMessage(entityId: string): string {
    return (
        `Für „${entityId}" ist kein Qonto-Konto hinterlegt, Rechnungen über Qonto sind deshalb gesperrt ` +
        '(die Qonto-Zugangsdaten gelten für die ganze Installation und würden sonst die Rechnungen ' +
        'einer anderen Entität zeigen). Unter Einstellungen → Anbindungen ein Qonto-Konto zuordnen ' +
        'oder die Rechnungsstellung auf „Selbst" umstellen.'
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
