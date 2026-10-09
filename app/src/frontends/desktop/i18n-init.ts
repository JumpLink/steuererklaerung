/**
 * Binds the translation catalogue as a SIDE EFFECT OF BEING IMPORTED — main.ts imports this module
 * first, so it runs before any other module of the app is evaluated.
 *
 * A call in main.ts's body is too late: ES modules evaluate their whole import graph before the
 * importing body runs, so a module-level `_('…')` (a nav label, a status table) would be looked up
 * under the C locale and stay English for the rest of the process. Under `de_DE` that read as a
 * half-translated sidebar with no error anywhere.
 */

import { initI18n } from './i18n.ts';

initI18n();
