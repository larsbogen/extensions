<p align="center">
  <img src="images/store-logo.webp" height="128">
  <h1 align="center">Raycast Extensions</h1>
</p>

<p align="center">
  <a aria-label="Follow Raycast on X" href="https://x.com/raycast">
    <img alt="" src="https://img.shields.io/badge/Follow%20@raycast-black.svg?style=for-the-badge&logo=X">
  </a>
  <a aria-label="Join the community on Slack" href="https://raycast.com/community">
    <img alt="" src="https://img.shields.io/badge/Join%20the%20community-black.svg?style=for-the-badge&logo=Raycast&logoColor=fff">
  </a>
</p>

[Raycast](https://raycast.com/) lets you control your tools with a few keystrokes. This repository contains all extensions that are available in the [Raycast Store](https://raycast.com/store). It also includes documentation and examples of how to extend Raycast using React.

![Header](images/header.webp)

## Getting Started

Visit [https://developers.raycast.com](https://developers.raycast.com) to get started with our API. If you want to discover and install extensions, check out [our Store](https://raycast.com/store).

Be sure to read and follow our [Community](https://manual.raycast.com/community-guidelines) and [Extension](https://manual.raycast.com/extensions) guidelines and [Acceptable Use Policy](https://www.raycast.com/aup) when submitting your extension and interacting with other folks in this repository.

## Feedback

Raycast wouldn't be where it is without the feedback from our community, so we would be happy to hear what you think of the API / DevX and how we can improve. Please use [GitHub issues](https://github.com/raycast/extensions/issues/new/choose) for everything API related (bugs, improvements suggestions, developer experience, docs, etc). We have a few [templates](https://developers.raycast.com/examples) that should help you get started.

## Community

Join our [Slack community](https://raycast.com/community) to share your extension, debug nasty bugs or simply get to know like-minded folks.

## Personlig lokalt oppsett

Se [PersonalRaycast](tooling/raycast-setup/README.md) for flyttbar konfigurasjon, kontrollerte oppdateringer, tilbakeføring og kommandoer for de personlige utvidelsene.

Denne personlige forken har lokale tilpasninger i [Todoist](extensions/todoist/README.md),
[Lokalt søk](extensions/local-search/README.md) og
[Parallels](extensions/parallels-virtual-machines/README.md). Arbeidsregler og
testkommandoer for bidrag ligger i [AGENTS.md](AGENTS.md).

Todoist har et flytende fokuskort og en klargjort kobling fra oppgavenes
høyreklikkmeny i den offisielle appen. [Oppsett av «Start fokus»](extensions/todoist/integrations/focus-context-menu/README.md)
beskriver den lokale broen, privat Todoist-integrasjon, HTTPS-tunnel og Raycasts
førstegangstillatelse. Koden er implementert og automatisk testet; aktivering i
kontoen og faktisk ettklikksbruk er fortsatt uverifisert. Se
[verifikasjon og begrensninger](extensions/todoist/integrations/focus-context-menu/QA.md).
