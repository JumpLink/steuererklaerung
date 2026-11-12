/**
 * The assistant's change log (ADR 0005): one NDJSON line per write tool that returned, appended by
 * the MCP server's child process into `assistant-changes.ndjson` in the app's data directory.
 *
 * It records REFERENCES, never values — time, session, tool, outcome and the NAMES of the fields
 * the call carried. No amounts, no Steuernummern, no document bodies, so the log never becomes a
 * second copy of the tax data. It is still the shape of someone's bookkeeping: 0600 in a 0700
 * directory, and `createBackup` takes it along.
 */

import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { userDataDir } from '../../paths.ts';

export const CHANGE_LOG_FILE = 'assistant-changes.ndjson';

/**
 * The ACP session the MCP child serves. Only a server started for the assistant carries it; the
 * guard in `frontends/mcp/write-guard.ts` stays off without it, so an externally registered client
 * sees no change.
 */
export const ACP_SESSION_ENV = 'STEUER_ACP_SESSION';

export type ChangeOutcome = 'ok' | 'error' | 'declined';

export interface ChangeLogEntry {
    /** ISO time the tool returned. */
    time: string;
    /** The ACP session that made the call. */
    session: string;
    tool: string;
    /** `declined` = refused before the tool ran (no backup, so no write). */
    outcome: ChangeOutcome;
    /** Names of the arguments the call carried — never their values. */
    fields: string[];
}

export function changeLogPath(): string {
    return join(userDataDir(), CHANGE_LOG_FILE);
}

export function appendChangeLog(entry: ChangeLogEntry, path: string = changeLogPath()): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    // `mode` only applies when the file is created; a log that already existed keeps its old bits.
    chmodSync(path, 0o600);
}
