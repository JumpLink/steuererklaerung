import { Adw, Gtk } from "@gjsify/adwaita-nativescript";
import * as GObject from "@gjsify/adwaita-nativescript/gobject";
import { _ } from "../../../app/src/core/lib/i18n.ts";
import tree from "./settings-view.blp?shared-tree";
import type { PaperlessCreds } from "../data/paperless.ts";
import { normalizePaperlessUrl } from "../data/paperless-url.ts";

export interface BhPaperlessSettings {
  _url_row: Adw.EntryRow;
  _token_row: Adw.PasswordEntryRow;
  _status_label: Gtk.Label;
  _save_button: Gtk.Button;
}

export class BhPaperlessSettings extends Gtk.Box {
  static {
    GObject.registerClass(
      {
        GTypeName: "BhPaperlessSettings",
        Template: tree,
        InternalChildren: ["url_row", "token_row", "status_label", "save_button"],
      },
      this,
    );
  }

  /** Called with the validated connection; the owner stores it and reloads. */
  onSaved: ((creds: PaperlessCreds) => void) | null = null;

  /** Shows what is stored (the token is never read back into the form). */
  setUrl(url: string): void {
    this._url_row.text = url;
  }

  _onSaveClicked(): void {
    const url = normalizePaperlessUrl(this._url_row.text);
    const token = this._token_row.text.trim();
    if (!url) return this.report(_("Enter an http:// or https:// address."));
    if (!token) return this.report(_("Enter the API token."));
    this._token_row.text = "";
    this.report("");
    this.onSaved?.({ url, token });
  }

  report(message: string): void {
    this._status_label.label = message;
    this._status_label.visible = message !== "";
  }
}
