import "./engine";
import "./i18n";
import { Application } from "@nativescript/core";
import { registerAdwaita } from "@gjsify/adwaita-nativescript";

registerAdwaita();
Application.run({ moduleName: "app-root" });
