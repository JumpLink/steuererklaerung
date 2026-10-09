/**
 * Entity + year discovery for the native app.
 *
 * The probe body moved to the shared core presenter (src/core/presenters/workspace.ts), which the web
 * server now consumes too — this eliminates the twin `candidateYears` / `yearsWithData` blocks. This
 * module is a thin adapter that keeps the app-facing names (`AppEntity` / `AppWorkspace` /
 * `loadAppWorkspace`) so the many view/data importers need no change:
 *   - `AppEntity`      = the shared `EntityModel`
 *   - `AppWorkspace`   = the shared `WorkspaceModel`
 *   - `loadAppWorkspace` = the shared `loadWorkspaceModel`
 */

export type { EntityModel as AppEntity, WorkspaceModel as AppWorkspace } from '../../core/presenters/workspace.ts';
export { loadWorkspaceModel as loadAppWorkspace } from '../../core/presenters/workspace.ts';
