# Arbeidsregler for denne personlige Raycast-forken

## Omfang og dokumentasjon

- Sjekk aktuell Git-status og instruksjoner i berørte undermapper før endringer.
  Bevar brukerens øvrige endringer og private filer; stage bare filer som tilhører oppgaven.
- De lokale komponentene er `extensions/todoist`, `extensions/local-search`,
  `extensions/parallels-virtual-machines`, `script-commands`, `shared` og
  `tooling/raycast-setup`. Checkout kan være sparse; ikke hent eller bygg hele
  oppstrømsmonorepoet for en lokal endring.
- Hold berørte README-er og eksisterende QA-dokumentasjon oppdatert. Skill
  implementert kode, automatiserte tester, lokal installasjon og faktisk bruk.
  Commit/push betyr ikke at en integrasjon er installert eller aktivert.
- Se rotens README og `tooling/raycast-setup/README.md` for prosjektkart og
  kontrollert oppdatering/tilbakeføring. Ikke start `ray develop`, installer,
  registrer eller restart apper som del av rutinemessig verifikasjon.

## Testing uten avbrudd

- Bruk normale kommandolinjetester, typesjekk, lint og bygg. Behold meningsfulle,
  deterministiske regresjonstester i de vanlige testpakkene.
- Ikke bruk Computer Use, skrivebordsautomatisering, åpne brukerprogrammer,
  brukerens nettleserprofil, systemutklippstavlen eller synlige simulatorer til
  rutinemessig testing. Ikke flytt peker eller fokus, send tastetrykk, eller be
  brukeren lukke/restarte apper, låse opp enheter eller utføre manuelle teststeg.
- Nettlesertester skal være headless med egne prosesser og isolerte profiler.
  Ved endring av webapplikasjoner: behold Safari-kompatibilitet, test Chromium og
  WebKit og relevante mobile visningsstørrelser. Dette beviser ikke ekte Safari
  eller fysisk iOS. Rapporter presist hva som er og ikke er verifisert.
- Bruk én testarbeider lokalt og kjør tunge kontroller sekvensielt. Undersøk feil
  via logger, testresultater, spor og automatisk genererte bilder. Manglende dekning
  gir ikke tillatelse til å bytte til interaktiv testing.
- Native AppKit-tester skal bruke løsrevne visninger uten vinduer. Bruk simulerte
  kontoer/API-er og erstatt appåpning med stubber. Stopp bare oppgavens egne servere
  og prosesser og rydd egne midlertidige testfiler etterpå.
- Unntak krever at brukeren uttrykkelig ber om den konkrete interaktive kontrollen,
  eller at eksisterende ubetjent CI kan kjøre den uten å påvirke skrivebordet.
  En generell beskjed om å teste, committe eller publisere er ikke et slikt unntak.

## Kontroller for berørte komponenter

Kjør fra den berørte utvidelsens mappe; ikke kjør alle komponenter uten grunn.
For Todoist:

```sh
npm test -- --maxWorkers=1
npm run lint
npm run typecheck
```

`npm test` kjører også fokusbroens Node-/HTTP-tester via `pretest`. De bruker
isolerte loopback-porter og simulerer Raycast-åpning. `npm run test:bridge` kjører
bare disse testene. Ved native endringer eller bygg som trenger ny fokushjelper:

```sh
FOCUS_PANEL_BUILD_DIR=work/OPPGAVENS-UNIKE-MAPPE npm run test:focus
FOCUS_PANEL_BUILD_DIR=work/OPPGAVENS-UNIKE-MAPPE npm run build
```

Bytt plassholderen med en unik oppgavemappe. `npm run build` bygger også native
fokushjelper, men registrerer ikke utvidelsen i Raycast. For endringer i det felles
oppsettet brukes `npm test` fra `tooling/raycast-setup`; dette bruker syntetiske
hjemmemapper og simulert aktivering. Andre komponenters kommandoer står i deres
`package.json` og README.

## Todoist og fokuskortet

- Gjenbruk `src/focus/service.ts` og eksisterende native fokuskort. Ekstern inngang
  er `src/focus-task.ts`; lokal HTTP-bro, installasjon og dokumentasjon ligger i
  `integrations/focus-context-menu` under Todoist-utvidelsen.
- Bevar HMAC-kontroll av rå forespørselsbytes, kontoavgrensning, fast Raycast-URL,
  ferske oppgavedata, request-kvitteringer og tidsavgrensede native starter.
- Start aldri automatisk på nytt etter et uavklart utfall. Samme aktive oppgave
  skal gjenåpnes uten å nullstille timer, pause eller kø. Et akseptert OS-kall skal
  beskrives som sendt til fokuskortet, ikke som bekreftet startet fokus.
- Privat integrasjonskonfigurasjon, verifikasjonsnøkler, API-token, oppgavedata og
  kvitteringer skal ikke inn i Git eller chat. `config.example.json` inneholder
  bare plassholdere. Ikke endre Raycasts tillatelser eller opprett en offentlig
  tunnel som del av testing.
- `integrations/focus-context-menu/QA.md` dokumenterer verifikasjon og gjenværende
  aktivering. Bevar skillet mellom automatisert kontrakttest og ekte appbruk.

## reMarkable og diskhygiene

- Ved sending, opplasting, synkronisering, organisering, listing, nedlasting eller
  sikkerhetskopiering på reMarkable: bruk `remarkable-cli-workflow` og foretrekk
  installert `rm2`. For Markdown-lignende notater: bruk også
  `send-markdown-to-remarkable`. Testkjøring skal ikke utføre ekte sendinger.
- Kontroller ledig diskplass før Xcode-/iOS-/watchOS-/simulatortunge oppgaver.
  Under 25 GB ledig: unngå store nedlastinger og nye runtimes, og opplys om grensen.
- Legg egne byggeprodukter, cacher, arkiver og testbunter i oppgavens `work/`-mappe
  eller en unik midlertidig mappe. Bruk eksplisitt `-derivedDataPath` med xcodebuild.
  Gjenbruk installerte runtimes og egnede simulatorer.
- Bevar nødvendige leveranser før opprydding; fjern bare eksakte oppgaveopprettede
  mapper/enheter. Ikke slett delte Xcode-data, runtimes, andre DerivedData-mapper
  eller brukerens filer. Rapporter plassering, beholdt størrelse og ryddestatus
  dersom oppgaven skriver mer enn 1 GiB utenfor arbeidsområdet, og kontroller
  ledig plass etter vesentlig filproduksjon.
