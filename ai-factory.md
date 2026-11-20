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

Det som saknades: `pi-dag` var inte inkopplat i `packages/server` (beslut 17). Steg 1 nedan gör
det; wire-kontrakt och UI saknas fortfarande. Det finns heller ingen nodtyp som kör
`pi-swarm`:s grindar och worktree-landning, och ingen fabriksvy i webbappen.

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
   definitionen. Logga modell, tokens och utfall per nod. *Klart när:* granskarens fynd blockerar
   release tills de är besvarade.
5. **Resurser:** samtidighetsgräns via delegationens semafor, köstatus för flera DAG:er per
   workspace. *Klart när:* fler än en DAG körs utan att överskrida gränsen.

Varje steg uppdaterar [[module-pi-dag]], [[submodule-server-agent]] och beslut 17 i
[[architecture]], eftersom beslutet "ThinkRail neither bundles it nor exposes it" ändras.

## Öppna frågor

- **`pi-swarm` och `pi-dag`:** ska swarm på sikt bli en DAG-mall, eller leva vidare som det
  chattdrivna läget bredvid? Förslag: behåll båda, men låt dem dela hjälparna och inte schemaläggaren.
- **Nätverk för barnsessioner:** pi saknar en sandlåda på OS-nivå, så "inget nätverk" kräver en
  separat isoleringsmekanism. Det kräver en egen utredning.
- **Bounds:** `pi-dag` tillåter 128 noder och 16 MiB per värde. Det räcker troligen, men behöver
  mätas mot riktiga repo-diffar.
