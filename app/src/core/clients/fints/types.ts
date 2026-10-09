/**
 * FinTS type re-exports and wrapper types for CLI consumption.
 *
 * TanMethod and DecoupledParams are not re-exported from lib-fints barrel,
 * so we infer them from FinTSConfig.
 */

import type { FinTSConfig } from 'lib-fints';

export type { BankingInformation, BankMessage } from 'lib-fints';

export type { BankAccount, AccountType } from 'lib-fints';

export type { AccountBalance } from 'lib-fints';

export type { Statement, Transaction, Balance } from 'lib-fints';

export type { ClientResponse, StatementResponse, AccountBalanceResponse, SynchronizeResponse } from 'lib-fints';

/** Inferred TanMethod type from FinTSConfig.availableTanMethods */
export type TanMethod = ReturnType<FinTSConfig['selectTanMethod']>;

/** Inferred DecoupledParams from TanMethod */
export type DecoupledParams = NonNullable<TanMethod['decoupled']>;
