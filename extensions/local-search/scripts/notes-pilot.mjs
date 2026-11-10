// Node 24+ runs the same TypeScript ranking function as the Raycast command.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { searchNotes } from "../src/notes-search.ts";

const [catalogFile, goldFile] = process.argv.slice(2);
if (!catalogFile || !goldFile) {
  console.error("Bruk: node scripts/notes-pilot.mjs KATALOG.json FASIT.json");
  process.exit(2);
}
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const [catalog, gold] = await Promise.all([json(catalogFile), json(goldFile)]);
const { queries, holdout } = gold;
assert.equal(catalog.version, 1);
assert.ok(Array.isArray(queries));
assert.equal(queries.length, 30, "Fasiten skal ha 30 søk");
const positives = queries.filter((q) => q.expected !== null);
assert.equal(positives.length, 20, "20 kjente utsnitt og 10 blindspor kreves");
assert.equal(new Set(queries.map((q) => q.mode + ":" + q.query.trim().toLocaleLowerCase("nb"))).size, 30, "Søkene skal være ulike");
const pages = Object.values(catalog.documents).reduce((sum, doc) => sum + doc.pages, 0);
assert.ok(pages >= 50 && pages <= 100, "Velg et pilotutvalg på 50–100 eksportsider");
assert.ok(holdout.notebook.startsWith("Notatbøker/") && catalog.documents[holdout.notebook]);
assert.ok(Array.isArray(holdout.versions) && new Set(holdout.versions).size >= 2);
for (const name of holdout.versions) assert.ok(name.startsWith("Kommenterte/") && catalog.documents[name]);
assert.ok(positives.some((q) => q.expected.document === holdout.notebook));
assert.ok(positives.some((q) => holdout.versions.includes(q.expected.document)));

function sameComment(entry, expected) {
  if (entry.document !== expected.document || entry.page !== expected.page) return false;
  const [x, y, w, h] = entry.rect, [gx, gy, gw, gh] = expected.rect;
  const intersection = Math.max(0, Math.min(x+w, gx+gw) - Math.max(x, gx))
    * Math.max(0, Math.min(y+h, gy+gh) - Math.max(y, gy));
  // Require overlap in both directions: a box covering the whole page cannot qualify as a comment.
  return intersection >= 0.5 * gw * gh && intersection >= 0.5 * w * h;
}
let correct = 0, falseCertainties = 0;
const misses = [];
for (const [i, q] of queries.entries()) {
  assert.ok(["all", "ink"].includes(q.mode) && q.query.trim());
  const hits = searchNotes(catalog.entries, q.query, q.mode);
  if (q.expected === null) {
    if (hits.some((hit) => !hit.uncertain)) { falseCertainties++; misses.push({ search: i + 1, reason: "sikkert blindspor" }); }
    continue;
  }
  const expected = q.expected;
  assert.ok(catalog.documents[expected.document] && Number.isSafeInteger(expected.page) && expected.page > 0);
  assert.ok(expected.page <= catalog.documents[expected.document].pages && expected.rect.length === 4 &&
    expected.rect.every(Number.isFinite) && expected.rect[2] > 0 && expected.rect[3] > 0);
  const position = hits.findIndex((h) => sameComment(h.entry, expected));
  if (position >= 0 && position < 3) { correct++; continue; }
  const located = catalog.documents[expected.document].located.some((e) =>
    sameComment({ ...e, document: expected.document }, expected));
  misses.push({search: i + 1, reason: position >= 3 ? "rangering" : located ?
    "lesning eller avsnittstilknytning" : "pennestrøk ikke lokalisert"});
}
console.log(JSON.stringify({pages, top3: correct, known: positives.length, falseCertainties, negatives: 10, misses}, null, 2));
if (correct < 16 || falseCertainties > 0) process.exitCode = 1;
