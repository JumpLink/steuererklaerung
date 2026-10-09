// <BhYearSwitcher> — sidebar year picker: toggle segments up to 4 years, DropDown beyond.

import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';
import { ControlType, type StoryMeta } from '@gjsify/stories';
import { type StoryArgs, type StoryModule, StoryWidget } from '@gjsify/storybook';

import { BhYearSwitcher } from './year-switcher.ts';

const META: StoryMeta = {
    title: 'Steuererklärung/YearSwitcher',
    description:
        'Jahres-Wechsler der Sidebar: gleichbreite Toggle-Segmente, solange die Liste überschaubar ist ' +
        '(≤ 4 Jahre), darüber automatisch ein DropDown.',
    controls: [
        { name: 'yearCount', label: 'Anzahl Jahre', type: ControlType.RANGE, min: 1, max: 8, step: 1, defaultValue: 3 },
    ],
};

export class YearSwitcherStory extends StoryWidget {
    private switcher: BhYearSwitcher | null = null;
    private picked: Gtk.Label | null = null;

    static {
        GObject.registerClass({ GTypeName: 'BhStoryYearSwitcher' }, YearSwitcherStory);
    }

    constructor() {
        super(StoryWidget.fromMeta(YearSwitcherStory.getMetadata(), 'Default'));
    }

    static getMetadata(): StoryMeta {
        return { ...META, component: BhYearSwitcher.$gtype };
    }

    initialize(): void {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, widthRequest: 260 });
        this.switcher = new BhYearSwitcher();
        this.picked = new Gtk.Label({ xalign: 0, cssClasses: ['dim-label'] });
        this.switcher.onChanged = (year) => this.picked?.set_label(`gewählt: ${year}`);
        box.append(this.switcher);
        box.append(this.picked);
        this.addContent(box);
        this.updateArgs(this.args);
    }

    updateArgs(_args: StoryArgs): void {
        const count = Number(this.args.yearCount) || 3;
        const last = 2026;
        const years = Array.from({ length: count }, (_, i) => last - count + 1 + i);
        this.switcher?.setYears(years, last);
        this.picked?.set_label(`gewählt: ${last}`);
    }
}

GObject.type_ensure(YearSwitcherStory.$gtype);

export const YearSwitcherStories: StoryModule = { stories: [YearSwitcherStory] };
