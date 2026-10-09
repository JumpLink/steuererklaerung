import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    addProject,
    formalityFromArg,
    getProject,
    listProjects,
    matchProjectByName,
    removeProject,
    resolveScheduleProject,
    setScheduleProject,
    slugForProject,
    suggestProjects,
    updateProject,
} from '../../../src/core/actions/projects.ts';
import {
    addTimeEntry,
    assignTimeProject,
    importTimeRows,
    listTime,
    type LegacyTimeRow,
    projectsForContact,
    resolveTimeProject,
    timeProjectLabel,
} from '../../../src/core/actions/time.ts';
import { buildCreateInput } from '../../../src/core/actions/recurring-invoices.ts';
import {
    findProjectLinkErrors,
    loadManifest,
    loadRecurringInvoices,
    type Project,
    type RecurringInvoice,
} from '../../../src/core/config/index.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

const CUSTOMERS = new Set(['c_beispiel', 'c_muster']);

const schedule = (over: Record<string, unknown> = {}) => ({
    id: 'beispiel-hosting',
    customer: { name: 'Beispiel GmbH', contactId: 'c_beispiel' },
    domains: ['beispiel.de'],
    nextPeriod: { start: '2026-01-01', end: '2026-12-31' },
    items: [{ title: 'Hosting', unitPrice: 108 }],
    ...over,
});

const project = (over: Partial<Project> = {}): Project => ({
    id: 'beispiel-website',
    name: 'Website Relaunch',
    contactId: 'c_beispiel',
    domains: ['beispiel.de'],
    ...over,
});

export default async () => {
    await describe('Projekt-Konsistenz (Schema)', async () => {
        let dir = '';
        let path = '';
        const write = (entity: Record<string, unknown>) => {
            ({ dir, path } = writeManifestFixture({ entities: [{ id: 'muster', ...entity }] }));
        };
        afterEach(async () => {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        });

        await it('lässt eine Alt-Config ohne Projekte unverändert gültig', () => {
            write({ recurring: [schedule()] });
            const manifest = loadManifest(path);
            expect(manifest.entities[0].projects).toBe(undefined);
            expect(loadRecurringInvoices(path)[0].projectId).toBe(undefined);
        });

        await it('lehnt eine projectId ab, die auf kein Projekt zeigt', () => {
            write({ projects: [project()], recurring: [schedule({ projectId: 'gibt-es-nicht' })] });
            let message = '';
            try {
                loadManifest(path);
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message.includes('gibt-es-nicht')).toBe(true);
            expect(message.includes('existiert nicht')).toBe(true);
        });

        await it('lehnt ein Projekt eines anderen Kunden ab', () => {
            write({
                projects: [project({ contactId: 'c_muster' })],
                recurring: [schedule({ projectId: 'beispiel-website' })],
            });
            let message = '';
            try {
                loadManifest(path);
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message.includes('anderen Kunden')).toBe(true);
        });

        await it('verlangt für einen Vertrag mit Projekt einen Kunden-Kontakt', () => {
            const errors = findProjectLinkErrors(
                [project()],
                [{ id: 'ohne-kontakt', projectId: 'beispiel-website', customer: {} }],
            );
            expect(errors.length).toBe(1);
            expect(errors[0].includes('customer.contactId')).toBe(true);
        });

        await it('meldet doppelte Projekt-Ids', () => {
            expect(findProjectLinkErrors([project(), project()], []).length).toBe(1);
        });

        await it('erlaubt mehrere Verträge an einem Projekt', () => {
            write({
                projects: [project()],
                recurring: [
                    schedule({ projectId: 'beispiel-website' }),
                    schedule({ id: 'beispiel-domain', projectId: 'beispiel-website' }),
                ],
            });
            const ids = loadRecurringInvoices(path).map((s) => s.projectId);
            expect(ids).toStrictEqual(['beispiel-website', 'beispiel-website']);
        });
    });

    await describe('Projekt-Aktionen', async () => {
        let dir = '';
        let path = '';
        beforeEach(async () => {
            ({ dir, path } = writeManifestFixture({
                entities: [
                    {
                        id: 'muster',
                        recurring: [
                            schedule(),
                            schedule({ id: 'muster-hosting', customer: { name: 'Muster AG', contactId: 'c_muster' } }),
                        ],
                    },
                ],
            }));
        });
        afterEach(async () => {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        });
        const opts = () => ({ path, contactIds: CUSTOMERS });

        await it('legt ein Projekt an, mit Slug aus dem Namen und bereinigten Domains', () => {
            const p = addProject(
                'muster',
                {
                    name: 'Website Relaunch',
                    contactId: 'c_beispiel',
                    domains: [' Beispiel.DE ', 'beispiel.de', ''],
                    contactPerson: { greeting: 'Silke' },
                },
                opts(),
            );
            expect(p.id).toBe('website-relaunch');
            expect(p.domains).toStrictEqual(['beispiel.de']);
            expect(listProjects('muster', { path }).length).toBe(1);
            expect(getProject('muster', 'website-relaunch', { path }).contactPerson?.greeting).toBe('Silke');
        });

        await it('vergibt bei gleichem Namen eine freie Id statt abzubrechen', () => {
            addProject('muster', { name: 'Website', contactId: 'c_beispiel' }, opts());
            expect(addProject('muster', { name: 'Website', contactId: 'c_beispiel' }, opts()).id).toBe('website-2');
        });

        await it('verweigert einen unbekannten Kunden und eine doppelte eigene Id', () => {
            let message = '';
            try {
                addProject('muster', { name: 'X', contactId: 'c_fremd' }, opts());
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message.includes('c_fremd')).toBe(true);
            addProject('muster', { id: 'p1', name: 'A', contactId: 'c_beispiel' }, opts());
            let dup = '';
            try {
                addProject('muster', { id: 'p1', name: 'B', contactId: 'c_beispiel' }, opts());
            } catch (err) {
                dup = (err as Error).message;
            }
            expect(dup.includes('vergeben')).toBe(true);
        });

        await it('schreibt bei --dry-run nichts', () => {
            addProject('muster', { name: 'Website', contactId: 'c_beispiel' }, { ...opts(), dryRun: true });
            expect(listProjects('muster', { path }).length).toBe(0);
            expect(readFileSync(path, 'utf8').includes('projects')).toBe(false);
        });

        await it('ändert nur angegebene Felder und leert eine Kontaktperson mit null', () => {
            addProject(
                'muster',
                {
                    id: 'p1',
                    name: 'A',
                    contactId: 'c_beispiel',
                    contactPerson: { greeting: 'Silke', formality: 'sie' },
                    notes: 'x',
                },
                opts(),
            );
            const changed = updateProject('muster', 'p1', { name: 'B', contactPerson: { greeting: null } }, opts());
            expect(changed.name).toBe('B');
            expect(changed.contactPerson).toStrictEqual({ formality: 'sie' });
            expect(changed.notes).toBe('x');
            const cleared = updateProject('muster', 'p1', { contactPerson: { formality: null }, notes: null }, opts());
            expect(cleared.contactPerson).toBe(undefined);
            expect(cleared.notes).toBe(undefined);
        });

        await it('setzt die Anredeform mit inherit auf „wie im Vertrag" zurück', () => {
            addProject(
                'muster',
                {
                    id: 'p1',
                    name: 'A',
                    contactId: 'c_beispiel',
                    contactPerson: { greeting: 'Silke', formality: 'sie' },
                },
                opts(),
            );
            expect(formalityFromArg(undefined)).toBe(undefined);
            expect(formalityFromArg('sie')).toBe('sie');
            expect(formalityFromArg('inherit')).toBe(null);
            let message = '';
            try {
                formalityFromArg('none');
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message.includes('unbekannt')).toBe(true);
            // Only the form goes; the greeting stays.
            const reset = updateProject(
                'muster',
                'p1',
                { contactPerson: { formality: formalityFromArg('inherit') } },
                opts(),
            );
            expect(reset.contactPerson).toStrictEqual({ greeting: 'Silke' });
            // The reset is what the file holds, not just the returned object.
            expect(getProject('muster', 'p1', { path }).contactPerson).toStrictEqual({ greeting: 'Silke' });
        });

        await it('hängt einen Vertrag an ein Projekt und löst ihn wieder', () => {
            addProject('muster', { id: 'p1', name: 'A', contactId: 'c_beispiel' }, opts());
            setScheduleProject('muster', 'beispiel-hosting', 'p1', { path });
            expect(loadRecurringInvoices(path).find((s) => s.id === 'beispiel-hosting')?.projectId).toBe('p1');
            setScheduleProject('muster', 'beispiel-hosting', null, { path });
            expect(loadRecurringInvoices(path).find((s) => s.id === 'beispiel-hosting')?.projectId).toBe(undefined);
        });

        await it('weigert sich, einen Vertrag an das Projekt eines anderen Kunden zu hängen — und schreibt nichts', () => {
            addProject('muster', { id: 'p1', name: 'A', contactId: 'c_beispiel' }, opts());
            const before = readFileSync(path, 'utf8');
            let message = '';
            try {
                setScheduleProject('muster', 'muster-hosting', 'p1', { path });
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message.includes('anderen Kunden')).toBe(true);
            expect(readFileSync(path, 'utf8')).toBe(before);
            let unknown = '';
            try {
                setScheduleProject('muster', 'beispiel-hosting', 'nope', { path });
            } catch (err) {
                unknown = (err as Error).message;
            }
            expect(unknown.includes('existiert nicht')).toBe(true);
        });

        await it('verweigert das Löschen, solange ein Vertrag am Projekt hängt', () => {
            addProject('muster', { id: 'p1', name: 'A', contactId: 'c_beispiel' }, opts());
            setScheduleProject('muster', 'beispiel-hosting', 'p1', { path });
            let message = '';
            try {
                removeProject('muster', 'p1', { path });
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message.includes('beispiel-hosting')).toBe(true);
            setScheduleProject('muster', 'beispiel-hosting', null, { path });
            removeProject('muster', 'p1', { path });
            expect(listProjects('muster', { path }).length).toBe(0);
        });

        await it('verweigert den Kundenwechsel eines Projekts mit Vertrag', () => {
            addProject('muster', { id: 'p1', name: 'A', contactId: 'c_beispiel' }, opts());
            setScheduleProject('muster', 'beispiel-hosting', 'p1', { path });
            let message = '';
            try {
                updateProject('muster', 'p1', { contactId: 'c_muster' }, opts());
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message.includes('anderen Kunden')).toBe(true);
            expect(getProject('muster', 'p1', { path }).contactId).toBe('c_beispiel');
        });
    });

    await describe('Anschreiben aus dem Projekt (buildCreateInput)', async () => {
        let dir = '';
        let path = '';
        const prevLedger = process.env.LEDGER_DB_PATH;
        const setup = (projects: unknown[], recurring: unknown[]) => {
            ({ dir, path } = writeManifestFixture({
                entities: [
                    {
                        id: 'muster',
                        invoicing: {
                            type: 'self',
                            defaultHeader: 'Hallo {anrede},\n\n{gruss}',
                            defaultHeaderSie: 'Guten Tag {anrede},\n\n{gruss}',
                        },
                        projects,
                        recurring,
                    },
                ],
            }));
            process.env.LEDGER_DB_PATH = `${dir}/ledger.db`;
        };
        afterEach(async () => {
            if (prevLedger === undefined) delete process.env.LEDGER_DB_PATH;
            else process.env.LEDGER_DB_PATH = prevLedger;
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        });
        const inv = (): RecurringInvoice => loadRecurringInvoices(path)[0];

        await it('nimmt Anrede und Sie vom Projekt, sobald der Vertrag daran hängt', () => {
            setup(
                [project({ contactPerson: { greeting: 'Frau Muster', formality: 'sie' } })],
                [
                    schedule({
                        projectId: 'beispiel-website',
                        customer: { name: 'Beispiel GmbH', contactId: 'c_beispiel', greeting: 'Alt', formality: 'du' },
                    }),
                ],
            );
            const built = buildCreateInput(inv(), { path, today: '2026-02-01' });
            expect(built.input.header).toBe('Guten Tag Frau Muster,\n\nMit freundlichen Grüßen');
            expect(built.addressing.greetingFrom).toBe('project');
            expect(built.headerWarnings).toStrictEqual([]);
        });

        await it('fällt auf den Vertrag zurück, wenn das Projekt keine Kontaktperson hat', () => {
            setup(
                [project()],
                [
                    schedule({
                        projectId: 'beispiel-website',
                        customer: { name: 'Beispiel GmbH', contactId: 'c_beispiel', greeting: 'Markus' },
                    }),
                ],
            );
            const built = buildCreateInput(inv(), { path, today: '2026-02-01' });
            expect(built.input.header).toBe('Hallo Markus,\n\nBeste Grüße');
            expect(built.addressing.greetingFrom).toBe('contract');
        });

        await it('rendert einen Vertrag ohne Projekt wie bisher', () => {
            setup([], [schedule({ customer: { name: 'Beispiel GmbH', contactId: 'c_beispiel', greeting: 'Markus' } })]);
            const built = buildCreateInput(inv(), { path, today: '2026-02-01' });
            expect(built.input.header).toBe('Hallo Markus,\n\nBeste Grüße');
        });

        await it('bricht bei einem kaputten Verweis ab, statt eine fremde Anrede zu setzen', () => {
            setup([project()], [schedule({ projectId: 'beispiel-website' })]);
            // Break the link after the fact, as a stale in-memory schedule would: the renderer must refuse.
            const broken = { ...inv(), projectId: 'weg' };
            let message = '';
            try {
                buildCreateInput(broken, { path });
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message.includes('weg')).toBe(true);
        });

        await it('löst den Vertrag pur gegen die Projektliste auf', () => {
            const s = { id: 's', projectId: 'beispiel-website', customer: { name: 'B', contactId: 'c_beispiel' } };
            expect(resolveScheduleProject(s, [project()])?.id).toBe('beispiel-website');
            expect(resolveScheduleProject({ ...s, projectId: undefined }, [project()])).toBe(undefined);
            let message = '';
            try {
                resolveScheduleProject({ ...s, customer: { name: 'B', contactId: 'c_muster' } }, [project()]);
            } catch (err) {
                message = (err as Error).message;
            }
            expect(message.includes('anderen Kunden')).toBe(true);
        });
    });

    await describe('Zeit-Labels und Vorschläge', async () => {
        const projects = [
            project(),
            project({ id: 'beispiel-shop', name: 'Shop', domains: ['shop.beispiel.de'] }),
            project({ id: 'muster-seite', name: 'Musterseite', contactId: 'c_muster', domains: [] }),
        ];

        await it('ordnet ein Label eindeutig zu, sonst gar nicht', () => {
            expect(matchProjectByName('website relaunch', projects)?.id).toBe('beispiel-website');
            expect(matchProjectByName('Musterseite Phase 2', projects)?.id).toBe('muster-seite');
            expect(matchProjectByName('Unbekannt', projects)).toBe(null);
            expect(matchProjectByName('', projects)).toBe(null);
            // "e" is inside several names: ambiguous, so unassigned rather than guessed.
            expect(matchProjectByName('e', projects)).toBe(null);
        });

        await it('bevorzugt den gleichen Namen vor einem Teiltreffer und engt auf den Kunden ein', () => {
            const more = [...projects, project({ id: 'beispiel-shop-2', name: 'Shop Relaunch' })];
            expect(matchProjectByName('Shop', more)?.id).toBe('beispiel-shop');
            expect(matchProjectByName('Musterseite', projects, 'c_beispiel')).toBe(null);
        });

        await it('bildet Slugs ohne Umlaute und nie leer', () => {
            expect(slugForProject('Müller Größe')).toBe('mueller-groesse');
            expect(slugForProject('———')).toBe('projekt');
        });

        await it('schlägt pro Kunde und Domain-Gruppe ein Projekt vor und legt nichts an', () => {
            const schedules = [
                schedule({
                    id: 'hosting',
                    domains: ['Beispiel.de'],
                    customer: { name: 'Beispiel GmbH', contactId: 'c_beispiel', greeting: 'Silke', formality: 'sie' },
                }),
                schedule({ id: 'domain', domains: ['beispiel.de', 'beispiel.com'] }),
                schedule({
                    id: 'andere',
                    domains: ['muster.de'],
                    customer: { name: 'Muster AG', contactId: 'c_muster' },
                }),
                schedule({ id: 'ohne-domain', domains: [] }),
                schedule({ id: 'gekuendigt', status: 'cancelled' }),
                schedule({ id: 'ohne-kontakt', domains: ['x.de'], customer: { name: 'X' } }),
            ].map((s) => ({
                entityId: 'muster',
                status: 'active',
                intervalMonths: 12,
                reminderLeadDays: 28,
                currency: 'EUR',
                ...s,
            })) as unknown as RecurringInvoice[];
            const out = suggestProjects(schedules, []);
            expect(out.suggestions.length).toBe(2);
            const [first, second] = out.suggestions;
            expect(first.kind).toBe('new');
            expect(first.scheduleIds).toStrictEqual(['hosting', 'domain']);
            expect(first.project.domains).toStrictEqual(['beispiel.de', 'beispiel.com']);
            // The contract's greeting travels along, so adopting the proposal changes no letter.
            expect(first.project.contactPerson).toStrictEqual({ greeting: 'Silke', formality: 'sie' });
            expect(second.scheduleIds).toStrictEqual(['andere']);
            expect(out.skipped.map((s) => s.scheduleId)).toStrictEqual(['ohne-kontakt']);
        });

        await it('verweist auf ein bestehendes Projekt statt ein doppeltes vorzuschlagen', () => {
            const schedules = [schedule({ id: 'hosting', domains: ['beispiel.de'] })].map((s) => ({
                entityId: 'muster',
                status: 'active',
                intervalMonths: 12,
                reminderLeadDays: 28,
                currency: 'EUR',
                ...s,
            })) as unknown as RecurringInvoice[];
            const out = suggestProjects(schedules, [project()]);
            expect(out.suggestions.length).toBe(1);
            expect(out.suggestions[0].kind).toBe('existing');
            expect(out.suggestions[0].project.id).toBe('beispiel-website');
            // Already attached contracts are not proposed again.
            expect(
                suggestProjects([{ ...schedules[0], projectId: 'beispiel-website' }], [project()]).suggestions.length,
            ).toBe(0);
        });
    });

    await describe('Zeit-Import mit Projekten', async () => {
        let dir = '';
        const prevLedger = process.env.LEDGER_DB_PATH;
        beforeEach(async () => {
            dir = mkdtempSync(join(tmpdir(), 'bh-projects-time-'));
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
        });
        afterEach(async () => {
            if (prevLedger === undefined) delete process.env.LEDGER_DB_PATH;
            else process.env.LEDGER_DB_PATH = prevLedger;
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        });
        const row = (project: string, externalId: string): LegacyTimeRow => ({
            project,
            startedAt: '2026-07-15T15:00:00.000Z',
            endedAt: '2026-07-15T16:00:00.000Z',
            description: '',
            externalId,
            billed: false,
        });

        await it('setzt projectId und Kunde bei einem Treffer und listet Unbekanntes weiter auf', () => {
            const projects = [project()];
            const result = importTimeRows(
                'muster',
                [row('Website Relaunch Phase 2', 'e1'), row('Etwas ganz anderes', 'e2')],
                () => null,
                (label) => matchProjectByName(label, projects),
            );
            expect(result.imported).toBe(2);
            // No project is created by an import; the unknown label is only reported.
            expect(result.unmatchedProjects).toStrictEqual(['Etwas ganz anderes']);
            const entries = listTime({ entityId: 'muster' });
            const hit = entries.find((e) => e.externalId === 'e1');
            expect(hit?.projectId).toBe('beispiel-website');
            expect(hit?.contactId).toBe('c_beispiel');
            expect(hit?.project).toBe('Website Relaunch');
            expect(hit?.note).toBe('Import-Label: Website Relaunch Phase 2');
            const miss = entries.find((e) => e.externalId === 'e2');
            expect(miss?.projectId).toBe(null);
            expect(miss?.project).toBe('Etwas ganz anderes');
        });

        await it('importiert ohne Projekte wie bisher', () => {
            const result = importTimeRows('muster', [row('Nordwerk', 'e3')], () => 'c_nordwerk');
            expect(result.unmatchedProjects).toStrictEqual([]);
            const [entry] = listTime({ entityId: 'muster' });
            expect(entry.projectId).toBe(null);
            expect(entry.contactId).toBe('c_nordwerk');
            expect(entry.note).toBe(null);
        });
    });

    await describe('Zeiteinträge und Projekte', async () => {
        let dir = '';
        let manifestDir = '';
        const prevLedger = process.env.LEDGER_DB_PATH;
        const prevWorkspace = process.env.STEUER_WORKSPACE;
        const alpha = project({ id: 'alpha-site', name: 'Alpha Site', contactId: 'c_beispiel' });
        const beta = project({ id: 'beta-shop', name: 'Beta Shop', contactId: 'c_muster' });
        beforeEach(async () => {
            dir = mkdtempSync(join(tmpdir(), 'bh-time-projects-'));
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
            const fixture = writeManifestFixture({ entities: [{ id: 'muster', projects: [alpha, beta] }] });
            manifestDir = fixture.dir;
            process.env.STEUER_WORKSPACE = fixture.path;
        });
        afterEach(async () => {
            if (prevLedger === undefined) delete process.env.LEDGER_DB_PATH;
            else process.env.LEDGER_DB_PATH = prevLedger;
            if (prevWorkspace === undefined) delete process.env.STEUER_WORKSPACE;
            else process.env.STEUER_WORKSPACE = prevWorkspace;
            for (const d of [dir, manifestDir]) {
                try {
                    rmSync(d, { recursive: true, force: true });
                } catch {
                    /* best-effort */
                }
            }
        });
        const entry = (over: Record<string, unknown> = {}) =>
            addTimeEntry({
                entityId: 'muster',
                project: 'Freies Label',
                startedAt: '2026-07-15T15:00:00.000Z',
                endedAt: '2026-07-15T16:00:00.000Z',
                ...over,
            });

        await it('löst Id und Namen auf und lässt ein freies Label stehen', () => {
            expect(resolveTimeProject('muster', 'beta-shop')).toStrictEqual({
                project: 'Beta Shop',
                projectId: 'beta-shop',
                contactId: 'c_muster',
            });
            expect(resolveTimeProject('muster', 'alpha site').projectId).toBe('alpha-site');
            expect(resolveTimeProject('muster', 'Etwas anderes', 'c_x')).toStrictEqual({
                project: 'Etwas anderes',
                projectId: null,
                contactId: 'c_x',
            });
        });

        await it('lehnt einen Kunden ab, der nicht zum Projekt passt', () => {
            let message = '';
            try {
                resolveTimeProject('muster', 'beta-shop', 'c_beispiel');
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message.includes('gehört zu Kontakt c_muster')).toBe(true);
        });

        await it('bietet je Kunde nur dessen Projekte an, ohne Kunden alle', () => {
            expect(projectsForContact([alpha, beta], 'c_muster').map((p) => p.id)).toStrictEqual(['beta-shop']);
            expect(projectsForContact([alpha, beta], null).map((p) => p.id)).toStrictEqual(['alpha-site', 'beta-shop']);
        });

        await it('zeigt den aktuellen Projektnamen, sonst das gespeicherte Label', () => {
            expect(timeProjectLabel({ project: 'Alt', projectId: 'alpha-site' }, [alpha])).toBe('Alpha Site');
            expect(timeProjectLabel({ project: 'Alt', projectId: 'weg' }, [alpha])).toBe('Alt');
            expect(timeProjectLabel({ project: 'Alt', projectId: null }, [alpha])).toBe('Alt');
        });

        await it('ordnet einen Eintrag einem Projekt zu und nimmt ihn wieder heraus', () => {
            const e = entry();
            const assigned = assignTimeProject(e.id, 'alpha-site');
            expect(assigned.projectId).toBe('alpha-site');
            expect(assigned.project).toBe('Alpha Site');
            expect(assigned.contactId).toBe('c_beispiel');
            const [stored] = listTime({ entityId: 'muster' });
            expect(stored.projectId).toBe('alpha-site');
            const cleared = assignTimeProject(e.id, null);
            expect(cleared.projectId).toBe(null);
            // Taking the link off keeps the label and the customer.
            expect(cleared.project).toBe('Alpha Site');
            expect(cleared.contactId).toBe('c_beispiel');
        });

        await it('verweigert ein Projekt eines anderen Kunden, ein unbekanntes und einen abgerechneten Eintrag', () => {
            const messageOf = (fn: () => void): string => {
                try {
                    fn();
                } catch (err) {
                    return err instanceof Error ? err.message : String(err);
                }
                return '';
            };
            const owned = entry({ contactId: 'c_beispiel' });
            expect(messageOf(() => assignTimeProject(owned.id, 'beta-shop')).includes('nicht zu c_beispiel')).toBe(
                true,
            );
            expect(messageOf(() => assignTimeProject(owned.id, 'gibt-es-nicht')).includes('gibt es')).toBe(true);
            const billed = entry({ invoiceId: 'inv-1' });
            expect(messageOf(() => assignTimeProject(billed.id, 'alpha-site')).includes('Rechnung')).toBe(true);
            expect(listTime({ entityId: 'muster' }).find((x) => x.id === owned.id)?.projectId).toBe(null);
        });
    });
};
