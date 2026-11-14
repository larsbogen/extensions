# Start fokus fra Todoist

En privat Todoist UI-utvidelse sender den valgte oppgaven til det eksisterende
Raycast-fokuskortet. Menynavnet kan være **Start fokus**. Tjenesten kjører på samme
Mac som Raycast og mottar signerte forespørsler gjennom en HTTPS-tunnel:

```text
Todoist: høyreklikk → Start fokus
  → HTTPS-tunnel → lokal /process → Raycast focus-task → eksisterende fokuskort
```

Dette er implementert og automatisk testet med simulerte eksterne tjenester.
Det er foreløpig ikke registrert, installert eller aktivert i den virkelige
Todoist-/Raycast-kontoen. Se [QA](QA.md) for verifikasjon og begrensninger.

## Ett menyvalg

Todoist sender den første `initial`-handlingen straks menyvalget velges. Broen
starter Raycast-kommandoen på Mac-en og svarer med `finished`, uten et ekstra
kort eller en Start-knapp. Meldingen **Sendt til fokuskortet** bekrefter bare
overføringen til operativsystemet. Feil ved henting eller oppstart vises av Raycast.

Todoist dokumenterer ikke en automatisk URL-åpningshandling. `Action.OpenUrl`
krever en handling på et kort. Lokal kjøring bak HTTPS-tunnel gjør denne
begrensningen irrelevant for denne løsningen.

Raycast kan kreve et førstegangsvalg for den nye kommandoen. Den installerte
versjonen 2.11.1.0 har **Always Run Command**, som lagrer tillatelsen per kommando.
Etter dette er ett menyvalg teknisk mulig. Ingen slik tillatelse er satt av
kode eller under testing. Faktisk bruk fra Todoist er ennå ikke verifisert.

## Engangsoppsett

Krever macOS, Node 24 eller nyere, den personlige Todoist-utvidelsen i Raycast og
en fungerende Todoist-tilkobling der. Den lokale kommandoen heter `focus-task`.
Raycast-utvidelsen oppdateres gjennom prosjektets eksisterende kontrollerte
oppdateringsflyt, `./bin/raycast-setup update` fra repository-roten. Denne flyten
kan utsette aktivering når fokuskortet er i bruk; ikke erstatt eller stopp kortet
for å tvinge en oppdatering.

1. Opprett en privat app i [Todoists App Management Console](https://app.todoist.com/app/settings/integrations/developer).
2. Legg til en UI extension med navn **Start fokus**, type **Context menu**,
   kontekst **Task**, og Data Exchange Format-versjon 1.
3. Opprett en privat konfigurasjonsfil. Fra `extensions/todoist`:

   ```sh
   mkdir -p "$HOME/Library/Application Support/TodoistFocusBridge"
   chmod 700 "$HOME/Library/Application Support/TodoistFocusBridge"
   install -m 600 integrations/focus-context-menu/config.example.json \
     "$HOME/Library/Application Support/TodoistFocusBridge/config.json"
   ```

   Fyll inn Todoist-bruker-ID og appens **Verification token** i den lokale filen.
   Bruk samme konto som Raycast. Dette er ikke den personlige Todoist API-tokenen;
   broen trenger ingen API- eller OAuth-token. Eksempelverdiene avvises. Ikke legg
   den ferdige filen i Git, chat, shellhistorikk eller PersonalRaycasts felles config.

4. Valider filen uten å starte noe:

   ```sh
   npm run focus:bridge -- --config "$HOME/Library/Application Support/TodoistFocusBridge/config.json" --check-config
   ```

5. Installer broens egen LaunchAgent, slik at den starter ved innlogging:

   ```sh
   npm run focus:bridge:agent -- install --config "$HOME/Library/Application Support/TodoistFocusBridge/config.json" --node "$(command -v node)"
   ```

   `print` i stedet for `install` viser plist-filen uten å installere noe. Agenten
   bruker absolutte stier til Node og denne kildemappen; `--node` bevarer en stabil
   symlenkesti (for eksempel Homebrews `bin/node`) gjennom Node-oppgraderinger.
   Reinstallasjon trengs hvis stiene flyttes. Den lytter bare på `127.0.0.1`, som standard på port `8765`. Alternativt kan broen kjøres
   i forgrunnen med kommandoen fra punkt 4 uten `--check-config`.

6. Konfigurer en stabil HTTPS-tunnel som peker til `http://127.0.0.1:8765`, for
   eksempel en allerede administrert Cloudflare Tunnel eller Tailscale Funnel.
   Det må være en adresse Todoist kan nå fra internett; en vanlig privat
   Tailscale Serve-adresse er ikke tilstrekkelig. Tunnelens levetid må følge
   tjenesten. Ingen tunnel opprettes automatisk av disse skriptene.
7. Sett UI-utvidelsens **Data exchange endpoint URL** til
   `https://DIN-HTTPS-ADRESSE/process`, og velg **Install for me**.
8. Ved første faktiske bruk kan Raycast be om tillatelse til **Start Focus Task**.
   **Always Run Command** er valget som tillater senere starter uten den dialogen.

Dette er oppsett av integrasjonen, ikke nødvendige manuelle teststeg. Automatiske
tester trenger verken konto, tunnel, Raycast-tillatelse eller åpne apper.

## Drift og feil

- Mac-en må være våken, innlogget og tilkoblet. Menyvalget på andre datamaskiner
  i samme Todoist-konto sender også til denne Mac-en. Broen er laget for én Mac.
- `GET /health` returnerer bare `{ "ok": true }`. Det beviser at HTTP-tjenesten
  svarer, ikke at Raycast, Todoist-innloggingen eller fokuskortet virker.
- Todoist-signaturen kontrolleres over originale bytes. Bare riktig konto og
  en innledende oppgavehandling tillates. Broen bruker en fast Raycast-kommando,
  aldri en URL eller shellkommando fra innkommende data.
- Identiske forespørsler samles mens overføringen pågår og i ti sekunder etter vellykket overføring.
  Todoists dokumenterte forespørsel har ingen tidsstemplet engangs-ID. Broen kan
  derfor ikke skille en senere identisk levering fra et nytt bevisst menyvalg.
  Dette er duplikatbeskyttelse, ikke en generell garanti mot gjenspilling av
  tidligere vellykkede overføringer. Uavklarte overføringer beholdes og sperrer
  samme forespørsel frem til eksplisitt gjenoppretting.
- Broens private `.state.json` ved siden av konfigurasjonen lagrer bare hash,
  request-ID, status og tid, ikke innhold eller token. Pågående/ukjente overføringer
  sendes ikke automatisk om igjen, heller ikke etter omstart.
- Raycast-kommandoen henter ferske oppgaver og prosjekter, kontrollerer kontoen,
  avviser fullførte/slettede/arkiverte oppgaver og avviser lenker eldre enn fem
  minutter. Samme aktive oppgave åpnes uten å nullstille timer, pause eller kø.
- Raycast lagrer kvitteringer i utvidelsens `focus-requests`-mappe. En request-ID
  brukes bare én gang. Et usikkert utfall beholdes som `unknown`; ingen automatisk
  ny start skjer. Førstegangsbekreftelse som tar over fem minutter krever nytt menyvalg.
- **Sendt til fokuskortet** kan vises selv om kommandoen ikke er installert/aktivert,
  Raycast venter på tillatelse eller innlogging, eller oppgaven senere avvises.
  Det er bevisst ikke en melding om at timeren har startet.

Avinstaller bare denne bakgrunnstjenesten:

```sh
npm run focus:bridge:agent -- uninstall
```

Privat konfigurasjon og kvitteringer beholdes. Fjern også utvidelsen fra Todoist
og den konkrete tunnelruten når integrasjonen tas ut av bruk. Andre tjenester
eller tunnelruter skal ikke nullstilles.

Ved et uavklart utfall er samme forespørsel sperret. Gjenoppretting er en eksplisitt
driftsoperasjon: stopp/avinstaller broen, avklar utfallet i Raycasts kvittering og
la eventuelle fem minutter gamle lenker utløpe. Flytt deretter bare
`config.json.state.json` ved siden av den private konfigurasjonen til en privat
sikkerhetskopi før broen startes igjen. Dette opphever duplikatsperren; ikke gjør
det automatisk ved feil. Selve konfigurasjonen og fokusdataene skal beholdes.

## Utvikling

`npm test -- --maxWorkers=1` kjører både HTTP-testene og den vanlige Vitest-pakken.
`npm run test:bridge` kjører bare Node-testene. Testene bruker syntetiske signaturer,
midlertidige filer og isolerte loopback-porter; appåpning er erstattet med en stub.

Kilder kontrollert 12. november 2026:

- [Todoist: UI extensions og støttede plattformer](https://www.todoist.com/help/todoist/integrations/what-are-ui-extensions-in-todoist-Tu1Vlcn28)
- [Todoist: forespørsler, HMAC, installasjon og bridges](https://www.todoist.com/help/todoist/integrations/build-your-first-todoist-ui-extension-Tu1aQhceS)
- [Todoist: Action.OpenUrl](https://www.todoist.com/help/todoist/integrations/todoist-cards-reference-Tu1bJ28AR)
- [Raycast: deeplinks, launchType og context](https://developers.raycast.com/information/lifecycle/deeplinks)
