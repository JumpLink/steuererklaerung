import type { EventData, Page } from "@nativescript/core";
import { Adw, Gtk } from "@gjsify/adwaita-nativescript";
import { build, buildInto, registerTemplateClass } from "@gjsify/adwaita-nativescript/builder";
import windowTree from "../../../app/src/frontends/desktop/window.blp?shared-tree";
import yearSwitcherTree from "../../../app/src/frontends/desktop/widgets/year-switcher.blp?shared-tree";
import assistentPanelTree from "../../../app/src/frontends/desktop/assistent-panel.blp?shared-tree";

// The desktop classes this window names. The spike builds the two that already project onto
// NativeScript from their own Blueprint; `BhEntitySwitcher` needs `Gtk.Popover`, which the port
// does not have yet (docs/android/target-gap.md), so a bare bin stands in for it.
class YearSwitcher extends Adw.Bin {
  constructor() {
    super();
    buildInto(this, withoutGaps(yearSwitcherTree));
  }
}
class AssistentPanel extends Gtk.Box {
  constructor() {
    super();
    buildInto(this, withoutGaps(assistentPanelTree), {
      // The handlers the blueprint names (`clicked => $_onCloseClicked()`); the spike only
      // proves that the tree builds, so they do nothing.
      scope: { _onCloseClicked: () => {}, _onSendClicked: () => {} },
    });
  }
}
class EntitySwitcherStub extends Adw.Bin {}

registerTemplateClass("BhYearSwitcher", YearSwitcher);
registerTemplateClass("BhAssistentPanel", AssistentPanel);
registerTemplateClass("BhEntitySwitcher", EntitySwitcherStub);

type Node = Parameters<typeof build>[0];

// Spike only: each entry is a gap docs/android/spike-report.md names. The builder refuses a tree
// that reaches nothing, so the node is cut here and the cut is logged instead of hidden.
const KNOWN_GAPS: ReadonlyArray<(parent: Node, child: Node) => string | null> = [
  (parent, child) =>
    parent.tag === "GtkMenuButton" && child.slot === "child" ? "Gtk.MenuButton.child" : null,
];

function withoutGaps(tree: Node): Node {
  const cuts: string[] = [];
  const result = cutKnownGaps(tree, cuts);
  console.log(`SPIKE gaps cut: ${cuts.length ? cuts.join(", ") : "none"}`);
  return result;
}

function cutKnownGaps(node: Node, cuts: string[]): Node {
  const children = (node.children ?? [])
    .filter((child) => {
      const gap = KNOWN_GAPS.map((rule) => rule(node, child)).find((hit) => hit !== null);
      if (gap) cuts.push(gap);
      return !gap;
    })
    .map((child) => {
      // `Adw.ToastOverlay` has the `child` setter but declares no builder slot, so the overlay
      // is dropped and its content takes its place.
      if (child.tag === "AdwToastOverlay" && child.children?.length === 1) {
        cuts.push("Adw.ToastOverlay.child");
        return cutKnownGaps({ ...child.children[0], slot: child.slot }, cuts);
      }
      return cutKnownGaps(child, cuts);
    });
  // `Gtk.Image` declares no style classes in the port, so `styles ["accent"]` would be dropped.
  const styleClasses = node.tag === "GtkImage" && node.styleClasses ? undefined : node.styleClasses;
  if (styleClasses !== node.styleClasses) cuts.push("Gtk.Image.styleClasses");
  // Bind flags need a template instance (`build({ template })`), which the spike does not construct:
  // the binding stays one-way and the toggle no longer follows the sidebar back.
  let bindings = node.bindings;
  if (bindings && Object.values(bindings).some((bind) => bind.flags?.length)) {
    cuts.push("bind flags");
    bindings = Object.fromEntries(Object.entries(bindings).map(([key, bind]) => [key, { ...bind, flags: undefined }]));
  }
  return { ...node, children, styleClasses, bindings };
}

export function onLoaded(args: EventData): void {
  (args.object as Page).content = build(withoutGaps(windowTree), { translate: (msgid: string) => msgid });
  console.log("SPIKE window built");
}
