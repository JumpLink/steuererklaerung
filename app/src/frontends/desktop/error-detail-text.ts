/**
 * The wording of an error `detail` (see `ErrorDetail` in core/lib/errors.ts), kept free of GTK so a
 * test can run it: the test bundle must not import a GUI typelib, and `i18n.ts` does.
 *
 * `_` is a PARAMETER named like the translation function on purpose — the extractor keys on the
 * name, so the msgids below are collected, while the caller decides which catalogue answers.
 */

import type { ErrorDetail } from '../../core/lib/errors.ts';

export type Translate = (msgid: string) => string;

/** Fill `{name}` placeholders (same contract as `fmt` in i18n.ts, which this module cannot import). */
function fmt(template: string, values: Record<string, string | number>): string {
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

/** The text for a `detail`, or `null` when its code is unknown to this version of the window. */
export function translateDetail(detail: ErrorDetail, _: Translate): string | null {
    const p = detail.params ?? {};
    switch (detail.code) {
        case 'manifest-missing':
            return fmt(
                _(
                    'No configuration found at {path} (looked for {file}, then the old name {legacy}). ' +
                        'Run the setup assistant, or "steuer config migrate" to merge old configurations.',
                ),
                p,
            );
        case 'manifest-save-missing':
            return fmt(_('There is no configuration at {path} to save to.'), p);
        case 'manifest-unreadable':
            return fmt(_('{name} could not be read: {error}'), p);
        case 'manifest-bad-json':
            return fmt(_('{name} is not valid JSON: {error}'), p);
        case 'manifest-not-migrated':
            return fmt(
                _('{name} has not been migrated to configuration format v{version} yet. Run "steuer config migrate".'),
                p,
            );
        case 'manifest-invalid':
            return fmt(_('The configuration at {path} is invalid:\n{issues}'), p);
        case 'manifest-too-new':
            return fmt(
                _(
                    'This configuration is version {fileVersion}; this app knows version {appVersion}. ' +
                        'A newer version wrote it and it is NOT changed here — saving would drop everything ' +
                        'this version does not know yet. Please use the newer version or restore the file from a backup.',
                ),
                p,
            );
        case 'manifest-no-entity':
            return _('The configuration contains no entity.');
        case 'entity-not-found':
            return fmt(_('Entity "{id}" not found in the configuration. Known entities: {known}.'), p);
        case 'entity-section-missing':
            return fmt(_('Entity "{id}" has no "{section}" section.'), p);
        case 'paperless-missing':
            return _('The configuration has no "paperless" section. Set up Paperless in the settings.');
        case 'paperless-invalid':
            return fmt(_('Invalid Paperless section in the configuration:\n{issues}'), p);
        case 'fints-missing':
            return _('The configuration has no "fints" section. Configure the FinTS bank connections.');
        case 'backup-busy':
            return fmt(_('A backup is already running (process {pid}, since {since}).'), p);
        case 'backup-busy-unknown':
            return _('A backup is already running.');
        case 'backup-inside':
            return fmt(_('The backup folder {root} lies inside {tree} — please choose another one.'), p);
        case 'backup-integrity':
            return fmt(_('The integrity check of the copy {dest} failed: {verdict}'), p);
        default:
            return null;
    }
}
