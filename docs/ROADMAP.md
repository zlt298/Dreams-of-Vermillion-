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

### Drones and deployables
- A framework in `rules/effects/scripts/drones.ts`:
  - deploy, recall, redeploy and move
  - placement rules (adjacent, Sensors or range; line of sight; free space)
  - Limited charges
  - field triggers on starting a turn in, or first entering, an area each round
  - actions offered to other units (activating an ally's drone)
  - damage reduction from allied systems
  - flat deployables, reveal fields and ICEOUT fields
  - AI aiming hints
- Scripted:
  - drones: Restock, ICEOUT, Hive, Sentinel, Tempest, Assassin, Autoloader, Lotus Projector
  - deployables: Perimeter Command Plate, Aegis Shield Generator, Portable Bunker, Stasis Barrier
  - fields: OASIS Wall, Interdiction Field
  - Hydra's OROCHI core (companion drone plus Full Deployment)
  - Drone Commander's Shepherd and Invigorate
- **Field overlays:**
  - Every persistent zone is tinted on the map by effect: green protects, red harms, purple controls, yellow reveals, cyan is a barrier, brown is terrain.
  - Zones include smoke, difficult and damaging terrain, drone fields, deployables, barriers and NPC domes.
  - The hover tooltip lists the fields on that tile. **V** toggles the overlay.

### Rules fidelity snapshot
Out of the 392 items in lancer-data, 278 (71%) are fully executed and 43 are approximated. The rest show a `*` and log their rules text for you to resolve by hand.

| section | scripted | partial | auto | manual |
|---|---|---|---|---|
| Frame traits | 26 | 2 | 0 | 1 |
| Core systems | 20 | 2 | 0 | 7 |
| Weapons | 19 | 5 | 53 | 8 |
| Systems | 69 | 19 | 4 | 32 |
| Mods | 2 | 1 | 3 | 2 |
| Talent ranks | 50 | 10 | 6 | 21 |
| Core bonuses | 9 | 4 | 17 | 0 |

---

## Next

**Priorities (set by the owner):**
- Player content and deployables come first.
- Pilot combat (on-foot pilots) is out of scope.
- Official NPCs can stay sparse.
- **No balance retesting until the content is in.** One full rebalance happens at the end.

### 1. Deployables and drones
✅ The framework and 16 drone/deployable items are done (see Done).

Remaining here:
- Approximations: Assassin Drone's reaction trigger, the Command Plate's ally flight, OASIS Wall's energy resistance and straight-line movement, Interdiction Field's teleport lockout.
- Using the framework for the remaining deployable-based player items (Javelin Rockets, charges, NHP-driven drones).

### 2. Player content (L, in batches, each with a test)
Driven by `npm run coverage -- --list`.
1. **The 8 missing CORE systems:**
   - Raleigh Thunder God
   - Black Witch Mag Field
   - Dusk Wing DHIYED
   - Goblin INSTINCT
   - Hydra OROCHI (after §1)
   - Pegasus Omnigun
   - Barbarossa Apocalypse Rail
   - Sherman SOLIDCORE
2. **The remaining manual systems:**
   - charges (Flash, Mesmer, Grounding, Roller, Clamp Bombs, BB)
   - NHPs (SEKHMET, TLALOC, ATHENA, SISYPHUS, NOAH)
   - Armor-Lock, FADE Cloak, Tesseract, Blinkshield and the rest
3. **The 22 manual talent ranks:**
   - Heavy Gunner, Leader, Juggernaut, Spotter, Infiltrator
   - Technophile, Exemplar, Stormbringer, Grease Monkey
   - the others
4. **Manual weapons and mods:**
   - Vorpal Gun, Mimic Gun, Siege Cannon, Autopod
   - prototype weapons
   - Throughbolt Rounds, UNCLE
5. **Finish the partial scripts** (39 items).
6. **Grapple completion and environment rules (M).**

### 3. UX
1. Minimap or overview toggle (S).
2. In-HUD reaction prompts instead of `confirm()` (M).
3. Threat overlay (M).
4. Campaign map edges and hover previews (S).
5. Overcharge clarity (S).
6. Settings screen (S).
7. Hangar quality of life (S).
8. Touch support (M).

### 4. AI
1. Focus fire (M).
2. Role tactics (M).
3. Reactions, Grapple, Ram and Hide (S).
4. Use Overcharge (S).
5. Difficulty levels (S).
6. Using new drones and deployables well (M, after §1).

### 5. Content, story and presentation
1. More teams (S each).
2. Sitrep variety (M).
3. Map biomes and boss arenas (M).
4. Campaign events (M).
5. Story extras: a failed-run readout, Choir chatter, act-boss flavour (S each).
6. Model polish, effects, terrain, audio (M).

### 6. Balance (after content)
One full pass once §1–§2 are in. Includes:
- tier-3 fight length (17–25 rounds; target 8–14)
- Hunter Cell
- tier-1 openers
- official-encounter scale
- the final boss

### 7. Tooling
1. CI (S).
2. Split `battle.ts` (M).
3. Deterministic replays (M).
4. Bundle code-splitting (S).

### Later or optional
- Official NPC optional features (173 left).
- Official NPC deployables and the partial NPC scripts.
- Level-aware encounter warnings.

### Out of scope
- Pilots on foot: Eject, Mount, Dismount, Jockey, pilot gear.
