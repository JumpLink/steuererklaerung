# Qonto API Scopes

Reference for Qonto OAuth scopes used by the CLI for document sync and tax automation.

**Official docs:** [Available scopes](https://docs.qonto.com/get-started/business-api/authentication/oauth/available-scopes)

## All Available Scopes

| Scope | Description |
|-------|-------------|
| `organization.read` | Balance, IBAN, transactions, organization, team |
| `attachment.read` | Read/export attachments |
| `attachment.write` | Upload attachments, remove from transactions |
| `supplier_invoice.read` | List supplier invoices |
| `supplier_invoice.write` | Create supplier invoices |
| `client_invoices.read` | Read client invoices, quotes, credit notes |
| `client_invoice.write` | Create/update client invoices, quotes |
| `client.read` | Read customer data |
| `client.write` | Create, update, delete customers |
| `einvoicing.read` | Read e-invoicing settings |
| `webhook` | Manage webhooks (list, create, get, update, delete) |
| `offline_access` | Long-lived tokens (refresh) for background automation |
| `payment.write` | Execute payments, manage recipients (SEPA, external) |
| `internal_transfer.write` | Internal transfers between accounts |
| `international_transfer.write` | International transfers |
| `membership.read` | Read own membership data (identity, role) |
| `membership.write` | Invite members |
| `team.read` | List teams |
| `team.write` | Create teams |
| `card.read` | Read card details |
| `card.write` | Create, block, discard cards |
| `insurance_contract.read` | Read insurance contracts |
| `insurance_contract.write` | Create/update insurance contracts |
| `request_review.write` | Approve/reject requests |
| `request_transfers.write` | Create multi-transfer requests |
| `request_cards.write` | Create card requests (flash/virtual) |
| `bank_account.write` | Create, update, close business accounts |
| `beneficiary.trust` | Mark/unmark recipients as trusted |
| `payment_link.read` | Read payment links, connection status, payments |
| `payment_link.write` | Create, deactivate payment links, connect provider |

## Recommended Scopes for Document Sync

### Required (core functionality)

| Scope | Reason |
|-------|--------|
| `organization.read` | Transactions, accounts, organization - basis for all sync and booking logic |
| `attachment.read` | Read attachments from Qonto for sync to Paperless / accounting software |
| `attachment.write` | Upload attachments to Qonto transactions (e.g. from Paperless) |
| `offline_access` | Background automation without re-login (refresh token) |
| `webhook` | Receive changes (transactions, attachments) in near real-time |

### Important for invoicing and tax

| Scope | Reason |
|-------|--------|
| `supplier_invoice.read` | Supplier invoices for sync and tax/USt-VA |
| `supplier_invoice.write` | Optional: create supplier invoices in Qonto (e.g. from Paperless) |
| `client_invoices.read` | Outgoing invoices/quotes/credit notes for accounting and tax |
| `client_invoice.write` | Optional: create/update invoices in Qonto |
| `client.read` | Customer data for invoice assignment |
| `client.write` | Optional: manage customers in Qonto |
| `einvoicing.read` | E-invoicing settings for correct automation |

### Optional (only if needed)

| Scope | When useful |
|-------|------------|
| `payment.write` | Only if payments (SEPA etc.) should be triggered automatically |
| `card.read` | Only if card info is needed for assignment/reporting |
| `membership.read` | Only if roles/identity are needed for permissions |
| `team.read` | Only for team-based workflows |

### Typically not needed

- `internal_transfer.write`, `international_transfer.write` - unless automated transfers are planned
- `membership.write`, `team.write`, `bank_account.write` - account/team management
- `card.write`, `insurance_contract.*`, `request_*`, `beneficiary.trust`, `payment_link.*` - unless explicitly planned
