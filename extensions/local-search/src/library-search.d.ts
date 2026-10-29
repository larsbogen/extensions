import type { Entry, Topic, Fulltext } from "./service";
export function normalize(value: unknown): string;
export function indexEntries(entries: Entry[], topics: Topic[]): Entry[];
export function findEntries(
  entries: Entry[],
  state: { q?: string; year?: string; tags?: string[] },
  fulltext?: Fulltext["matches"],
): Entry[];
