/**
 * Zod building blocks for the answers of the one-shot AI jobs (ADR 0002, step 1).
 *
 * The prompts allow "empty string or omit if not found", and models also answer `null`; all three
 * mean "not on the document" and become `undefined`. Anything else must have the declared type —
 * a value of the wrong type is a failed job, never a silently cast one.
 */

import { z } from 'zod';

/** Empty string, `null` and an omitted key all mean the same: the document does not state it. */
export const absent = (value: unknown): unknown => (value === '' || value === null ? undefined : value);

export const optionalText = () => z.preprocess(absent, z.string().optional());
export const optionalNumber = () => z.preprocess(absent, z.number().optional());
export const optionalBoolean = () => z.preprocess(absent, z.boolean().optional());
/** An amount: a wrong-typed value ("12,50", "19%") is dropped for that field, so it never fails the whole answer. */
export const lenientNumber = () => z.preprocess(absent, z.number().optional().catch(undefined));
export const optionalNumbers = () => z.preprocess(absent, z.array(z.number()).optional());
