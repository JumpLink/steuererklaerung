import { Adw } from "@gjsify/adwaita-nativescript";
import * as GObject from "@gjsify/adwaita-nativescript/gobject";
import tree from "../../../app/src/frontends/desktop/widgets/year-switcher.blp?shared-tree";

/** The desktop's year switcher shell; v1 on the phone has no tax year, so the window hides it. */
export class BhYearSwitcher extends Adw.Bin {
  static {
    GObject.registerClass({ GTypeName: "BhYearSwitcher", Template: tree }, this);
  }
}
