import { interactivePrompts } from '../../../core/lib/interactive-prompts.ts';
import type {
    ExtractedInvoiceFields,
    ExtractInvoiceFieldsProcessedInfo,
} from '../../../core/actions/paperless/extract-invoice.ts';

export const INTERACTIVE_TTY_MESSAGE =
    'This command is interactive by default. Use --auto for non-TTY (e.g. in scripts), or run from a terminal.';

function formatExtractedForDisplay(extracted: ExtractedInvoiceFields): string[] {
    const lines: string[] = [];
    if (extracted.invoice_number != null && String(extracted.invoice_number).trim()) {
        lines.push(`  Rechnungsnummer:   ${extracted.invoice_number}`);
    }
    if (extracted.invoice_date != null && String(extracted.invoice_date).trim()) {
        lines.push(`  Rechnungsdatum:    ${extracted.invoice_date}`);
    }
    if (extracted.due_date != null && String(extracted.due_date).trim()) {
        lines.push(`  Fälligkeitsdatum:  ${extracted.due_date}`);
    }
    if (typeof extracted.total_net === 'number' && !Number.isNaN(extracted.total_net)) {
        lines.push(`  Betrag (Netto):    ${extracted.total_net}`);
    }
    if (typeof extracted.total_gross === 'number' && !Number.isNaN(extracted.total_gross)) {
        lines.push(`  Betrag (Brutto):   ${extracted.total_gross}`);
    }
    if (typeof extracted.tax_amount === 'number' && !Number.isNaN(extracted.tax_amount)) {
        lines.push(`  Umsatzsteuer:      ${extracted.tax_amount}`);
    }
    if (extracted.tax_rate != null && String(extracted.tax_rate).trim()) {
        lines.push(`  Steuersatz:       ${extracted.tax_rate}`);
    }
    if (extracted.customer_number != null && String(extracted.customer_number).trim()) {
        lines.push(`  Kundennummer:      ${extracted.customer_number}`);
    }
    if (extracted.service_period_start != null && String(extracted.service_period_start).trim()) {
        lines.push(`  Leistungszeitraum: ${extracted.service_period_start} – ${extracted.service_period_end ?? '?'}`);
    }
    return lines;
}

export async function onDocumentProcessedInteractive(info: ExtractInvoiceFieldsProcessedInfo): Promise<void> {
    const label = info.fileName || info.title || `#${info.documentId}`;
    console.log('');
    console.log(`--- Document #${info.documentId}: ${label} ---`);
    const lines = formatExtractedForDisplay(info.extracted);
    if (lines.length > 0) {
        console.log(lines.join('\n'));
    } else {
        console.log('  (no fields extracted)');
    }
    console.log(info.updated ? '  → Saved to Paperless.' : '  → Dry-run (not saved).');
    console.log('');
    const { input } = await interactivePrompts();
    await input({ message: 'Press Enter to continue to next document', default: '' });
}
