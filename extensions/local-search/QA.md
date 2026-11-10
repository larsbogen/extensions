# QA – 29. oktober 2026

13 tester i Raycast-utvidelsen består. Automatiske tester bruker syntetiske data og mocks. Ingen brukerapp, vanlig nettleserprofil eller fysisk enhet betjenes.

- `npm test`: kontrakttester for norsk metadata-/PDF-søk, år/tema-AND, validering av adresser/svar/PDF-side, oppstartssamordning, fremmed server, én fornyelse etter 401, avbrytbare forespørsler, React-flyt for gamle svar og paginering.
- `npm run typecheck`, `npm run build`, `npm run lint` og `npx eslint src tests` består. Lokal lint kjører ESLint og Prettier direkte fordi dette er en privat utvidelse. `npm run lint:store` validerer i tillegg Store-metadata: forfatternavnet `larsbogen` er ikke en registrert Raycast Store-konto (404), og norske navn gir advarsler om tittelformatering. Store-publisering inngår ikke i leveransen.
- Turatlas: nye API-/tilgangstester, headless direktelenker før/etter innlogging, ugyldig ID og importoversikt uten importstart. Alle 12 direktelenkescenarioer bestått i Chromium, WebKit og begge mobile visningsstørrelser, med én worker og eksterne nettforespørsler blokkert.

Native Raycast-visning er ikke manuelt kontrollert. Bygget er ikke installert eller startet i brukerens Raycast. Ekte Safari og PDF-leserens faktiske håndtering av `#page=` er ikke verifisert. WebKit og mobil visningsstørrelse beviser ikke ekte Safari eller fysisk iPhone. Søke- og åpningslogikken er testet uten brukerens private arkiver.

## Lokale tjenester – 29. oktober 2026

- `npm test`: 23 tester består, inkludert passiv status, uavhengige rader, oppdatering, gammel/ugyldig protokoll, fremmed serveradresse, start og bekreftet klarstatus før åpning, gjenbruk, kontrollert stopp, dobbeltaktivering og ett statusoppslag etter tidsavbrudd. Loggtester dekker størrelse/linjegrense, rotasjon, tom/manglende fil, symlinker og bokstavelig gjengivelse av Markdown/kontrolltegn.
- `npm run typecheck`, `npm run lint` og `npm run build` består. React-testene bruker prosjektets eksisterende react-test-renderer; React varsler at biblioteket er foreldet.
- Turatlas: 13 målrettede tester i `service-status.test.ts`, `launcher.test.ts` og `raycast-launcher.test.ts` består; `npm run typecheck` består. Testene bruker egne midlertidige mapper, syntetiske data og loopback-servere.
- Masteroppgaver: seks nye statustester og de 16 eksisterende bibliotektestene består. Begge faktiske CLI-statuskommandoer er kontrollert mot tomme testmapper. Status uten serverfil endrer ingen tilstand; klarstatus verifiserer instans og PID; fremmed identitet, ugyldige filer og utilgjengelig levende prosess gir ukjent status. Ingen kontrollnøkler følger med i statusutdata.

Ingen av brukerens tjenester er startet/stoppet i verifikasjonen. Native Raycast-visning og faktisk åpning av nettleser/Finder er ikke manuelt verifisert. Utvidelsen er bygget.

### Lokal installasjon – 29. oktober 2026

Den eksisterende `ray develop --non-interactive`-prosessen har installert den oppdaterte utvidelsen. Det installerte manifestet i `~/.config/raycast/extensions/local-search/package.json` inneholder `local-services`, og `local-services.js` finnes med statuskontrolleren. Ingen ekstra utviklingsprosess eller innloggingstjeneste er startet. Kommandoen er ikke åpnet i Raycast som del av verifikasjonen.

## reMarkable-notater

Bruk en egen importmappe med 50–100 eksportsider til den private piloten. De tilsvarende originalene teller ikke med en ekstra gang. Lag en fasit før justering med 20 kjente kommentarer og 10 blindspor. Reserver en hel notatbok og alle versjonene i én dokumentfamilie. Bruk de reserverte dokumentene først ved sluttevalueringen. Lagre fasit og privat indeks utenfor kildetreet.

Fasiten er JSON med `holdout.notebook` (relativ filsti), `holdout.versions` (liste med relative filstier) og `queries`. Hvert søk angir `query`, `mode` (`all` eller `ink`) og `expected`. For et blindspor er `expected` lik `null`. Et kjent treff kan for eksempel være `{"document":"Kommenterte/Emneplan.pdf","page":3,"rect":[280,350,90,14]}`. Rektangelet omslutter håndskriften og oppgis i PDF-punkter fra sidens nedre venstre hjørne. Sidenummeret begynner på 1. Treffet teller når dokument og side stemmer, og det felles arealet dekker minst halve hvert rektangel.

Kjør fra utvidelsesmappen etter bygg. Bruk absolutte stier.

```sh
assets/remarkable-notes index --root "$IMPORTMAPPE" --store "$INDEKSMAPPE"
node scripts/notes-pilot.mjs "$INDEKSMAPPE/catalog.json" "$FASIT"
NOTES_PILOT_CATALOG="$INDEKSMAPPE/catalog.json" NOTES_PILOT_GOLD="$FASIT" \
  ./node_modules/.bin/vitest run --maxWorkers=1 --reporter=verbose --silent=false tests/notes-command.test.tsx -t 'pilot:'
```

Grensen er minst 16/20 riktige utsnitt blant topp tre, 0/10 blindspor med sikre treff og p95 høyst 1000 ms. Tidsmålingen går fra input til rendret React-liste med lokal bildeadresse for første treff i det hodeløse testmiljøet. Den måler en allerede innlest katalog. Ved et bomskudd viser evalueringsskriptet om utsnittet manglet i indeksen, om lesning/avsnittstilknytning manglet, eller om treffet ble rangert for lavt.

Et reproduserbart syntetisk sett kan genereres med `python3 scripts/make-notes-fixture.py /absolutt/ny/testmappe` (Pillow og ReportLab). Settet inneholder eksportene i `import/` og `fasit.json`. Det bruker kursiv skrift gjengitt som bildepiksler for å teste hele kjeden fra PDF til lokalt OCR-søk.

Målt 10. november 2026 på den ferdigbygde macOS-hjelperen med Apple Vision: 60 syntetiske sider i seks eksportfiler ga 20 kommentarutsnitt. Riktig utsnitt kom blant de tre første i 20/20 søk. Ingen av de 10 blindsporene ga sikre treff. Hodeløs p95 for listen og bildeadressen var 4 ms på de 30 søkene. På fysisk side 7 i testdokumentet «Emnebeskrivelse v2» viste PNG-en både avsnittet om MUR107 og margkommentaren «høstsemester».

Alle 30 ordinære TypeScript-/React-tester og 14 Swift-tester bestod, sammen med lint, typesjekk og distribusjonsbygg. En PDFView uten vindu viste riktig fysisk side med kommentarens rektangel i visningsområdet. Testene omfatter også innskutt side, rotasjon, uklar sidetilknytning, endret siffer i rasterisert eksport og oppfrisking av indeksen. Treffkvaliteten på privat håndskrift og den synlige presentasjonen i Raycast er fortsatt umålt.
