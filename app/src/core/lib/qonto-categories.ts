/**
 * German display labels for Qonto transaction categories (the snake_case enum stored on
 * transactions, e.g. `other_expense`, `online_service`). Keeps the raw key as the grouping/matching
 * identity while front-ends render a readable label. Unmapped keys fall back to a humanised form
 * (underscores → spaces, capitalised), so a new Qonto category still shows something sensible.
 */

const QONTO_CATEGORY_LABELS: Record<string, string> = {
    atm: 'Bargeld (Automat)',
    deposit: 'Einzahlung',
    fees: 'Gebühren',
    finance: 'Finanzen',
    gas_station: 'Tankstelle',
    hardware_and_equipment: 'Hardware & Ausstattung',
    hotel_and_lodging: 'Übernachtung',
    insurance: 'Versicherung',
    it_and_electronics: 'IT & Elektronik',
    legal_and_accounting: 'Recht & Beratung',
    logistics: 'Logistik',
    manufacturing: 'Fertigung',
    marketing: 'Marketing',
    meals: 'Verpflegung',
    office_rental: 'Büromiete',
    online_service: 'Online-Dienste',
    other_expense: 'Sonstige Ausgaben',
    other_income: 'Sonstige Einnahmen',
    other_service: 'Sonstige Dienstleistungen',
    refund: 'Erstattung',
    rent_and_charges: 'Miete & Nebenkosten',
    restaurant_and_bar: 'Restaurant & Bar',
    salary: 'Gehälter',
    sales: 'Umsätze',
    subcontractor: 'Subunternehmer',
    subscription: 'Abonnements',
    tax: 'Steuern',
    transport: 'Transport & Reise',
    treasury_and_interco: 'Treasury / Verrechnung',
    utility: 'Nebenkosten / Versorger',
    voucher: 'Gutschein',
    gift: 'Geschenk',
};

/** Humanise an unmapped snake_case key: `other_service` → `Other Service`. */
export function humanizeKey(key: string): string {
    return key
        .split('_')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/**
 * The German display label for a Qonto category key. Already-German values (e.g. the `'Sonstige'`
 * fallback the home aggregate uses when a transaction has no category) pass through unchanged.
 */
export function qontoCategoryLabel(key: string): string {
    if (QONTO_CATEGORY_LABELS[key]) return QONTO_CATEGORY_LABELS[key];
    return /[_a-z]/.test(key) && key === key.toLowerCase() ? humanizeKey(key) : key;
}

/** German labels for Qonto transaction `operation_type` values (shown when there's no counterparty/purpose). */
const QONTO_OPERATION_TYPE_LABELS: Record<string, string> = {
    transfer: 'Überweisung',
    income: 'Zahlungseingang',
    swift_income: 'Auslandseingang (SWIFT)',
    card: 'Kartenzahlung',
    direct_debit: 'Lastschrift',
    direct_debit_hold: 'Lastschrift (vorgemerkt)',
    qonto_fee: 'Qonto-Gebühr',
    fee: 'Gebühr',
    cheque: 'Scheck',
    recall: 'Rücklastschrift',
    pagopa_payment: 'PagoPA-Zahlung',
    biller: 'Rechnungszahlung',
    credit_note: 'Gutschrift',
};

/** German label for a Qonto `operation_type` (humanised fallback for unmapped values). */
export function qontoOperationTypeLabel(type: string): string {
    return QONTO_OPERATION_TYPE_LABELS[type] ?? humanizeKey(type);
}
