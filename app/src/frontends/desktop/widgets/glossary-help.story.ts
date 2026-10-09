// <BhGlossaryHelp> story — the Lernmodus "?" glossar button next to a label. The controls drive the
// glossary term + the Lernmodus gate, so the button appears/disappears live (hidden when Lernmodus is
// off, exactly as in the real views).

import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';
import { ControlType, type StoryMeta } from '@gjsify/stories';
import { type StoryArgs, type StoryModule, StoryWidget } from '@gjsify/storybook';

import { BhGlossaryHelp } from './glossary-help.ts';

/** A representative slice of the glossary keys the views wire up. */
const TERMS = ['euer', 'gewinn', 'ust-zahllast', 'afa', 'mcp'];

const META: StoryMeta = {
    title: 'Steuererklärung/GlossaryHelp',
    description:
        'Der „?"-Glossar-Button (Lernmodus): eine kleine MenuButton neben einem Label, die ein Popover mit ' +
        'der Klartext-Erklärung des Fachbegriffs öffnet. Sichtbar nur, wenn Lernmodus AN ist.',
    controls: [
        { name: 'lernmodus', label: 'Lernmodus', type: ControlType.BOOLEAN, defaultValue: true },
        {
            name: 'term',
            label: 'Begriff',
            type: ControlType.SELECT,
            options: TERMS.map((t) => ({ label: t, value: t })),
            defaultValue: 'gewinn',
        },
    ],
};

/** Story: a KPI-style label with the "?" button; toggling Lernmodus shows/hides it. */
export class GlossaryHelpStory extends StoryWidget {
    private help: BhGlossaryHelp | null = null;
    private hint: Gtk.Label | null = null;

    static {
        GObject.registerClass({ GTypeName: 'BhStoryGlossaryHelp' }, GlossaryHelpStory);
    }

    constructor() {
        super(StoryWidget.fromMeta(GlossaryHelpStory.getMetadata(), 'Default'));
    }

    static getMetadata(): StoryMeta {
        return { ...META, component: BhGlossaryHelp.$gtype };
    }

    initialize(): void {
        const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
        const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, halign: Gtk.Align.CENTER });
        row.append(new Gtk.Label({ label: 'Gewinn 2025', cssClasses: ['heading'] }));
        this.help = new BhGlossaryHelp();
        row.append(this.help);
        this.hint = new Gtk.Label({ cssClasses: ['dim-label', 'caption'] });
        col.append(row);
        col.append(this.hint);
        this.addContent(col);
        this.updateArgs(this.args);
    }

    updateArgs(_args: StoryArgs): void {
        if (!this.help) return;
        const term = String(this.args.term ?? 'gewinn');
        const on = this.args.lernmodus as boolean;
        this.help.setTerm(term);
        this.help.setLernmodus(on);
        this.hint?.set_label(on ? `Begriff „${term}" — auf „?" klicken` : 'Lernmodus AUS — kein „?"');
    }
}

GObject.type_ensure(GlossaryHelpStory.$gtype);

export const GlossaryHelpStories: StoryModule = { stories: [GlossaryHelpStory] };
