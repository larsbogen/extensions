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

## Dagsplan til reMarkable (macOS)

Kommandoen **Send dagsplan til reMarkable** lager en norsk dagsplan med dagens og
forfalte oppgaver, beregnet i Europe/Oslo. Den inkluderer aktive oppgaver med dato
eller deadline i dag eller tidligere, som er ufordelte eller tildelt deg.
Todoist-data leses på nytt både når kommandoen åpnes og når forhåndsvisningen lages.

1. Åpne **Velg målmappe**, og velg en eksisterende mappe eller **Opprett ny mappe**.
   Navnefeltet foreslår `Dagsplaner`. Den nye mappen opprettes i **Mine filer** og
   velges automatisk som målmappe. En eksisterende mappe med samme navn der
   gjenbrukes; mapper andre steder påvirkes ikke.
2. Alle oppgaver er valgt fra start. Enter velger bort/til én oppgave. Søk endrer
   ikke utvalget. Handlingsmenyen har også **Velg alle** og **Fjern alle valg**.
3. **Lag forhåndsvisning** (`⌘↵`) fryser utvalget, lager PDF og kontrollerer hver
   side. PDF-en åpnes i standard PDF-leser.
4. Kontroller oppgaver, sideantall og målmappe, og bruk deretter **Send til
   reMarkable**. Bekreftet sending viser dokumentnavn og dokument-ID.

PDFKit genererer dokumentet direkte i utvidelsen, uten Marked, AppleScript eller
Python som PDF-motor. Dokumentet har A4 stående, en Swiss-inspirert Arial-layout,
12-punkts oppgavetekst, avkrysningsbokser, to notatlinjer per oppgave, åtte generelle
notatlinjer og sidetall. Lange titler brytes. Oppgavetekst behandles bokstavelig;
HTML og Markdown kan ikke endre dokumentets mal. Noto Emoji gir svarte/hvite
emojis. Skriftene bygges inn i PDF-en.

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
brukes som reserve når den finnes. Arial leses fra macOS' installerte skrifter.
Ingen innloggingshemmeligheter lagres eller logges av denne kommandoen.

### Forhåndsvisning, nytt forsøk og lokale filer

Hver eksport får eget dokumentnavn `Dagsplan – ÅÅÅÅ-MM-DD – TT.MM.SS` og en unik
jobbmappe i Raycasts støtteområde (`daily-plans/<UUID>`). PDF, Markdown-kopi og
jobbstatus beholdes i sju dager; utløpte jobber ryddes ved neste bruk. PNG-bildene
som brukes til validering slettes straks. **Vis eksportfiler** åpner jobbmappen.

Endret utvalg eller målmappe krever ny forhåndsvisning. **Åpne siste eksport**
gjenåpner det tidligere, frosne dokumentet. PDF-ens kontrollsum verifiseres før
sending. Bare én eksport, sending eller mappeopprettelse kan kjøre om gangen, også på tvers av
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

`npm test` inkluderer simulerte prosessvar for Cloud og Poppler, dato-/utvalgstester
og tester som leser faktiske genererte PDF-er med PDF.js. PDF-testene bruker macOS'
Arial-skrifter og kjøres derfor bare på macOS. Ingen automatiserte tester sender
noe til reMarkable. Kontroller lokalt med `npm run dev`: utvalg → mappe → PDF →
forhåndsvisning. En faktisk sending utføres først når brukeren velger sendehandlingen.

Den inkluderte [Noto Emoji-fonten](https://github.com/google/fonts/tree/main/ofl/notoemoji)
er distribuert under SIL Open Font License; se `assets/daily-plan/OFL.txt`.
