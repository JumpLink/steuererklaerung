/**
 * @steuererklaerung/dms — the document-management surface shared by the CLI/web and the future
 * native GNOME app: the back-end-agnostic provider abstraction (built-in DMS + Paperless),
 * the AI receipt extraction ("KI statt OCR"), and the store↔document reconciliation read-path.
 */

export * from './types.ts';
export * from './builtin-provider.ts';
export * from './paperless-provider.ts';
export * from './extract.ts';
export * from './reconcile.ts';
export * from './pdf-thumb.ts';
export * from './pdf-text.ts';
