/**
 * Pure forwarding helpers for BhTabHub.
 *
 * Kept separate from `tab-hub.ts` so the test bundle can exercise them without importing GTK/Adw.
 */

/**
 * Return the visible tab's header toggle, or `undefined` when there is none.
 *
 * The hub itself has no toggle; it only exposes whatever the currently visible tab exposes.
 */
export function forwardHeaderToggle<T>(
    views: ReadonlyMap<string, { headerToggle?(): T | undefined }>,
    visibleId: string | null,
): T | undefined {
    const view = visibleId ? views.get(visibleId) : undefined;
    return view?.headerToggle?.();
}
