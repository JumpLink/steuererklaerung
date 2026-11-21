/**
 * Binds the gettext catalogue on Android and hands the core its translator.
 *
 * English is the source language (as on the desktop); German arrives as `app/po/de.po`, which the
 * Vite build compiles into `locale/<lang>/LC_MESSAGES/<domain>.mo` assets (`vite.config.ts`).
 * `initLocale` binds the extracted directory and makes the domain the default one, which is what
 * the `.blp` trees use for their `_("…")` strings; Android re-reads the system language on every
 * lookup, so switching it needs no restart logic here.
 *
 * Imported by `app.ts` before any view: a string looked up before this runs stays English.
 */
import { initLocale } from "@gjsify/adwaita-app/locale";
import { setCoreTranslator } from "../../app/src/core/lib/i18n.ts";

const translate = initLocale("eu.jumplink.Steuererklaerung");
setCoreTranslator({ gettext: translate, ngettext: translate.plural, pgettext: translate.context });
