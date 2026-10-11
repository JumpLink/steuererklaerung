import type { DmsVocabularyEntry } from './types.ts';

/** Find a list entry by exact name, else by id. A name wins, so a type called "2024" stays reachable. */
export function findVocabularyEntry(entries: DmsVocabularyEntry[], ref: string): DmsVocabularyEntry | undefined {
    return entries.find((e) => e.name === ref) ?? entries.find((e) => e.id === ref);
}
