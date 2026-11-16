import { Adw, Gtk } from "@gjsify/adwaita-nativescript";
import * as GObject from "@gjsify/adwaita-nativescript/gobject";
import tree from "../../../app/src/frontends/desktop/widgets/entity-switcher.blp?shared-tree";

export interface BhEntitySwitcher {
  _avatar: Adw.Avatar;
  _name_label: Gtk.Label;
  _sub_label: Gtk.Label;
  _popover: Gtk.Popover;
}

/**
 * The sidebar card from the desktop's own blueprint, with its popover. v1 on the phone has one
 * identity (the Paperless connection), so the popover lists it and offers the connection form.
 */
export class BhEntitySwitcher extends Adw.Bin {
  static {
    GObject.registerClass(
      {
        GTypeName: "BhEntitySwitcher",
        Template: tree,
        InternalChildren: ["avatar", "name_label", "sub_label", "popover"],
      },
      this,
    );
  }

  onManage: (() => void) | null = null;

  setIdentity(name: string, sub: string): void {
    this._avatar.text = name;
    this._name_label.label = name;
    this._sub_label.label = sub;
    const box = new Gtk.Box({ orientation: "vertical", spacing: 8, marginTop: 6, marginBottom: 6, marginStart: 6, marginEnd: 6 });
    const list = new Gtk.ListBox({ selectionMode: "none", styleClasses: ["boxed-list"] });
    const row = new Adw.ActionRow({ title: name, subtitle: sub, activatable: true });
    row.add_prefix(new Gtk.Image({ iconName: "preferences-system-symbolic" }));
    row.connect("activated", () => {
      this._popover.popdown();
      this.onManage?.();
    });
    list.append(row);
    box.append(list);
    this._popover.child = box;
  }
}
