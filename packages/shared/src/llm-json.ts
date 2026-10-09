/**
 * Tolerant JSON extraction from LLM text replies.
 *
 * LLMs wrap JSON in markdown fences, add prose, or emit minor syntax slips
 * (trailing commas, single quotes, truncated output). These helpers pull out
 * the most plausible JSON object and parse it leniently, then optionally
 * validate against a Zod schema.
 *
 * Ported/generalized from the faktenforum/crawler LLM harness.
 */

import { jsonrepair } from 'jsonrepair';
import type { ZodType } from 'zod';

/** Strip a single ```json ... ``` (or plain ``` ... ```) fence if present. */
function stripJsonFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? (fenced[1] ?? text) : text;
}

/**
 * Return the most plausible JSON-object slice from a model reply. Handles
 * markdown fences and surrounding prose. Returns null when no `{ ... }` exists.
 */
export function extractJsonCandidate(text: string): string | null {
  const trimmed = stripJsonFences(text).trim();
  if (trimmed.startsWith('{')) return trimmed;

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

/** Parse strictly, then fall back to jsonrepair. Returns undefined if unparseable. */
export function parseJsonLeniently(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through to repair */
  }
  try {
    return JSON.parse(jsonrepair(candidate));
  } catch {
    return undefined;
  }
}

export type ParseResult<T> = { success: true; data: T } | { success: false; error: string };

/**
 * Extract + leniently parse + Zod-validate a JSON object from raw LLM text.
 * Extra fields are stripped by Zod; the gate is "did we get a usable object".
 */
export function parseJsonWithSchema<T>(raw: string | undefined, schema: ZodType<T>): ParseResult<T> {
  if (!raw) return { success: false, error: 'no result text received' };

  const candidate = extractJsonCandidate(raw);
  if (!candidate) return { success: false, error: 'result contains no JSON object' };

  const json = parseJsonLeniently(candidate);
  if (json === undefined) return { success: false, error: 'result is not parseable JSON even after repair' };

  const result = schema.safeParse(json);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    error: result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
  };
}
