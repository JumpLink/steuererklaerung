// Tab hubs — consolidate several existing views under one nav entry (the v2 IA: 15 → 9). Built on
// adw-inline-view-switcher (the Adwaita segmented top switcher + panels), replacing the earlier
// hand-rolled .bh-chips bar. Pure composition: each tab hosts an existing sub-view component and
// forwards the entity/year attributes. Lazy: only the ACTIVE tab's sub-view is created (and
// re-created on entity/year change), so heavy tabs (e.g. Steuererklärung, which recomputes
// EÜR/GewSt/Feststellung) don't all fetch at once — adw-inline-view-switcher itself keeps every
// panel in the DOM, so lazy mounting is our job.

import { esc } from '../lib/format.ts';

interface Tab {
    label: string;
    tag: string;
}

abstract class TabHub extends HTMLElement {
    protected abstract tabs: Tab[];
    private active = 0;
    /** Tabs already populated for the current entity/year — avoids re-fetching on every tab switch. */
    private readonly loaded = new Set<number>();

    static get observedAttributes() {
        return ['entity', 'year'];
    }

    connectedCallback() {
        this.render();
    }

    attributeChangedCallback() {
        // Entity/year changed from the shell — every tab's data is stale. Drop the mounted sub-views
        // (their fetch runs in connectedCallback, so they must be re-created, not just re-attributed)
        // and re-mount the active one.
        if (!this.isConnected) return;
        this.loaded.clear();
        for (const host of this.querySelectorAll('.bh-hub-page')) host.replaceChildren();
        this.mountActive();
    }

    private render() {
        this.innerHTML = `
      <div class="bh-hub">
        <adw-inline-view-switcher class="bh-hub-switcher" display-mode="labels" active="${this.active}">
          ${this.tabs
              .map(
                  (t, i) =>
                      `<adw-view-stack-page title="${esc(t.label)}"><div class="bh-hub-page" data-i="${i}"></div></adw-view-stack-page>`,
              )
              .join('')}
        </adw-inline-view-switcher>
      </div>`;
        // adw-inline-view-switcher emits notify::active with { active: index } on a tab change; the
        // panels stay mounted, so we lazily create the sub-view for whichever tab becomes active.
        this.querySelector('adw-inline-view-switcher')?.addEventListener('notify::active', (e) => {
            this.active = (e as CustomEvent<{ active: number }>).detail.active;
            this.mountActive();
        });
        this.mountActive();
    }

    /** Create (once per entity/year) the active tab's sub-view and forward entity/year. */
    private mountActive() {
        if (this.loaded.has(this.active)) return;
        // The switcher moved our .bh-hub-page div into its panel wrapper, but it stays queryable here.
        const host = this.querySelector(`.bh-hub-page[data-i="${this.active}"]`);
        const tab = this.tabs[this.active];
        if (!host || !tab) return;
        const el = document.createElement(tab.tag);
        el.setAttribute('entity', this.getAttribute('entity') ?? '');
        el.setAttribute('year', this.getAttribute('year') ?? '');
        host.appendChild(el);
        this.loaded.add(this.active);
    }
}

export class BhSteuerHub extends TabHub {
    protected tabs: Tab[] = [
        { label: 'Erklärung', tag: 'bh-steuererklaerung-view' },
        { label: 'EÜR', tag: 'bh-tax-view' },
        { label: 'USt-VA', tag: 'bh-ustva-view' },
        { label: 'Steuerkonto', tag: 'bh-steuerkonto-view' },
    ];

    // A `privat` entity has only the Einkommensteuer estimate — the EÜR/USt-VA/Steuerkonto tabs are
    // business-only. Filter before the base renders the switcher.
    connectedCallback() {
        if (this.getAttribute('kind') === 'privat') {
            this.tabs = [{ label: 'Einkommensteuer', tag: 'bh-steuererklaerung-view' }];
        }
        super.connectedCallback();
    }
}
export class BhReviewHub extends TabHub {
    protected tabs: Tab[] = [
        { label: 'Eingang', tag: 'bh-review-view' },
        { label: 'Offene Belege', tag: 'bh-belege-view' },
        { label: 'Alle Belege', tag: 'bh-documents-view' },
    ];
}

customElements.define('bh-steuer-hub', BhSteuerHub);
customElements.define('bh-review-hub', BhReviewHub);

declare global {
    interface HTMLElementTagNameMap {
        'bh-steuer-hub': BhSteuerHub;
        'bh-review-hub': BhReviewHub;
    }
}
