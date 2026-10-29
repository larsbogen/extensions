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
