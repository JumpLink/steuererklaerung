// <bh-help term="…"> — a small "ⓘ" button that opens an Adwaita-style popover with a
// plain-German explanation of a term (from the glossary). Always available; closes on
// outside-click, ESC, scroll or resize. Non-intrusive: hidden until clicked.

import { GLOSSARY } from '../lib/glossary.ts';
import { esc } from '../lib/format.ts';

let openPop: HTMLElement | null = null;
let openTrigger: HTMLElement | null = null;

function closePop() {
    openPop?.remove();
    openPop = null;
    openTrigger?.setAttribute('aria-expanded', 'false');
    openTrigger = null;
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', closePop, true);
    window.removeEventListener('resize', closePop);
}
function onDocClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (openPop && !openPop.contains(t) && !t.closest('.bh-help-btn')) closePop();
}
function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') closePop();
}

export class BhHelp extends HTMLElement {
    connectedCallback() {
        const term = this.getAttribute('term') ?? '';
        this.innerHTML = `<button class="bh-help-btn" type="button" aria-label="Erklärung" aria-haspopup="dialog" aria-expanded="false">?</button>`;
        this.querySelector('button')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggle(term, e.currentTarget as HTMLElement);
        });
    }

    private toggle(term: string, btn: HTMLElement) {
        const wasOpen = openPop;
        closePop();
        if (wasOpen) return; // clicking the same/any open one just closes it

        const g = GLOSSARY[term];
        if (!g) return;
        const pop = document.createElement('div');
        pop.className = 'bh-help-pop';
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', g.title);
        pop.innerHTML = `<strong>${esc(g.title)}</strong><p>${esc(g.text)}</p>`;
        document.body.appendChild(pop);
        btn.setAttribute('aria-expanded', 'true');
        openTrigger = btn;

        const r = btn.getBoundingClientRect();
        const width = Math.min(320, window.innerWidth - 24);
        pop.style.width = `${width}px`;
        const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8);
        pop.style.left = `${left}px`;
        pop.style.top = `${r.bottom + 8}px`;
        // Flip above the button if there is no room below.
        const h = pop.getBoundingClientRect().height;
        if (r.bottom + 8 + h > window.innerHeight - 8) pop.style.top = `${Math.max(8, r.top - h - 8)}px`;

        openPop = pop;
        setTimeout(() => {
            document.addEventListener('click', onDocClick, true);
            document.addEventListener('keydown', onKey, true);
            window.addEventListener('scroll', closePop, true);
            window.addEventListener('resize', closePop);
        }, 0);
    }
}

customElements.define('bh-help', BhHelp);

declare global {
    interface HTMLElementTagNameMap {
        'bh-help': BhHelp;
    }
}
