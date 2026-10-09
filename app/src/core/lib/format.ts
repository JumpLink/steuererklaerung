/**
 * de-DE display formatters shared by every frontend (web review UI + native desktop app).
 * Runtime-agnostic (Intl only, no DOM) — the GJS app and the browser both execute these, so
 * they live in the kernel to keep the surfaces thin. DOM-specific escaping stays in the web client.
 */

export const eur = (n: number | null | undefined): string =>
    n == null ? '—' : n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

export const pct = (frac: number): string => `${(frac * 100).toLocaleString('de-DE', { maximumFractionDigits: 2 })} %`;

/** Plain de-DE number with exactly two decimals, no currency symbol (e.g. an editable amount field). */
export const num2 = (n: number | null | undefined): string =>
    n == null ? '' : n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ISO `YYYY-MM-DD` → `DD.MM.YYYY`. */
export const deDate = (iso: string | null | undefined): string => {
    if (!iso) return '';
    const [y, m, d] = iso.slice(0, 10).split('-');
    return d && m && y ? `${d}.${m}.${y}` : iso;
};

/** ISO timestamp → `TT.MM.JJJJ HH:MM` in local time (e.g. a decision-log / snapshot `at`). */
export const deDateTime = (iso: string): string => {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return iso;
    return dt.toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
};

/** Month abbreviations, 1-based (index 0 unused) so `MONTHS[isoMonth]` reads directly. */
export const MONTHS = ['', 'Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

/** 1–2 letter uppercase initials from a display name (for avatars). */
export const initials = (name: string): string => {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

/** Adwaita accent palette for avatars — stable per seed so a contact keeps its colour. */
const AVATAR_PALETTE = ['#3584e4', '#2190a4', '#3a944a', '#e5a50a', '#e66100', '#813d9c', '#1c71d8', '#c01c28'];

/** Deterministic avatar accent colour derived from a seed string. */
export const avatarColor = (seed: string): string => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
};
