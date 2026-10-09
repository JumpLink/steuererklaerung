/**
 * Steuernummer helpers shared by every ELSTER builder (UStVA, EUER, UStE, GewSt,
 * Feststellung). Extracted from ustva-xml.ts so the annual/declaration builders can
 * reuse the regional → 13-digit conversion AND derive the BuFa (Empfaenger) from the
 * CONVERTED number rather than the regional form.
 */

/**
 * Bundesfinanzamtsnummer prefix per 2-digit Landeskennung, for converting a regional
 * Steuernummer (FF/BBB/UUUUP) into the 13-digit bundeseinheitliche ELSTER format
 * (FFFF0BBBUUUUP). FFFF = prefix+Landeskennung.
 *
 * Niedersachsen mapping: "18" → prefix "23", so 18/BBB/UUUUP → 2318 0 BBB UUUUP.
 */
const BUFA_PREFIX: Record<string, string> = {
    '10': '11', // Berlin
    '11': '22', // Brandenburg
    '13': '40', // Mecklenburg-Vorpommern
    '14': '32', // Sachsen
    '15': '31', // Sachsen-Anhalt
    '16': '41', // Thüringen
    '17': '21', // Schleswig-Holstein
    '18': '23', // Niedersachsen
    '19': '24', // Hamburg
    '20': '24', // Hamburg
    '21': '26', // Bremen
    '22': '28', // Nordrhein-Westfalen
    '23': '51', // Nordrhein-Westfalen
    '24': '28', // Nordrhein-Westfalen (alt)
    '26': '27', // Hessen
    '27': '28', // Nordrhein-Westfalen
    '28': '28', // Nordrhein-Westfalen
    '29': '91', // Bayern
    '30': '91', // Bayern
    '31': '91', // Bayern
    '32': '91', // Bayern
    '33': '28', // Nordrhein-Westfalen
    '34': '28', // Nordrhein-Westfalen
    '40': '26', // Hessen
    '41': '28', // Nordrhein-Westfalen
    '42': '28', // Nordrhein-Westfalen
    '43': '28', // Nordrhein-Westfalen
    '44': '28', // Nordrhein-Westfalen
    '46': '26', // Hessen
    '48': '26', // Hessen
    '50': '28', // Nordrhein-Westfalen
    '51': '28', // Nordrhein-Westfalen
    '52': '28', // Nordrhein-Westfalen
    '53': '28', // Nordrhein-Westfalen
    '54': '28', // Nordrhein-Westfalen
    '55': '28', // Nordrhein-Westfalen
    '56': '28', // Nordrhein-Westfalen
    '66': '26', // Hessen
    '76': '28', // Nordrhein-Westfalen
    '86': '91', // Bayern
    '91': '91', // Bayern
};

/**
 * Convert a regional Steuernummer (e.g. "11/222/44444") to the 13-digit
 * bundeseinheitliche ELSTER format `([0-9]{4})0[0-9]{8}`.
 *
 * Mapping: FF/BBB/UUUUP → FFFF0BBBUUUUP where FFFF = BuFa prefix derived from the
 * 2-digit Landeskennung. A number that is already 13 digits is returned unchanged.
 */
export function toElsterSteuernummer(regionalNr: string): string {
    // If already 13 digits, return as-is
    const digits = regionalNr.replace(/\D/g, '');
    if (digits.length === 13 && /^\d{4}0\d{8}$/.test(digits)) return digits;

    // Parse regional format: FF/BBB/UUUUP
    const parts = regionalNr.split('/');
    if (parts.length !== 3) {
        throw new Error(`Cannot convert Steuernummer "${regionalNr}" to ELSTER format. Expected FF/BBB/UUUUP.`);
    }
    const [land, bezirk, personal] = parts;
    const prefix = BUFA_PREFIX[land];
    if (!prefix) {
        throw new Error(`Unknown Landeskennung "${land}" in Steuernummer "${regionalNr}".`);
    }
    // ELSTER: FFFF 0 BBB UUUUP → prefix+land + "0" + bezirk + personal
    return `${prefix}${land}0${bezirk}${personal}`;
}

/**
 * Derive the 4-digit Bundesfinanzamtsnummer (the ELSTER `<Empfaenger id="F">` value)
 * from a 13-digit ELSTER Steuernummer — the first four digits.
 */
export function bufaFromElsterSteuernummer(elsterNr13: string): string {
    return elsterNr13.slice(0, 4);
}
