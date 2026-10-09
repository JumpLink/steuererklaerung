/**
 * Manifest section schema: an entity's inline `projects` block.
 *
 * A project is the unit a customer engagement is billed and written to: one customer
 * (`contactId`), the domains it covers, and — optionally — the person who is addressed in the
 * cover letter. Several recurring invoices may belong to one project; a recurring invoice belongs
 * to at most one (`projectId` on the schedule). Time entries point at a project the same way, but
 * their free-text `project` label stays readable, so nothing here is mandatory and a manifest
 * without projects stays valid.
 *
 * This module also owns {@link findProjectLinkErrors}, the one place that decides whether the
 * links between projects and schedules are consistent. The manifest schema, the project actions and
 * the cover-letter renderer all ask it, so there is no second opinion that could drift.
 */

import { z } from 'zod';
import type { RecurringEntry } from './recurring.ts';

/** The person a project's cover letters address. Text only: we never guess a gender from a name. */
const ContactPersonSchema = z.object({
    /**
     * Free-form salutation name for the cover letter's `{anrede}`, e.g. "Silke" or "Markus, moin
     * Frederik". Wins over the contract's `customer.greeting`.
     */
    greeting: z.string().optional(),
    /** First name, for display and for suggesting a greeting; the letter itself uses `greeting`. */
    firstName: z.string().optional(),
    /** `du` or `sie`. Wins over the contract's `customer.formality`; unset falls through to it. */
    formality: z.enum(['du', 'sie']).optional(),
});
export type ProjectContactPerson = z.infer<typeof ContactPersonSchema>;

export const ProjectSchema = z.object({
    /** Stable slug, e.g. "musterkunde-website". Time entries and schedules refer to it. */
    id: z.string().min(1),
    /** Display name, e.g. "Website Relaunch". Time-tracking labels are matched against it. */
    name: z.string().min(1),
    /** The customer contact (contacts master) this project is for. */
    contactId: z.string().min(1),
    /** Domains the project covers (documentation + suggesting which contracts belong to it). */
    domains: z.array(z.string()).default([]),
    contactPerson: ContactPersonSchema.optional(),
    /** Mail template (id from the entity's `mailTemplates`) for this project's contracts; a contract's own wins. */
    mailTemplateId: z.string().min(1).optional(),
    notes: z.string().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** An entity's projects = a plain array of {@link ProjectSchema}. */
export const ProjectSectionSchema = z.array(ProjectSchema);
export type ProjectSection = z.infer<typeof ProjectSectionSchema>;

/** Why one schedule does not fit its project, or `undefined` when it does (or has no project). */
export function projectLinkError(
    schedule: Pick<RecurringEntry, 'id' | 'projectId'> & { customer: { contactId?: string } },
    projects: readonly Pick<Project, 'id' | 'name' | 'contactId'>[],
): string | undefined {
    if (!schedule.projectId) return undefined;
    const project = projects.find((p) => p.id === schedule.projectId);
    if (!project) {
        return `Wiederkehrender Posten „${schedule.id}": Projekt „${schedule.projectId}" existiert nicht.`;
    }
    if (!schedule.customer.contactId) {
        return `Wiederkehrender Posten „${schedule.id}" gehört zu Projekt „${project.name}", hat aber keinen Kunden-Kontakt (customer.contactId) — Kunde nicht vergleichbar.`;
    }
    if (schedule.customer.contactId !== project.contactId) {
        return `Wiederkehrender Posten „${schedule.id}" hat einen anderen Kunden (${schedule.customer.contactId}) als Projekt „${project.name}" (${project.contactId}).`;
    }
    return undefined;
}

/**
 * Every inconsistency between an entity's projects and its schedules, as readable German lines:
 * duplicate project ids, a `projectId` that points nowhere, and a project of a different customer.
 * Empty when all is well.
 */
export function findProjectLinkErrors(
    projects: readonly Pick<Project, 'id' | 'name' | 'contactId'>[],
    schedules: readonly (Pick<RecurringEntry, 'id' | 'projectId'> & { customer: { contactId?: string } })[],
): string[] {
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const p of projects) {
        if (seen.has(p.id)) errors.push(`Projekt-Id „${p.id}" ist doppelt vergeben.`);
        seen.add(p.id);
    }
    for (const s of schedules) {
        const err = projectLinkError(s, projects);
        if (err) errors.push(err);
    }
    return errors;
}
