/**
 * Entry point of the standalone CLI bundles (`dist/steuer.gjs.mjs`, `dist/steuer.node.mjs`).
 *
 * The CLI itself lives in `frontends/cli/main.ts` so the packaged desktop entry can run it too —
 * a package ships one binary, and `steuererklaerung --help` has to work from it.
 */

import { runCli } from './frontends/cli/main.ts';

runCli();
