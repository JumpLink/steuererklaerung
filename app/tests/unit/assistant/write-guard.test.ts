/**
 * The assistant's write guard (ADR 0005 step 2): the first write of a session snapshots, the second
 * does not, a failed snapshot blocks the session, and the change log has the agreed shape.
 * Everything in a temp directory with made-up tool names — no real data.
 */
import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { CHANGE_LOG_FILE, type ChangeLogEntry } from '../../../src/core/actions/assistant/change-log.ts';
import { SessionBackupGate } from '../../../src/core/actions/assistant/session-backup.ts';
import { createBackup, type BackupSources } from '../../../src/core/actions/backup.ts';
import { guardAssistantWrites } from '../../../src/frontends/mcp/write-guard.ts';

type Handler = (...a: unknown[]) => unknown;

/** A stand-in for McpServer that only remembers the handlers registered through it. */
function stubServer(): { server: McpServer; handlers: Record<string, Handler> } {
    const handlers: Record<string, Handler> = {};
    const server = {
        registerTool: (name: string, _config: unknown, cb: Handler) => {
            handlers[name] = cb;
            return undefined;
        },
    } as unknown as McpServer;
    return { server, handlers };
}

export default async () => {
    await describe('assistant write guard', async () => {
        let dir = '';
        let logPath = '';

        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'write-guard-test-'));
            logPath = join(dir, 'data', CHANGE_LOG_FILE);
        });
        afterEach(() => {
            rmSync(dir, { recursive: true, force: true });
        });

        const lines = (): ChangeLogEntry[] =>
            existsSync(logPath)
                ? readFileSync(logPath, 'utf-8')
                      .split('\n')
                      .filter(Boolean)
                      .map((l) => JSON.parse(l) as ChangeLogEntry)
                : [];

        function setup(backup: () => void) {
            const { server, handlers } = stubServer();
            guardAssistantWrites(server, { session: 'ses_test', gate: new SessionBackupGate(backup), logPath });
            const ok = { content: [{ type: 'text', text: '{}' }] };
            server.registerTool(
                'beispiel_schreiben',
                { annotations: { readOnlyHint: false }, inputSchema: {} } as never,
                (async () => ok) as never,
            );
            server.registerTool(
                'beispiel_lesen',
                { annotations: { readOnlyHint: true }, inputSchema: {} } as never,
                (async () => ok) as never,
            );
            return handlers;
        }

        await it('snapshots before the first write and not before the second', async () => {
            let snapshots = 0;
            const h = setup(() => {
                snapshots++;
            });
            await h.beispiel_schreiben({ betrag: 1 }, {});
            await h.beispiel_schreiben({ betrag: 2 }, {});
            expect(snapshots).toBe(1);
            expect(lines().map((l) => l.outcome)).toStrictEqual(['ok', 'ok']);
        });

        await it('a failing snapshot declines the write and blocks the session without an override', async () => {
            let attempts = 0;
            let ran = 0;
            const { server, handlers } = stubServer();
            guardAssistantWrites(server, {
                session: 'ses_test',
                logPath,
                gate: new SessionBackupGate(() => {
                    attempts++;
                    throw new Error('disk full');
                }),
            });
            server.registerTool(
                'beispiel_schreiben',
                { annotations: { readOnlyHint: false } } as never,
                (async () => {
                    ran++;
                    return { content: [] };
                }) as never,
            );
            const first = (await handlers.beispiel_schreiben({})) as { isError?: boolean; content: { text: string }[] };
            const second = (await handlers.beispiel_schreiben({})) as { isError?: boolean };
            expect(first.isError).toBe(true);
            expect(first.content[0].text.includes('disk full')).toBe(true);
            expect(second.isError).toBe(true);
            expect(ran).toBe(0);
            expect(attempts).toBe(1);
            expect(lines().map((l) => l.outcome)).toStrictEqual(['declined', 'declined']);
        });

        await it('writes one line of time, session, tool, outcome and field names — mode 0600, no values', async () => {
            const h = setup(() => {});
            await h.beispiel_schreiben({ betrag: 123456, notiz: 'geheim' }, {});
            const [entry] = lines();
            expect(Object.keys(entry).sort()).toStrictEqual(['fields', 'outcome', 'session', 'time', 'tool']);
            expect(entry.session).toBe('ses_test');
            expect(entry.tool).toBe('beispiel_schreiben');
            expect(entry.fields).toStrictEqual(['betrag', 'notiz']);
            expect(Number.isNaN(Date.parse(entry.time))).toBe(false);
            const raw = readFileSync(logPath, 'utf-8');
            expect(raw.includes('123456') || raw.includes('geheim')).toBe(false);
            expect(statSync(logPath).mode & 0o777).toBe(0o600);
        });

        await it('logs a tool error result as an error and a throw as an error', async () => {
            const { server, handlers } = stubServer();
            guardAssistantWrites(server, { session: 's', logPath, gate: new SessionBackupGate(() => {}) });
            server.registerTool(
                'a',
                { annotations: { readOnlyHint: false } } as never,
                (async () => ({ isError: true })) as never,
            );
            server.registerTool(
                'b',
                { annotations: { readOnlyHint: false } } as never,
                (async () => {
                    throw new Error('boom');
                }) as never,
            );
            await handlers.a({});
            let threw = false;
            try {
                await handlers.b({});
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);
            expect(lines().map((l) => l.outcome)).toStrictEqual(['error', 'error']);
        });

        await it('logs and snapshots nothing for a read tool', async () => {
            let snapshots = 0;
            const h = setup(() => {
                snapshots++;
            });
            await h.beispiel_lesen({}, {});
            expect(snapshots).toBe(0);
            expect(existsSync(logPath)).toBe(false);
        });

        await it('takes the change log into the backup', async () => {
            const ws = join(dir, 'ws');
            const store = join(ws, 'transactions-data');
            mkdirSync(store, { recursive: true });
            writeFileSync(join(ws, 'steuererklaerung.json'), '{"version":1,"entities":[]}');
            const sources: BackupSources = {
                manifestPath: join(ws, 'steuererklaerung.json'),
                storeDir: store,
                ledgerPath: join(store, 'ledger.db'),
            };
            const prev = process.env.XDG_DATA_HOME;
            process.env.XDG_DATA_HOME = join(dir, 'xdg');
            try {
                const h = setup(() => {});
                await h.beispiel_schreiben({}, {});
                mkdirSync(join(dir, 'xdg', 'steuererklaerung'), { recursive: true });
                writeFileSync(join(dir, 'xdg', 'steuererklaerung', CHANGE_LOG_FILE), readFileSync(logPath));
                const { path, meta } = createBackup({ root: join(dir, 'b'), sources, lockPath: join(dir, 'lock') });
                expect(meta.files.includes(CHANGE_LOG_FILE)).toBe(true);
                expect(statSync(join(path, CHANGE_LOG_FILE)).mode & 0o777).toBe(0o600);
            } finally {
                if (prev === undefined) delete process.env.XDG_DATA_HOME;
                else process.env.XDG_DATA_HOME = prev;
            }
        });
    });
};
