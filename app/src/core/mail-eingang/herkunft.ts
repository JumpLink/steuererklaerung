/**
 * What a receipt says about where it came from (Idee 15): „aus Mail von Name, 12.05.2026“.
 * The sender and the date of the message — never its subject or text, which are not stored.
 */

import type { DmsOrigin } from '@steuererklaerung/dms';
import { deDate } from '../lib/format.ts';

/** The sender as a person reads it: the display name when there is one, else the address. */
export function senderLabel(from: string): string {
    const name = /^(.*?)\s*<[^>]+>\s*$/.exec(from)?.[1].trim();
    return name || from.replace(/^<|>$/g, '').trim();
}

export function herkunftSatz(origin: DmsOrigin): string {
    return `aus Mail von ${senderLabel(origin.from)}, ${deDate(origin.date)}`;
}

/** The open receipts that arrived by mail — what the Beleg-Eingang counts as „neue Belege aus Mail“. */
export function belegeAusMail<T extends { origin?: DmsOrigin | null }>(docs: readonly T[]): T[] {
    return docs.filter((d) => d.origin?.kind === 'mail');
}

export function neueBelegeSatz(count: number): string {
    return count === 1 ? '1 neuer Beleg aus Mail' : `${count} neue Belege aus Mail`;
}
