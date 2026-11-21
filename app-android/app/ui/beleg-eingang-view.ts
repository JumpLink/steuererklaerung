import { Adw, Gtk } from "@gjsify/adwaita-nativescript";
import { createPaperlessClient, type Document, type PaperlessCreds } from "../data/paperless.ts";

/** What the owner decides when the list cannot be shown: Paperless is not set up, or it answered badly. */
export interface BelegEingangHandlers {
  onOpenSettings(): void;
}

export function documentTitle(doc: Document): string {
  return doc.title?.trim() || doc.original_file_name || `#${doc.id}`;
}

export function documentSubtitle(doc: Document): string {
  return (doc.added ?? doc.created ?? "").slice(0, 10);
}

/**
 * The inbox: Paperless documents tagged "Neu". A dynamic list, so it is built in code (the
 * blueprint is for static forms). One Gtk.Stack holds the four states a request can end in.
 */
export class BelegEingangView extends Gtk.Box {
  private readonly stack = new Gtk.Stack({ vexpand: true });
  private readonly list = new Gtk.ListBox({ selectionMode: "none", styleClasses: "boxed-list" });
  private readonly empty = new Adw.StatusPage({
    iconName: "emblem-ok-symbolic",
    title: "Inbox is empty",
    description: "No document carries the tag Neu.",
  });
  private readonly failure = new Adw.StatusPage({ iconName: "dialog-error-symbolic", title: "Could not load the inbox" });
  private readonly setup = new Adw.StatusPage({
    iconName: "preferences-system-symbolic",
    title: "Connect Paperless",
    description: "Enter the address and API token of your Paperless-ngx.",
  });
  private generation = 0;
  private documents: Document[] = [];
  private client: ReturnType<typeof createPaperlessClient> | null = null;
  private nextPage: number | null = null;
  private loadingMore = false;

  constructor(private readonly handlers: BelegEingangHandlers) {
    super({ orientation: "vertical" });
    const scroll = new Gtk.ScrolledWindow({ vexpand: true, hscrollbarPolicy: "never" });
    const holder = new Gtk.Box({ orientation: "vertical", marginTop: 12, marginBottom: 12, marginStart: 12, marginEnd: 12 });
    holder.append(this.list);
    scroll.child = holder;

    const settingsButton = (label: string) => {
      const button = new Gtk.Button({ label, halign: "center", styleClasses: "suggested-action pill" });
      button.connect("clicked", () => this.handlers.onOpenSettings());
      return button;
    };
    this.setup.child = settingsButton("Open settings");
    this.failure.child = settingsButton("Check settings");

    const loading = new Adw.Spinner({ halign: "center", valign: "center", widthRequest: 48, heightRequest: 48 });
    this.stack.add_named(loading, "loading");
    this.stack.add_named(scroll, "list");
    this.stack.add_named(this.empty, "empty");
    this.stack.add_named(this.failure, "error");
    this.stack.add_named(this.setup, "setup");
    this.append(this.stack);
  }

  /** Fetches page one of the inbox (more pages follow on demand); a newer call wins over a slower older one. */
  async reload(creds: PaperlessCreds | null): Promise<void> {
    const mine = ++this.generation;
    if (!creds) {
      this.stack.set_visible_child_name("setup");
      return;
    }
    this.stack.set_visible_child_name("loading");
    try {
      const client = createPaperlessClient(creds);
      const page = await client.listInbox();
      if (mine !== this.generation) return;
      this.client = client;
      this.documents = page.results;
      this.nextPage = page.next ? 2 : null;
      this.show();
    } catch (error) {
      if (mine !== this.generation) return;
      this.failure.description = error instanceof Error ? error.message : String(error);
      this.stack.set_visible_child_name("error");
    }
  }

  private show(): void {
    this.list.remove_all();
    for (const doc of this.documents) {
      this.list.append(new Adw.ActionRow({ title: documentTitle(doc), subtitle: documentSubtitle(doc) }));
    }
    if (this.nextPage !== null) {
      const row = new Adw.ButtonRow({ title: this.loadingMore ? "Loading…" : "Load more", sensitive: !this.loadingMore });
      row.connect("activated", () => void this.loadMore());
      this.list.append(row);
    }
    this.stack.set_visible_child_name(this.documents.length ? "list" : "empty");
  }

  private async loadMore(): Promise<void> {
    const client = this.client;
    const page = this.nextPage;
    if (!client || page === null || this.loadingMore) return;
    const mine = this.generation;
    this.loadingMore = true;
    this.show();
    try {
      const result = await client.listInbox(page);
      if (mine !== this.generation) return;
      this.documents = [...this.documents, ...result.results];
      this.nextPage = result.next ? page + 1 : null;
    } catch (error) {
      if (mine !== this.generation) return;
      this.failure.description = error instanceof Error ? error.message : String(error);
      this.stack.set_visible_child_name("error");
      return;
    } finally {
      this.loadingMore = false;
    }
    this.show();
  }
}
