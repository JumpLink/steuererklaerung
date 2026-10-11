/**
 * Zod building blocks for the answers of the one-shot AI jobs (ADR 0002, step 1).
 *
 * The prompts allow "empty string or omit if not found", and models also answer `null`; all three
 * mean "not on the document" and become `undefined`. Anything else must have the declared type —
 * a value of the wrong type is a failed job, never a silently cast one.
 */

import { z } from 'zod';

const absent = (value: unknown): unknown => (value === '' || value === null ? undefined : value);

export const optionalText = () => z.preprocess(absent, z.string().optional());
export const optionalNumber = () => z.preprocess(absent, z.number().optional());
export const optionalBoolean = () => z.preprocess(absent, z.boolean().optional());
export const optionalNumbers = () => z.preprocess(absent, z.array(z.number()).optional());
