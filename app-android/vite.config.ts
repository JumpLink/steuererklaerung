import blueprintPlugin from "@gjsify/vite-plugin-blueprint";
import { defineNativescriptConfig } from "@gjsify/nativescript-vite";

export default defineNativescriptConfig(
  { giRenderer: true },
  { plugins: [blueprintPlugin({ template: { renderer: "adwaita-nativescript" } })] }
);
