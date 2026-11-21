import { Adw, Gtk } from "@gjsify/adwaita-nativescript";
import { _ } from "../../../app/src/core/lib/i18n.ts";
import type { DocumentDetail } from "../data/document-detail.ts";

/** One document's fields with a way back to the list. Dynamic content, so built in code. */
export class BelegDetailView extends Gtk.Box {
  private readonly group = new Adw.PreferencesGroup();

  constructor(onBack: () => void) {
    super({ orientation: "vertical", spacing: 12, marginTop: 12, marginBottom: 12, marginStart: 12, marginEnd: 12 });
    const back = new Gtk.Button({ label: _("Back"), halign: "start", styleClasses: "flat" });
    back.connect("clicked", () => onBack());
    this.append(back);
    this.append(this.group);
  }

  show(detail: DocumentDetail): void {
    for (const row of this.group.searchRows()) this.group.remove(row as never);
    const rows: Array<[string, string]> = [
      [_("Title"), detail.title],
      [_("Correspondent"), detail.correspondent || "—"],
      [_("Created"), detail.created || "—"],
      [_("Tags"), detail.tags.join(", ") || "—"],
    ];
    for (const [title, subtitle] of rows) this.group.add(new Adw.ActionRow({ title, subtitle }));
  }
}
