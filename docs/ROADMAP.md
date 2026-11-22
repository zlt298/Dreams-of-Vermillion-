# Dreams of Vermillion: roadmap

This file has two parts: what has been built so far, and what's next in priority order.

Each upcoming item is sized:

| size | effort |
|---|---|
| S | under 1 hour |
| M | a few hours |
| L | a day or more |

Useful commands, all run from `game/`:

| command | what it does |
|---|---|
| `npm test` | 225 unit tests |
| `npm run e2e` | browser campaign run plus a GPU-leak check |
| `npm run bench` | AI speed per turn |
| `npm run coverage -- --list` | rules fidelity report |
| `npm run validate-enemies` | checks the enemy team files |
| `npx tsx scripts/simulate.ts 10` | balance sweep, AI vs AI |

---

## Done

### Foundation
- **COMP/CON:**
  - COMP/CON v3 is a pinned submodule in `vendor/compcon`.
  - The importer reads v3 exports, v2 pilot data and COMP/CON's pregen templates, and flags content that isn't in lancer-data (LCP items).
- **Rules engine:**
  - grid, line of sight and cover on a 3D height map
  - movement and engagement
  - attacks, accuracy, crits and damage
  - heat, the official structure and overheating tables
  - statuses with Lancer durations
  - tech, Brace and Overwatch
  - deployables and mines
- **Enemy ruleset:** an original NPC framework (roles, tiers, templates, feature DSL, budgets), with a validator, a `generate-enemies` Claude skill and 12 teams covering every tier and kind.
- **AI and presentation:**
  - a utility-based tactical AI
  - a Three.js isometric view
  - the battle HUD
  - a three-act campaign with persistent damage, repairs, rewards, level-ups and COMP/CON re-import

### Rules corrections
- Ambiguous rulings were cross-checked against COMP/CON's own combat code (later superseded where the core book differs; see below):
  - resistance rounds up
  - reaching 0 stress means a meltdown at the end of the next turn
  - Grunts die to external heat
  - Ultras refresh reactions every turn
  - NPCs and tech attacks can't crit
- A quick action can't be repeated in a turn from normal actions. It can be repeated when paid with a free-action quick: Overcharge, Everest Initiative, ASURA. Full Tech still gives two quick techs.

### Stability and performance
- Caches for the map, line of sight and cover, plus per-unit script lists and single-pass AI pathing. The AI takes about 15 ms per turn on average (p95 about 35 ms).
- **GPU memory leak fixed:**
  - tile highlights and effects are allocated once and reused
  - each battle view frees everything it used when it closes
  - event and log history is capped
  - hover work only happens when the hovered tile changes
  - the e2e test fails if the leak comes back
- Animation speed control with a skip option and a per-turn time budget. Battles always reach the end screen.
- Versioned run saves with validation (damaged or newer saves are discarded with a message), safer re-import matching, and a cleaned-up roster.

### UX
- Reaction policies per mech: auto, ask or off, for Brace and Overwatch.
- Undo a move that revealed nothing.
- Initiative bar showing who is ready, acting, done or destroyed.
- Detailed attack preview: hit and crit chance, damage range, chance to destroy or cause structure damage. It runs in a state sandbox, which also fixed preview side effects.
- **Auto (AI)** turn button.
- **Open COMP/CON** link and export hint in the Hangar.

### Core book alignment
- Rules were re-checked against the LANCER core book. Corrections:
  - reactions are one per turn, each reaction type once per round
  - Quick Tech can repeat with a different option; Activate once per system; protocols once per turn
  - Biological characters are immune to tech except Scan and Lock On
  - armor is subtracted once from the attack total, then resistance
  - heat on characters without a heat cap becomes energy damage
  - flying characters can't be knocked Prone
  - falling deals 3 per 3 spaces, maximum 9
  - only hostiles the same size or larger obstruct
  - wreckage is hard cover and difficult terrain
  - hard cover must be adjacent and as large as the target; distant obstructions give soft cover
  - Blast cover is measured from the blast centre
  - dangerous terrain is also checked when ending a turn there
  - forcing saves breaks Hidden; Hide in soft cover needs you fully inside it
  - grappled characters can't Boost
  - Stabilize can reload Loading weapons
  - Barrage adds an Auxiliary per fired mount
- **Official NPC templates:**
  - Elite: +1/+1 and two turns
  - Veteran: +1/+1, Veterancy and one of nine Veteran traits
  - Commander: Voice of Authority and Military Discipline
  - Ultra: +3/+3, +5 HP, two turns (three vs 5+), Deadly, Juggernaut, Legendary and Reflex
  - Mercenary: Opportunist
  - Only Veterans and Ultras crit.
- **Progression:** +5 License Levels per act (LL0 / LL5 / LL10), matching the core book's NPC tiers. Per-player budgets rose to T2 1.5 and T3 2.0.
- **LCP importer:** official NPC classes from a pack you own. These are stored in the browser only and join campaign and skirmish encounters.
- **Official base features scripted:** 67 scripts keyed by feature id, plus structured on-hit conditions and Line/Cone save attacks. Core pack base features: 81 of 116 fully automated, 16 approximated. A smoke battle runs for every script, and official encounter budgets were re-tuned afterwards.

### Story
- Four console-readout interludes: opening, end of act 1, end of act 2, finale. They type out, hold-to-skip, show a faint two-frame flash of the burning solar eye, and are replayable from the title screen.
- Final boss retooled as *The Voice of the Eye*, with Sleepwalker grunts and Cantors of the Second Dawn. It's always the act 3 boss. Sim: 50% player wins vs LL10.

### Content and balance
- Legal LL5 and LL10 sample squads (the act 2 and act 3 levels), also available from Hangar buttons.
- The balance sim matches squad to tier (LL0 pregens vs T1, LL5 vs T2, LL10 vs T3).
- Team rosters were retuned for the long map. Results from AI vs AI runs on 18×36 maps:

  | kind | player wins | mechs lost per fight |
  |---|---|---|
  | standard | 87–100% | 0.3–1.1 |
  | elite | 50–90% | 0.9–2.8 |
  | boss | 60–75% | 1.4–2.5 |

  These are the results after the core-book and template changes: 8–10 seeds per team, against LL0 / LL5 / LL10 squads.

### Presentation and map
- Procedural low-poly unit models, shaped by manufacturer or role, carrying their actual weapons, with marks for templates; creatures for biological enemies.
- The battlefield is 18 wide × 36 long, with terrain features scaled by area.
  - The camera fits the map's width and pans along its length.
  - The AI's "advance pull" brings units forward until they're in range.
  - Holdout lasts 8 rounds.

### Rules fidelity snapshot
Out of the 392 items in lancer-data, 266 (68%) are fully executed and 39 are approximated. The rest show a `*` and log their rules text for you to resolve by hand.

| section | scripted | partial | auto | manual |
|---|---|---|---|---|
| Frame traits | 26 | 2 | 0 | 1 |
| Core systems | 19 | 2 | 0 | 8 |
| Weapons | 19 | 5 | 53 | 8 |
| Systems | 59 | 15 | 4 | 46 |
| Mods | 2 | 1 | 3 | 2 |
| Talent ranks | 49 | 10 | 6 | 22 |
| Core bonuses | 9 | 4 | 17 | 0 |

---

## Next

### 0. Official NPC fidelity
1. **Optional features (L):** 173 are left, about 15% automated. Script them in batches the same way, starting with the classes that appear most often.
2. **Deployables and mines (M):** Engineer turrets, Seeder mines, Rainmaker Javelin Rockets, Barricade printer, Hive swarms. These depend on the drone and deployable framework (§4.3).
3. **Tighten the partial scripts (S):** Barrel Roll's free movement, Suppress triggering *as* the target starts to move, Earthshaker cover segments, Mirage Dataveil transfer.
4. **An official-encounter preview (S):** a list of classes and features with automation markers.

### 0b. Story (optional ideas from the story handoff)
1. A "failed run" readout (iteration ended, rewinding…) on the squad-lost screen.
2. Short between-mission lines: Choir radio chatter, the NHP breaking into comms.
3. Flavor for the other act bosses and Choir teams (solar-eye sigils, singing on open channel).

### 1. Encounters and pacing
1. **Level-aware encounters (M).**
   - Choose the enemy tier from the squad's average License Level, with the act as a minimum.
   - Warn in the Hangar when pilot levels don't match the act.
   - Show the expected level per act on the campaign map.
2. **Long tier-3 fights (M).**
   - On long maps, tier-3 battles average 17–25 rounds in the sim.
   - Investigate passive AI (artillery that never advances, Controllers stalling) and sustain loops (healer + overshield + regen).
   - Target: 8–14 rounds.
3. **Hunter Cell (T1 elite) is slightly easy (S):** 90% wins in the sim, target 50–80%.
4. **Tier-1 openers are trivial (S).** On long maps, grunt-heavy T1 teams die on the approach (0.1–0.2 mechs lost). Give them ranged pressure or flanking deployments.
5. **Deployment variety (M):** flank and ambush deployments, and objectives that start mid-map, so long maps aren't always a straight march.

### 2. UX
1. **Minimap or overview toggle (S, new):** one key to zoom out and back, plus click-to-jump. More useful now that maps are long.
2. **In-HUD reaction prompts (M, new).** Replace the browser `confirm()` used by "ask" reactions. This needs a resumable engine: attack resolution as a generator that can pause for a decision.
3. **Threat overlay (M):** shade every tile hostiles can hit next turn.
4. **Campaign map edges (S):** draw node connections, and preview the sitrep and tier on hover.
5. **Hangar quality of life (S):** sort and filter, a mech-sheet modal, an SP-overflow warning, and highlighting of LCP content.
6. **Settings screen (S):** animation speed, default reaction policies, colour-blind palette, camera sensitivity.
7. **Touch support (M):** tap to select, long-press for tooltips, collapsible panels.
8. **Overcharge clarity (S, new):** show the free-action quick as its own pip, and mark which actions it can repeat.

### 3. AI
1. **Focus fire and kill priority (M):** coordinate attacks on one target instead of each unit choosing greedily.
2. **Role tactics (M):** Defenders body-block, Support stays near damaged allies, Controllers apply Lock On before allies attack.
3. **Reactions and options (S):** decide when to react, Grapple, Ram and Hide.
4. **Use Overcharge (S, new)** to repeat a strong quick action when the heat is affordable.
5. **Difficulty levels (S):** scale AI caution and randomness, and the encounter budget.

### 4. Rules fidelity
Driven by `npm run coverage -- --list`.
1. **Finish the partial scripts (M):** Drake cover sections, Mourning Cloak teleport moves, Goblin Reactive Code, Napoleon Heavy Shielding, and the leadership, exemplar and stormbringer choices.
2. **The 8 missing CORE systems (L):**
   - Barbarossa Apocalypse Rail
   - Raleigh Thunder God
   - Hydra OROCHI drones
   - Goblin Symbiosis
   - Pegasus Omnigun
   - Sherman COREBURN
   - Black Witch Mag Field
   - Dusk Wing Hall of Mirrors
3. **Drone and deployable framework (L):** drones that act on their owner's turn, recall and redeploy, auras. This unlocks Aegis, Sentinel, Assassin, Hive, Lotus, ICEOUT and the Perimeter Command Plate.
4. **The remaining 46 systems and 22 talent ranks (L),** in batches, each with a test.
5. **Pilots on foot (L):** Eject, Mount, Dismount, Jockey, and pilot gear.
6. **Grapple completion (M)** and **environment rules (M):** flying line of sight, zero-g, object damage to cover.
7. ✅ **Rulings settled.**
   - Each system's quick ability is its own action for the no-repeat rule (unchanged).
   - Reliable damage kills grunts. A successful save leaves a grunt unharmed.

### 5. Content and balance
1. **More teams (S each)** with the skill, aiming for 4+ per tier and kind.
2. **Sitrep variety (M):** Escort and Recon, and use each team's `sitrep` hint.
3. **Map biomes and set pieces (M),** plus boss arenas.
4. **Campaign events (M)** and **lancer-data reserves as rewards (S).**
5. **Re-run the balance sweep (S)** after any rules or AI change. Targets are in the `generate-enemies` skill.

### 6. Presentation
1. **Model polish (M):** walk bob, weapon recoil, visible part damage, tinted wrecks.
2. **Effects (M):** muzzle flashes, smoke and fire particles, shield domes, hit sparks.
3. **Terrain detail and a skybox (S),** and **audio (M).**
4. **Sprites (optional, later):** a consistent pipeline, for example rendering the procedural models out as images.

### 7. Tooling
1. **CI (S):** typecheck, tests, validate-enemies, coverage (fail if it drops) and e2e.
2. **Split `battle.ts` (M):** it's about 2,000 lines. Split it into combat, movement, damage, tech and sandbox modules.
3. **Deterministic replays (M):** log intents plus the seed, with a "copy replay" button for bug reports.
4. **Parallel balance sim (S, new):** a full sweep takes about 15 minutes on one core. Use worker threads.
5. **Bundle code-splitting (S)** and **verify that the vendored COMP/CON runs locally (S).**

### Suggested next session
- Encounters 1.1–1.3 and UX 2.1, since the long map makes these matter most.
- Then AI 3.1–3.2, which should also help with tier-3 pacing.
