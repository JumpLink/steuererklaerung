/**
 * Typed DOM lookups for the Adwaita web components. The custom elements aren't in lib.dom's
 * `HTMLElementTagNameMap`, so `querySelector`/`createElement` return the base `Element`/`HTMLElement`.
 * These two helpers concentrate the single unavoidable boundary cast in one place instead of
 * sprinkling `as unknown as T` across every call site.
 */

/** `root.querySelector(selector)` typed as the Adwaita component `T` (or null when absent). */
export function q<T>(root: ParentNode, selector: string): T | null {
    return root.querySelector(selector) as unknown as T | null;
}

/** `document.createElement(tag)` typed as the Adwaita component `T`. */
export function qc<T>(tag: string): T {
    return document.createElement(tag) as unknown as T;
}
