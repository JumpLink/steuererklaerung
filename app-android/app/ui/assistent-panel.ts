import { Gtk } from "@gjsify/adwaita-nativescript";
import * as GObject from "@gjsify/adwaita-nativescript/gobject";
import tree from "../../../app/src/frontends/desktop/assistent-panel.blp?shared-tree";

/** The desktop panel's chrome. v1 on the phone has no assistant engine: it opens, it closes, it answers nothing. */
export class BhAssistentPanel extends Gtk.Box {
  static {
    GObject.registerClass({ GTypeName: "BhAssistentPanel", Template: tree }, this);
  }

  onClose: (() => void) | null = null;

  _onCloseClicked(): void {
    this.onClose?.();
  }

  _onSendClicked(): void {}
}
