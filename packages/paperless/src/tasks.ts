/**
 * Paperless-NGX API – Tasks.
 * Query consumption task status by task_id (UUID returned from post_document).
 */

import { get } from './request.ts';
import type { Task } from './types.ts';

const TASKS_PATH = '/api/tasks/';

/** Regex to extract existing document ID from duplicate message: "duplicate of [name] (#123)" */
const DUPLICATE_DOCUMENT_ID_REGEX = /#(\d+)/;

export interface WaitForTaskResultOptions {
    /** Poll interval in ms. Default 1500. */
    pollIntervalMs?: number;
    /** Max wait in ms. Default 60000. */
    timeoutMs?: number;
}

export interface WaitForTaskResultOutcome {
    /** Resolved document ID (new or duplicate). */
    documentId: number;
    /** True if the document was created by this upload; false if it was a duplicate. */
    created: boolean;
}

/**
 * Get a task by its UUID (e.g. returned from postDocument). Returns null if not found.
 * When status === 'SUCCESS', related_document contains the created document ID.
 */
export async function getTask(taskId: string): Promise<Task | null> {
    const list = await get<Task[]>(TASKS_PATH, { task_id: taskId });
    if (Array.isArray(list) && list.length > 0) {
        return list[0];
    }
    return null;
}

/**
 * Poll task until status is SUCCESS or FAILURE. Returns the document ID: on SUCCESS from related_document;
 * on FAILURE with duplicate message, parses document ID from result (e.g. "duplicate of ... (#123)").
 * Throws on timeout or non-duplicate failure.
 */
export async function waitForTaskResult(
    taskId: string,
    options: WaitForTaskResultOptions = {},
): Promise<WaitForTaskResultOutcome> {
    const { pollIntervalMs = 1500, timeoutMs = 60_000 } = options;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const task = await getTask(taskId);
        if (!task) {
            await sleep(pollIntervalMs);
            continue;
        }

        const status = (task.status ?? '').toUpperCase();

        if (status === 'SUCCESS') {
            const raw = task.related_document;
            const documentId = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
            if (Number.isNaN(documentId)) {
                throw new Error(`Task ${taskId}: SUCCESS but invalid related_document: ${raw}`);
            }
            return { documentId, created: true };
        }

        if (status === 'FAILURE') {
            const result = task.result ?? '';

            // Try regex on result message first (e.g. "duplicate of ... (#123)")
            const match = result.match(DUPLICATE_DOCUMENT_ID_REGEX);
            if (match) {
                const documentId = parseInt(match[1], 10);
                return { documentId, created: false };
            }

            // Fallback: Paperless may set related_document even on FAILURE (duplicate with traceback)
            if (task.related_document != null) {
                const raw = task.related_document;
                const documentId = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
                if (!Number.isNaN(documentId) && documentId > 0) {
                    return { documentId, created: false };
                }
            }

            // Paperless sometimes returns a transient traceback before the real result is set.
            // Wait and retry instead of throwing immediately.
            if (result.includes('<traceback object') || result.includes('Traceback')) {
                await sleep(pollIntervalMs);
                continue;
            }

            throw new Error(`Task ${taskId} failed: ${result || 'unknown'}`);
        }

        await sleep(pollIntervalMs);
    }

    throw new Error(`Task ${taskId}: timeout after ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
