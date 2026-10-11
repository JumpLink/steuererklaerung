# Contracts: prior art

Question: what do existing tools do with recurring contracts (Verträge, subscriptions, bills), and
what should this app take from them for its own contract management?

Retrieved 2026-10-11. Two open-source projects are read from source, pinned as shallow submodules
under [`refs/firefly-iii`](../../refs/firefly-iii) and [`refs/wallos`](../../refs/wallos); file
paths below are relative to those. Two cancellation services are read from their public pages
only. The legal notes cite secondary sources and are background, not legal advice.

## Takeaways

1. **Model term, renewal and notice separately.** A contract has an initial term, a renewal rule
   (fixed period, or indefinite) and a notice period. The latest notice date is derived — the
   current term end minus the notice period — never stored. Neither open-source tool models this;
   both only store a single end or cancellation date.
2. **Matching is a rule, not a field.** Firefly III moved bill matching out of the bill into its
   rule engine (text contains + amount window). For bank debits the strong keys are creditor ID
   and mandate reference; amount and text are a fallback.
3. **Expected vs. seen payments is the core finding.** Firefly III computes the expected dates in a
   period and subtracts the paid ones; what is left and old enough is overdue. Add the two cases a
   SEPA account sees: a returned direct debit and a changed amount.
4. **One list, few numbers, strong filters.** Wallos stays readable because each entry shows four
   facts (name, price, cycle, next date) and everything else is a filter or a sort.
5. **A cancellation is a process with proof.** Both services track sending, the shipping proof and
   the provider's confirmation as separate states, with a follow-up when no confirmation arrives.

## Firefly III — bills and recurring transactions

Concepts only; the UI is not a model for this app.

- **Bill** (`app/Models/Bill.php`): name, `amount_min`/`amount_max` (an amount window, not one
  amount), `date` as the anchor, `repeat_freq` (daily, weekly, monthly, quarterly, half-year,
  yearly — `config/firefly.php`), `skip` (only every n-th period), `active`, `end_date` and
  `extension_date`. The UI text for `extension_date` reads "must be extended or cancelled on or
  before" (`resources/lang/en_US/firefly.php`) — the closest it gets to a notice deadline, entered
  by hand.
- **Matching** used to live on the bill (`match` keywords). The upgrade command
  `app/Console/Commands/Upgrade/UpgradesBillsToRules.php` turns each bill into a rule with triggers
  `description_contains` plus `amount_exactly` or `amount_less`/`amount_more`, and the action
  `link_to_bill`. Lesson: a link is a decision; the rule only proposes it.
- **Expected dates** (`app/Support/Models/BillDateCalculator.php`): from anchor, frequency and skip
  it lists the `pay_dates` in a window; `paid_dates` are the linked transactions. Month ends are
  clamped (a bill on the 31st is due on the 30th in a 30-day month). The API enrichment
  (`app/Support/JsonApi/Enrichments/SubscriptionEnrichment.php`) adds `next_expected_match`.
- **Overdue**: expected minus paid is non-empty and the earliest open date lies at least six days
  back — a hard-coded grace period with a FIXME. A tolerance in days belongs in the data.
- **Warnings** before `end_date`/`extension_date` at 90, 30, 14, 7 and 0 days
  (`app/Jobs/WarnAboutBills.php`, `bill_reminder_periods` in `config/firefly.php`).
- **Recurring transactions** (`app/Models/RecurrenceRepetition.php`) are the generating side
  (create a booking), not the checking side. Useful detail: weekend handling (do nothing, skip,
  previous Friday, next Monday) and repeat forever / until a date / n times.

## Wallos — subscriptions

Data model (`db/wallos.empty.db`, `migrations/*.php`):

- **subscriptions**: name, logo, price, currency, `next_payment`, `cycle` (daily, weekly, monthly,
  yearly, one-time) × `frequency` (every n), notes, `payment_method_id`, `payer_user_id` (a
  household member), `category_id`, `notify` + `notify_days_before`, `cancellation_date`,
  `auto_renew`, `start_date`, `inactive`, `url`, `replacement_subscription_id` (what replaced a
  cancelled one).
- Lookup tables for **categories** (ordered), **payment methods** (enabled, ordered, icon) and
  **household** members. A category is the user's own word, not a tax category.
- **Monthly normalisation** (`getPricePerMonth` in `includes/stats_calculations.php`): daily ×30,
  weekly ×4.35, monthly, yearly ÷12, each divided by the frequency; one-time counts zero.
- **Upcoming cancellations** with their monthly value (`includes/upcoming_cancellations.php`).

### What makes the Wallos UI clear

Input for a later GTK page (screenshots in `screenshots/wallos-subscriptions-light.png`,
`wallos-dashboard-light.png`, `wallos-stats.png`):

- **Each entry shows four facts**: logo, name, a large price with its cycle, the next date. The
  payment method is a small icon. Everything else opens on demand.
- **Inactive entries stay in the list**, greyed out with a struck-through price — history is
  visible without a second screen. One-time purchases get their own section.
- **One toolbar**: search, filter, sort, list/card toggle. Filters
  (`includes/filters_menu.php`): member, category, payment method, state, renewal type (auto,
  manual, one-time), notifications. Sorts (`includes/sort_options.php`): name, next payment,
  price, category, member, payment method, state, renewal type, last added.
- **The dashboard answers "what needs me"**: overdue renewals, upcoming payments, amount due this
  month — no charts on the first screen.
- **Stats are a separate page** of single-number tiles (active count, monthly and yearly cost,
  cost per day, most and least expensive) plus one 12-month projection.

For a GTK page this maps to an `AdwPreferencesGroup`/boxed list with one row per contract, the
amount as a suffix, a subtitle with cycle and next date, and the notice deadline as a badge when
it is close.

## Volders — cancellation service

Public pages only.

- **Ordinary vs. extraordinary** cancellation: ordinary at the term end with the notice period;
  extraordinary for an important reason (§ 314 BGB) ([anbieter-kuendigen](https://www.volders.de/anbieter-kuendigen)).
- **Deadline calculation**, worked example on the same page: a 24-month contract from 01.05.2018
  with three months' notice must be cancelled by 31.01.2020. What counts is the date the provider
  receives the notice, not the sending date. Text form is usually enough.
- **Sonderkündigung** on a price increase (mobile, [handyvertrag-kuendigen](https://www.volders.de/handyvertrag-kuendigen));
  motor insurance within one month of the price-increase letter, ordinary by 30 November
  ([kfz-versicherung-kuendigen](https://www.volders.de/kfz-versicherung-kuendigen)). Other
  insurance: three months before the end of the insurance year
  ([versicherung-kuendigen](https://www.volders.de/versicherung-kuendigen)).
- **Flow**: template → e-signature → send by fax, e-mail, letter or registered mail → shipping
  confirmation by e-mail and as a download → the provider confirms, which can take up to 28 days.

## Aboalarm — cancellation service

Public pages only.

- The user receives a **shipping proof**; the **cancellation confirmation** comes from the
  provider, usually within 21 days, with no legal duty to send one. Follow up after three weeks
  ([help centre](https://aboalarm.zendesk.com/hc/de)).
- **Guarantee terms**: send at least four working days before the deadline; no confirmation within
  four weeks → contact support; a reminder after 14 days
  ([kuendigungsgarantie](https://www.aboalarm.de/kuendigungsgarantie)).
- A free **cancellation reminder**: the user enters start, end and notice period and gets an
  e-mail on a chosen day. A **contract check** reads bank debits and lets the user decide per
  debit: cancel, save a reminder, or ignore ([ADAC-Aboalarm AGB](https://adac.aboalarm.de/agb)).
  The ignore decision is what keeps a matcher quiet the next time.

## Legal background (secondary sources)

From [vertrag-kuendigen.com](https://vertrag-kuendigen.com/ratgeber/automatische-vertragsverlaengerung/)
and [e-recht24.de](https://www.e-recht24.de/ecommerce/13100-vertragslaufzeit-und-kuendigungsbutton.html):

- Consumer contracts concluded from 1 March 2022: initial term at most 24 months; after it, a
  tacit renewal only for an indefinite period, cancellable at any time with at most one month's
  notice (§ 309 Nr. 9 BGB).
- Older contracts: renewal by up to one year, notice up to three months.
- Telecommunications: cancellable with one month after the initial term (§ 56 TKG), special right
  on contract changes (§ 57 TKG). Insurance: § 11 VVG.
- A deadline that falls on a weekend does not move (cited there as BGH III ZR 172/04).

**Consequence for the data model**: store initial term, renewal period (or "indefinite") and
notice period as separate fields. "Indefinite" means the latest notice date rolls forward: today
plus the notice period, to the next possible end.

## For this app

| Concept | Source | Take it? |
|---|---|---|
| Amount window (min/max or ± tolerance) | Firefly III | Yes, as amount + tolerance |
| Cycle × every-n | Firefly III, Wallos | Yes; reuse the existing series intervals |
| Expected minus seen payments | Firefly III | Yes, with a tolerance in days from the data |
| Matching as a proposal, link as a decision | Firefly III rules, Aboalarm ignore | Yes: link and reject per transaction |
| Creditor ID / mandate reference keys | SEPA practice | Yes, stronger than text |
| Returned and changed payments | not in either tool | Yes, as findings |
| Term / renewal / notice separately | legal background | Yes |
| User category, payment method | Wallos | Yes, as plain text fields |
| Household member as payer | Wallos | No; this app uses entities and accounts |
| Logo, currency per entry | Wallos | No for now |
| Cancellation letter, shipping proof, confirmation | Volders, Aboalarm | Later step |
