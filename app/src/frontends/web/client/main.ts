// Entry: register the Adwaita base components + their theme, our app components,
// and our styles. The <bh-app> in index.html upgrades once registered.
// adwaita-web 0.12 self-applies its compiled stylesheet on import (injects a
// <style id="adwaita-web-style">), so no separate `@gjsify/adwaita-web/style.css`
// import is needed — pulling it in too would ship the ~126 KB Adwaita CSS twice.
import '@gjsify/adwaita-web';
import './styles.css';

import './components/bh-app.ts';
import './components/bh-home-view.ts';
import './components/bh-tab-hub.ts';
import './components/bh-review-view.ts';
import './components/bh-assistent-view.ts';
import './components/bh-transactions-view.ts';
import './components/bh-documents-view.ts';
import './components/bh-belege-view.ts';
import './components/bh-tax-view.ts';
import './components/bh-steuererklaerung-view.ts';
import './components/bh-ustva-view.ts';
import './components/bh-fristen-view.ts';
import './components/bh-auswertungen-view.ts';
import './components/bh-steuerkonto-view.ts';
import './components/bh-rechnungen-view.ts';
import './components/bh-kontakte-view.ts';
import './components/bh-settings-view.ts';
import './components/bh-konten-view.ts';
import './components/bh-help.ts';
import './components/bh-tx-detail.ts';
import './components/bh-invoice-detail.ts';
import './components/bh-invoice-form.ts';
import './components/bh-chart.ts';
