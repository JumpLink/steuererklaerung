// <BhEntitySwitcher> — sidebar entity card (Adw.Avatar initials + name + role) with a popover picker.

import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';
import { ControlType, type StoryMeta } from '@gjsify/stories';
import { type StoryArgs, type StoryModule, StoryWidget } from '@gjsify/storybook';

import { BhEntitySwitcher } from './entity-switcher.ts';

const DEMO = [
    { id: 'gbr', name: 'Fischer & Weber GbR', sub: 'Unternehmen' },
    { id: 'einzel', name: 'Nordwerk Design', sub: 'Unternehmen' },
    { id: 'privat', name: 'Alex Fischer', sub: 'Privat' },
];

const META: StoryMeta = {
    title: 'Steuererklärung/EntitySwitcher',
    description:
        'Entity-Karte der Sidebar: Farb-Initialen-Avatar, Name und Rolle; ein Klick öffnet das Popover ' +
        'mit allen Entitäten und den Registry-Aktionen (anlegen, umbenennen, entfernen). Ohne ' +
        'onManage-Handler bleibt die Karte bei einer einzigen Entität statisch (kein Chevron).',
    controls: [
        {
            name: 'entityCount',
            label: 'Anzahl Entitäten',
            type: ControlType.RANGE,
            min: 1,
            max: 3,
            step: 1,
            defaultValue: 3,
        },
    ],
};

export class EntitySwitcherStory extends StoryWidget {
    private switcher: BhEntitySwitcher | null = null;
    private picked: Gtk.Label | null = null;

    static {
        GObject.registerClass({ GTypeName: 'BhStoryEntitySwitcher' }, EntitySwitcherStory);
    }

    constructor() {
        super(StoryWidget.fromMeta(EntitySwitcherStory.getMetadata(), 'Default'));
    }

    static getMetadata(): StoryMeta {
        return { ...META, component: BhEntitySwitcher.$gtype };
    }

    initialize(): void {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, widthRequest: 260 });
        this.switcher = new BhEntitySwitcher();
        this.picked = new Gtk.Label({ xalign: 0, cssClasses: ['dim-label'] });
        this.switcher.onChanged = (id) => {
            this.picked?.set_label(`gewählt: ${id}`);
            const items = DEMO.slice(0, Number(this.args.entityCount) || DEMO.length);
            this.switcher?.setEntities(items, id);
        };
        box.append(this.switcher);
        box.append(this.picked);
        this.addContent(box);
        this.updateArgs(this.args);
    }

    updateArgs(_args: StoryArgs): void {
        const items = DEMO.slice(0, Number(this.args.entityCount) || DEMO.length);
        this.switcher?.setEntities(items, items[0].id);
        this.picked?.set_label(`gewählt: ${items[0].id}`);
    }
}

GObject.type_ensure(EntitySwitcherStory.$gtype);

export const EntitySwitcherStories: StoryModule = { stories: [EntitySwitcherStory] };
