import blueprintPlugin from "@gjsify/vite-plugin-blueprint";
import { defineNativescriptConfig } from "@gjsify/nativescript-vite";
import { fileURLToPath } from "node:url";

export default defineNativescriptConfig(
  {
    giRenderer: true,
    // The desktop catalogue (`app/po`) is shared: the build compiles it to `.mo` assets that
    // `app/i18n.ts` binds on the device. Needs `msgfmt` on PATH.
    locale: {
      poDirectory: fileURLToPath(new URL("../app/po", import.meta.url)),
      domain: "eu.jumplink.Steuererklaerung",
    },
  },
  { plugins: [blueprintPlugin({ template: { renderer: "adwaita-nativescript" } })] }
);
