# Todoist

**This extension is not created by, affiliated with, or supported by Doist.**

Check your Todoist tasks from within Raycast and quickly create new ones.

## Create Tasks View

You can quickly access your `Home` command favorites views using deep-links and quick-links. Here's how:

1. Open the `Home` command and select your view in the dropdown (e.g `All Tasks` or a specific project)
2. Search for `Create View Quicklink` in the actions (`⌘` + `K`).
3. Give the quicklink a custom name (optional) and create it (`⌘` + `⏎`).
4. Use Raycast root search to find your new quicklink and quickly access your tasks view.

This makes it easy to access any of your views, including projects and labels!

## Quick date choices

Open **Schedule Task** (`⌘⇧S`) on a task to choose **Today**, **Tomorrow**,
**Later This Week**, **This Weekend**, **Next Week**, or **No Date**. Each dated
choice shows its target day and date. Moving a task keeps its time and recurrence;
**No Date** removes its date and recurrence. **Pick Date** and **Set Repeat**
remain available below the shortcuts.

**Later This Week** means two days from today and is hidden if that falls in the
next week. The weekend and next-week choices use your Todoist date settings
(Saturday and Monday by default); a weekend that has passed is labeled **Next
Weekend**.

## Disabled Commands

This extension includes a few commands that are disabled by default. You can enable them by going to the extension's settings. These commands are:

- `Create Project`
- `Unfocus Current Task`

## Using the Extension With an API Token

In most cases, you can use OAuth to authenticate with Todoist. You'll be prompted to connect your Todoist account when using any of the extension's commands.

However, if you prefer, you can also use an API token. To do so, you need to retrieve your token from the [integration settings view](https://todoist.com/app/settings/integrations) under the section called **API token**. Copy it and paste in the extension's preferences under **Todoist Token**.

## Developing this fork

This fork fixes filter pagination, sync cache merging, and task duplication.
From `extensions/todoist`, run:

```sh
npm ci
npm test
npm run lint
npm run build
```

Tests use simulated API responses and do not access a Todoist account.
To load the fork locally in Raycast, run `npm run dev`. Authenticate in Raycast when prompted.
The distribution build is written to `dist/`; building and testing do not install the fork or change the Store version.

## Min arbeidsdag

**Min arbeidsdag** finnes som egen kommando og som visning i **My Tasks**.
Eksisterende standardvisning beholdes. Velg **Legg til oppgaver** for å finne
forslag fra dagens og forfalte oppgaver, eller søk blant alle aktive oppgaver som
er dine eller uten tildeling. Oppgaver uten dato eller med en fremtidig dato kan
også tas med. **Legg til i arbeidsdagen** finnes dessuten i de vanlige oppgavelistene.

- **Flytt opp/ned** bestemmer arbeidsrekkefølgen. **Marker som topp tre** fremhever
  inntil tre oppgaver uavhengig av rekkefølgen; markeringen endrer ikke Todoist-prioritet.
- Oppdatering fra Todoist beholder utvalget og rekkefølgen. Fullførte og utilgjengelige
  oppføringer vises separat. **Fjern fra dagen** fjerner bare den lokale oppføringen.
- **Start dagens fokus** begynner ved første aktive oppføring. **Start fokus herfra**
  begynner ved den valgte oppføringen. Dagsplanen til reMarkable bruker samme aktive
  utvalg og rekkefølge.
- Planen lagres separat for hver Todoist-konto og kalenderdato i Europe/Oslo.
  På en ny dag tilbyr **Velg hva som videreføres** de uferdige oppgavene fra siste
  tidligere plan. Bare oppgavene du velger legges til; topp tre velges på nytt.

Arbeidsdagene ligger i `workdays/` i utvidelsens støtteområde. De beholdes uavhengig
av PDF-eksportenes sju dagers levetid. Atomisk lagring og låsing beskytter mot
samtidige kommandoer. Oppgavedato, prosjekt, prioritet og selve Todoist-oppgaven
endres ikke når du planlegger, flytter eller fjerner en lokal oppføring.

### Fokuskøen

Fokus startet fra arbeidsdagen følger den samme rekkefølgen, uten en egen kø å
redigere. Etter utløpt økt kan du velge **Fortsett**, **Ta pause** eller **Neste
oppgave**. Etter bekreftet fullføring blir kortet stående med **Start neste** og
muligheten til å avslutte. Neste oppgave starter først når du velger det, og
ventetiden teller ikke som arbeid.

**Neste oppgave** lagrer stoppet på gjeldende arbeidsperiode uten å fullføre
Todoist-oppgaven. Den hoppede oppgaven blir i planen, men køen går bare fremover;
den begynner ikke automatisk fra toppen. Før overgang kontrolleres fersk
Todoist-status, og fullførte eller utilgjengelige oppføringer hoppes over. Ved feil
forblir økten pauset. Endret rekkefølge gjelder ved neste overgang og avbryter ikke
pågående arbeid. En økt som går over midnatt beholder den opprinnelige plandatoen.

Gjentakende oppgaver knyttes til den valgte forekomsten. Fullføring skal ikke ta
neste forekomst inn i køen automatisk. Økt-ID og forespørsels-ID beskytter mot
forsinkede svar og doble handlinger. **Focus Task** utenfor arbeidsdagen fortsetter
å fungere som en enkeltstående økt.

## Arbeidsoversikt

**Arbeidsoversikt** viser dag eller uke, med **Forrige periode**, **Neste periode**
og prosjektfilter. Datoene følger Europe/Oslo, og ukene går fra mandag til søndag.
Visningen oppdateres ved åpning og med **Oppdater** (`⌘R`); den gjør ingen periodiske
bakgrunnskall.

- Fokustiden bygger på lagrede aktive arbeidsperioder, også når Toggl er slått av.
  Tid fordeles over dato- og ukegrenser, uten å legge økttotalen til en gang til.
  En åpen periode telles bare frem til siste lagrede kontrollpunkt; pause, dvale og
  tid etter krasj telles ikke.
- Fullføringer hentes fra Todoists aktivitetslogg, på tvers av klienter og prosjekter,
  filtrert på den innloggede brukeren. Alle sider leses og hendelser dedupliseres.
  Tallet er antall **fullføringer utført i perioden**, ikke antall unike oppgaver:
  hver gjentakende forekomst og hver ny fullføring etter gjenåpning teller.
- Toggl-status skiller mellom bekreftet synkronisering, ventende arbeid, bare lokal
  tid og avvik. At du har valgt å beholde en ekstern Toggl-versjon betyr ikke at
  den samsvarer med den lokale tiden. Rapporten kontakter ikke Toggl på nytt.
- **Datadekning** og oppdateringstid viser om resultatet er komplett, begrenset av
  kontoens aktivitetshistorikk, delvis hentet eller basert på tidligere lagrede
  opplysninger. Manglende data vises som ukjent eller et minimum, ikke som null.

Nye arbeidsperioder beholder Todoist-konto og prosjektnavn. Eldre perioder uten
sikker kontotilknytning vises separat fra hovedtallene. Eldre økttid uten pålitelige
starttidspunkter beholdes, men fordeles ikke på dager. Rapportcache ligger i
`work-reports/` i støtteområdet og er skilt per konto og periode.

## Flytende fokuskort (macOS)


**Focus Task** (`⌘F` på en Todoist-oppgave) åpner nå et eget, flyttbart macOS-kort.
Kortet viser oppgavetittelen med tekstbryting og en timer. Det har sin egen størrelse;
Raycasts generelle utseende blir ikke endret.

Kompaktmodus er standard, også ved oppgradering. Kortet starter på 360 × 240 punkter
(minst 320 punkter bredt), med automatisk minimumshøyde for valgt tekststørrelse.
Det viser tittel, timer/status, **Pause/Fortsett** og menyen **•••**. Lange titler kan
rulles uten å forkortes. Menyen gir **Vis detaljer**, **Fullfør oppgave**, **+5 min**,
**Åpne oppgave**, **Flytt** og **Avslutt økt**. Ubegrensede økter skjuler **+5 min**.
**Vis detaljer** åpner alle kontrollene nedenfor; velg **Vis kompakt** for å gå tilbake.
Visningsvalg og størrelse for hver visning huskes separat, sammen med tekststørrelse
og plassering. Bytte beholder økten og øvre høyre hjørne innenfor skjermen.

Fullføring, feil, ventende synkronisering og ubekreftet Toggl-stopp vises også i
kompaktmodus. **Prøv igjen** gjentar fullføring; **Se detaljer** åpner de eksisterende
kontrollene for synkronisering og gjennomgang. Varsler kan øke høyden midlertidig
uten å endre lagret størrelse. ⌘P, ⌘+ og ⌘↵ virker i begge visninger.

- Velg **Tekst: 20 / 26 / 34 / 42** og **Bredde: 420 / 480 / 640 / 800** direkte i kortet.
  Dra i tittelen eller bruk **Flytt**-menyen for å flytte vinduet, og bruk håndtaket nederst til høyre for fri størrelse.
  Plassering, bredde og tekststørrelse huskes. Svært lange titler kan rulles inne i kortet.
- En ny økt starter med 25 minutter. Velg 15, 25, 50 minutter eller uten tidsgrense i kortet,
  eller endre standarden i utvidelsens **Focus Session Length**-innstilling.
  Endring av varighet bevarer tiden du allerede har jobbet.
- **Pause / Fortsett** styrer aktiv tid, og **+5 min** forlenger økten.
  Når tiden er ute, blir kortet stående med valget om ny økt eller forlengelse.
- **Åpne oppgave** åpner oppgaven i Todoist. **Avslutt økt** lukker kortet og stopper timeren.
  Ingen av delene fullfører oppgaven i Todoist.
- **Fullfør oppgave** fullfører oppgaven i Todoist og fjerner fokuset. En enkeltstående
  økt lukker kortet; i fokuskøen blir det stående klart for **Start neste**.
  Timeren står på pause mens fullføringen pågår. Ved feil kan du prøve igjen eller fortsette økten.
  For gjentakende oppgaver fullføres den aktuelle forekomsten, og fokusetiketten fjernes fra den neste.
  Hvis kommandoen ble deaktivert av en tidligere versjon, aktiver **Complete Focused Task**
  under **Raycast Settings → Todoist**. Godkjenn eventuell forespørsel fra Raycast om å kjøre kommandoen.
- Lukkekrysset setter økten på pause. Bruk **Show Focus Window** i Raycast for å hente den
  frem igjen. Samme oppgave beholder timeren; en annen oppgave starter en ny økt.
  **Unfocus Task** stopper også kortet. Etter maskinhvile, skjermlås eller omstart må en
  påbegynt økt fortsettes manuelt. Ved et uventet prosesskrasj kan inntil fem sekunder
  siden siste lagring gå tapt.

Kortet er en AppKit-hjelpeapp som får oppgavemetadata gjennom lokale JSON-filer under
utvidelsens supportmappe (`focus-panel/`). Den får ingen Todoist-token. Med Toggl
aktivert gjør hjelpeappen egne Toggl-kall og kan fortsette synkronisering etter at
kortet er lukket. App- og nettstedblokkering inngår ikke. Windows beholder den
eksisterende menylinjefunksjonen.

### Toggl Track i fokuskortet

Velg **Koble til Toggl**, lim inn API-tokenet fra Toggl-profilen, og velg
arbeidsområde og standardprosjekt eller **Uten prosjekt**. Tokenet lagres bare i
macOS-nøkkelringen. Det sendes ikke gjennom Raycast-broen eller skrives til lokale
JSON-filer eller logger. macOS kan be om nøkkelringtilgang etter at den lokalt
signerte hjelpeappen er bygget på nytt. Tilgangsfeil vises i kortet.

- **Registrer i Toggl** styrer føring fra handlingstidspunktet. Tid jobbet mens
  bryteren var av, etterregistreres ikke. Prosjektvalg huskes per Todoist-prosjekt,
  Toggl-konto og arbeidsområde. Eldre fokusoppgaver uten prosjekt-ID bruker standarden.
- Oppgavetittelen blir beskrivelsen. Todoist-lenken kan slås på i innstillingene.
  Prosjektlisten kan oppdateres manuelt; innstillingene oppdaterer automatisk en
  liste som er eldre enn 24 timer.
- **Arbeidstid i økten** er samlet lokal aktiv tid. Nedtellingen viser fortsatt tid
  igjen. **⌘P** pauser/fortsetter, **⌘+** forlenger og **⌘↵** fullfører oppgaven.
- Pause, utløp, oppgave-/prosjektbytte, lukking, skjermlås og dvale avslutter den
  aktuelle arbeidsperioden. Fortsett og **+5 min** etter utløp åpner en ny periode.
  12 minutter arbeid, 5 minutter pause og 8 minutter arbeid gir to registreringer
  med til sammen 20 minutter.
- **Registrerer i Toggl** betyr bekreftet ekstern oppstart. Nettbrudd og API-kvoter
  gir lokal kø. Når stopp ikke er bekreftet, opplyser kortet at den eksterne timeren
  kan fortsette. Stopp synkroniseres med det lagrede tidspunktet.
- En annen aktiv timer krever et valg: **Bytt til fokusoppgaven** eller **Fortsett
  uten Toggl**. Før stopp og oppdatering kontrolleres registreringen for eksterne
  endringer. Kortet pauser ved konflikt og lar deg beholde Toggl-versjonen eller
  erstatte den med lokal tid.
- **Synkroniser** kontrollerer hele gjeldende fokusøkt, også ferdig synkroniserte
  perioder. Automatiske handlinger behandler bare ventende arbeid; oppstart og
  oppvåkning kontrollerer også aktiv periode. Historikken hentes ikke på nytt ved
  hver pause eller gjenopptakelse. Det gjøres ingen periodisk polling.
- Ved uklart opprettelsessvar vises **Se gjennom**. Kontroller kandidater i Toggl,
  og knytt eventuelt til en eksisterende registrering. Automatisk ny opprettelse
  forsøkes aldri etter et mulig gjennomført kall, heller ikke ved tomt oppslag.
- Etter krasj stoppes en kjent fokusregistrering ved siste lagrede kontrollpunkt.
  Det usikre intervallet markeres for gjennomgang, med mulighet til å korrigere
  stoppetiden. Normalt kan opptil fem sekunder siden siste lagring mangle.
- **Fullfør oppgave** lagrer stopp før Todoist-kallet. Todoist kan fullføres mens
  Toggl venter; meldingen opplyser da om uavklart synkronisering. **Show Focus Window**
  kan åpne ventende Toggl-arbeid også etter at Todoist-fokuset er fjernet.

Køen lagres før nettverkskall og overlever omstart. Hjelpeappen kjører videre uten
synlig kort mens automatiske forsøk gjenstår. Den avsluttes når køen er ferdig eller
krever et valg. Etter maskinomstart starter den ved neste fokusbruk; integrasjonen
installerer ingen innloggingstjeneste. Gamle perioder beholder sin opprinnelige
konto og sitt arbeidsområde ved kontobytte. Allerede lagrede kontotoken kan brukes
for å avslutte disse periodene; ingen perioder flyttes til den nye kontoen.

Lokal fokusstatus migreres fra versjon 1 eller 2 til versjon 3. Før migrering
lagres en byteidentisk kopi som `state-v1-before-workday.json` eller
`state-v2-before-workday.json` ved siden av `state.json`, med tilgang bare for
brukeren. Eksisterende sikkerhetskopi overskrives ikke. Arbeidsperioder, historikk,
ventende Toggl-arbeid og vindusinnstillinger beholdes. Eldre tid uten pålitelige
starttidspunkter blir ikke gjort om til daterte arbeidsperioder eller sendt til Toggl.

En eldre hjelpeapp som bare støtter versjon 1 eller 2 må ikke brukes mot migrerte
data. Tilbakeføring må bruke en versjon som støtter versjon 3; ikke erstatt gjeldende
status med sikkerhetskopien for å omgå dette, siden nyere arbeid og ventende
synkronisering da kan gå tapt.

Synkroniseringen bruker separate, vedvarende budsjetter for bruker- og
organisasjonskall, tilpasset gratiskvoten på 30 kall per time. Vanlige kall får bruke
28 plasser; de siste to holdes av til nødvendige stopp og avklaringer. Fem vanlige
arbeidsperioder med pause/gjenoppta bruker 10 brukerkall og 10 organisasjonskall,
utenom tilkobling, manuell synkronisering og feil.

Toggls headere for restkvote og tilbakestilling brukes sammen med det lokale
budsjettet. Restkvote uten tilbakestillingstid beholdes konservativt i én time.
HTTP 402 følger den lengste oppgitte ventetiden fra kvoteheaderen og `Retry-After`;
én time brukes bare dersom begge mangler eller er ugyldige. HTTP 429 gir også
utsatt nytt forsøk. `Retry-After` støtter sekunder og HTTP-dato. Lokale grenser kan
kreve lengre venting, og manuell synkronisering omgår ikke disse grensene.

Budsjetter og ventetider overlever omstart. Andre integrasjoner kan bruke den
samme kvoten etter siste svar fra Toggl; verken serveropplysninger eller lokale
budsjetter garanterer derfor at et stopp kan sendes straks. Stoppetiden beholdes
lokalt slik at senere synkronisering ikke forlenger registrert arbeidstid.
Arbeidsoversikten viser lokal tid og sist kjente Toggl-status. Import av annen
Toggl-historikk, etikettkoblinger og fakturerbar tid inngår ikke.

`npm run test:focus` bruker falsk klokke og simulerte Toggl-svar. Testene dekker
blant annet nøyaktig aktiv tid, frakoblet arbeid, omstart, uklare svar, kallforbruk,
kvoteheadere, stoppreserve, ventetider og manuell kontroll av historikk,
eksterne endringer, kontobytte, lagringsfeil og migrering. `npm test` kontrollerer
JSON-broen, samtidige Raycast-kommandoer og Todoist-fullføring. Automatiske tester
bruker ingen ekte kontoer eller token.

Ved oppgradering husker hjelpeappen også kvitteringen fra det gamle meldingsformatet.
En gammel `request.json` kan dermed ikke hente tilbake en tidligere fokusoppgave
etter at en ny er valgt. Nye kømeldinger går foran gamle meldinger, og en mislykket
lagring stanser behandlingen til meldingen kan lagres.

Bygging krever eksisterende Xcode Command Line Tools på macOS. `npm run build` og
`npm run dev` bygger hjelpeappen først. **Bygging og testing skal ikke avbryte en
pågående fokusøkt.** Den nye hjelpeappen tas i bruk ved neste naturlige oppstart;
verifikasjonen skal ikke lukke eller starte brukerens aktive kort på nytt.
Bygge- og testmappen kan overstyres med `FOCUS_PANEL_BUILD_DIR` (relativt til
utvidelsen eller som absolutt sti); standarden er `work/focus-panel-build`.
Hjelpeappen bygges for arkitekturen til maskinen du bruker; et distribuert bygg for
andre Mac-arkitekturer må bygges der eller gjøres universelt før publisering.

```sh
npm run build:focus  # AppKit-hjelpeapp, lokalt signert, ingen nedlasting
npm run test:focus   # Timer, lagring, Toggl og løsrevne AppKit-visninger
npm test            # Inkluderer JSON-broen og bekreftelse av oppstart
```

Genererte moduler og testprogram ligger i `work/focus-panel-build/` og kan slettes
etter bygging. Kjørbar app i `assets/focus-panel/` må beholdes for lokal bruk og inngår
i Raycast-bygg. Den er generert og ikke sjekket inn.

### Kontrollert lokal oppdatering på macOS

Det felles [PersonalRaycast-verktøyet](../../tooling/raycast-setup/README.md) erstatter den permanente utviklingstjenesten. Fra repo-roten:

```sh
./bin/raycast-setup setup
./bin/raycast-setup check
./bin/raycast-setup update
./bin/raycast-setup rollback
```

Kildeendringer tas i bruk etter beståtte kontroller. Fokusøkter og ventende Toggl-arbeid beholdes. `npm run dev` er fortsatt tilgjengelig for eksplisitt utvikling. Eksisterende `local:install` og `local:restart` videresender til oppsett og oppdatering. Tjenesten avvikles først når du kjører den nye installasjonsflyten; det skjer ikke ved bygging eller testing.

## Outlook til Todoist (macOS)

**Create Task from Outlook** henter markert tekst direkte fra Outlooks
tilgjengelighetsgrensesnitt, og leser emne og avsender fra det synlige meldingshodet.
Raycasts `getSelectedText()` brukes som reserve hvis Outlook ikke tilbyr den
native markeringen. Kommandoen bruker macOS-tilgjengelighet og System Events og trenger ikke
Todoist-tillegget i Outlook eller Microsoft Graph-tilgang.

1. Åpne en e-post i Outlooks leserute eller i et eget vindu.
2. Marker tekst i selve e-posten.
3. Kjør **Create Task from Outlook** i den lokale Todoist-utvidelsen.
4. Kontroller tittel og beskrivelse, velg eventuelt prosjekt/dato, og bruk
   **Create Task** for å lagre.

Hurtigtaster satt i Raycast er globale. For å bruke **⌘T bare i Outlook**, legg
snarveien under **Microsoft Outlook → Keyboard Shortcuts** i BetterTouchTool,
med handlingen **Execute Shell Script / Task** og dette skriptet:

```sh
/usr/bin/open -g 'raycast://extensions/doist/todoist/create-task-from-outlook?launchType=background'
```

Fjern eventuell global ⌘T-binding i Raycast. Bakgrunnsstarten lar Outlook beholde
fokus mens teksten leses; oppgaveskjemaet åpnes deretter. Kommandoen leser
markeringen også når Outlooks «Forklar dette»-popup har fokus. Den sender ikke
Escape og endrer ikke fokus i e-posten. Feil vises som en kort melding selv ved
bakgrunnsstart. Raycast trenger macOS-tillatelse til tilgjengelighet
og til å bruke System Events hvis systemet ber om det.

Emnet fylles inn som tittel. Beskrivelsen inneholder avsenderens navn og
e-postadresse, etterfulgt av akkurat det markerte utdraget. Avsenderen gjelder
den åpne meldingen, også når utdraget kommer fra sitert tekst i tråden.
Du kan redigere alt før oppgaven lagres. E-postemner tolkes som vanlig tekst;
datoer, `p1`, `#prosjekt` og `@etikett` i emnet endrer ikke andre oppgavefelt.

Kommandoen stopper hvis Outlook ikke er aktiv, markeringen mangler, fokus er
utenfor e-postens leserute og markeringspopup, eller meldingshodet ikke kan leses. Den henter ikke
gammelt innhold fra utklippstavlen som reserve. Utdraget logges ikke av
kommandoen, og automatisk kladdelagring er slått av for dette skjemaet.
Tilgjengelighetsfeltene kan endres i senere Outlook-versjoner; en uventet
struktur gir en feil fremfor å gjette emne eller avsender.

## Dagsplan til reMarkable (macOS)

Kommandoen **Send dagsplan til reMarkable** lager en norsk dagsplan fra det aktive
utvalget i **Min arbeidsdag**, i samme rekkefølge og med de samme topp tre-markeringene.
Todoist-data og arbeidsdagen leses på nytt ved åpning og før eksport. Oppgaver som
ikke lenger er tilgjengelige tas ikke med i en ny PDF.

1. Velg oppgaver i **Min arbeidsdag**. Hvis dagens plan mangler eller er tom, gir
   eksportkommandoen handlingen **Velg oppgaver til arbeidsdagen**. Etter redigering
   kan du åpne eksportkommandoen igjen eller bruke **Hent arbeidsdagen på nytt**.
2. Åpne **Velg målmappe**, og velg en eksisterende mappe eller **Opprett ny mappe**.
   Navnefeltet foreslår `Dagsplaner`. Den nye mappen opprettes i **Mine filer** og
   velges automatisk. En eksisterende mappe med samme navn der gjenbrukes.
3. **Lag forhåndsvisning** (`⌘↵`) fryser planen, lager PDF og kontrollerer hver side.
   Raycast viser ett sidebilde om gangen med **Side X av Y**. Bla med **Neste side**
   og **Forrige side** (`⌘→` / `⌘←`). Sidenavigasjon sender aldri dokumentet.
4. Velg **Send til reMarkable** (`⌘⇧↵`) for eksplisitt sending til den viste mappen.
   Forhåndsvisning alene laster ikke opp filen. Bekreftet sending lagrer dokument-ID.
   **Åpne PDF eksternt** er et eget valg; andre apper åpnes ikke automatisk.

Dagens siste usendte arbeidsdagseksport kan gjenopptas ved neste åpning. Endringer
markeres når arbeidsdagen leses på nytt. Velg **Kontroller arbeidsdagen** (`⌘R`) i
forhåndsvisningen for å oppdatere denne kontrollen. Den gamle PDF-en endres ikke;
lag en ny forhåndsvisning for å få med endringene.

PDFKit genererer dokumentet direkte. Sidene har reMarkable-skjermens 3:4-format
(447 × 596 pt), og venstremargen gir plass til verktøylinjen. Første side har dato,
oppgaveantall, forfalte oppgaver, samlet estimat, valgt **Dagens fokus** og en
kronologisk tidslinje over dagens oppgaver med klokkeslett.

**Arbeidsrekkefølge** følger den lokale planen, også når prosjekter er blandet
eller en underoppgave står før forelderen. Prosjekt og eventuell forelder vises
som tilleggsinformasjon. Store avkrysningsbokser, prioritetssirkler, **FORFALT**-merke,
prikkekolonne og en avsluttende notatflate beholdes. Lange titler brytes og finnes
i sin helhet i oppgavelisten; fokusfeltet og tidslinjen kan forkorte oppsummeringen.
Oppgavetekst behandles bokstavelig. Inter og Noto Emoji følger med og bygges inn i PDF-en.

### Lokalt oppsett

- Installer `rm2` med Cloud-støtte fra den lokale reMarkable CLI-installasjonen.
- Installer Poppler (`brew install poppler`) for `pdfinfo` og `pdftoppm`.
- Mappevalg og oppretting krever både `rm2 cloud web-login` og `rm2 cloud login`.
  Web-listen kan være forsinket; `--fresh` kontrollerer derfor mappeinnholdet mot
  den levende synkroniseringsindeksen før valg eller oppretting.
- Mappeoppretting krever `rm2 cloud mkdir` og `create_folder` og `fresh_listing` i CLI-ens capabilities.
  Den lokale installasjonen er oppdatert; endringen og oppsett er dokumentert i
  [support/rm2-cloud-mkdir.md](support/rm2-cloud-mkdir.md).
- `rm2 cloud login` kreves for sending. Den lagrede upload-parent-ID-en brukes
  direkte, så senere sending trenger ikke web-innlogging.
- PDF-forhåndsvisning kan lages uten gyldig upload-innlogging.

Kommandoens innstillinger kan overstyre absolutte stier til `rm2`, `pdfinfo` og
`pdftoppm`. Standardene søker i Homebrew, PATH og den lokale rm2-installasjonen
under `~/Library/Python/3.9/bin`. Poppler fra den lokale Codex-runtime-installasjonen
brukes som reserve når den finnes.
Ingen innloggingshemmeligheter lagres eller logges av denne kommandoen.

### Forhåndsvisning, nytt forsøk og lokale filer

Hver eksport får eget dokumentnavn `Dagsplan – ÅÅÅÅ-MM-DD – TT.MM.SS` og en unik
jobbmappe i Raycasts støtteområde (`daily-plans/<UUID>`). PDF, Markdown-kopi,
jobbstatus og validerte PNG-sidebilder beholdes i sju dager; utløpte jobber ryddes
ved neste bruk. Midlertidige og mislykkede renderinger fjernes. **Vis eksportfiler**
viser den lagrede PDF-en i Finder.

Sidebildenes kontrollsummer knyttes til PDF-ens kontrollsum. Manglende eller
ødelagte sidebilder regenereres fra den samme verifiserte PDF-en, uten å endre
planen eller sendestatus. Dette gjelder også eldre eksportjobber. Nye øyeblikksbilder
bruker versjon 2 med manuell rekkefølge og topp tre; eksisterende versjon 1-jobber
og deres PDF-er beholdes uendret og kan fortsatt åpnes og sendes når statusen tillater det.

Endret utvalg eller målmappe krever ny forhåndsvisning. **Åpne siste eksport**
gjenåpner det tidligere, frosne dokumentet. PDF-ens kontrollsum verifiseres før
sending og gjenoppretting av sidebilder. Eksport, sending, mappeopprettelse og
gjenoppretting av sidebilder bruker samme låsing, også på tvers av
kommandoinstanser. Bekreftet sending sperrer ny sending av samme jobb. Ved et
uklart nettverksutfall eller avbrudd under opplasting må du kontrollere reMarkable;
kommandoen prøver aldri å laste opp samme jobb automatisk igjen.

Ved uklar mappeoppretting lagres en liten markør i støtteområdet. Et nytt forsøk
med samme navn gjør bare et ferskt mappeoppslag: én entydig mappe i Mine filer kan
gjenbrukes. Ellers må du kontrollere mappelisten; ingen ny opprettelse forsøkes
automatisk. Markøren beholdes til opprettelsen er avklart.

Hver eksport blir et nytt dokument. Eksisterende håndskrift beholdes, og
avkrysninger eller notater synkroniseres ikke tilbake til Todoist. Ingen
Todoist-oppgaver opprettes eller endres. Automatisk sending og USB/SSH inngår ikke.
Øvrige kommandoer har fortsatt Windows-støtte.

### Utvikling og kontroll

`npm test` inkluderer simulerte Cloud- og Poppler-svar, tester av rekkefølge og utvalg,
kontroll av bildecache og tester som leser faktiske genererte PDF-er med PDF.js.
Ingen automatiserte tester sender noe til reMarkable eller åpner en ekstern PDF-leser.
En faktisk sending skjer bare gjennom den eksplisitte sendehandlingen.

Den inkluderte [Noto Emoji-fonten](https://github.com/google/fonts/tree/main/ofl/notoemoji)
og [Inter](https://github.com/rsms/inter) er distribuert under SIL Open Font License;
se `assets/daily-plan/OFL.txt` og `assets/daily-plan/Inter-OFL.txt`.

### Verifikasjon av kompaktmodus

Automatiserte Swift-tester dekker migrering av tidligere fokusdata, separate
størrelser, visningsbytte, timerfaser, handlingsmeny/hurtigtaster, varsler og
løsrevne AppKit-visninger med lange titler, alle fire tekststørrelser og minste
bredde. Testene åpner ingen vinduer og bruker ingen ekte kontoer. TypeScript-testene,
lint og produksjonsbygg kontrolleres separat. Faktisk samspill med skrivebord,
fysiske skjermer og VoiceOver er ikke verifisert av disse testene.

## Verifikasjon av arbeidsdag, kø, rapporter og forhåndsvisning

Den normale testpakken dekker planlagring, samtidige oppdateringer, kontoskille,
valgt videreføring, gjentakende oppgaver og samme rekkefølge gjennom arbeidsdag,
fokuskø og eksport. Rapporttester bruker faste klokker og simulerte API-sider,
inkludert sommertid, midnatt, gjentatte fullføringer, nettfeil og begrenset historikk.
Fokustestene bruker falsk klokke og løsrevne AppKit-visninger, og dekker køoverganger,
gamle/doble svar, migrering, sikkerhetskopi og bevart Toggl-arbeid.

```sh
npm test -- --maxWorkers=1
npm run test:focus
npm run lint
npm run typecheck
npm run build
```

Kjør kontrollene sekvensielt lokalt. Native byggeprodukter og testprogrammer ligger
i `work/focus-panel-build/` eller en eksplisitt `FOCUS_PANEL_BUILD_DIR`. Kontroller
ledig diskplass før native bygg. Den eksisterende macOS-CI-flyten bruker samme
kommandolinjekontroller uten skrivebordsautomatisering.

PDF-testene kontrollerer faktisk tekst, sidestørrelser og koordinater. En syntetisk
PDF med norske bokstaver, emoji, lange titler, topp tre og blandet prosjektrekkefølge
er også rendret med Poppler og kontrollert side for side som lokale bilder.

Lokalt 30. oktober 2026 bestod 242 TypeScript-tester med én arbeider, alle fem
Swift-testprogrammene med falsk klokke og 22 tester av installasjon/oppdatering.
Lint, typesjekk og produksjonsbygg inngår i den samme kontrollen.

Faktisk bildevisning og navigasjon i Raycast, samspill mellom det aktive fokusvinduet
og skrivebordet, samt ekte Todoist-/Toggl-kall og reMarkable Cloud-sending er ikke
verifisert gjennom disse testene. Kontrollene bruker ingen åpne brukerprogrammer, fysiske enheter eller innloggede
nettlesere. De dokumenterte begrensningene krever ingen manuelle handlinger for å
fullføre automatisert verifikasjon.
