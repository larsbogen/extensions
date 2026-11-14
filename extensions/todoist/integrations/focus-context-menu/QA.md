# Verifikasjon 12. november 2026

## Kontroll før commit og push 14. november 2026

README-ene og rotens nye AGENTS.md er kontrollert mot implementasjonen. Alle
276 Vitest-tester og 14 Node-tester bestod på nytt med én arbeider, sammen med
lint og TypeScript-kontroll. Dokumentformatering og `git diff --check` bestod.
Ingen kodeatferd er endret siden verifikasjonen nedenfor; native tester og
produksjonsbygg er derfor ikke gjentatt. Aktivering og faktisk appbruk er fortsatt
uverifisert. Ingen brukerprogrammer ble åpnet eller styrt.

## Resultat

- 276 Vitest-tester og 14 Node-tester bestod, med én arbeider.
- ESLint, Prettier og TypeScript-kontroll bestod.
- Native fokus-/presentasjons-/innboks-/økt-/Toggl-tester bestod uten åpne vinduer.
- Produksjonsbygg av native fokuskort og Raycast-utvidelsen bestod.

HTTP-testene kjørte på isolerte loopback-porter med syntetiske signaturer og
simulert appåpning. En samlet test sendte en signert Todoist-forespørsel gjennom
HTTP-broen, dekodet den faktiske Raycast-lenken og kjørte `focusTask` med simulert
Todoist-API og fokustjeneste. Dette bekrefter kontrakten uten en ekstra kortknapp;
det bekrefter ikke faktisk appåpning.

## Dekning

- HMAC over nøyaktige bytes, kontoavgrensning, ugyldig kontekst/ID, JSON og størrelsesgrenser.
- Samtidige duplikater, langsom overføring, ukjent utfall, senere levering og omstart.
- Privat konfigurasjon, journal uten oppgavetekst/token, tidsstempler og sikker URL-koding.
- Ferske Todoist-data, kontobytte, fullførte/slettede oppgaver og arkiverte prosjekter.
- Fem minutters gyldighet, gjenbruk av request-ID og fokusendring mens data hentes.
- Samme oppgave beholder timer, pause og kø; eksplisitt start åpner fokuskortet.
- Forhåndssjekk av hjelpeprogram/varighet før tidligere fokus stoppes.
- Tidsavgrensede native startforespørsler, rydding etter feil/timeout og korrekt kvittering.
- Native avvisning av utløpte starter bevarer økt og sporing uten å åpne et vindu.
- LaunchAgent-plist med absolutte XML-kodede argumenter; ingen shellkommando eller token i plist.

## Ett menyvalg og uverifisert bruk

Todoist dokumenterer initial forespørsel fra kontekstmenyen, offentlig endepunkt,
signatur og `finished`. Broen trenger derfor ingen ekstra Todoist-knapp.
[Offisiell utviklerveiledning](https://www.todoist.com/help/todoist/integrations/build-your-first-todoist-ui-extension-Tu1aQhceS).

Raycasts dokumentasjon omtaler bekreftelse ved ekstern kjøring.
Skrivebeskyttet inspeksjon av installert Raycast 2.11.1.0 fant alternativet
**Always Run Command** og lagring per kommando. Dette underbygger ett menyvalg
etter engangstillatelsen, men ingen slik tillatelse er satt og den faktiske flyten
er ikke prøvd. [Raycast-dokumentasjon](https://developers.raycast.com/information/lifecycle/deeplinks).

Ikke verifisert eller aktivert:

- Privat Todoist-app, installasjon av menyvalget og offentlig HTTPS-tunnel.
- Raycast-registrering av den nye kommandoen, førstegangstillatelse og faktisk kortåpning.
- Virkelige Todoist-/Toggl-kall og oppgavebytte på skrivebordet.
- LaunchAgent bootstrap/innlogging og drift etter hvile eller maskinomstart.
- Faktisk Safari, andre nettlesere, mobilapper eller fysiske enheter. Dette er en
  lokal HTTP-/Raycast-kobling uten egen nettleser-UI; ingen nettlesertest ble kjørt.

Ingen eksisterende app, nettleserøkt, utklippstavle, systemtillatelse eller tunnel
ble endret under kontrollene. Testservere og midlertidige testmapper er ryddet.

## Avgrensninger

**Sendt til fokuskortet** bekrefter at OS-kallet ble akseptert, ikke at fokus startet.
Raycast lagrer separat faktisk utfall. En bruker kan fremdeles vente på innlogging
eller tillatelse, og en deaktivert/uregistrert kommando kan ikke starte fokuset.

Todoists dokumenterte payload mangler engangs-ID/tidsstempel. Vellykkede identiske
overføringer dedupliseres i ti sekunder; en senere identisk levering kan ikke
skilles fra et nytt menyvalg. Ukjente overføringer holdes sperret frem til eksplisitt
gjenoppretting. Maksimum 128 slike kvitteringer stopper nye starter fremfor å
glemme usikre utfall.

Forhåndssjekken bevarer tidligere fokus ved manglende hjelpeprogram eller ugyldig
varighet. Eksisterende fokusbytte stopper likevel gammel økt før hele byttet er
ferdig. Feil i senere etikettopprydding eller native oppstart kan derfor etterlate
den gamle økten stoppet; det finnes ingen garanti om atomisk tilbakeføring.

## Lokal ressursbruk

Ledig plass før arbeidet var 37 GiB, og 35 GiB etter opprydding. Native testprodukter
i `work/context-menu-native` (66 MB) og byggecache i
`work/context-menu-build-20261112` (64 MB) ble fjernet etter bestått kjøring.
Bygget fokuskort (892 KiB) og Raycast-distribusjon (89 MB) er beholdt i prosjektets
vanlige `assets/focus-panel` og `dist`. Ingen simulatorer, runtimes eller
nedlastinger ble opprettet. Ingen stor filproduksjon utenfor repositoryet.
