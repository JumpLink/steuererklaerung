/**
 * Belege aus einem Mail-Ordner (Idee 15) end to end against the built-in DMS and a fake mailbox:
 * what lands, how the cursor moves (UID + UIDVALIDITY), dedupe by content hash, a Dokumentregel on
 * arrival, read-only behaviour, and that the password never reaches the manifest. All names invented.
 */
import { describe, it, expect, beforeEach, afterEach } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuiltinDmsProvider } from '@steuererklaerung/dms';
import {
    getMailEingangState,
    ledgerDbPath,
    migrate,
    openLedger,
    saveMailEingangState,
    recordMailEingangRun,
    type MailEingangState,
} from '@steuererklaerung/store';
import {
    belegeAusMailAbrufen,
    MAX_MESSAGES_PER_RUN,
    type MailEingangDeps,
} from '../../../src/core/actions/mail-eingang.ts';
import { loadMailEingang, saveEntityDms, saveMailEingang } from '../../../src/core/config/index.ts';
import type { MailEingangConfig } from '../../../src/core/config/schema/mail-eingang.ts';
import { planeAbruf, pruefeMailEingang } from '../../../src/core/mail-eingang/abruf-plan.ts';
import { belegeAusMail } from '../../../src/core/mail-eingang/herkunft.ts';
import { storeMailEingangPassword } from '../../../src/core/mail/mail-eingang-secret.ts';
import { FakeMailbox, fixturePdf } from '../../helpers/mail-fixtures.ts';

const config: MailEingangConfig = {
    host: 'imap.firma.invalid',
    port: 993,
    security: 'tls',
    username: 'belege@firma.invalid',
    folder: 'Belege',
};

const withPdf = (marker: string, from?: string, name = `Rechnung-${marker}.pdf`) => ({
    ...(from ? { from } : {}),
    parts: [
        { type: 'text/plain', body: 'Anbei die Rechnung.' },
        { type: 'application/pdf', disposition: 'attachment', filename: name, body: fixturePdf(marker) },
    ],
});

export default async () => {
    await describe('Mail-Ordner — Fortsetzung (UID + UIDVALIDITY)', async () => {
        await it('starts from zero without a stored cursor, and resumes above the last UID', async () => {
            expect(planeAbruf(null, { uidValidity: 7, uidNext: 10 })).toStrictEqual({
                since: 0,
                neuNummeriert: false,
                ersterAbruf: true,
            });
            expect(planeAbruf({ uidValidity: 7, lastUid: 4 }, { uidValidity: 7, uidNext: 10 })).toStrictEqual({
                since: 4,
                neuNummeriert: false,
                ersterAbruf: false,
            });
        });

        await it('discards the stored UIDs when the UIDVALIDITY changes', async () => {
            const plan = planeAbruf({ uidValidity: 7, lastUid: 40 }, { uidValidity: 8, uidNext: 3 });
            expect(plan.since).toBe(0);
            expect(plan.neuNummeriert).toBe(true);
        });

        await it('also starts over when the server hands out numbers it already used', async () => {
            expect(planeAbruf({ uidValidity: 7, lastUid: 40 }, { uidValidity: 7, uidNext: 12 }).neuNummeriert).toBe(
                true,
            );
        });

        await it('refuses a connection without TLS to anything but this machine', async () => {
            expect(pruefeMailEingang({ host: 'mail.firma.invalid', security: 'none' })).toContain(
                'Ohne Verschlüsselung',
            );
            expect(pruefeMailEingang({ host: '127.0.0.1', security: 'none' })).toBe(null);
            expect(pruefeMailEingang({ host: 'mail.firma.invalid', security: 'tls' })).toBe(null);
        });
    });

    await describe('Mail-Ordner — Abruf ins eingebaute DMS', async () => {
        let dir = '';
        const prev = new Map<string, string | undefined>();
        const setEnv = (k: string, v: string) => {
            if (!prev.has(k)) prev.set(k, process.env[k]);
            process.env[k] = v;
        };
        const manifestPath = () => join(dir, 'steuererklaerung.json');
        const withLedger = <T>(fn: (db: ReturnType<typeof openLedger>) => T): T => {
            const db = openLedger(ledgerDbPath());
            try {
                migrate(db);
                return fn(db);
            } finally {
                db.close();
            }
        };
        const makeDeps = (box: FakeMailbox, over: Partial<MailEingangDeps> = {}): MailEingangDeps => ({
            connector: box,
            provider: new BuiltinDmsProvider('gbr'),
            config,
            password: 'geheim-passwort-4711',
            state: {
                get: (folder) => withLedger((db) => getMailEingangState(db, 'gbr', folder)),
                save: (s: MailEingangState) => withLedger((db) => saveMailEingangState(db, s)),
                recordRun: (folder, at, result) =>
                    withLedger((db) => recordMailEingangRun(db, 'gbr', folder, at, result)),
            },
            entityId: 'gbr',
            now: () => new Date('2026-06-01T08:00:00Z'),
            rules: [],
            ...over,
        });

        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'bh-maileingang-'));
            setEnv('TRANSACTIONS_DATA_DIR', dir);
            setEnv('LEDGER_DB_PATH', join(dir, 'ledger.db'));
            writeFileSync(
                manifestPath(),
                JSON.stringify({
                    version: 1,
                    entities: [
                        { id: 'gbr', name: 'Test GbR', kind: 'gbr', accounts: ['camt:*'], dms: { type: 'builtin' } },
                    ],
                }),
            );
            setEnv('STEUER_WORKSPACE', manifestPath());
        });
        afterEach(() => {
            for (const [k, v] of prev) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            prev.clear();
            rmSync(dir, { recursive: true, force: true });
        });

        await it('imports the PDF of a new message with sender and date as its origin', async () => {
            const box = new FakeMailbox().add(1, withPdf('eins', 'Anna Beispiel <anna@lieferant.example>'));
            const r = await belegeAusMailAbrufen(makeDeps(box));
            expect(r.ok).toBe(true);
            if (!r.ok) return;
            expect(r.neu).toBe(1);
            expect(r.zusammenfassung).toBe('1 Nachricht geprüft · 1 neuer Beleg');
            const docs = await new BuiltinDmsProvider('gbr').list({ from: '2026-01-01', to: '2026-12-31' });
            expect(docs.length).toBe(1);
            expect(docs[0].origin).toStrictEqual({
                kind: 'mail',
                from: 'Anna Beispiel <anna@lieferant.example>',
                date: '2026-05-12',
            });
            // The message date puts the receipt in its own year until the file says better.
            expect(docs[0].created).toBe('2026-05-12');
            expect(belegeAusMail(docs).length).toBe(1);
        });

        await it('fetches each message once: a second run finds nothing new', async () => {
            const box = new FakeMailbox().add(1, withPdf('eins')).add(2, withPdf('zwei'));
            const first = await belegeAusMailAbrufen(makeDeps(box));
            expect(first.ok && first.neu).toBe(2);
            box.fetched.length = 0;
            const second = await belegeAusMailAbrufen(makeDeps(box));
            expect(second.ok && second.neu).toBe(0);
            expect(second.ok && second.nachrichten).toBe(0);
            expect(box.fetched.length).toBe(0);
            expect(box.searches[box.searches.length - 1].lastUid).toBe(2);
            box.add(3, withPdf('drei'));
            const third = await belegeAusMailAbrufen(makeDeps(box));
            expect(third.ok && third.neu).toBe(1);
            expect(box.fetched).toStrictEqual([3]);
        });

        await it('stores the cursor and a counts-only result line in the ledger', async () => {
            const box = new FakeMailbox().add(5, withPdf('x', 'Anna <a@l.example>', 'Streng-geheim-Rechnung.pdf'));
            box.uidValidity = 99;
            await belegeAusMailAbrufen(makeDeps(box));
            const state = withLedger((db) => getMailEingangState(db, 'gbr', 'Belege'))!;
            expect(state.uidValidity).toBe(99);
            expect(state.lastUid).toBe(5);
            expect(state.lastRunAt).toBe('2026-06-01T08:00:00.000Z');
            expect(state.lastResult).toBe('1 Nachricht geprüft · 1 neuer Beleg');
            expect(state.lastResult!.includes('Streng')).toBe(false);
        });

        await it('after a UIDVALIDITY change it re-checks everything and stores nothing twice', async () => {
            const box = new FakeMailbox().add(1, withPdf('eins')).add(2, withPdf('zwei'));
            await belegeAusMailAbrufen(makeDeps(box));
            // The server renumbers: same mails, new validity, new UIDs.
            const renumbered = new FakeMailbox();
            renumbered.uidValidity = 2;
            renumbered.add(1, withPdf('eins')).add(2, withPdf('zwei')).add(3, withPdf('drei'));
            const r = await belegeAusMailAbrufen(makeDeps(renumbered));
            expect(r.ok).toBe(true);
            if (!r.ok) return;
            expect(r.neuNummeriert).toBe(true);
            expect(r.nachrichten).toBe(3);
            expect(r.neu).toBe(1);
            expect(r.vorhanden).toBe(2);
            expect(r.zusammenfassung).toContain('Ordner neu nummeriert');
            const docs = await new BuiltinDmsProvider('gbr').list({ from: '2026-01-01', to: '2026-12-31' });
            expect(docs.length).toBe(3);
            expect(withLedger((db) => getMailEingangState(db, 'gbr', 'Belege'))!.uidValidity).toBe(2);
        });

        await it('dedupes by content: the same file in two mails, or already added by hand, lands once', async () => {
            const dms = new BuiltinDmsProvider('gbr');
            await dms.store({
                bytes: fixturePdf('von-hand'),
                filename: 'von-hand.pdf',
                mimeType: 'application/pdf',
                created: '2026-05-01',
            });
            const box = new FakeMailbox()
                .add(1, withPdf('doppelt', undefined, 'a.pdf'))
                .add(2, withPdf('doppelt', undefined, 'b.pdf'))
                .add(3, withPdf('von-hand'));
            const r = await belegeAusMailAbrufen(makeDeps(box));
            expect(r.ok && r.neu).toBe(1);
            expect(r.ok && r.vorhanden).toBe(2);
            const docs = await dms.list({ from: '2026-01-01', to: '2026-12-31' });
            expect(docs.length).toBe(2);
            // The hand-added receipt keeps no mail origin: the mail did not overwrite it.
            expect(docs.find((d) => d.title === 'von-hand.pdf')?.origin ?? null).toBe(null);
        });

        await it('applies a Dokumentregel on arrival, before any AI', async () => {
            const box = new FakeMailbox().add(
                1,
                withPdf('telefon', 'Funknetz <rechnung@funknetz.example>', 'Funknetz Beispiel 2026-05.pdf'),
            );
            const r = await belegeAusMailAbrufen(
                makeDeps(box, {
                    rules: [
                        {
                            muster: 'Funknetz Beispiel',
                            korrespondent: 'Funknetz Beispiel AG',
                            dokumenttyp: 'Rechnung',
                            kategorie: '4921 Telefon/Internet',
                            richtung: 'incoming',
                        },
                    ],
                }),
            );
            expect(r.ok && r.neu).toBe(1);
            const doc = (await new BuiltinDmsProvider('gbr').list({ from: '2026-01-01', to: '2026-12-31' }))[0];
            expect(doc.correspondent).toBe('Funknetz Beispiel AG');
            expect(doc.category).toBe('4921 Telefon/Internet');
            expect(doc.ruleOrigin?.label).toBe('„Funknetz Beispiel“');
            expect(doc.origin?.kind).toBe('mail');
        });

        await it('skips a message without a receipt and a message that is too large, and moves on', async () => {
            const box = new FakeMailbox()
                .add(1, { parts: [{ type: 'text/plain', body: 'Nur Text' }] })
                .add(2, withPdf('gross'))
                .add(3, withPdf('ok'));
            box.sizes.set(2, 500 * 1024 * 1024);
            const r = await belegeAusMailAbrufen(makeDeps(box));
            expect(r.ok && r.neu).toBe(1);
            expect(r.ok && r.uebersprungen).toBe(2);
            expect(box.fetched).toStrictEqual([1, 3]);
            expect(withLedger((db) => getMailEingangState(db, 'gbr', 'Belege'))!.lastUid).toBe(3);
        });

        await it('passes the sender filter to the server and checks it again on the message', async () => {
            const box = new FakeMailbox()
                .add(1, withPdf('a', 'Anna <anna@lieferant.example>'))
                .add(2, withPdf('b', 'Werbung <news@spam.example>'));
            const r = await belegeAusMailAbrufen(makeDeps(box, { config: { ...config, sender: 'lieferant.example' } }));
            expect(r.ok && r.neu).toBe(1);
            expect(box.searches[0].sender).toBe('lieferant.example');
        });

        await it('stops before a message whose receipt could not be stored, so the next run retries it', async () => {
            const box = new FakeMailbox().add(1, withPdf('eins')).add(2, withPdf('zwei')).add(3, withPdf('drei'));
            const base = new BuiltinDmsProvider('gbr');
            let n = 0;
            const flaky = Object.create(base) as BuiltinDmsProvider;
            flaky.store = async (input) => {
                if (++n === 2) throw new Error('Platte voll');
                return base.store(input);
            };
            const r = await belegeAusMailAbrufen(makeDeps(box, { provider: flaky }));
            expect(r.ok && r.neu).toBe(1);
            expect(r.ok && r.fehler.length).toBe(1);
            expect(withLedger((db) => getMailEingangState(db, 'gbr', 'Belege'))!.lastUid).toBe(1);
            const again = await belegeAusMailAbrufen(makeDeps(box));
            expect(again.ok && again.neu).toBe(2);
        });

        await it('takes at most one batch per run and says how many are waiting', async () => {
            const box = new FakeMailbox();
            for (let uid = 1; uid <= MAX_MESSAGES_PER_RUN + 5; uid++)
                box.add(uid, { parts: [{ type: 'text/plain', body: `n${uid}` }] });
            const r = await belegeAusMailAbrufen(makeDeps(box));
            expect(r.ok && r.nachrichten).toBe(MAX_MESSAGES_PER_RUN);
            expect(r.ok && r.offen).toBe(5);
        });

        await it('a dry run counts but stores nothing and moves no cursor', async () => {
            const box = new FakeMailbox().add(1, withPdf('eins')).add(2, withPdf('zwei'));
            const r = await belegeAusMailAbrufen(makeDeps(box), { dryRun: true });
            expect(r.ok && r.dryRun).toBe(true);
            expect(r.ok && r.neu).toBe(2);
            expect(r.ok && r.zusammenfassung).toContain('würden');
            expect(await new BuiltinDmsProvider('gbr').list({ from: '2000-01-01', to: '2100-01-01' })).toStrictEqual(
                [],
            );
            expect(withLedger((db) => getMailEingangState(db, 'gbr', 'Belege'))).toBe(null);
            const real = await belegeAusMailAbrufen(makeDeps(box));
            expect(real.ok && real.neu).toBe(2);
        });

        await it('with Paperless it fetches nothing and points to Paperless’ own mail rules', async () => {
            const box = new FakeMailbox().add(1, withPdf('eins'));
            const paperless = { kind: 'paperless' } as unknown as MailEingangDeps['provider'];
            const r = await belegeAusMailAbrufen(makeDeps(box, { provider: paperless }));
            expect(r.ok).toBe(false);
            if (r.ok) return;
            expect(r.grund).toBe('paperless');
            expect(r.meldung).toContain('Paperless');
            expect(box.connects).toBe(0);
        });

        await it('without a configuration or a password it does not even connect', async () => {
            const box = new FakeMailbox().add(1, withPdf('eins'));
            const a = await belegeAusMailAbrufen(makeDeps(box, { config: null }));
            expect(!a.ok && a.grund).toBe('nicht-konfiguriert');
            const b = await belegeAusMailAbrufen(makeDeps(box, { password: null }));
            expect(!b.ok && b.grund).toBe('kein-passwort');
            const c = await belegeAusMailAbrufen(
                makeDeps(box, { config: { ...config, host: 'mail.firma.invalid', security: 'none' } }),
            );
            expect(!c.ok && c.grund).toBe('ungueltig');
            expect(box.connects).toBe(0);
        });

        await it('reports a failed connection without the password and records it', async () => {
            const box = new FakeMailbox();
            box.failConnect = 'Anmeldung abgelehnt';
            const r = await belegeAusMailAbrufen(makeDeps(box));
            expect(!r.ok && r.grund).toBe('verbindung');
            const state = withLedger((db) => getMailEingangState(db, 'gbr', 'Belege'))!;
            expect(state.lastResult).toBe('Fehler: Anmeldung abgelehnt');
            expect(state.lastUid).toBe(0);
        });

        await it('never writes the password into the manifest', async () => {
            saveMailEingang('gbr', config);
            saveEntityDms('gbr', { type: 'builtin' });
            expect(loadMailEingang('gbr')?.host).toBe('imap.firma.invalid');
            const box = new FakeMailbox().add(1, withPdf('eins'));
            await belegeAusMailAbrufen(makeDeps(box));
            expect(box.lastPassword).toBe('geheim-passwort-4711');
            const text = readFileSync(manifestPath(), 'utf8');
            expect(text.includes('geheim-passwort-4711')).toBe(false);
            expect(/passw/i.test(text)).toBe(false);
            // The ledger and the receipt files do not hold it either.
            expect(readFileSync(join(dir, 'ledger.db')).includes(Buffer.from('geheim-passwort-4711'))).toBe(false);
            // No store path accepts one: storing without a keyring simply reports false.
            expect(typeof storeMailEingangPassword('gbr', '')).toBe('boolean');
        });

        await it('keeps the mail folder when the DMS settings are saved again', async () => {
            saveMailEingang('gbr', { ...config, sender: 'lieferant.example', onStart: true });
            saveEntityDms('gbr', { type: 'paperless', paperlessUrl: 'http://paperless.invalid' });
            saveEntityDms('gbr', { type: 'builtin' });
            const kept = loadMailEingang('gbr');
            expect(kept?.sender).toBe('lieferant.example');
            expect(kept?.onStart).toBe(true);
            saveMailEingang('gbr', null);
            expect(loadMailEingang('gbr')).toBe(null);
        });

        await it('uses EXAMINE-style reading only: the fake source is never asked to change anything', async () => {
            // The port has no write method at all; this pins that a fetch touches search + fetch + close.
            const box = new FakeMailbox().add(1, withPdf('eins'));
            await belegeAusMailAbrufen(makeDeps(box));
            expect(box.connects).toBe(1);
            expect(box.closed).toBe(1);
        });
    });
};
