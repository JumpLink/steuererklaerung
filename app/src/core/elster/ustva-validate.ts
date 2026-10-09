/**
 * Validate generated USt-VA XML: root element, namespace, and presence of Steuerfall / kz elements.
 * Optional XSD validation when xsd_path is set (after official specs are available).
 */

import { readFileSync } from 'node:fs';

import { XMLParser } from 'fast-xml-parser';

import type { ElsterConfig } from '../config/index.ts';

const USTVA_NS_PREFIX = 'http://finkonsens.de/elster/elsteranmeldung/ustva/v';

export interface UstvaValidationResult {
    valid: boolean;
    errors: string[];
}

/**
 * Validate XML at file path: root Anmeldungssteuern, correct namespace, Steuerfall with kz66, kz81, kz86.
 */
export function validateUstvaXml(filePath: string, config: ElsterConfig): UstvaValidationResult {
    const errors: string[] = [];
    let raw: string;
    try {
        raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
        return {
            valid: false,
            errors: [`Failed to read file: ${err instanceof Error ? err.message : String(err)}`],
        };
    }

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
    });
    let parsed: unknown;
    try {
        parsed = parser.parse(raw);
    } catch (err) {
        return {
            valid: false,
            errors: [`Invalid XML: ${err instanceof Error ? err.message : String(err)}`],
        };
    }

    if (parsed == null || typeof parsed !== 'object') {
        errors.push('XML root is missing or not an object');
        return { valid: false, errors };
    }

    const root = parsed as Record<string, unknown>;
    // Parser may expose XML declaration as "?xml"; treat Anmeldungssteuern as the document root
    const anmeldung = root.Anmeldungssteuern as Record<string, unknown> | undefined;
    const rootKey = Object.keys(root).find((k) => !k.startsWith('@') && k !== '?xml');
    if (!anmeldung || typeof anmeldung !== 'object') {
        errors.push(`Expected root element "Anmeldungssteuern", got "${rootKey ?? 'undefined'}"`);
        return { valid: false, errors };
    }
    const expectedNs = USTVA_NS_PREFIX + config.schema_version;
    const xmlns = anmeldung['@_xmlns'] ?? (anmeldung as { xmlns?: string }).xmlns;
    if (xmlns !== expectedNs) {
        errors.push(`Expected xmlns "${expectedNs}", got "${String(xmlns)}"`);
    }

    const steuerfall = anmeldung.Steuerfall as Record<string, unknown> | undefined;
    if (!steuerfall || typeof steuerfall !== 'object') {
        errors.push('Missing element: /Anmeldungssteuern/Steuerfall');
        return { valid: errors.length === 0, errors };
    }

    const ustvaBlock = (steuerfall.Umsatzsteuervoranmeldung as Record<string, unknown>) ?? steuerfall;
    // At least one Kennzahl (Kz66, Kz81, Kz83, or Kz86) must be present.
    // Zero-value fields are intentionally omitted from XML to avoid ELSTER "Nullwert" hints.
    const getKz = (name: string) => ustvaBlock[name] ?? ustvaBlock[name.toLowerCase()];
    const hasAnyKz =
        getKz('Kz66') !== undefined ||
        getKz('Kz81') !== undefined ||
        getKz('Kz83') !== undefined ||
        getKz('Kz86') !== undefined;
    if (!hasAnyKz) errors.push('No Kennzahlen (Kz66/Kz81/Kz83/Kz86) found in XML.');

    return {
        valid: errors.length === 0,
        errors,
    };
}
