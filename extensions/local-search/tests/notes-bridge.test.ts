import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openNote, previewURL, readNotesCatalog } from "../src/notes-bridge";

let home = "",
  root = "",
  store = "";
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "remarkable-notes-ts-")));
  root = join(home, "Import $$ (ø)");
  store = join(home, "Indeks");
  await Promise.all([mkdir(root), mkdir(store)]);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

it("skjuler resultater fra den forrige importmappen og beholder hoppet-over-rapporten når kommandoen åpnes på nytt", async () => {
  const other = join(home, "annen");
  await mkdir(other);
  const skipped = [
    { document: "eksempel.pdf", page: 4, reason: "Mangler original" },
  ];
  await writeFile(
    join(store, "catalog.json"),
    JSON.stringify({ version: 1, root, entries: [], skipped }),
  );
  expect((await readNotesCatalog(root, store))?.skipped).toEqual(skipped);
  expect(await readNotesCatalog(other, store)).toBe(null);
  await symlink(root, join(home, "alias"));
  expect((await readNotesCatalog(join(home, "alias"), store))?.root).toBe(root);
  await writeFile(
    join(store, "catalog.json"),
    JSON.stringify({
      version: 1,
      root: join(home, "alias"),
      entries: [],
      skipped,
    }),
  );
  expect((await readNotesCatalog(root, store))?.root).toBe(root);
});

it("nekter en symlenke ut av indeksmappen både som forhåndsvisning og som katalog", async () => {
  const file = join(root, "privat.png");
  await writeFile(file, "privat data");
  await symlink(file, join(store, "bilde.png"));
  await symlink(file, join(store, "catalog.json"));
  await expect(previewURL(store, "bilde.png")).rejects.toThrow();
  await expect(previewURL(store, "../privat.png")).rejects.toThrow();
  await expect(readNotesCatalog(root, store)).rejects.toThrow();
});

it("åpner uten skall og rapporterer native feil før siden er klar", async () => {
  const helper = join(home, "leser.sh");
  await writeFile(
    helper,
    '#!/bin/sh\n[ "$1" = open ] && [ -d "$3" ] && [ -d "$5" ] && [ "$7" = test-id ] && { echo READY; exit 0; }\necho "PDF-en er endret" >&2\nexit 2\n',
    { mode: 0o700 },
  );
  await expect(
    openNote(helper, root, store, "test-id"),
  ).resolves.toBeUndefined();
  await expect(openNote(helper, root, store, "feil-id")).rejects.toThrow(
    "PDF-en er endret",
  );
});
