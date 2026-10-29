# QA – 29. oktober 2026

13 tester i Raycast-utvidelsen består. Automatiske tester bruker syntetiske data og mocks. Ingen brukerapp, vanlig nettleserprofil eller fysisk enhet betjenes.

- `npm test`: kontrakttester for norsk metadata-/PDF-søk, år/tema-AND, validering av adresser/svar/PDF-side, oppstartssamordning, fremmed server, én fornyelse etter 401, avbrytbare forespørsler, React-flyt for gamle svar og paginering.
- `npm run typecheck`, `npm run build`, `npm run lint` og `npx eslint src tests` består. Lokal lint kjører ESLint og Prettier direkte fordi dette er en privat utvidelse. `npm run lint:store` validerer i tillegg Store-metadata: forfatternavnet `larsbogen` er ikke en registrert Raycast Store-konto (404), og norske navn gir advarsler om tittelformatering. Store-publisering inngår ikke i leveransen.
- Turatlas: nye API-/tilgangstester, headless direktelenker før/etter innlogging, ugyldig ID og importoversikt uten importstart. Alle 12 direktelenkescenarioer bestått i Chromium, WebKit og begge mobile visningsstørrelser, med én worker og eksterne nettforespørsler blokkert.

Native Raycast-visning er ikke manuelt kontrollert. Bygget er ikke installert eller startet i brukerens Raycast. Ekte Safari og PDF-leserens faktiske håndtering av `#page=` er ikke verifisert. WebKit og mobil visningsstørrelse beviser ikke ekte Safari eller fysisk iPhone. Søke- og åpningslogikken er testet uten brukerens private arkiver.
