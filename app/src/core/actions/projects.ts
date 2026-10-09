/**
 * Projects — the reader and writer half of the per-entity `projects` block, shared by the CLI, MCP
 * and the native app.
 *
 * A project ties a customer contact, its domains and (optionally) the person the cover letters
 * address to the recurring invoices and time entries that belong together. Nothing here is
 * mandatory: a manifest without projects keeps working, and a contract or time entry without a
 * project behaves exactly as before.
 *
 * What is NOT done here on purpose: no project is ever created on its own. `importTimeRows` lists
 * unknown labels, `suggestProjects` PROPOSES projects and writes nothing — a wrong project would put
 * hours or a greeting on the wrong customer, and that is cheaper to prevent than to find.
 */

import {
    findProjectLinkErrors,
    loadProjects,
    loadRecurringInvoices,
    type Project,
    type RecurringInvoice,
    saveProjects,
    saveRecurringInvoices,
} from '../config/index.ts';
import { ConfigError } from '../lib/errors.ts';
import { listEntityContacts } from './contacts.ts';
import { uniqueScheduleId } from './recurring-schedules.ts';

/** Lower-case, letters and digits only (umlauts kept), blanks collapsed — the form labels are compared in. */
export function normalizeLabel(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9äöüß]+/g, ' ')
        .trim();
}

/**
 * Match a free-text label (a time entry's `project`) to one project by name.
 *
 * Deliberately conservative, like `matchProjectToContact`: a normalised name that is EQUAL wins;
 * otherwise a substring match in either direction counts, but only when exactly ONE project
 * matches. An ambiguous label stays unmatched rather than putting hours on the wrong project.
 * `contactId` narrows the candidates to one customer's projects.
 */
export function matchProjectByName(
    label: string,
    projects: readonly Project[],
    contactId?: string | null,
): Project | null {
    const wanted = normalizeLabel(label);
    if (!wanted) return null;
    const candidates = contactId ? projects.filter((p) => p.contactId === contactId) : projects;
    const exact = candidates.filter((p) => normalizeLabel(p.name) === wanted);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    const hits = candidates.filter((p) => {
        const name = normalizeLabel(p.name);
        return name !== '' && (name.includes(wanted) || wanted.includes(name));
    });
    return hits.length === 1 ? hits[0] : null;
}

/**
 * The project a schedule belongs to, `undefined` when it has none. Throws a readable error when the
 * link is broken (unknown project, other customer): a cover letter must not be rendered with a
 * greeting that silently belongs to somebody else.
 */
export function resolveScheduleProject(
    schedule: Pick<RecurringInvoice, 'id' | 'projectId' | 'customer'>,
    projects: readonly Project[],
): Project | undefined {
    if (!schedule.projectId) return undefined;
    const [error] = findProjectLinkErrors(projects, [schedule]);
    if (error) throw new Error(error);
    return projects.find((p) => p.id === schedule.projectId);
}

/** `Musterkunde Website` → `musterkunde-website`; never empty. */
export function slugForProject(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c] ?? c)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return slug || 'projekt';
}

// --- Manifest-backed reads and writes -------------------------------------------------------

export interface ProjectActionOptions {
    /** Manifest path; defaults to the active manifest. */
    path?: string;
    /** Validate and report, but do not write. */
    dryRun?: boolean;
    /** Contact ids that exist for the entity; read from the ledger when omitted. */
    contactIds?: ReadonlySet<string>;
}

/** The contact fields a project may set; `null` clears a field, `undefined` keeps it. */
export interface ProjectContactPersonPatch {
    greeting?: string | null;
    firstName?: string | null;
    formality?: 'du' | 'sie' | null;
}

/** The `--formality` values of the CLI: a form, or `inherit` to drop the project's own and take the contract's. */
export const FORMALITY_ARGS = ['du', 'sie', 'inherit'] as const;

/** `inherit` → `null` (clear), a form → itself, absent → `undefined` (keep). */
export function formalityFromArg(value: string | undefined): ProjectContactPersonPatch['formality'] {
    if (value === undefined) return undefined;
    if (value === 'inherit') return null;
    if (value === 'du' || value === 'sie') return value;
    throw new Error(`Anredeform „${value}" unbekannt (${FORMALITY_ARGS.join(', ')}).`);
}

export interface ProjectInput {
    /** Defaults to a slug of the name, made unique. */
    id?: string;
    name: string;
    contactId: string;
    domains?: string[];
    contactPerson?: ProjectContactPersonPatch;
    notes?: string | null;
    /** Id of one of the entity's mail templates; null/empty removes it. */
    mailTemplateId?: string | null;
}

export type ProjectPatch = Partial<Omit<ProjectInput, 'id'>>;

const text = (s: string | null | undefined): string | undefined => {
    const t = (s ?? '').trim();
    return t || undefined;
};

/** Domains trimmed, lower-cased, deduplicated; blanks dropped. */
export function cleanDomains(domains: readonly string[] | undefined): string[] {
    return [...new Set((domains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean))];
}

/** Apply a contact-person patch; an emptied person is dropped instead of stored as `{}`. */
function mergeContactPerson(
    current: Project['contactPerson'],
    patch: ProjectContactPersonPatch | undefined,
): Project['contactPerson'] {
    if (!patch) return current;
    const next = {
        greeting: patch.greeting === undefined ? current?.greeting : text(patch.greeting),
        firstName: patch.firstName === undefined ? current?.firstName : text(patch.firstName),
        formality: patch.formality === undefined ? current?.formality : (patch.formality ?? undefined),
    };
    const entries = Object.entries(next).filter(([, v]) => v !== undefined);
    return entries.length ? (Object.fromEntries(entries) as Project['contactPerson']) : undefined;
}

function knownContactIds(entityId: string, opts: ProjectActionOptions): ReadonlySet<string> {
    return opts.contactIds ?? new Set(listEntityContacts(entityId).map((c) => c.id));
}

function assertContact(entityId: string, contactId: string, opts: ProjectActionOptions): void {
    if (!knownContactIds(entityId, opts).has(contactId)) {
        throw new Error(`Kontakt „${contactId}" gibt es für ${entityId} nicht (siehe \`contacts list\`).`);
    }
}

/** Refuse a project list that would leave a schedule of this entity pointing at the wrong project. */
function assertConsistent(entityId: string, projects: Project[], opts: ProjectActionOptions): void {
    const schedules = loadRecurringInvoices(opts.path).filter((s) => s.entityId === entityId);
    const errors = findProjectLinkErrors(projects, schedules);
    if (errors.length) throw new Error(errors.join('\n'));
}

function persist(entityId: string, projects: Project[], opts: ProjectActionOptions): void {
    assertConsistent(entityId, projects, opts);
    if (!opts.dryRun) saveProjects(entityId, projects, opts.path);
}

/** Every project of an entity, in manifest order. */
export function listProjects(entityId: string, opts: ProjectActionOptions = {}): Project[] {
    return loadProjects(entityId, opts.path);
}

/** One project by id, or a clear error naming the known ids. */
export function getProject(entityId: string, id: string, opts: ProjectActionOptions = {}): Project {
    const all = loadProjects(entityId, opts.path);
    const found = all.find((p) => p.id === id);
    if (!found) {
        const known = all.map((p) => p.id).join(', ') || '(keine)';
        throw new Error(`Projekt „${id}" gibt es für ${entityId} nicht. Bekannt: ${known}.`);
    }
    return found;
}

/** Create a project. An explicit `id` that is taken is an error; a derived one gets a numeric suffix. */
export function addProject(entityId: string, input: ProjectInput, opts: ProjectActionOptions = {}): Project {
    const name = text(input.name);
    if (!name) throw new Error('Ein Projekt braucht einen Namen.');
    assertContact(entityId, input.contactId, opts);
    const all = loadProjects(entityId, opts.path);
    const ids = all.map((p) => p.id);
    if (input.id && ids.includes(input.id)) throw new Error(`Projekt-Id „${input.id}" ist schon vergeben.`);
    const project: Project = {
        id: input.id ?? uniqueScheduleId(slugForProject(name), ids),
        name,
        contactId: input.contactId,
        domains: cleanDomains(input.domains),
    };
    const contactPerson = mergeContactPerson(undefined, input.contactPerson);
    if (contactPerson) project.contactPerson = contactPerson;
    const notes = text(input.notes);
    if (notes) project.notes = notes;
    const templateId = text(input.mailTemplateId);
    if (templateId) project.mailTemplateId = templateId;
    persist(entityId, [...all, project], opts);
    return project;
}

/** Change a project. Unset fields stay; the id never changes (schedules and time entries refer to it). */
export function updateProject(
    entityId: string,
    id: string,
    patch: ProjectPatch,
    opts: ProjectActionOptions = {},
): Project {
    const all = loadProjects(entityId, opts.path);
    const index = all.findIndex((p) => p.id === id);
    if (index < 0) throw new Error(`Projekt „${id}" gibt es für ${entityId} nicht.`);
    const current = all[index];
    if (patch.contactId && patch.contactId !== current.contactId) assertContact(entityId, patch.contactId, opts);
    const name = patch.name === undefined ? current.name : text(patch.name);
    if (!name) throw new Error('Ein Projekt braucht einen Namen.');
    const next: Project = {
        id: current.id,
        name,
        contactId: patch.contactId ?? current.contactId,
        domains: patch.domains === undefined ? current.domains : cleanDomains(patch.domains),
    };
    const contactPerson = mergeContactPerson(current.contactPerson, patch.contactPerson);
    if (contactPerson) next.contactPerson = contactPerson;
    const notes = patch.notes === undefined ? current.notes : text(patch.notes);
    if (notes) next.notes = notes;
    const templateId = patch.mailTemplateId === undefined ? current.mailTemplateId : text(patch.mailTemplateId);
    if (templateId) next.mailTemplateId = templateId;
    const updated = [...all];
    updated[index] = next;
    persist(entityId, updated, opts);
    return next;
}

/**
 * Delete a project. Refused while a recurring invoice still belongs to it — the contract would
 * lose its greeting without a word. Time entries are not touched: they keep their label and a
 * dangling `projectId` is simply read as "label only".
 */
export function removeProject(entityId: string, id: string, opts: ProjectActionOptions = {}): void {
    const all = loadProjects(entityId, opts.path);
    if (!all.some((p) => p.id === id)) throw new Error(`Projekt „${id}" gibt es für ${entityId} nicht.`);
    const using = loadRecurringInvoices(opts.path).filter((s) => s.entityId === entityId && s.projectId === id);
    if (using.length) {
        throw new Error(
            `Projekt „${id}" wird noch von ${using.map((s) => `„${s.id}"`).join(', ')} verwendet — dort zuerst das Projekt lösen.`,
        );
    }
    persist(
        entityId,
        all.filter((p) => p.id !== id),
        opts,
    );
}

/**
 * Attach a recurring invoice to a project, or detach it with `null`. The consistency rules (project
 * exists, same customer) are the schema's; a violation throws and writes nothing.
 */
export function setScheduleProject(
    entityId: string,
    scheduleId: string,
    projectId: string | null,
    opts: ProjectActionOptions = {},
): RecurringInvoice {
    const all = loadRecurringInvoices(opts.path);
    const schedule = all.find((s) => s.id === scheduleId && s.entityId === entityId);
    if (!schedule)
        throw new ConfigError(`Kein wiederkehrender Posten „${scheduleId}" für ${entityId}.`, opts.path ?? '');
    if (projectId === null) delete schedule.projectId;
    else schedule.projectId = projectId;
    const errors = findProjectLinkErrors(
        loadProjects(entityId, opts.path),
        all.filter((s) => s.entityId === entityId),
    );
    if (errors.length) throw new Error(errors.join('\n'));
    if (!opts.dryRun) saveRecurringInvoices(all, opts.path);
    return schedule;
}

// --- Suggestions ----------------------------------------------------------------------------

/** A proposal for the person to take over by hand. Nothing in it has been written. */
export interface ProjectSuggestion {
    /** `new`: this project does not exist yet. `existing`: it does, and these contracts are not attached. */
    kind: 'new' | 'existing';
    project: Project;
    /** Contracts that would belong to it. */
    scheduleIds: string[];
}

export interface SuggestProjectsResult {
    suggestions: ProjectSuggestion[];
    /** Contracts with domains that cannot be proposed, each with the reason. */
    skipped: { scheduleId: string; reason: string }[];
}

/**
 * Propose projects from the contracts: one per customer and group of overlapping domains.
 *
 * Contracts of one customer that share a domain (hosting and a domain registration for the same
 * site) land in one project — that is the point of a project having several contracts. A group
 * whose customer already has a project covering one of its domains is reported as `existing`
 * instead of proposing a duplicate. Contracts without domains, already attached, or cancelled are
 * left out; contracts without a customer contact are listed in `skipped`, because a project needs one.
 *
 * The greeting of the contract is carried over into the proposed contact person, so taking the
 * proposal over does not change a single cover letter.
 */
export function suggestProjects(
    schedules: readonly RecurringInvoice[],
    projects: readonly Project[],
): SuggestProjectsResult {
    const skipped: SuggestProjectsResult['skipped'] = [];
    const open = schedules.filter((s) => s.status !== 'cancelled' && !s.projectId && cleanDomains(s.domains).length);

    const byCustomer = new Map<string, RecurringInvoice[]>();
    for (const s of open) {
        const contactId = s.customer.contactId;
        if (!contactId) {
            skipped.push({ scheduleId: s.id, reason: 'kein Kunden-Kontakt (customer.contactId)' });
            continue;
        }
        byCustomer.set(contactId, [...(byCustomer.get(contactId) ?? []), s]);
    }

    const suggestions: ProjectSuggestion[] = [];
    const takenIds = projects.map((p) => p.id);
    for (const [contactId, list] of byCustomer) {
        for (const group of groupByDomains(list)) {
            const domains = cleanDomains(group.flatMap((s) => s.domains));
            const existing = projects.find(
                (p) => p.contactId === contactId && cleanDomains(p.domains).some((d) => domains.includes(d)),
            );
            if (existing) {
                suggestions.push({ kind: 'existing', project: existing, scheduleIds: group.map((s) => s.id) });
                continue;
            }
            const customer = group[0].customer;
            const person = group.map((s) => s.customer).find((c) => text(c.greeting) || c.formality);
            const project: Project = {
                id: uniqueScheduleId(slugForProject(`${customer.name} ${domains[0]}`), takenIds),
                name: domains.join(', '),
                contactId,
                domains,
            };
            if (person) {
                const contactPerson = mergeContactPerson(undefined, {
                    greeting: person.greeting,
                    formality: person.formality,
                });
                if (contactPerson) project.contactPerson = contactPerson;
            }
            takenIds.push(project.id);
            suggestions.push({ kind: 'new', project, scheduleIds: group.map((s) => s.id) });
        }
    }
    return { suggestions, skipped };
}

/** Split schedules into groups whose domains overlap (transitively), in input order. */
function groupByDomains(list: readonly RecurringInvoice[]): RecurringInvoice[][] {
    const groups: { domains: Set<string>; members: RecurringInvoice[] }[] = [];
    for (const s of list) {
        const domains = cleanDomains(s.domains);
        const hits = groups.filter((g) => domains.some((d) => g.domains.has(d)));
        const target = hits[0] ?? { domains: new Set<string>(), members: [] };
        if (!hits.length) groups.push(target);
        for (const other of hits.slice(1)) {
            for (const d of other.domains) target.domains.add(d);
            target.members.push(...other.members);
            groups.splice(groups.indexOf(other), 1);
        }
        for (const d of domains) target.domains.add(d);
        target.members.push(s);
    }
    return groups.map((g) => g.members);
}
