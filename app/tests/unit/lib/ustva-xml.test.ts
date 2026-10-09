import { describe, it, expect } from '@gjsify/unit';
import { buildUstvaEds, buildUstvaPortalUpload } from '../../../src/core/elster/ustva-xml.ts';
import type { UstvaAggregate } from '../../../src/core/elster/ustva-aggregate.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';

// Fictitious Steuernummer (Niedersachsen format FF/BBB/UUUUP) — no real data.
const config: ElsterConfig = {
    tax_number: '18/815/08152',
    schema_version: 2025,
    period: { year: 2025, quarter: 1 },
    output_directory: '/tmp',
    test_mode: true,
    taxation_basis: 'ist',
    ust_dauerfristverlaengerung: false,
    exclude_tags: [],
    include_tags: [],
    entity_id: 'artcode',
    account_labels: {},
    gesellschafter: [],
};

const aggregate: UstvaAggregate = {
    net_19: 1000,
    net_7: 200,
    vat_out: 204,
    vat_in: 50,
    outgoing_count: 2,
    incoming_count: 1,
};

// Regression guard for the EDS envelope refactor: the output must stay
// byte-identical when the shared envelope builder is extracted. (@gjsify/unit
// has no inline snapshots; this asserts the exact string instead.)
const EXPECTED_EDS = `<?xml version="1.0" encoding="UTF-8"?>
<Elster xmlns="http://www.elster.de/elsterxml/schema/v11">
    <TransferHeader version="11">
        <Verfahren>ElsterAnmeldung</Verfahren>
        <DatenArt>UStVA</DatenArt>
        <Vorgang>send-Auth</Vorgang>
        <Testmerker>700000004</Testmerker>
        <HerstellerID>00000</HerstellerID>
        <DatenLieferant></DatenLieferant>
        <Datei>
            <Verschluesselung>CMSEncryptedData</Verschluesselung>
            <Kompression>GZIP</Kompression>
        </Datei>
    </TransferHeader>
    <DatenTeil>
        <Nutzdatenblock>
            <NutzdatenHeader version="11">
                <NutzdatenTicket>1</NutzdatenTicket>
                <Empfaenger id="F">2318</Empfaenger>
            </NutzdatenHeader>
            <Nutzdaten>
                <Anmeldungssteuern xmlns="http://finkonsens.de/elster/elsteranmeldung/ustva/v2025" version="2025">
                    <Steuerfall>
                        <Umsatzsteuervoranmeldung>
                            <Jahr>2025</Jahr>
                            <Zeitraum>41</Zeitraum>
                            <Steuernummer>2318081508152</Steuernummer>
                            <Kz09>00000</Kz09>
                            <Kz66>50.00</Kz66>
                            <Kz81>1000</Kz81>
                            <Kz83>154.00</Kz83>
                            <Kz86>200</Kz86>
                        </Umsatzsteuervoranmeldung>
                    </Steuerfall>
                </Anmeldungssteuern>
            </Nutzdaten>
        </Nutzdatenblock>
    </DatenTeil>
</Elster>
`;

// A §13b case: EU service (Adobe-like, Abs. 1 → Kz 46/47) + third-country service (Abs. 2 → Kz 84/85),
// deductible Vorsteuer Kz 67 = Σ tax. The owed tax nets against Kz 67 → Kz 83 stays 154.00.
const aggregate13b: UstvaAggregate = {
    ...aggregate,
    reverseCharge: {
        abs1Base: 558.4,
        abs1Tax: 106.1,
        abs2Base: 100,
        abs2Tax: 19,
        deductibleVat: 125.1,
        count: 3,
    },
};

export default async () => {
    await describe('buildUstvaEds', async () => {
        await it('produces a stable EDS envelope', async () => {
            expect(buildUstvaEds(aggregate, config)).toBe(EXPECTED_EDS);
        });

        await it('emits §13b Kennziffern (46/47/67/84/85) in numeric order, Kz 83 unchanged', async () => {
            const xml = buildUstvaEds(aggregate13b, config);
            expect(xml).toContain('<Kz46>558</Kz46>');
            expect(xml).toContain('<Kz47>106.10</Kz47>');
            expect(xml).toContain('<Kz67>125.10</Kz67>');
            expect(xml).toContain('<Kz84>100</Kz84>');
            expect(xml).toContain('<Kz85>19.00</Kz85>');
            expect(xml).toContain('<Kz83>154.00</Kz83>'); // owed §13b tax nets against Kz 67
            // numeric order: 46 < 66 < 67 < 81 < 83 < 84 < 86
            expect(xml.indexOf('<Kz46>')).toBeLessThan(xml.indexOf('<Kz66>'));
            expect(xml.indexOf('<Kz67>')).toBeLessThan(xml.indexOf('<Kz81>'));
            expect(xml.indexOf('<Kz84>')).toBeLessThan(xml.indexOf('<Kz86>'));
        });

        await it('puts the SAME Hersteller-ID in Kz09 and the TransferHeader', async () => {
            // ERiC compares the two and rejects a mismatch: Fehler 89, "Die angegebenen
            // Identifikationsnummern des Softwareherstellers in Vorsatz und Kz 09 (Satz2)
            // unterscheiden sich". Kz09 was hardcoded '00000' while the envelope carried the
            // configured id, so validate-eric failed for every entity that sets one — invisible
            // for as long as the returns went out through the Mein-ELSTER XML import.
            const xml = buildUstvaEds(aggregate, { ...config, hersteller_id: '39542' });
            expect(xml).toContain('<HerstellerID>39542</HerstellerID>');
            expect(xml).toContain('<Kz09>39542</Kz09>');
            // The discriminator: the placeholder must be gone, not merely joined by the real id.
            expect(xml).not.toContain('<Kz09>00000</Kz09>');
        });

        await it('falls back to the 00000 placeholder in BOTH places when none is configured', async () => {
            // Unconfigured must still agree — two defaults that drift apart would fail ERiC the
            // same way. `config` has no hersteller_id, which is why the byte-exact test above holds.
            const xml = buildUstvaEds(aggregate, config);
            expect(xml).toContain('<HerstellerID>00000</HerstellerID>');
            expect(xml).toContain('<Kz09>00000</Kz09>');
        });
    });

    // The Mein-ELSTER XML-Import artifact (no Hersteller-ID needed): the plain <Anmeldungssteuern>
    // ISO-8859-15 file, NOT the ERiC <Elster> envelope.
    await describe('buildUstvaPortalUpload', async () => {
        await it('produces the plain <Anmeldungssteuern> ISO-8859-15 upload file (no ERiC envelope)', async () => {
            const { filename, xml } = buildUstvaPortalUpload(aggregate, config, 2025, 1);
            expect(filename).toBe('ustva-2025-Q1.xml');
            expect(xml.startsWith('<?xml version="1.0" encoding="ISO-8859-15"')).toBe(true);
            // Root is the Nutzdaten payload the portal wants — the /Elster/…/Nutzdaten envelope is absent.
            expect(xml).toContain('<Anmeldungssteuern xmlns="http://finkonsens.de/elster/elsteranmeldung/ustva/v2025" version="2025">');
            expect(xml).not.toContain('<Elster');
            expect(xml).not.toContain('<TransferHeader');
            expect(xml).not.toContain('<HerstellerID>');
            // Same Kennzahlen as the EDS (shared computeUstvaKennzahlen).
            expect(xml).toContain('<Kz81>1000</Kz81>');
            expect(xml).toContain('<Kz86>200</Kz86>');
            expect(xml).toContain('<Kz83>154.00</Kz83>');
        });

        await it('byte output is 1:1 ASCII → valid ISO-8859-15 bytes', async () => {
            const { xml, bytes } = buildUstvaPortalUpload(aggregate, config, 2025, 1);
            expect(bytes.length).toBe(xml.length); // pure ASCII: one byte per char
            expect(String.fromCharCode(...bytes)).toBe(xml);
        });
    });
};
