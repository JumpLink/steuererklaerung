import { Adw, Gtk } from "@gjsify/adwaita-nativescript";
import * as GObject from "@gjsify/adwaita-nativescript/gobject";
import windowTree from "../../app/src/frontends/desktop/window.blp?shared-tree";
import { clearPaperlessCreds, loadPaperlessCreds, savePaperlessCreds, savedPaperlessUrl } from "./data/config.ts";
import { paperlessHost } from "./data/paperless-url.ts";
import { BhAssistentPanel } from "./ui/assistent-panel.ts";
import { BelegEingangView } from "./ui/beleg-eingang-view.ts";
import { BhEntitySwitcher } from "./ui/entity-switcher.ts";
import { BhPaperlessSettings } from "./ui/settings-view.ts";
import { BhYearSwitcher } from "./ui/year-switcher.ts";

// The template names these classes (`$BhEntitySwitcher` …); importing them registers them.
void [BhAssistentPanel, BhEntitySwitcher, BhYearSwitcher];

type SectionId = "beleg-eingang" | "settings";

export interface BhMainWindow {
  _split_view: Adw.NavigationSplitView;
  _sidebar_title: Adw.WindowTitle;
  _entity_switcher: BhEntitySwitcher;
  _year_switcher: BhYearSwitcher;
  _nav_list: Gtk.ListBox;
  _content_title: Adw.WindowTitle;
  _toast_overlay: Adw.ToastOverlay;
  _stack: Gtk.Stack;
  _sync_button: Gtk.Button;
  _assistant_panel: BhAssistentPanel;
  _assistant_split: Adw.OverlaySplitView;
}

/** The desktop's own `window.blp`, built as a template class; the sections are the phone's v1 set. */
export class BhMainWindow extends Adw.ApplicationWindow {
  static {
    GObject.registerClass(
      {
        GTypeName: "BhMainWindow",
        Template: windowTree,
        InternalChildren: [
          "split_view",
          "sidebar_title",
          "entity_switcher",
          "year_switcher",
          "nav_list",
          "content_title",
          "toast_overlay",
          "stack",
          "sync_button",
          "assistant_panel",
          "assistant_split",
        ],
      },
      this,
    );
  }

  private titles = new Map<SectionId, string>();
  private current: SectionId = "beleg-eingang";
  private inbox!: BelegEingangView;
  private settings!: BhPaperlessSettings;

  constructor() {
    super();
    this._sidebar_title.title = "Steuererklärung";
    this._year_switcher.visible = false;
    this._assistant_panel.onClose = () => {
      this._assistant_split.showSidebar = false;
    };
    this._sync_button.connect("clicked", () => void this.refresh());

    this.inbox = new BelegEingangView({ onOpenSettings: () => this.show("settings") });
    this.settings = new BhPaperlessSettings();
    this.settings.onSaved = (creds) => {
      savePaperlessCreds(creds);
      this.updateIdentity();
      this.toast("Connection saved");
      this.show("beleg-eingang");
    };
    this.addSection("beleg-eingang", "Document inbox", "mail-unread-symbolic", this.inbox);
    this.addSection("settings", "Paperless connection", "preferences-system-symbolic", this.settings);

    this._entity_switcher.onManage = () => this.show("settings");
    this.updateIdentity();
    this.show(loadPaperlessCreds() ? "beleg-eingang" : "settings");
  }

  toast(title: string): void {
    this._toast_overlay.add_toast(new Adw.Toast({ title }));
  }

  private addSection(id: SectionId, title: string, icon: string, view: Gtk.Box): void {
    this.titles.set(id, title);
    this._stack.add_named(view, id);
    const row = new Adw.ActionRow({ title, activatable: true });
    row.add_prefix(new Gtk.Image({ iconName: icon }));
    row.connect("activated", () => this.show(id));
    this._nav_list.append(row);
  }

  private updateIdentity(): void {
    const url = savedPaperlessUrl();
    this._entity_switcher.setIdentity("Paperless-ngx", url ? paperlessHost(url) : "Not connected");
  }

  private show(id: SectionId): void {
    this.current = id;
    this._stack.set_visible_child_name(id);
    this._content_title.title = this.titles.get(id) ?? "";
    this._split_view.showContent = true;
    if (id === "settings") this.settings.setUrl(savedPaperlessUrl());
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.current === "beleg-eingang") await this.inbox.reload(loadPaperlessCreds());
  }

  forgetConnection(): void {
    clearPaperlessCreds();
    this.updateIdentity();
    void this.inbox.reload(null);
  }
}
