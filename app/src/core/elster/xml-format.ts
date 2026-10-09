/** Shared XML-string helpers for the ELSTER declaration builders (EUER, UStE, GewSt). */

import { escapeXml } from './eds-envelope.ts';

/** `n` spaces of indentation. */
export const pad = (n: number): string => ' '.repeat(n);

/** German decimal: `1234.5` → `1234,50`. */
export const amtDe = (n: number): string => n.toFixed(2).replace('.', ',');

/** `<name>value</name>` (value XML-escaped) at the given indent. */
export function leaf(indent: number, name: string, value: string): string {
    return `${pad(indent)}<${name}>${escapeXml(value)}</${name}>\n`;
}

/** `<name>\n…inner…\n</name>` at the given indent. */
export function wrap(indent: number, name: string, inner: string): string {
    return `${pad(indent)}<${name}>\n${inner}${pad(indent)}</${name}>\n`;
}

/**
 * The schema year a declaration builder writes for a Veranlagungszeitraum: the year itself when the
 * builder implements that year's schema, else the nearest one it does implement.
 *
 * Every builder used to hard-code `v2025`, so a 2024 return went out in the 2025 namespace and ERiC
 * refused it before any plausibility check ("no declaration found for element 'E77'"). A later year
 * whose schema nobody has implemented yet keeps the newest one: ERiC then names the unknown
 * Datenartversion, which says more than a namespace error would.
 */
export function schemaJahr(year: number, implementiert: readonly number[]): number {
    if (implementiert.includes(year)) return year;
    const sorted = [...implementiert].sort((a, b) => a - b);
    return year < sorted[0] ? sorted[0] : sorted[sorted.length - 1];
}

/** `<Container><Sum><Ecode>amt</Ecode></Sum></Container>` at the given base indent. */
export function sumLine(indent: number, container: string, ecode: string, value: number): string {
    return wrap(indent, container, wrap(indent + 4, 'Sum', leaf(indent + 8, ecode, amtDe(value))));
}
