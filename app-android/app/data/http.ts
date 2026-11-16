/** Tiny fetch wrapper: timeout, error snippet, JSON. No node:* and no process.env. */

export async function requestJson<T>(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<T> {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
    try {
        const res = await fetch(url, ctl ? { ...init, signal: ctl.signal } : init);
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
