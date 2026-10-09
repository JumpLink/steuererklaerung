// The glossary DATA + type now live in the core (src/core/lib/glossary.ts) so the web <bh-help>
// popover, the native "?" glossar button and the assistant all share ONE source. This module
// re-exports them so the existing web imports keep working unchanged.

export { GLOSSARY, type GlossaryEntry } from '../../../../core/lib/glossary.ts';
