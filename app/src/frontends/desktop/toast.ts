/**
 * App-wide toast helper. The window registers its single Adw.ToastOverlay here at startup so any
 * view/dialog can show a transient confirmation without threading the overlay through constructors.
 * The app's first toasts (invoice save / finalize / storno).
 */

import Adw from '@girs/adw-1';

let overlay: Adw.ToastOverlay | null = null;

/** Called once by the window with its content ToastOverlay. */
export function registerToastOverlay(o: Adw.ToastOverlay): void {
    overlay = o;
}

/** Show a transient toast, if the overlay is registered (no-op otherwise). */
export function showToast(title: string, timeoutSeconds = 3): void {
    if (!overlay) return;
    overlay.add_toast(new Adw.Toast({ title, timeout: timeoutSeconds }));
}

/**
 * Show an undoable toast (HIG: Undo-Toast instead of a confirmation dialog for reversible writes).
 * `onUndo` runs when the user taps "Rückgängig" — at most once; the longer timeout leaves room to react.
 */
export function showUndoToast(title: string, onUndo: () => void, timeoutSeconds = 6): void {
    if (!overlay) return;
    const toast = new Adw.Toast({ title, timeout: timeoutSeconds, buttonLabel: 'Rückgängig' });
    let used = false;
    toast.connect('button-clicked', () => {
        if (used) return;
        used = true;
        onUndo();
    });
    overlay.add_toast(toast);
}
