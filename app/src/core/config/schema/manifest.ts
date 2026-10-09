/**
 * The consolidated `steuererklaerung.json` **version 1** manifest — the single config source that folds the
 * former 7 files into one document:
 *
 *   - `version: 1`      — the manifest marker (a legacy/registry steuererklaerung.json has no version).
 *   - `app`             — assistant + MCP settings (was the top-level assistant/mcp keys).
 *   - `paperless`       — the global sync-config.json payload.
 *   - `fints`           — the global fints-config.json payload (PIN stays in .env).
 *   - `entities[]`      — each with inline `elster` / `est` / `recurring` (was satellite files).
 *
 * `bmf-umrechnungskurse.json` (reference data) and `.env` (secrets) deliberately stay SEPARATE.
 *
 * This module is I/O-free: it defines the shape only. The loader/writer live in ../manifest.ts.
 */

import type { infer as ZodInfer } from 'zod';
import { z } from 'zod';
import { AppSectionSchema } from './app-settings.ts';
import { ManifestEntitySchema } from './entity.ts';
import { FinTSSectionSchema } from './fints.ts';
import { PaperlessSectionSchema } from './paperless.ts';
import { findProjectLinkErrors } from './project.ts';

/** The manifest format version. Bump only on a breaking structural change to the manifest. */
export const MANIFEST_VERSION = 1 as const;

export const ManifestSchema = z
    .object({
        /** Manifest marker — always 1 for this format. A legacy registry steuererklaerung.json has no `version`. */
        version: z.literal(MANIFEST_VERSION),
        /** Built-in web assistant + externally-exposed MCP tool groups. */
        app: AppSectionSchema.optional(),
        /** Global Paperless-ngx sync config (custom field / tag / doc-type ids, providers, …). */
        paperless: PaperlessSectionSchema.optional(),
        /** Global FinTS/HBCI bank accounts (PIN never stored here — it lives in the environment). */
        fints: FinTSSectionSchema.optional(),
        /** The entity registry — at least one entity, each with its inline elster/est/recurring sections. */
        entities: z.array(ManifestEntitySchema).min(1, 'manifest must list at least one entity'),
    })
    .superRefine((manifest, ctx) => {
        // A contract pointing at a missing project or one of another customer would otherwise render the
        // wrong greeting or none — silently. Failing here also stops a write that would create it.
        manifest.entities.forEach((entity, i) => {
            for (const message of findProjectLinkErrors(entity.projects ?? [], entity.recurring ?? [])) {
                ctx.addIssue({ code: 'custom', path: ['entities', i, 'projects'], message });
            }
        });
    });
export type Manifest = ZodInfer<typeof ManifestSchema>;
export type { ManifestEntity } from './entity.ts';
