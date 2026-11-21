---
id: ai-factory
type: architecture-design
status: draft
title: AI-Software-Factory — orkestrering på pi-dag, inte LangGraph
parent: architecture
references: [module-pi-dag, module-pi-swarm, module-pi-delegation, module-pi-subagents, module-desktop]
tags: [adr, dag, orchestration, factory]
---

## Sammanfattning

Ett externt förslag rekommenderade att bygga en lokal AI-Software-Factory med LangGraph.js och en
SQLite-checkpointer, ovanpå en Tauri-app med en Node/Bun-sidecar. Förslaget säger också
uttryckligen att vi ska *undvika två agentramverk och välja ett*. När vi läser koden ser vi att
forken redan har det ramverket: [[module-pi-dag]] är en hållbar, värdägd DAG-motor över
[[module-pi-delegation]], och [[module-pi-swarm]] har redan parallella arbetare i egna
git-worktrees, kvalitetsgrindar, granskare och verifierare. Att lägga till LangGraph skulle ge en
andra schemaläggare, en andra persistens och en andra modell för mänskligt godkännande.

**Beslut:** Ingen LangGraph och ingen SQLite. Fabriken byggs genom att koppla in `pi-dag` i
`packages/server` (arkitekturbeslut 17 kallar det redan "ThinkRail's selected future
composition"), och genom att återanvända `pi-swarm`:s worktree-, grind- och landningshjälpare som
DAG-nodernas verktyg.

## Förslagets antaganden jämfört med koden

| Förslaget antar | Så ser forken ut (2026-11-20) |
|---|---|
| Tauri-skal + Node/Bun-sidecar ska byggas | Tauri-skalet finns redan (`apps/desktop/src-tauri`, `sidecar.rs`). Det startar värden som sidecar över loopback-HTTP med en `THINKRAIL_SIDECAR_READY`-handskakning. Det är det enda skal vi utvecklar mot. Electrobun-skriptet finns kvar i repot men är inget mål. |
| Node eller Bun är oklart | Bun 1.4.4 (`packageManager`), TypeScript 7 beta. |
| Pi-version okänd; `pi-durable` behövs | `@earendil-works/pi-*` 1.5.2 (med patch av `pi-ai`). `pi-durable` används inte. Hållbarheten finns redan i `pi-dag`. |
| Session-state ligger kanske bara i minnet | Delegationshistorik och barntranskript sparas under värdens datakatalog. `pi-dag` har egna snapshots per DAG (`state.json`, `payloads/`, `owners/`). |
| LangGraph behövs för fan-out/fan-in, retries och interrupt | `pi-dag` har grafvalidering, parallella noder, gates, `pause/interrupt/cancel/continue/retry`, idempotenta kommandon (`commandId` + `expectedVersion`) och återställning till pausat läge efter processförlust. |
| Worktree per agent ska byggas | `pi-swarm` har `createWorktree`, `worktreeDiff`, `applyPatch`, `commitWorktree`, `removeWorktree` och ägarglobbar. |
| Typkontroll/test-grindar och adversarial review ska byggas | `pi-swarm` har `detectGates`/`runGates` (typecheck/lint/test, Cargo/Go), samt `reviewer`- och `verifier`-medlemmar. |
| Mänskligt godkännande via `interrupt()` | `pi-dag` har human-only release-gates. Controller-verktyg kan aldrig ge sig själva mänsklig behörighet, och `owner`-bindningar kan inte godkänna. |
| SQLite för checkpoints | `pi-dag` använder filer med atomisk publicering, SHA-256-adresserade payloads och exklusivt processägarskap utan databas. Det passar "en process styr varje DAG". |

Det som saknades när ADR:en skrevs: `pi-dag` var inte inkopplat i `packages/server` (beslut 17),
det fanns inget wire-kontrakt eller UI för DAG:er, ingen nodtyp som körde `pi-swarm`:s grindar och
worktree-landning, och ingen fabriksvy i webbappen. Roadmapen nedan har byggt allt detta.

## Varför inte LangGraph

- **Två källor till sanning.** LangGraph-checkpoints och pi-delegationens historik skulle båda
  påstå att de äger körningens tillstånd. `pi-dag` bygger medvetet på delegationens kanoniska
  historik och gör aldrig anspråk på exakt-en-gång för externa sidoeffekter. En LangGraph-nod som
  anropar pi skulle tappa den garantin.
- **Svagare godkännandemodell.** `interrupt()` är en paus, inte en behörighetsgräns. `pi-dag` skiljer
  på controller, owner och människa, och det är just den egenskap en kodfabrik med merge-rätt behöver.
- **Beroenden och runtime.** LangGraph.js plus en native SQLite-binding mot Bun och
  sidecar-binären i Tauri lägger till yta som `check:seams`, `check:pi-packages` och binärsmoke-testerna måste bära.
- **Förslaget motsäger sig självt.** Det rekommenderar både "välj ett ramverk" och "lägg till LangGraph".

Temporal och liknande avfärdas av samma skäl som i förslaget: tung infrastruktur för en lokal app.

## Målbild

```
Tauri-skal (src-tauri)  ──sidecar, loopback HTTP/WS──  ThinkRail-värd (Bun, packages/server)
                                                     ├── pi-delegation: en tjänst per workspace
                                                     ├── pi-dag: workspace-ägd DAG-tjänst   ← NY koppling
                                                     │     noder = pi-barnsessioner (planerare,
                                                     │     kodare, granskare) + grindnoder
                                                     ├── pi-swarm-hjälpare: worktree, diff, gates, land
                                                     └── wire: dag-läsningar + kommandon        ← NYTT
Webb (apps/web)  ── Fabriksvy: graf, noder, grindar, diff, godkänn/avslå                  ← NYTT
```

Ett fabriksflöde blir en `pi-dag`-definition, inte kod:

1. **Plan:** en planeringsnod (stark modell) producerar deluppgifter med `owns`/`avoid`-globbar.
2. **Fan-out:** en kodarnod per deluppgift, var och en i egen worktree. Överlappande globbar
   serialiseras genom grafens kanter, inte genom låsning.
3. **Grindar:** per gren `runGates` (typecheck/lint/test). Om något fallerar körs `retry` på
   kodarnoden, högst N försök enligt nodens policy.
4. **Join + granskning:** en granskarnod på en annan modellfamilj läser den sammanslagna diffen,
   read-only.
5. **Mänsklig release-gate:** UI:t visar diff, grindresultat och granskning. Godkänn binder mänsklig
   behörighet via värden. Avslå skickar beslutet tillbaka till planeraren.
6. **Land:** `applyPatch`/`commitWorktree` till målbranchen och sedan `removeWorktree`.

## Vad vi behåller, bygger ut och undviker

- **Behåll:** hela IDE-ytan, delegationens sessionsmodell, `pi-dag`:s snapshot- och ägarskapsformat
  samt `pi-swarm`:s git- och grindhjälpare. Ingen datamigrering.
- **Bygg ut:** server-komposition av `pi-dag` (workspace-ägd, explicit körkontext), wire-kontrakt
  för de fyra läsningarna och `execute`, en grind-/landningsnod, en fabriksvy samt rollbaserat
  modellval per nod (`model`/`thinkingLevel` sparas redan i utfallen).
- **Undvik:** LangGraph, SQLite, `pi-durable` (överlappar `pi-dag`), en andra schemaläggare i
  `pi-swarm`, och att låta controller-verktyg godkänna release.

## Säkerhet

- Kodarnoder får skrivverktyg bara inom sin worktree. Granskare och verifierare är read-only (som i
  `pi-swarm`).
- Grindar kör projektets deklarerade skript via `detectGates` och aldrig godtyckliga skript som
  modellen väljer. Projektets förtroendestatus (`projectTrust`) avgör om grindar får köras alls.
- Hemligheter injiceras inte i barnprompter. Nätverkstillgång för barn är ett öppet beslut (se nedan).
- Merge kräver alltid human-only release-gate.

## Roadmap

1. **Komposition (klar):** skapa `pi-dag`-tjänsten per workspace i `packages/server` med samma retained
   `ModelRuntime` som delegationen. Testa paused recovery efter att värden dödats.
   *Klart när:* en DAG skapad via `/dag` överlever en omstart av sidecar och kan återupptas.
2. **Wire + vy (klar):** kontrakt i `packages/contracts`, läsningar och kommandon i servern samt en
   fabriksvy i `apps/web` (graf, nodstatus, gates, beslut). *Klart när:* godkännande sker i UI:t
   utan chatt.
3. **Fabriksnoder (klar):** grind- och landningsnod som återanvänder `pi-swarm`:s hjälpare. Planerings-
   och kodarnoder har ägarglobbar. *Klart när:* två oberoende deluppgifter körs parallellt i egna
   worktrees, passerar grindar och landar efter godkännande.
4. **Granskning och modellroller (klar):** granskarnod på annan modellfamilj samt per-nod-modellval i
   definitionen. Logga modell, tokens och utfall per nod. *Klart när:* release väntar på att en
   människa har tagit ställning till granskarens fynd. Granskningsnodens godkännande är mänskligt;
   värden räknar inte själv öppna fynd, utan personen avgör (och ser fynden på både gransknings- och
   release-kortet).
5. **Resurser (klar):** samtidighetsgräns via delegationens semafor, köstatus för flera DAG:er per
   workspace. *Klart när:* fler än en DAG körs utan att överskrida gränsen.

Varje steg uppdaterar [[module-pi-dag]], [[submodule-server-agent]] och beslut 17 i
[[architecture]], eftersom beslutet "ThinkRail neither bundles it nor exposes it" ändras.

## Uppföljning

Det som återstod efter de fem stegen ovan, och hur det blev (2026-11-20). Detaljerna står i
[[submodule-server-agent]] (avsnitten "Live progress push", "History and output reads", "Starting a run and the
planner", "Gate retries" och "Factory resources"), [[submodule-web-factory]] och [[module-contracts]].

1. **Live-push av förlopp: klart.** `pi-dag` fick en smal observatör, `DagServiceOptions.onChange`, som anropas
   efter varje durabel commit (skapande, admission, avslut, grindar, kommandon från alla anropare) och aldrig för
   strömmande deltan. Värden debouncar den till `dag.changed` (120 ms per DAG) och väcker pausade arbetarturer
   direkt; 100 ms-pollen i `slots.ts` och panelens 5 s-polling är borta (äldre värdar under v133 pollas
   fortfarande). Notis-bindningarna var inget alternativ: de skriver in sig i varje DAG och når bara inaktiva chattar.
2. **Kontroller och läsningar i panelen: klart.** Retry, continue, cancel (steg och hela flödet) och interrupt,
   där de destruktiva kräver ett andra tryck. `dag.history` (sidindelad manifestlista, högst 50 per sida) och
   `dag.output` (ett deklarerat utfall, högst 64 KiB, aldrig sökvägar) är läsningar som bara en människa når.
3. **Automatiska grindförsök: klart, med ett medvetet avsteg.** Värden kör grindarna när kodaren försöker lämna in,
   nekar inlämningen med den felande rapporten och låter samma kodare rätta framåt, högst `gateRetries` gånger per
   försök (standard 2, tak 5, bokförs av värden). Det blev en rättningsslinga i samma försök och inte pi-dags
   `retry`-kommando, eftersom `retry` ogiltigförklarar alla efterföljare och skulle tävla med en granskare som redan
   startat. En människa kan fortfarande köra `retry` (nytt försök, ny budget).
4. **Planerarnod: klart.** Två DAG:er, inte en grafändring: en skrivskyddad planeringsnod med en mänsklig
   godkännandegrind, och sedan `dag.startFromPlan` som på värden kontrollerar att en människa godkänt, validerar
   planen på nytt (gränser, reserverade id, disjunkta `owns`) och bygger fabriks-DAG:en. Den har sin egen mänskliga
   release, så en plan når aldrig utcheckningen utan två separata mänskliga beslut.
5. **Modellval per roll i gränssnittet: klart.** Ett startformulär i panelen (`dag.roles`, `dag.start`):
   uppgift, planerare eller en kodare, och en modell per roll. Granskaren måste ha en annan modellfamilj om inte
   personen uttryckligen tillåter samma familj; avvikelsen skrivs in i releasefrågan. Punkt 4 och 5 delar
   startingången och ligger i samma commit.
6. **Global gräns över arbetsytor: klart.** `AppConfig.factoryMaxConcurrent` (1-64, standard 8) ligger ovanpå varje
   arbetsyttas egen gräns; en tur tar först arbetsytans plats och sedan en global, och räknas som köad tills den har
   båda. Ändras live via inställningarna och redovisas i `dag.queue`. Inget UI-reglage än.
7. **Grafritning: klart.** Lagerlayout utan beroende (`graphLayout.ts`), ritad med temat i panelen.
8. **Språk: klart för ryska, övriga lämnade med avsikt.** `packages/locales/SPEC.md` säger att översättningar är
   partiella och att en ny nyckel översätts till ryska i samma ändring; de andra katalogerna släpar kvar utan
   att något test kräver mer. Alla `factory.*`-nycklar finns nu på ryska (rättat med katalogens ordlista:
   «рецензент»), medan es, ja, pl, zh-CN och zh-TW faller tillbaka på engelska.

### Andra omgången (2026-11-21)

Det som stod kvar efter första uppföljningen, plus brister som en genomgång av agentstegen hittade. Detaljerna står
i [[submodule-server-agent]], [[submodule-web-factory]], [[module-contracts]] och [[module-pi-swarm]].

1. **Grind för den sammanslagna ändringen: klart.** Grindarna körde bara per kodargren, så två grenar som var för sig
   gick igenom kunde landa ett trasigt mål. Mallen har nu alltid en `integrate`-nod (roll `integration`) efter alla
   grindnoder: värden slår ihop varje kodares landningsbara commit på målets spets i en kastbar utcheckning och kör
   projektets grindar på resultatet i samma OS-sandlåda. Granskaren väntar på den, release visar utslaget, och
   `factory_land` vägrar om posten inte gick igenom, om dess källor inte är exakt de commits som skulle landa eller
   om målet har flyttat sig (undantag: en återupptagen, delvis landning). Äldre definitioner utan nod landar som förr.
2. **Avslag går tillbaka till planeraren: klart, med en person som trycker.** Ett avslaget release- eller
   granskningsbeslut visar "Replan with this feedback" i panelen (`dag.replan`, v138). Det bygger en ny, pausad
   planerings-DAG med den ursprungliga uppgiften, personens skäl, granskarens fynd och grindrapporterna (begränsat till
   `MAX_TASK_CHARS`), med samma roller, modeller och mål. Inget modellarbete startar av sig självt vid ett avslag.
3. **Flera kodare i startformuläret: klart.** Upp till 8 rader med id, uppgift, `owns` och `avoid`, validerade som på
   värden (samma konservativa överlappsregel); värdens avslag visas fortfarande.
4. **Reglage för den globala gränsen: klart** (Inställningar → Chatt → Fabrik, 1–64).
5. **`dag.output` för artefakter: klart** (v137). En hash-kontrollerad förhandsvisning: text upp till 64 KiB, bilder
   upp till 2 MiB, annars namn och storlek. Ingen nedladdning; det skulle kräva den binära vägen.
6. **Diffar kapas aldrig tyst: klart.** Mätt på det här repot: ungefär var tjugonde commit är ensam över de 256 KiB
   som ett verktygsresultat rymmer. `factory_diff` ger nu varje källa sin egen andel, märker varje kapning i texten,
   och värden bokför kapade källor så att granskaren läser resten och release-sammanfattningen säger att granskningen
   var partiell.
7. **Swarm-tavlan överlever en omstart: klart.** Den sparas atomiskt per workspace och återställs pausad;
   `swarm_resume` startar om medlemmar i deras befintliga worktrees.
8. **Verklig körning av Linux- och macOS-sandlådan: inkopplad, inte körd än.** CI-jobbet `gate-sandbox` kör de
   riktiga sandlådetesterna på ubuntu-latest och macos-latest och misslyckas i stället för att hoppa över när
   sandlådan saknas.
9. **Agenten känner till fabriken: klart.** Routern `choosing-a-workflow` skickar uppdelningsbart arbete till
   subagenter, `/swarm` eller fabriken, och skillen `running-a-factory` lär agenten att lämna över en färdig plan till
   panelen. En chatt kan bygga en fabriksliknande DAG men aldrig släppa eller landa den: landningen kontrollerar på
   värden att en människa godkände release.
10. **Språk:** alla `factory.*`- och `settings.factory.*`-nycklar översätts till es, ja, pl, zh-CN och zh-TW.

`scout`-rollen behålls som den billiga modellen för de mekaniska noderna (grind, integration, release, landning);
någon egen spaningsnod före planeraren läggs inte till.

Kvar: en riktig körning från början till slut mot en verklig leverantör (två kodare, en grind som rättas, ett fynd,
ett avslag med ny plan, godkännande och landning); första körningen av `gate-sandbox` i CI; nätverksisolering för
barnsessioner i allmänhet (se nedan).

## Öppna frågor

- **`pi-swarm` och `pi-dag`:** ska swarm på sikt bli en DAG-mall, eller leva vidare som det
  chattdrivna läget bredvid? Förslag: behåll båda, men låt dem dela hjälparna och inte schemaläggaren.
- **Nätverk för barnsessioner:** pi saknar en sandlåda på OS-nivå, så "inget nätverk" kräver en
  separat isoleringsmekanism. Det kräver en egen utredning.
- **Sandlåda för grindar: besvarad.** Grindprocesserna (projektets egna `typecheck`/`lint`/`test`) körs bara i en
  OS-sandlåda och aldrig utan: Windows AppContainer via `thinkrail-gate-sandbox.exe` bredvid sidecaren, Linux
  bubblewrap, macOS `sandbox-exec`. Ögonblicksbilden och beroendemapparna går att läsa men inte skriva, en privat
  scratch-mapp går att skriva, nätverk saknas helt och användarens övriga filer är stängda (se
  `packages/server/src/agent/SPEC.md`, "Gate sandbox"). Saknas sandlådan körs inga grindar och posten blir
  `ok: false` med skäl. Linux- och macOS-vägarna körs på riktigt i CI-jobbet `gate-sandbox` (se Andra omgången,
  punkt 8). Kvar: barnsessionerna (frågan ovan). Fabrikens egna noder har bara `factory_*`-verktyg och därmed inget
  verktyg som når nätet; frågan gäller allmänna DAG-barn och subagenter.
- **Bounds: besvarad.** `pi-dag` tillåter 128 noder, 512 kopplingar, 1 MiB definition och 16 MiB per värde. Den
  största planen (8 kodare) blir 20 noder, och den största diffen på `main` det senaste halvåret var 2,8 MB, och
  ingen diff blir ett DAG-värde (granskaren läser via verktyg). Gränserna behålls. Det som bet var fabrikens egen
  kapning på 256 KiB i `factory_diff`, som nu är synlig (Andra omgången, punkt 6).
