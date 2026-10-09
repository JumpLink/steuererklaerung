import { describe, it, expect, vi, afterEach } from '@gjsify/unit';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerDbPath } from '@steuererklaerung/store';
import { applyDemoEnv, demoDir } from '../../../src/core/config/demo.ts';
import { TEST_SANDBOX } from '../../helpers/isolate-env.ts';

/**
 * Neither the demo mode nor a test run may open the real ledger. Registered LAST in `test.mts`, so a
 * suite that cleared the override instead of restoring it is caught here.
 */
export default async () => {
    await describe('ledger isolation', async () => {
        afterEach(() => {
            vi.unstubAllEnvs();
        });

        await it('the test run uses a ledger under the temp directory, never transactions-data/', async () => {
            const path = ledgerDbPath();
            expect(path.startsWith(tmpdir())).toBe(true);
            expect(path.startsWith(TEST_SANDBOX)).toBe(true);
        });

        await it('demo mode points the ledger and the store into app/demo', async () => {
            vi.stubEnv('STEUER_DEMO', '1');
            vi.stubEnv('LEDGER_DB_PATH', undefined);
            vi.stubEnv('TRANSACTIONS_DATA_DIR', undefined);
            vi.stubEnv('STEUER_WORKSPACE', undefined);
            applyDemoEnv();
            expect(ledgerDbPath()).toBe(join(demoDir(), 'ledger.db'));
            expect(process.env.TRANSACTIONS_DATA_DIR).toBe(join(demoDir(), 'transactions-data'));
        });

        await it('demo mode does not follow a real store dir for its ledger', async () => {
            vi.stubEnv('STEUER_DEMO', '1');
            vi.stubEnv('LEDGER_DB_PATH', undefined);
            vi.stubEnv('TRANSACTIONS_DATA_DIR', '/real/transactions-data');
            vi.stubEnv('STEUER_WORKSPACE', undefined);
            applyDemoEnv();
            expect(ledgerDbPath()).toBe(join(demoDir(), 'ledger.db'));
        });
    });
};
