/**
 * Why a structured AI job failed — one kind per remedy, one translated sentence per kind.
 *
 * The kinds are lotse's `JobErrorKind` plus `no-agent`, so the opencode path hands its failures
 * through unchanged and the other providers reuse `malformed` / `invalid` for the same two cases.
 *
 * **Nothing about the input or the answer is kept.** lotse's `JobError` carries the model's raw
 * answer (`output`) and the parser's complaint (`cause`), both about a private document. This error
 * is built from the kind alone, so no log line or toast downstream can print either of them.
 */

import { _ } from '../../lib/i18n.ts';

export type AiJobErrorKind =
    | 'malformed'
    | 'invalid'
    | 'denied'
    | 'unknown-model'
    | 'auth'
    | 'refused'
    | 'timeout'
    | 'cancelled'
    | 'agent'
    | 'no-agent';

const KINDS: ReadonlySet<string> = new Set<AiJobErrorKind>([
    'malformed',
    'invalid',
    'denied',
    'unknown-model',
    'auth',
    'refused',
    'timeout',
    'cancelled',
    'agent',
    'no-agent',
]);

/** The sentence for a kind, translated when the string is built — never at module level. */
export function aiJobErrorMessage(kind: AiJobErrorKind): string {
    switch (kind) {
        case 'malformed':
            return _('The AI answered, but not with data the app can read.');
        case 'invalid':
            return _('The AI answer does not match the expected format and was not used.');
        case 'denied':
            return _(
                'The selected model is not allowed for your data (free hosted models are blocked), so nothing was sent.',
            );
        case 'unknown-model':
            return _('It is unclear which model the AI agent would use, so nothing was sent.');
        case 'auth':
            return _('The AI agent needs a login first: run "opencode auth login".');
        case 'refused':
            return _('The AI did not finish the task.');
        case 'timeout':
            return _('The AI did not answer in time.');
        case 'cancelled':
            return _('The AI task was cancelled.');
        case 'agent':
            return _('The AI agent could not be started or stopped unexpectedly.');
        case 'no-agent':
            return _('No AI agent is installed. Install opencode or choose another AI engine.');
    }
}

export class AiJobError extends Error {
    readonly kind: AiJobErrorKind;

    constructor(kind: AiJobErrorKind) {
        super(aiJobErrorMessage(kind));
        this.name = 'AiJobError';
        this.kind = kind;
    }
}

/** Whether a string names a kind — for mapping lotse's `JobError.kind` without importing lotse. */
export function isAiJobErrorKind(kind: string): kind is AiJobErrorKind {
    return KINDS.has(kind);
}
