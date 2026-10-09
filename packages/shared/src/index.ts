/**
 * @steuererklaerung/shared — leaf utilities reused across the CLI and the extracted packages
 * (store, paperless, dms) and the future native GNOME app. Pure TypeScript, no I/O beyond
 * what the callers pass in; runs identically on Node and GJS (via gjsify).
 */

export * from './date-utils.ts';
export * from './llm-json.ts';
export * from './http.ts';
export * from './llm.ts';
export * from './api.ts';
