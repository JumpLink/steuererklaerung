/**
 * Manifest section schema: top-level `fints` (the global FinTS/HBCI bank accounts).
 *
 * This module OWNS the former `fints-config.json` schema, its inferred types, and the pure runtime
 * helpers ({@link getPin}, {@link getDataDir}, {@link getDataFilePath}, {@link getAccountConfig}) —
 * the standalone `fints-config.ts` loader is gone; the accounts now live inline under the manifest's
 * `fints` key. The PIN is NEVER part of the payload — it stays in the environment (FINTS_PIN_<name>),
 * as do the FinTS data-directory location (FINTS_DATA_DIR).
 */

import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../../lib/errors.ts';

const FinTSAccountSchema = z.object({
    name: z.string().min(1, 'Account name is required'),
    url: z.string().url('Must be a valid FinTS server URL'),
    blz: z.string().min(8).max(8, 'BLZ must be exactly 8 digits'),
    user_id: z.string().min(1, 'User ID is required'),
    product_id: z
        .string()
        .min(1, 'Product ID is required (register at https://www.fints.org/de/hersteller/produktregistrierung)'),
    product_version: z.string().default('1.0'),
    tan_method_id: z.number().int().optional(),
    tan_media_name: z.string().optional(),
    customer_id: z.string().optional(),
});

export const FinTSConfigSchema = z.object({
    accounts: z.array(FinTSAccountSchema).min(1, 'At least one account must be configured'),
});

export type FinTSAccountConfig = z.infer<typeof FinTSAccountSchema>;
export type FinTSConfig = z.infer<typeof FinTSConfigSchema>;

/** The inline manifest section is formgleich with the former fints-config.json. */
export const FinTSSectionSchema = FinTSConfigSchema;
export type FinTSSection = z.infer<typeof FinTSSectionSchema>;

export function getDataDir(): string {
    return process.env.FINTS_DATA_DIR ?? join(process.cwd(), 'fints-data');
}

export function getDataFilePath(accountName: string): string {
    const safeName = accountName.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    return join(getDataDir(), `${safeName}.json`);
}

/**
 * Resolve PIN from environment variable FINTS_PIN_<normalized_name>.
 * Returns undefined if not set (caller should prompt interactively).
 */
export function getPin(account: FinTSAccountConfig): string | undefined {
    const envKey = `FINTS_PIN_${account.name.replace(/[-\s]/g, '_').toLowerCase()}`;
    return process.env[envKey] || undefined;
}

/**
 * Get a specific account config by name, or the only account if name is omitted.
 */
export function getAccountConfig(config: FinTSConfig, name?: string): FinTSAccountConfig {
    if (name) {
        const account = config.accounts.find((a) => a.name === name);
        if (!account) {
            const available = config.accounts.map((a) => a.name).join(', ');
            throw new ConfigError(`Account "${name}" not found in FinTS config. Available: ${available}`);
        }
        return account;
    }

    if (config.accounts.length === 1) {
        return config.accounts[0];
    }

    const available = config.accounts.map((a) => a.name).join(', ');
    throw new ConfigError(`Multiple accounts configured. Use --account <name> to select one. Available: ${available}`);
}
