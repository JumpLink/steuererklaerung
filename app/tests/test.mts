// Test entry: aggregates every *.test.ts suite (each a default-exported async
// fn) and runs them under @gjsify/unit. Built with `gjsify build tests/test.mts`
// for Node and GJS. Keep this list in sync when adding a test file.
import { run } from '@gjsify/unit';

import './helpers/isolate-env.ts';

import kredit from './unit/finanzierung/kredit.test.ts';
import finanzierung from './unit/finanzierung/finanzierung.test.ts';

import paypalParser from './unit/clients/paypal-parser.test.ts';
import llmFactory from './unit/clients/llm-factory.test.ts';
import qontoRequest from './unit/clients/qonto-request.test.ts';
import requestTimeouts from './unit/clients/request-timeouts.test.ts';
import fintsInteraction from './unit/clients/fints-interaction.test.ts';
import llmAuthErrors from './unit/clients/llm-auth-errors.test.ts';
import clientInvoices from './unit/clients/qonto/client-invoices.test.ts';

import elsterConfig from './unit/config/elster-config.test.ts';
import configWriters from './unit/config/config-writers.test.ts';
import bmfImport from './unit/config/bmf-import.test.ts';
import syncConfig from './unit/config/sync-config.test.ts';
import workspace from './unit/config/workspace.test.ts';
import configManifest from './unit/config/config-manifest.test.ts';
import exampleManifest from './unit/config/example-manifest.test.ts';
import testIsolation from './unit/lib/test-isolation.test.ts';
import renameFallback from './unit/config/rename-fallback.test.ts';
import userSettings from './unit/config/user-settings.test.ts';
import configLifecycle from './unit/config/lifecycle.test.ts';
import migrateForward from './unit/config/migrate-forward.test.ts';
import manifestRevisionSuite from './unit/config/manifest-revision.test.ts';
import ledgerOpen from './unit/lib/ledger-open.test.ts';
import paths from './unit/config/paths.test.ts';
import importBatches from './unit/actions/import-batches.test.ts';
import classificationRules from './unit/actions/classification-rules.test.ts';
import recurringPeriod from './unit/actions/recurring-period.test.ts';
import recurringEmail from './unit/actions/recurring-email.test.ts';
import reconcileInvoices from './unit/invoices/reconcile.test.ts';
import recurringSchedules from './unit/actions/recurring-schedules.test.ts';
import sendInvoiceEmail from './unit/actions/send-invoice-email.test.ts';
import syncPlan from './unit/sync/sync-plan.test.ts';
import syncService from './unit/sync/sync-service.test.ts';
import qontoGate from './unit/invoices/qonto-gate.test.ts';
import invoiceMail from './unit/mail/invoice-mail.test.ts';
import invoiceMailE2e from './unit/mail/invoice-mail-e2e.test.ts';
import desktopMailSender from './unit/mail/desktop-mail-sender.test.ts';
import estKinder from './unit/actions/est-kinder.test.ts';
import validateSteuernummer from './unit/actions/validate-steuernummer.test.ts';
import storeReceipt from './unit/actions/store-receipt.test.ts';
import dokumentRegeln from './unit/dokumentregeln/regeln.test.ts';
import paperlessErklaerung from './unit/dokumentregeln/paperless-erklaerung.test.ts';
import dokumentRegelnFlow from './unit/dokumentregeln/dokumentregeln-flow.test.ts';
import mailEingangMime from './unit/mail-eingang/mime.test.ts';
import mailEingangAbruf from './unit/mail-eingang/abruf.test.ts';
import imapClient from './unit/clients/imap-client.test.ts';
import elsterSection from './unit/config/elster-section.test.ts';
import slug from './unit/config/slug.test.ts';

import presentersWorkspace from './unit/presenters/workspace.test.ts';
import presentersSession from './unit/presenters/session.test.ts';
import presentersFreiVerfuegbar from './unit/presenters/frei-verfuegbar-presenter.test.ts';
import presentersBuchungen from './unit/presenters/buchungen.test.ts';
import presentersBelege from './unit/presenters/belege.test.ts';
import presentersRechnungen from './unit/presenters/rechnungen.test.ts';
import presentersKonten from './unit/presenters/konten.test.ts';
import presentersZeiten from './unit/presenters/zeiten.test.ts';

import afa from './unit/lib/afa.test.ts';
import glossary from './unit/lib/glossary.test.ts';
import autoLink from './unit/lib/auto-link.test.ts';
import belegReview from './unit/actions/beleg-review.test.ts';
import estTarif from './unit/lib/est-tarif.test.ts';
import estBerechnung from './unit/lib/est-berechnung.test.ts';
import estAggregate from './unit/lib/est-aggregate.test.ts';
import estIntake from './unit/lib/est-intake.test.ts';
import estPlan from './unit/lib/est-plan.test.ts';
import estXml from './unit/lib/est-xml.test.ts';
import betriebsaufgabe from './unit/lib/betriebsaufgabe.test.ts';
import bwa from './unit/lib/bwa.test.ts';
import chartsGeometry from './unit/lib/charts-geometry.test.ts';
import dateUtils from './unit/lib/date-utils.test.ts';
import euerAggregate from './unit/lib/euer-aggregate.test.ts';
import euerTransactions from './unit/lib/euer-transactions.test.ts';
import euerAdjustments from './unit/lib/euer-adjustments.test.ts';
import explainFigure from './unit/lib/explain.test.ts';
import errorsTyped from './unit/lib/errors.test.ts';
import euerXml from './unit/lib/euer-xml.test.ts';
import feststellung from './unit/lib/feststellung.test.ts';
import feststellungXml from './unit/lib/feststellung-xml.test.ts';
import fristen from './unit/lib/fristen.test.ts';
import steuertermine from './unit/elster/steuertermine.test.ts';
import homeModel from './unit/elster/home.test.ts';
import doppelzahlung from './unit/invoices/doppelzahlung.test.ts';
import doppelzahlungText from './unit/invoices/doppelzahlung-text.test.ts';
import doppelzahlungSchema from './unit/config/doppelzahlung-schema.test.ts';
import steuerzahlungen from './unit/elster/steuerzahlungen.test.ts';
import freiVerfuegbar from './unit/elster/frei-verfuegbar.test.ts';
import steuerkontoScope from './unit/elster/steuerkonto-scope.test.ts';
import yearHinweise from './unit/elster/year-hinweise.test.ts';
import kontoauszug from './unit/elster/kontoauszug.test.ts';
import hinweiseHandlung from './unit/elster/hinweise-handlung.test.ts';
import geldPruefungen from './unit/elster/geld-pruefungen.test.ts';
import laufendeKosten from './unit/elster/laufende-kosten.test.ts';
import zuPruefen from './unit/elster/zu-pruefen.test.ts';
import erstattung from './unit/elster/erstattung.test.ts';
import splitbuchung from './unit/elster/splitbuchung.test.ts';
import ustvaBuchungen from './unit/elster/ustva-buchungen.test.ts';
import projektErgebnis from './unit/elster/projekt-ergebnis.test.ts';
import vorAbgabe from './unit/elster/vor-abgabe.test.ts';
import crossChecks from './unit/elster/cross-checks.test.ts';
import filingSnapshots from './unit/elster/snapshots.test.ts';
import filingSignoffs from './unit/elster/signoffs.test.ts';
import ericSend from './unit/elster/eric-send.test.ts';
import submitFiling from './unit/elster/submit.test.ts';
import stammdaten from './unit/elster/stammdaten.test.ts';
import filingKeys from './unit/elster/filing-keys.test.ts';
import webFiling from './unit/elster/web-filing.test.ts';
import parseElsterArgsTest from './unit/elster/parse-elster-args.test.ts';
import edsEnvelope from './unit/elster/eds-envelope.test.ts';
import storeRoot from './unit/lib/store-root.test.ts';
import kontoabfrage from './unit/elster/kontoabfrage.test.ts';
import docApportion from './unit/elster/doc-apportion.test.ts';
import filings from './unit/lib/filings.test.ts';
import snapshotPeriod from './unit/lib/snapshot-period.test.ts';
import zve from './unit/lib/zve.test.ts';
import umsatzAufstellung from './unit/lib/umsatz-aufstellung.test.ts';
import steuerblattPdf from './unit/lib/steuerblatt-pdf.test.ts';
import reverseCharge from './unit/lib/reverse-charge.test.ts';
import ics from './unit/lib/ics.test.ts';
import gewst from './unit/lib/gewst.test.ts';
import gewstXml from './unit/lib/gewst-xml.test.ts';
import hinweise from './unit/lib/hinweise.test.ts';
import paypalEnrich from './unit/lib/paypal-enrich.test.ts';
import periods from './unit/lib/periods.test.ts';
import qontoExportEnrich from './unit/lib/qonto-export-enrich.test.ts';
import amazonEnrich from './unit/lib/amazon-enrich.test.ts';
import ledger from './unit/lib/ledger.test.ts';
import invoiceMailLog from './unit/lib/invoice-mail-log.test.ts';
import invoiceReminders from './unit/lib/invoice-reminders.test.ts';
import forderungen from './unit/invoices/forderungen.test.ts';
import sqliteBinding from './unit/lib/sqlite-binding.test.ts';
import contacts from './unit/lib/contacts.test.ts';
import classifications from './unit/lib/classifications.test.ts';
import steuernummer from './unit/lib/steuernummer.test.ts';
import usteAggregate from './unit/lib/uste-aggregate.test.ts';
import usteXml from './unit/lib/uste-xml.test.ts';
import vordruckLines from './unit/lib/vordruck-lines.test.ts';
import wizard from './unit/lib/wizard.test.ts';
import llmJson from './unit/lib/llm-json.test.ts';
import moneyHelpers from './unit/lib/money-helpers.test.ts';
import qontoCategories from './unit/lib/qonto-categories.test.ts';
import pagination from './unit/lib/pagination.test.ts';
import params from './unit/lib/params.test.ts';
import parsing from './unit/lib/parsing.test.ts';
import promptDrift from './unit/lib/prompt-drift.test.ts';
import reconcile from './unit/lib/reconcile.test.ts';
import reconcileStore from './unit/lib/reconcile-store.test.ts';
import linkCandidates from './unit/lib/link-candidates.test.ts';
import selectTaxHelpers from './unit/lib/select-tax-helpers.test.ts';
import customFieldCoercion from './unit/lib/custom-field-coercion.test.ts';
import sepaQr from './unit/lib/sepa-qr.test.ts';
import transactions from './unit/lib/transactions.test.ts';
import ustvaXml from './unit/lib/ustva-xml.test.ts';
import txView from './unit/web/tx-view.test.ts';
import chatContext from './unit/web/chat.test.ts';
import chatAgent from './unit/web/chat-agent.test.ts';
import accountsWeb from './unit/web/accounts.test.ts';
import dms from './unit/dms/dms.test.ts';
import reviewMetadataNote from './unit/paperless/review-metadata-note.test.ts';
import paperlessUploadTools from './unit/paperless/upload-tools.test.ts';
import paperlessApiVersion from './unit/paperless/api-version.test.ts';
import recurringInvoices from './unit/invoices/recurring.test.ts';
import recurringReminder from './unit/invoices/recurring-reminder.test.ts';
import headerTemplate from './unit/invoices/header-template.test.ts';
import projectAddressing from './unit/invoices/project-addressing.test.ts';
import projects from './unit/actions/projects.test.ts';
import projektZuordnung from './unit/actions/projekt-zuordnung.test.ts';
import rechnungProjekt from './unit/actions/rechnung-projekt.test.ts';
import projektPresenter from './unit/presenters/projekt.test.ts';
import outgoingInvoiceProvider from './unit/invoices/provider.test.ts';
import oneOffOutgoingInvoices from './unit/invoices/outgoing-invoices.test.ts';
import invoiceStoreTotals from './unit/invoices/store-totals.test.ts';
import invoiceStoreValidate from './unit/invoices/store-validate.test.ts';
import invoiceStoreRepo from './unit/invoices/store-repo.test.ts';
import invoiceIssuer from './unit/invoices/issuer.test.ts';
import eRechnungLesen from './unit/invoices/e-rechnung.test.ts';
import invoiceCiiXml from './unit/invoices/cii-xml.test.ts';
import invoicePdfModel from './unit/invoices/pdf-model.test.ts';
import selfInvoiceProvider from './unit/invoices/self-provider.test.ts';
import invoiceStatus from './unit/invoices/status.test.ts';
import invoiceForm from './unit/invoices/form.test.ts';
import invoiceActions from './unit/invoices/actions.test.ts';
import ohneKi from './unit/ai/ohne-ki.test.ts';

import timeStoreRepo from './unit/time/store-repo.test.ts';
import timeImport from './unit/actions/time-import.test.ts';
import timeInvoice from './unit/actions/time-invoice.test.ts';

run({
    timeStoreRepo,
    timeImport,
    timeInvoice,
    paypalParser,
    llmFactory,
    qontoRequest,
    requestTimeouts,
    fintsInteraction,
    llmAuthErrors,
    clientInvoices,
    elsterConfig,
    configWriters,
    bmfImport,
    syncConfig,
    workspace,
    configManifest,
    exampleManifest,
    renameFallback,
    userSettings,
    configLifecycle,
    migrateForward,
    manifestRevisionSuite,
    ledgerOpen,
    paths,
    importBatches,
    classificationRules,
    recurringPeriod,
    recurringEmail,
    reconcileInvoices,
    recurringSchedules,
    sendInvoiceEmail,
    syncPlan,
    syncService,
    qontoGate,
    invoiceMail,
    invoiceMailE2e,
    desktopMailSender,
    estKinder,
    validateSteuernummer,
    storeReceipt,
    dokumentRegeln,
    paperlessErklaerung,
    dokumentRegelnFlow,
    mailEingangMime,
    mailEingangAbruf,
    imapClient,
    elsterSection,
    slug,
    presentersWorkspace,
    presentersSession,
    presentersFreiVerfuegbar,
    presentersBuchungen,
    presentersBelege,
    presentersRechnungen,
    presentersKonten,
    presentersZeiten,
    afa,
    glossary,
    autoLink,
    belegReview,
    estTarif,
    estBerechnung,
    estAggregate,
    estIntake,
    estPlan,
    estXml,
    betriebsaufgabe,
    bwa,
    chartsGeometry,
    dateUtils,
    euerAggregate,
    euerTransactions,
    euerAdjustments,
    explainFigure,
    errorsTyped,
    euerXml,
    feststellung,
    feststellungXml,
    fristen,
    steuertermine,
    homeModel,
    doppelzahlung,
    doppelzahlungText,
    doppelzahlungSchema,
    forderungen,
    invoiceReminders,
    steuerzahlungen,
    freiVerfuegbar,
    steuerkontoScope,
    yearHinweise,
    kontoauszug,
    hinweiseHandlung,
    geldPruefungen,
    laufendeKosten,
    zuPruefen,
    erstattung,
    splitbuchung,
    ustvaBuchungen,
    projektErgebnis,
    vorAbgabe,
    crossChecks,
    filingSnapshots,
    filingSignoffs,
    ericSend,
    submitFiling,
    stammdaten,
    filingKeys,
    webFiling,
    parseElsterArgsTest,
    edsEnvelope,
    storeRoot,
    kontoabfrage,
    docApportion,
    filings,
    snapshotPeriod,
    zve,
    umsatzAufstellung,
    steuerblattPdf,
    reverseCharge,
    ics,
    gewst,
    gewstXml,
    hinweise,
    paypalEnrich,
    periods,
    qontoExportEnrich,
    amazonEnrich,
    ledger,
    invoiceMailLog,
    sqliteBinding,
    contacts,
    classifications,
    steuernummer,
    usteAggregate,
    usteXml,
    vordruckLines,
    wizard,
    llmJson,
    moneyHelpers,
    qontoCategories,
    pagination,
    params,
    parsing,
    promptDrift,
    reconcile,
    reconcileStore,
    linkCandidates,
    selectTaxHelpers,
    customFieldCoercion,
    sepaQr,
    transactions,
    ustvaXml,
    txView,
    chatContext,
    chatAgent,
    accountsWeb,
    dms,
    reviewMetadataNote,
    paperlessUploadTools,
    paperlessApiVersion,
    recurringInvoices,
    recurringReminder,
    headerTemplate,
    projectAddressing,
    projects,
    projektZuordnung,
    projektPresenter,
    rechnungProjekt,
    outgoingInvoiceProvider,
    oneOffOutgoingInvoices,
    invoiceStoreTotals,
    invoiceStoreValidate,
    invoiceStoreRepo,
    invoiceIssuer,
    invoiceCiiXml,
    eRechnungLesen,
    invoicePdfModel,
    selfInvoiceProvider,
    invoiceStatus,
    invoiceForm,
    invoiceActions,
    ohneKi,
    kredit,
    finanzierung,
    testIsolation,
});
