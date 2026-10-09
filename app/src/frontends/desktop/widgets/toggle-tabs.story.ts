// <BhToggleTabs> — segmented chips over a NON-homogeneous stack: the visible page defines the
// height (unlike Adw.ViewStack, which stretches every page to the tallest — the wizard-gap bug).

import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';
import { ControlType, type StoryMeta } from '@gjsify/stories';
import { type StoryArgs, type StoryModule, StoryWidget } from '@gjsify/storybook';

import { BhToggleTabs } from './toggle-tabs.ts';

const META: StoryMeta = {
    title: 'Steuererklärung/ToggleTabs',
    description:
        'Verlinkte ToggleButton-Chips über einem nicht-homogenen Gtk.Stack — jede Seite nimmt genau ' +
        'ihre eigene Höhe ein (kein Leerraum unter kurzen Seiten).',
    controls: [{ name: 'showIcons', label: 'Status-Icons', type: ControlType.BOOLEAN, defaultValue: true }],
};

/** Story: three pages of very different heights — switching shows the stack re-sizing. */
export class ToggleTabsStory extends StoryWidget {
    private host: Gtk.Box | null = null;

    static {
        GObject.registerClass({ GTypeName: 'BhStoryToggleTabs' }, ToggleTabsStory);
    }

    constructor() {
        super(StoryWidget.fromMeta(ToggleTabsStory.getMetadata(), 'Default'));
    }

    static getMetadata(): StoryMeta {
        return { ...META, component: BhToggleTabs.$gtype };
    }

    initialize(): void {
        this.host = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        this.addContent(this.host);
        this.rebuild();
    }

    updateArgs(_args: StoryArgs): void {
        this.rebuild();
    }

    private rebuild(): void {
        if (!this.host) return;
        let child = this.host.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this.host.remove(child);
            child = next;
        }
        const icons = this.args.showIcons as boolean;
        const tabs = new BhToggleTabs();
        tabs.add('kurz', 'Kurz', page(1), icons ? { iconName: 'emblem-ok-symbolic' } : {});
        tabs.add('mittel', 'Mittel', page(3), icons ? { iconName: 'dialog-warning-symbolic' } : {});
        tabs.add('lang', 'Lang', page(8), icons ? { iconName: 'dialog-error-symbolic' } : {});
        this.host.append(tabs);
    }
}

function page(rows: number): Gtk.Widget {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, marginTop: 8 });
    for (let i = 1; i <= rows; i++) {
        const row = new Gtk.Label({ label: `Zeile ${i}`, xalign: 0, cssClasses: ['card'] });
        row.set_margin_top(10);
        row.set_margin_bottom(10);
        row.set_margin_start(12);
        box.append(row);
    }
    return box;
}

GObject.type_ensure(ToggleTabsStory.$gtype);

export const ToggleTabsStories: StoryModule = { stories: [ToggleTabsStory] };
