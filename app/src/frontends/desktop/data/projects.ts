/**
 * Projekte data — the per-entity customer projects of the manifest, plus the customer contacts and
 * the recurring invoices they are chosen from and attached to. Reads and writes go through the same
 * actions the CLI uses, so a rule such as "a contract may only join a project of its own customer"
 * is the schema's, not a second copy in a dialog.
 */

import { listEntityContacts } from '../../../core/actions/contacts.ts';
import {
    addProject as coreAddProject,
    listProjects,
    type ProjectInput,
    type ProjectPatch,
    removeProject as coreRemoveProject,
    updateProject as coreUpdateProject,
} from '../../../core/actions/projects.ts';
import { listSchedules } from '../../../core/actions/recurring-schedules.ts';
import type { Project } from '../../../core/config/index.ts';
import type { Contact } from '@steuererklaerung/store';

export type { Project } from '../../../core/config/index.ts';
export type { Contact } from '@steuererklaerung/store';

export interface ProjectsData {
    projects: Project[];
    contacts: Contact[];
    /** projectId → ids of the recurring invoices that belong to it. */
    schedulesByProject: Map<string, string[]>;
}

/** Everything the Projekte view shows, in one synchronous read (manifest + store, no network). */
export function loadProjectsData(entityId: string): ProjectsData {
    const schedulesByProject = new Map<string, string[]>();
    for (const s of listSchedules(entityId)) {
        if (!s.projectId) continue;
        schedulesByProject.set(s.projectId, [...(schedulesByProject.get(s.projectId) ?? []), s.id]);
    }
    return { projects: listProjects(entityId), contacts: listEntityContacts(entityId), schedulesByProject };
}

/** The projects of one entity (for pickers). Empty for an entity without any. */
export function loadEntityProjects(entityId: string): Project[] {
    return listProjects(entityId);
}

export function addProject(entityId: string, input: ProjectInput): Project {
    return coreAddProject(entityId, input);
}

export function updateProject(entityId: string, id: string, patch: ProjectPatch): Project {
    return coreUpdateProject(entityId, id, patch);
}

/** Refused by the action while a recurring invoice still belongs to the project. */
export function removeProject(entityId: string, id: string): void {
    coreRemoveProject(entityId, id);
}
