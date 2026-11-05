/**
 * `filing import-protokoll` orchestration: read Übertragungsprotokoll PDFs and record each as a
 * filing. The pure planning ({@link planProtokollImport}) is separate from the PDF text extraction
 * and the register write so it stays testable.
 */

import { toElsterSteuernummer } from '../elster/steuernummer.ts';
import {
    declaredAmountOf,
    eingangIsoDate,
    eingangSortKey,
    parseUebertragungsprotokoll,
    type Uebertragungsprotokoll,
} from '../elster/uebertragungsprotokoll.ts';
import { execSync } from '../secrets/store.ts';
import { loadManifest, resolveEntities } from '../config/index.ts';
import { recordFiling } from './filings.ts';
import type { FilingInput } from '@steuererklaerung/store';

export interface EntitySteuernummer {
    id: string;
    taxNumber: string;
}

export interface ProtokollPlanItem {
    file: string;
    input: FilingInput;
    /** Files whose protocol covered the same filing but arrived earlier. */
    supersedes: string[];
}

function digits(s: string): string {
    return s.replace(/\D/g, '');
}

function elsterForm(nr: string): string | null {
    try {
        return toElsterSteuernummer(nr);
    } catch {
        return null;
    }
}

/** True when two Steuernummern name the same taxpayer (regional or 13-digit form, any separators). */
export function sameSteuernummer(a: string, b: string): boolean {
    const forms = (x: string) => new Set([digits(x), elsterForm(x)].filter((v): v is string => !!v));
    const fa = forms(a);
    return [...forms(b)].some((f) => fa.has(f));
}

/** Resolve the entity for a protocol's Steuernummer; no match → a fixed, data-free message. */
export function entityForSteuernummer(entities: EntitySteuernummer[], steuernummer: string): string {
    const hit = entities.find((e) => sameSteuernummer(e.taxNumber, steuernummer));
    if (!hit) throw new Error('keine Entität mit dieser Steuernummer');
    return hit.id;
}

/** Turn parsed protocols into register inputs; the latest Eingang per entity/kind/period wins. */
export function planProtokollImport(
    protocols: { file: string; protokoll: Uebertragungsprotokoll }[],
    entities: EntitySteuernummer[],
): ProtokollPlanItem[] {
    const sorted = [...protocols].sort((a, b) =>
        eingangSortKey(a.protokoll).localeCompare(eingangSortKey(b.protokoll)),
    );
    const byKey = new Map<string, ProtokollPlanItem>();
    for (const { file, protokoll: p } of sorted) {
        let entityId: string;
        try {
            entityId = entityForSteuernummer(entities, p.steuernummer);
        } catch (err) {
            throw new Error(`${file}: ${err instanceof Error ? err.message : err}`);
        }
        const key = `${entityId}:${p.kind}:${p.period}`;
        const earlier = byKey.get(key);
        byKey.set(key, {
            file,
            input: {
                entityId,
                kind: p.kind,
                period: p.period,
                filedAt: eingangIsoDate(p),
                declaredAmount: declaredAmountOf(p),
                note: `ELSTER ${p.transferticket}${p.berichtigt ? ' · berichtigt' : ''}`,
            },
            supersedes: earlier ? [...earlier.supersedes, earlier.file] : [],
        });
    }
    return [...byKey.values()];
}

/** `pdftotext -layout <pdf> -`; a missing binary or unreadable PDF becomes a plain error. */
export function pdfToText(pdf: string): string {
    try {
        return execSync('pdftotext', ['-layout', pdf, '-']);
    } catch {
        throw new Error('pdftotext fehlgeschlagen (poppler-utils installiert? PDF lesbar?)');
    }
}

/** Read, parse, plan; with `dryRun` false also record. Returns the plan either way. */
export function importProtokolle(files: string[], opts: { dryRun: boolean }): ProtokollPlanItem[] {
    const protocols = files.map((file) => {
        try {
            return { file, protokoll: parseUebertragungsprotokoll(pdfToText(file)) };
        } catch (err) {
            throw new Error(`${file}: ${err instanceof Error ? err.message : err}`);
        }
    });
    const entities = resolveEntities(loadManifest())
        .filter((e) => e.elster?.tax_number)
        .map((e) => ({ id: e.id, taxNumber: e.elster!.tax_number }));
    const plan = planProtokollImport(protocols, entities);
    if (!opts.dryRun) for (const item of plan) recordFiling(item.input);
    return plan;
}
