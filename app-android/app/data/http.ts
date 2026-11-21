/** Tiny fetch wrapper: timeout, error snippet, JSON. No node:* and no process.env. */
import { describeNetworkError } from './network-error.ts';

function hostOf(url: string): string {
    return /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url;
}

export async function requestJson<T>(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<T> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
    try {
        let res: Response;
        try {
            res = await fetch(url, ctl ? { ...init, signal: ctl.signal } : init);
        } catch (e) {
            if ((e as { name?: string })?.name === 'AbortError') throw e;
            throw new Error(describeNetworkError(e, hostOf(url), label), { cause: e });
        }
        const text = await res.text();
        if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 120)}`);
        return (text.trim() ? JSON.parse(text) : undefined) as T;
    } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') {
            throw new Error(`${label} did not answer within ${Math.round(timeoutMs / 1000)} s`);
        }
        throw e instanceof Error ? e : new Error(String(e));
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export function buildQuery(query: Record<string, unknown>): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v != null) p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
}
