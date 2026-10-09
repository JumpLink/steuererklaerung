/**
 * The setup assistant's model — which pages a run shows, what it collected, and the one write.
 *
 * Two modes share the same pages. The FIRST RUN still says where the files will land and asks for a
 * name; a NEW ENTITY added to an existing workspace skips that, starts at the choice between private
 * and business, and then asks only what fits the choice.
 *
 * Every question maps onto a field the manifest already has — nothing here invents one:
 *
 *   · Steuernummer        → `elster.tax_number` (business) · `est.person.steuernummer` (private)
 *   · USt-VA-Zeitraum     → `elster.period` (`month` or `quarter`; the schema requires one of the
 *                           two, so "yearly" and "none" have nowhere to go and are not offered)
 *   · Kleinunternehmer    → `invoicing.self.issuer.kleinunternehmer`, the only §19 flag there is
 *   · Zusammenveranlagung → `est.veranlagung` (`einzel` / `splitting`)
 *   · Bankkonten          → `accounts`, as exact account keys
 *   · Belege              → `dms`
 *
 * The page logic is pure so it can be tested without a display, and {@link applyEntitySetup} is the
 * only function that writes — a run that is cancelled never reaches it, so the disk stays as it was.
 */

import { entityIdAliases } from '@steuererklaerung/store';
import {
    DEFAULT_COUNTRY,
    defaultTaxModuleFor,
    getManifestPath,
    loadManifest,
    type Manifest,
    manifestExists,
    matchAccount,
    slugFromName,
    type TaxModuleId,
} from '../config/index.ts';
import { addEntity, assertAccountsMovable, initWorkspace } from './entities.ts';

export type EntitySetupMode = 'first-run' | 'new-entity';
export type EntitySetupKind = 'einzelunternehmen' | 'gbr' | 'privat';

/** The pages, in order. `welcome` and `entity` are first-run only; `kind` onward is the new-entity path. */
export type EntitySetupPage = 'welcome' | 'entity' | 'kind' | 'business' | 'private' | 'accounts' | 'dms' | 'finish';

/** What a run collected. `undefined` on an optional question means "later": nothing is written for it. */
export interface EntitySetupDraft {
    name: string;
    kind: EntitySetupKind;
    taxNumber: string;
    /** Business only. */
    kleinunternehmer?: boolean;
    /** Business only. */
    ustCadence?: 'month' | 'quarter';
    /** Private only. */
    veranlagung?: 'einzel' | 'splitting';
    /** Exact account keys to route to the new entity. */
    accounts: string[];
    dms: 'builtin' | 'paperless';
    paperlessUrl: string;
    /** Blank keeps the token of {@link EntitySetupDraft.dmsFrom}, if any. */
    paperlessToken: string;
    /** The entity whose Paperless setup was preselected; its token is reused when none is typed. */
    dmsFrom?: string;
    /** ISO country; unset = Germany (ADR 0001). */
    country?: string;
    /** The German tax features; unset = the country's own module. */
    taxModule?: TaxModuleId;
}

/** Whether a kind is a business (ELSTER section, USt questions) rather than a private household. */
export function isBusinessKind(kind: EntitySetupKind): boolean {
    return kind !== 'privat';
}

/**
 * The pages a run shows. The first-run path is unchanged; the new-entity path depends on the kind,
 * which is why the UI asks this again after the kind page.
 */
export function entitySetupPages(mode: EntitySetupMode, kind: EntitySetupKind): EntitySetupPage[] {
    if (mode === 'first-run') return ['welcome', 'entity', 'dms', 'finish'];
    return ['kind', isBusinessKind(kind) ? 'business' : 'private', 'accounts', 'dms', 'finish'];
}

/** The page after `current`, or null on the last one. */
export function nextEntitySetupPage(
    mode: EntitySetupMode,
    kind: EntitySetupKind,
    current: EntitySetupPage,
): EntitySetupPage | null {
    const pages = entitySetupPages(mode, kind);
    const i = pages.indexOf(current);
    return i >= 0 && i < pages.length - 1 ? pages[i + 1] : null;
}

/**
 * The Paperless instance the workspace already uses, so a further entity starts with it preselected.
 * The first entity with a Paperless URL wins; the token never leaves this module.
 */
export function sharedPaperless(manifest: Manifest | null): { entityId: string; url: string } | null {
    for (const e of manifest?.entities ?? []) {
        if (e.dms?.type === 'paperless' && e.dms.paperless?.url) return { entityId: e.id, url: e.dms.paperless.url };
    }
    return null;
}

/** A fresh draft. A workspace that already uses Paperless preselects it. */
export function newEntitySetupDraft(
    manifest: Manifest | null,
    kind: EntitySetupKind = 'einzelunternehmen',
): EntitySetupDraft {
    const shared = sharedPaperless(manifest);
    return {
        name: '',
        kind,
        taxNumber: '',
        accounts: [],
        dms: shared ? 'paperless' : 'builtin',
        paperlessUrl: shared?.url ?? '',
        paperlessToken: '',
        dmsFrom: shared?.entityId,
    };
}

/**
 * A free id derived from the name. "Privat" in a workspace that already has `privat` becomes
 * `privat-2` instead of failing on the last page with a duplicate-id error the user cannot fix
 * (they never see the id).
 */
export function freeEntityId(name: string, manifest: Manifest | null): string {
    const taken = new Set<string>();
    for (const e of manifest?.entities ?? []) for (const a of entityIdAliases(e.id)) taken.add(a);
    const base = slugFromName(name);
    const free = (id: string) => !entityIdAliases(id).some((a) => taken.has(a));
    if (free(base)) return base;
    for (let n = 2; ; n++) if (free(`${base}-${n}`)) return `${base}-${n}`;
}

/** Which entity an account key is routed to today, or undefined. */
export function accountOwner(manifest: Manifest | null, key: string): { id: string; name: string } | undefined {
    const owner = manifest?.entities.find((e) => matchAccount(key, e.accounts));
    return owner ? { id: owner.id, name: owner.name } : undefined;
}

/**
 * The raw sections the draft adds to the entity. Only answered questions produce a key: "later" means
 * the entity looks exactly like one created without the question.
 */
export function entitySetupSections(
    draft: EntitySetupDraft,
    id: string,
    manifest: Manifest | null,
    year: number = new Date().getFullYear(),
): Record<string, unknown> {
    const sections: Record<string, unknown> = {};
    const taxNumber = draft.taxNumber.trim();

    // Only a choice that differs from the default is written, so the default run creates the same
    // entity it created before the switch existed.
    const country = draft.country ?? DEFAULT_COUNTRY;
    if (country !== DEFAULT_COUNTRY) sections.country = country;
    if (draft.taxModule && draft.taxModule !== defaultTaxModuleFor(country)) sections.taxModule = draft.taxModule;

    if (isBusinessKind(draft.kind)) {
        // Same shape `ensureElsterSection` creates, so a business entity from either path is alike.
        const period = draft.ustCadence === 'month' ? { year, month: 1 } : { year, quarter: 1 };
        sections.elster = { entity_id: id, period, ...(taxNumber ? { tax_number: taxNumber } : {}) };
        if (draft.kleinunternehmer !== undefined) {
            sections.invoicing = { self: { issuer: { kleinunternehmer: draft.kleinunternehmer } } };
        }
    } else if (taxNumber || draft.veranlagung) {
        sections.est = {
            entity_id: id,
            ...(draft.veranlagung ? { veranlagung: draft.veranlagung } : {}),
            person: { name: draft.name.trim(), ...(taxNumber ? { steuernummer: taxNumber } : {}) },
        };
    }

    if (draft.dms === 'paperless') {
        const paperless: Record<string, string> = {};
        const url = draft.paperlessUrl.trim();
        if (url) paperless.url = url;
        const from = draft.dmsFrom ? manifest?.entities.find((e) => e.id === draft.dmsFrom) : undefined;
        const token = draft.paperlessToken.trim() || from?.dms?.paperless?.token;
        if (token) paperless.token = token;
        sections.dms = { type: 'paperless', ...(Object.keys(paperless).length ? { paperless } : {}) };
    } else {
        sections.dms = { type: 'builtin' };
    }
    return sections;
}

/**
 * The one write: create the entity with everything the run collected, in a single validated manifest
 * write. Creates the manifest when there is none yet (the first run, or a CLI that created one while
 * the assistant was open — then the entity is added instead). Returns the new entity's id.
 */
export function applyEntitySetup(draft: EntitySetupDraft, path: string = getManifestPath()): string {
    const name = draft.name.trim();
    if (!name) throw new Error('Name fehlt.');
    const manifest = manifestExists(path) ? loadManifest(path) : null;
    const id = freeEntityId(name, manifest);
    const accounts = [...new Set(draft.accounts)];
    const input = {
        id,
        name,
        kind: draft.kind,
        accounts,
        moveAccounts: true,
        sections: entitySetupSections(draft, id, manifest),
    };
    if (manifest) assertAccountsMovable(accounts, id, manifest);
    if (manifest) addEntity(input, path);
    else initWorkspace(input, path);
    return id;
}
