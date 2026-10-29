# Lokalt søk

To private macOS-kommandoer i Raycast: **Søk i masteroppgaver** og **Søk i Turatlas**. Tjenestene startes ved behov uten nettleservindu. Velg et treff for å åpne dokumentet eller turen.

## Oppsett

Fra denne mappen:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run dev -- --non-interactive
```

Den siste kommandoen registrerer den lokale utvidelsen i Raycast og fortsetter som utviklingsprosess. Bygg alene installerer ikke utvidelsen. Ingen ny oppstartstjeneste ved innlogging installeres. `npm run lint` kontrollerer lokal kildekode; valgfri `lint:store` trenger en registrert Raycast-forfatter før offentlig publisering.

Standarder er `~/Masteroppgaver/bibliotek`, `~/Strava`, `/usr/bin/python3` og `/opt/homebrew/bin/node`. Absolutte stier kan overstyres i utvidelsens innstillinger. Turatlas trenger eksisterende eieroppsett, avhengigheter, webbygg og den nye `raycast-info --json`-kommandoen. En allerede kjørende gammel Turatlas-server startes ikke om automatisk.

## Bruk

- Skriv for å søke etter 250 ms skrivepause. Tomt søk viser nyeste oppføringer. Resultatene lastes 50 om gangen.
- `⌘⇧F` velger filtre; `⌘R` oppdaterer data. Filtre og søk starter på nytt når kommandoen åpnes igjen.
- Biblioteket søker i metadata og lokal PDF-tekst. Alle ord må finnes, og flere temaer kombineres med AND. Enter åpner første PDF-treff på fysisk PDF-side, ellers første PDF-variant. Detaljer har sammendrag og inntil tre utdrag; handlingsmenyen har andre varianter og lenke til biblioteket.
- Manglende indeks gir fortsatt katalogsøk. Kommandoen bygger ingen indeks og laster ikke ned dokumenter.
- Turatlas søker i eksisterende titler, notater, aktivitetstype og dato. Stedssøk betyr tekstsøk; det brukes ingen geografisk tjeneste. Filtre tilbyr type og datoer som `ÅÅÅÅ-MM-DD`.
- Enter åpner valgt tur. Nettleseren bruker vanlig Turatlas-innlogging og beholder valgt tur gjennom innloggingen. «Åpne siste tur» ignorerer gjeldende filtre. «Åpne importoversikten» åpner administrasjonen uten å starte import.

## Lokal tilgang og data

Turatlas starter med en separat tilfeldig søkenøkkel, privat lagret og bundet til serverinstansen. Den gir bare lesetilgang til `/api/v1/raycast/activities`. Eierpassord og nettleserøkt deles ikke med Raycast. Søkeresultater og nøkler lagres bare i minnet. Ingen telemetri eller eksterne tjenester brukes av søkekommandoene.

`src/library-search.js` er en lokal kopi av bibliotekets rene `web/search.js`, med samme norske normalisering, AND-semantikk og rangeringsvekter. Ved endringer i bibliotekets søk må kopien og kontrakttestene oppdateres sammen. Kopien inneholder ingen katalogdata.

Se [QA](QA.md) for verifikasjon og begrensninger.

## Lokale tjenester

**Lokale tjenester** viser Turatlas og Masteroppgaver uten å starte dem. Status hentes ved åpning, med `⌘R` og etter en handling. Hver tjeneste viser tidspunktet for siste kontroll og fungerer uavhengig av feil hos den andre.

- **Kjører:** Åpne i standardnettleseren, eller velg **Stopp tjenesten** når kontrollert stopp er tilgjengelig.
- **Stoppet:** Velg **Start og åpne** eller **Start uten å åpne**. Nettleseren åpnes først når serveren er bekreftet klar.
- **Starter/stopper:** Vent til tjenesten er klar og oppdater status. Ved usikker status vises en forklaring og tilgang til logg og innstillinger.
- En Turatlas-server startet utenfor startmekanismen må stoppes der den ble startet.
- **Vis logg** viser siste 200 linjer, lest fra maksimalt 64 KiB, inne i Raycast. `⌘R` leser loggen på nytt, også etter loggrotasjon. **Vis loggfil i Finder** finner filen. Tekst fra loggen gjengis bokstavelig og beholdes bare i minnet.

Kommandoen bruker de samme prosjekt- og kjøretidsinnstillingene som søk. Kontrollskriptene i begge prosjektene må støtte `status --json`. Manglende eller eldre skript gir en forklaring i raden. Status tar maksimalt 20 sekunder; start/stopp maksimalt 90 sekunder. Ved tidsavbrudd kontrolleres status én gang uten automatisk gjentakelse av handlingen. Ingen menylinje eller ny bakgrunnstjeneste installeres. Bruk eksisterende lokale utviklingsoppsett for å aktivere den oppdaterte utvidelsen; bygg alene installerer den ikke.
