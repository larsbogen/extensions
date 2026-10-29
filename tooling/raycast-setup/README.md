# PersonalRaycast

Ett lokalt administrasjonsverktøy for Todoist, Parallels, Lokalt søk og Script Commands. Kjør fra denne repo-mappen:

```sh
./bin/raycast-setup setup
./bin/raycast-setup status
./bin/raycast-setup check
./bin/raycast-setup update
./bin/raycast-setup rollback
./bin/raycast-setup clean --dry-run
./bin/raycast-setup clean
```

`setup` oppretter konfigurasjon og kjører den kontrollerte installasjonsflyten. Det kan derfor ta flere minutter. Node 24 eller nyere, npm, eksisterende Xcode Command Line Tools og de eksterne prosjektenes eget oppsett må finnes fra før. Ingen programmer oppgraderes automatisk. Verktøyet bruker bare de tre personlige utvidelsene; resten av Raycast-monorepoet bygges ikke.

## Konfigurasjon og ny Mac

Maskinens konfigurasjon ligger i `~/Library/Application Support/PersonalRaycast/config.json` med versjon 1. Den inneholder `repositoryPath`, `atlasPath`, `libraryPath`, `nodePath`, `pythonPath`, `components` og `raycastTarget` (`release` for vanlig Raycast, `x` for Raycast X). Valgfrie absolutte stier: `rm2Path`, `pdfinfoPath`, `pdftoppmPath`, `focusStatePath` (selve fokusets state.json). Ukjente felt avvises. Hemmeligheter skal aldri legges her.

Eksempel ved flytting:

```sh
./bin/raycast-setup setup --repositoryPath '/ny/mappe/raycast-extensions' --atlasPath '/ny/mappe/Strava' --libraryPath '/ny/mappe/Masteroppgaver/bibliotek' --nodePath /opt/homebrew/bin/node
```

Hvis Node ligger et annet sted, sett `PERSONAL_RAYCAST_NODE` når startverktøyet kjøres. Oppsettet husker den valgte Node-stien. Eksplisitte stiinnstillinger i Raycast har forrang foran felleskonfigurasjonen. Ved neste bruk rapporterer Lokalt søk og Todoist slike avvik til `status`; før det vises at innstillingene ikke er rapportert. Nøkler, oppgaver og søkeresultater inngår ikke i denne diagnostikken.

1. Installer Node og Raycast på den nye Mac-en, og hent prosjektet. Ved sparse checkout trengs også `bin`, `shared`, `tooling` og `script-commands` i tillegg til de tre utvidelsene.
2. Installer Turatlas og biblioteket etter deres egne veiledninger. Flytt private arkiver separat.
3. Kjør `setup` med riktige mapper og Raycast-mål. Bekreft eventuell førstegangsregistrering som Raycast selv krever. Dette er oppsett, ikke en automatisk test.
4. Legg `~/Library/Application Support/PersonalRaycast/commands` til under Raycasts Script Commands. Bevar eventuelt den gamle registreringen til du har flyttet hurtigtastene, og fjern deretter duplikatene. Skriptfilnavn og utvidelses-ID-er beholdes, men en ny skriptmappe kan kreve ny binding av hurtigtaster.
5. Bruk Raycasts egne [Export Settings & Data og Import Settings & Data](https://manual.raycast.com/import-export) for aliaser, hurtigtaster og andre valgte innstillinger. Lokale utvidelser installeres fra kildekoden. Eksportfiler, token, fokusdata, ventende Toggl-arbeid og dagsplanhistorikk håndteres separat og skal ikke inn i Git.

Forslag til aliaser: `rcstatus`, `rccheck`, `rcupdate`, `rcback`, `tur` og `master`. La endrende kommandoer ha alias fremfor globale hurtigtaster; du kan selv velge hurtigtaster for daglig bruk. Ingen hurtigtaster endres av verktøyet.

## Oppdatering og gjenoppretting

Lokale filer, også nye filer og endringer uten commit, kopieres til `work/personal-raycast/<id>`. Kilden kontrolleres før og etter kopiering. `.env`, `node_modules`, gamle bygg og `.rayconfig` utelates. Ikke legg private arkiver i kildekodemappene.

`check` installerer avhengigheter med `npm ci` og kjører tester, lokal lint, bygg og typesjekk i kopien. Todoist får også Swift-tester. Ingen av disse kontrollene åpner eller registrerer noe i brukerens Raycast. `lint:store` er fortsatt en separat publiseringskontroll. Et nettbrudd under npm-installasjon stanser kontrollen og lar aktiv versjon stå.

`update` kontrollerer endrede komponenter. Felles kode eller konfigurasjonsendringer kontrollerer alle valgte komponenter. Bare beståtte kandidater aktiveres. Korte, task-eide Raycast-CLI-prosesser registrerer dem fra en beholdt kildemappe og avsluttes etter første bygg. Midlertidige avhengighetslenker fjernes etter aktivering; kildeplasseringen i Raycast forblir gyldig. Ingen permanent kildekodeovervåker blir igjen. Manuell utvikling med `npm run dev` er fortsatt mulig; en annen aktiv utviklingsprosess avvises.

Ved første migrering sikkerhetskopieres Todoists eksisterende LaunchAgent, før den avvikles. Feil gjenoppretter den tidligere tjenesten. `npm run local:install` og `local:restart` videresender nå til felles oppsett/oppdatering. De gamle stop/uninstall-aliasene viser status, siden den permanente tjenesten er avviklet; de avinstallerer ikke utvidelsen.

Mens fokushjelperen arbeider, beholdes kandidaten til neste eksplisitte oppdatering. Den nye klienten registrerer automatisk fokusdataenes plassering. Ved førstegangsbruk mot eldre fokusdata kan `focusStatePath` settes eksplisitt for kompatibilitetskontroll. En uavklart synkroniseringskø eller ukjent fokusversjon blokkerer aktivering og tilbakeføring.

En operasjonslås og journal beskytter mot samtidig kjøring og prosessavbrudd. Neste endrende handling forsøker først å gjenopprette en ufullført transaksjon. Hvis gjenoppretting feiler, beholdes journalen og handlingen rapporteres som mislykket. `rollback` gjenoppretter programkode fra sikkerhetskopi uten npm eller nettverk. Brukerdata og innstillinger spoleres aldri tilbake.

## Lagring og QA

Versjoner og rapporter lagres i PersonalRaycast-området. `clean` beholder aktiv og forrige versjon, opptil ti rapportsett i 14 dager, og avviser fremmede versjonsmapper og symbolske lenker. Logger begrenses til 10 MiB hver. Mislykkede kontroller og fullførte kandidatmapper fjernes; en utsatt kandidat beholdes. `clean --dry-run` viser hvilke filer som ville bli fjernet. En ufullført installasjonsjournal må gjenopprettes før andre handlinger, også opprydding.

Automatiske tester:

```sh
node --test --test-concurrency=1 tooling/raycast-setup/tests/setup.test.mjs
```

Testene bruker syntetiske hjemmemapper, falsk aktivering og virkelige filoperasjoner for feil, tilbakeføring, låser, utsatte kandidater, kildeendringer og sikker opprydding. En egen macOS-CI-jobb kjører verktøyet og de tre utvidelsenes kontroller sekvensielt.

Implementasjonen er testet med 20 administrasjonstester, 23 Lokalt søk-tester, 72 Parallels-tester og 159 Todoist-tester, samt Swift-testene. Lokal lint, typesjekk og distribusjonsbygg består. Testene bruker simulerte eksterne tjenester. Ekte Raycast-registrering, native visning, hurtigtaster, migrering av den kjørende LaunchAgent-en og nøkkelringdialoger er ikke kjørt under verifikasjonen. Raycasts CLI-varsling ved tilbakeføring bruker den samme lokale `cli/.../build-success`-ruten som den låste SDK-en; faktisk apprespons er ikke verifisert. Nettlesere eller enheter inngår ikke i denne endringen.

Hele `Manager.check()`-flyten er også kjørt fra et isolert øyeblikksbilde med `npm ci` fra lokal npm-cache og alle tre utvidelsenes kontroller. Den bestod uten aktivering. Turatlas-generatorens to berørte testfiler bestod med tre tester, inkludert syntetisk hjemmemappe og argumentoverføring uten serveroppstart.
