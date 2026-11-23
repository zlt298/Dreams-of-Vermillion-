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
- **Progression:** a fixed License Level per act (LL0 / LL5 / LL10), matching the core book's NPC tiers. Per-player budgets rose to T2 1.5 and T3 2.0.
- **LCP importer:** official NPC classes from a pack you own. These are stored in the browser only and join campaign and skirmish encounters.
- **Official base features scripted:** 67 scripts keyed by feature id, plus structured on-hit conditions and Line/Cone save attacks. Core pack base features: 81 of 116 fully automated, 16 approximated. A smoke battle runs for every script, and official encounter budgets were re-tuned afterwards.

### Story
- Four console-readout interludes: opening, end of act 1, end of act 2, finale. They type out, hold-to-skip, show a faint two-frame flash of the burning solar eye, and are replayable from the title screen.
- Final boss retooled as *The Voice of the Eye*, with Sleepwalker grunts and Cantors of the Second Dawn. It's always the act 3 boss. Sim: 67% player wins vs LL10 (after the November balance pass).

### Content and balance
- Legal LL5 and LL10 sample squads (the act 2 and act 3 levels).
- **Act levels enforced:**
  - Runs start at LL0. Off-level pilots get run-only copies fitted to LL0 and must be finished on the Squad preparation screen.
  - After each act boss the squad must be levelled to exactly LL5, then LL10, in the builder or by re-import. Continuing is blocked until every build is legal, fully spent and armed.
  - Run-time builds never overwrite roster pilots.
- **Themed pre-built squads:** Brawlers, Long Guns, Ghosts and Drone Wing, each at LL0, LL5 and LL10 (48 legal, fully spent builds). They are generated by `scripts/make-squads.ts`, and `tests/presets.test.ts` checks them. The hangar's squad picker replaces the separate pregen and sample buttons.
- The balance sim matches squad to tier (LL0 pregens vs T1, LL5 vs T2, LL10 vs T3).
- Team rosters were retuned for the long map. Results from AI vs AI runs on 18×36 maps:

  | kind | player wins | mechs lost per fight |
  |---|---|---|
  | standard | 87–100% | 0.3–1.1 |
  | elite | 50–90% | 0.9–2.8 |
  | boss | 60–75% | 1.4–2.5 |

  These are the results after the core-book and template changes: 8–10 seeds per team, against LL0 / LL5 / LL10 squads.

### Balance pass (November 2026, after content)
Three sim-integrity bugs were fixed first; each was skewing results:
- **Sandbox leak.** A reaction fired from an attack preview (Cover Me) could kill the active unit and end the round inside `Battle.sandbox`; turn state wasn't rolled back, so the real battle deadlocked with no activations left. Previewed Blasts could also flatten real terrain. The sandbox now restores round, side, active unit, winner, chain turn, grapples, LoS zones and terrain.
- **Standoffs.** Long-range teams and the lancers froze just outside each other's reach until the round cap. When nobody has attacked for 3+ rounds, the AI's advance pull now grows each idle round.
- **Rooted Drake.** The LL5/LL10 squads' Drake fired Fortress Protocol on round 2 near deployment and stayed immobilized. It now only roots within its weapons' reach and folds up (protocol) when nothing is in reach. Untargeted protocols with an AI score (Active Camouflage, ASURA) are now used too.

Team changes, each found by ablation (removing one unit or feature at a time):
| team | change | player wins |
|---|---|---|
| T1 Red Warden (boss) | Rotary Cannon 1d6+2 Reliable 2 → 1d6+1 Reliable 1 | 50% → 70% |
| T2 Furnace Saint (boss) | +1 Ember Zealot, +1 Kiln Thrall | 90% → 77% |
| T2 Forecast Cell (elite) | a second Forecast Specter | 100% → 80% |
| T3 Burning Eye Cantors (elite) | Witch-Cantor Elite → Veteran; Precentor loses Commander; Sanctus Ward recharge 5+, Antiphon 4+ → 6+ | 0% → 87% |
| T3 Voice of the Eye (boss) | + a Frenzy Blade (Veteran, Feign Death) | 97% → 67% |

Results, 30 seeds per team (`npx tsx scripts/simulate.ts 30`):
| kind | player wins | mechs lost per fight | avg rounds |
|---|---|---|---|
| standard | 90–100% | 0.1–0.7 | 7–18 |
| elite | 73–97% | 0.9–2.0 | 12–22 |
| boss | 67–77% | 1.9–2.3 | 14–19 |

### Presentation and map
- Procedural low-poly unit models, shaped by manufacturer or role, carrying their actual weapons, with marks for templates; creatures for biological enemies.
- The battlefield is 18 wide × 36 long, with terrain features scaled by area.
  - The camera fits the map's width and pans along its length.
  - The AI's "advance pull" brings units forward until they're in range.
  - Holdout lasts 8 rounds.

### Enemy variety
- 8 new original teams modelled on official NPC archetypes (sniper/scout, berserker, pyro/demolisher, witch/hornet, specter, bastion, engineer), written in the game's own feature format. No LCP data is copied.
  - T1: Theodora Sunspotters, Hymn of Blades
  - T2: Steamline Pyres, Gantry Witches, The Forecast Cell (elite)
  - T3: Cleanroom Wardens, Regolith Stalkers, Cantors of the Burning Eye (elite)
- All 20 teams are named for the story's factions.
- Tuned in the November balance pass (below); Cleanroom Wardens is still a long fight.

### Between-battle events
- 18 events after won combats (`run/events.ts`), seeded per node:
  - 25% nothing
  - 50% find
  - 15% gamble
  - 10% hard choice
- New boons: one-battle plating, tech booster, hot rounds, early-round intel, and Impaired or Stunned starts; permanent +2 HP, +1 accuracy, +1 Armor, and +1 Evasion/E-Defense.
- Their values are part of the post-content balance pass.

### Act looks
- Map themes (`run/mapgen.ts` and `render/scene.ts`), each with its own layout generator, palette, lighting and props:
  - outskirts (act 1, unchanged)
  - industrial park (act 2)
  - cleanroom with Martian incursions (act 3)
- Each theme's maps are tested to be connected from deployment to deployment.

### Tag tooltips
- Every tag shown in the UI (weapon cards, Hangar weapon lines, the battle log) is a hoverable chip with lancer-data's rules text; one global tooltip (`ui/tags.ts`) serves the whole page.

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

### CORE powers
Every CORE system is now executed (`rules/effects/scripts/cores.ts`):
- **Raleigh, Thunder God:** chambered Mjolnir, 4 kinetic per round; 4+ rounds are AP and Shred.
- **Black Witch, Mag Field:** stops kinetic and explosive shots crossing its edge, then they resume; metal characters are pulled in and Immobilized.
- **Dusk Wing, Hall of Mirrors:** hologram trail that detonates on hostiles, plus Hologram Teleport.
- **Goblin, Symbiosis:** shared conditions and heat; the Goblin acts inside its host's turn.
- **Pegasus, Ushabti Omnigun:** 1 unreducible damage, 1/round or 3/round after Unshackle. The "I Know Everything" average-damage toggle is included.
- **Barbarossa, Apocalypse Rail:** the Apocalypse Die counts down; three firing profiles leave clouds, a burning storm or a crater.
- **Sherman, SOLIDCORE:** charges and COREBURN.

### Talent ranks
All 21 talent ranks that used to be resolved by hand now have scripts (`scripts/talents2.ts`):
- Ace 3: Supersonic
- Bonded 2–3: Intercede, Cover Me!
- Centimane 3: Tidal Suppression
- Exemplar 3: To the Death
- Heavy Gunner 2–3: Hammerbeat, Bracketing Fire
- Infiltrator 1 and 3: Prowl, Mastermind
- Juggernaut 2–3: Kinetic Mass Transfer, Unstoppable Force
- Leader 2–3: Open Channels, Inspiring Presence
- Siege Specialist 1: Jackhammer
- Spotter 2–3: Panopticon, Bentham/Foucault
- Stormbringer 3: Torrent
- Grease Monkey 1 and 3, Technophile 1–2: no in-combat effect (noted as narrative)

Two engine additions support these: an `onStatusRemoved` hook and Prowl movement and hiding rules.

### Systems
The 32 systems that used to be resolved by hand now have scripts (`scripts/systems2.ts`):
- **Grenades and mines:** BB, Flash, Mesmer, Roller, Grounding, Clamp Bombs.
- **Shields and barriers:** Magnetic Shield, Blinkshield, Hardlight Defense, Flash Anchor, Armor-Lock.
- **NHPs:**
  - SEKHMET: the AI plays your turn.
  - TLALOC, ATHENA, NOAH.
  - SISYPHUS: stored d20s.
- **Utility:**
  - Cable Winch, MULE Harness, Whitewash
  - Javelin Rockets, Flicker Field, FADE Cloak, Retractable Profile
  - Swarm Body, H0R_OS II/III, Monitor Module, Law of Blades, Tesseract
  - the Ammo Case rounds
- **Engine mechanics added:**
  - blinded (line of sight only to adjacent spaces), intangible, can't-attack
  - automatic Hull/Agility saves, Mesmer movement
  - a d20-override hook
  - other units preventing forced movement or statuses
  - standard moves now fire the movement hook

### Grapples and environment rules
- **Grapples (core book):** sizes add together when several characters grapple one target; the smaller side is Immobilized and dragged along when the larger side moves. Same-size grapples hold a contested Hull check each turn. Only the defender can Break Free; the attacker can Release as a free action. A grapple ends when adjacency breaks or either party is destroyed.
- **Flight:** flyers land when Immobilized or Stunned, or on a failed Agility save after Structure or Stress damage, and take off on their next voluntary move.
- **Zero-g areas:** characters inside fly and are Slowed unless they could already fly. Tesseract Spread Focus creates one.
- **Destructible terrain (house rule):** each block level has 10 HP and Evasion 5; a skirmish can target a block, and a block with no levels left becomes rubble. Jackhammer, the BB charges, the Apocalypse Rail, COREBURN, Unstoppable Force and Earthshaker (raising debris cover) all use it.

### Player decisions (in-HUD picker)
- `Battle.choose` asks player mechs; enemies, AI-driven turns, autoplay and tests take the default.
- Commands and AI turns run as transactions: when the player has to decide, the battle rolls back to a checkpoint, the HUD picker asks (number keys, Esc for the default) and the command replays with the answer. The seeded RNG makes the replay exact.
- Brace and Overwatch "ask" now use the picker. A third policy, **Other reactions**, governs scripted reactions (Vorpal Gun, Intercede, Area Denial and the rest).

### Weapons, mods and the last partial scripts
- **Manual weapons and mods:** Autopod, Vorpal Gun, Mimic Gun, Siege Cannon modes, Prototype Weapons I–III (set-up and uses last until a Full Repair), Apocalypse Rail, UNCLE and Throughbolt Rounds (weapon-card toggle).
- **Frames and cores:** Drake Fortress, Mourning Cloak (true teleport moves), Goblin Reactive Code and INSTINCT Rig, Napoleon Heavy Shielding.
- **Weapons, mods, core bonuses:** Combat Drill, Pinaka (second area and delayed strike), Ghast Nexus drone mode, Annihilation Nexus drone centring, Plasma Thrower (cone/line toggle), Shock Wreath, Overpower Caliber, Briareos, Ghostweave, Open Door.
- **Systems:** all 32 partial systems rewritten against their rules text.
- **Talents:** all 16 partial ranks; the Bondmate is chosen once and kept for the run.
- **Engine additions:** save sources, line-of-sight zones, per-type resistance, straight-line moves, teleport lockout, chained turns, forced actions, attack rerolls and max damage.

### Mines and charges
- **One mine model** following the core book's MINE tag, plus a house rule that your own side never sets off your mines:
  - planted in an adjacent space, not next to another mine
  - arms at the end of your turn
  - triggers on entering an adjacent space (not on leaving) and bursts from its own space
  - Hidden from the other side until found
- **Search for Mines** (quick: a Systems check finds hostile mines within Sensors) and **Disarm** (quick, adjacent; a failure sets it off), for every mech and NPC, used by the AI too.
- Your mines (and detected enemy ones) appear as markers on the map and in the field overlays; Javelin Rocket marks are drawn too.
- **Charges moved onto mines:** Flash, Bouncing (flyers only), Smoke (set off by allies), Breaching and Grounding (remote detonation; Breaching can go on walls), HAVOK (Line 5 toward whoever set it off), Mesmer, Pattern-B.
- **Real objects:** the Webjaw Snare is a deployable that can't be attacked until sprung, and its Immobilized lasts until it is destroyed. Dimensional Emblems are objects an adjacent character can destroy with a Systems check.

### Rules fidelity snapshot
Out of the 392 items in lancer-data, all 392 are fully executed. The rest show a `*` and log their rules text for you to resolve by hand.

| section | scripted | partial | auto | manual |
|---|---|---|---|---|
| Frame traits | 27 | 2 | 0 | 0 |
| Core systems | 26 | 3 | 0 | 0 |
| Weapons | 19 | 5 | 53 | 8 |
| Systems | 87 | 33 | 4 | 0 |
| Mods | 2 | 1 | 3 | 2 |
| Talent ranks | 63 | 18 | 6 | 0 |
| Core bonuses | 9 | 4 | 17 | 0 |

---

### Rules audit (core book, Mech Combat chapter)
`game/tests/audit.test.ts` has 69 scenario checks with rigged dice. They cover:
- turns and actions
- movement, engagement, falling
- attacks and cover
- damage order
- statuses
- the action list
- reactions
- the structure and overheating tables

Two deviations were found and fixed:
- **Turn order across rounds.** Every round used to start with the players. Now the players open the battle, and after that the side that didn't take the last turn opens the next round, so enemies can act first.
- **Overheat carry-over.** One extra heat used to be kept. After stress, heat clears and only the heat beyond what it took to exceed the cap (cap + 1) carries over.

The pinned battles were re-pinned.

Known simplifications, left as they are:
- Flight has no altitude: there is no 10-space ceiling and no falling from flight (falling off ledges is modelled).
- Search checks every Hidden hostile in Sensors, not one chosen character.
- System Trauma picks the mount or system at random instead of letting the player choose.
- A pending meltdown at 2 Stress can't be retried with a free-action Engineering check.

### Branch integration (all chats now work from `main`)
- The Tester's rules, script, AI and campaign fixes and new test suites, the Balance Tester's AI fixes and retuned teams, the Design Director's narrative UI, and the Setup chat's GitHub Pages workflow and GPL-3.0 licence are all merged into `main`. The engine work was ported onto the split `rules/battle/` modules.
- Where the Tester's and Balance Tester's sandbox fixes overlapped, the Tester's `snapshotBattleFields`/`touchTile` version was kept.
- The merged branches were deleted. Start new work from `main`.

## Next

**Priorities (set by the owner):**
- Player content and deployables come first.
- Pilot combat (on-foot pilots) is out of scope.
- Official NPCs can stay sparse.
- **No balance retesting until the content is in.** One full rebalance happens at the end.

### 1. Deployables and drones
✅ The framework and 16 drone/deployable items are done (see Done).

✅ Mines and the remaining charges are done (see Done).

### 2. Player content (L, in batches, each with a test)
Driven by `npm run coverage -- --list`.
✅ Done: all 392 items are fully executed (the Goblin's INSTINCT Rig now acts inside its host's turn; Guide the Flock moves each drone to its own space).

### 3. UX
1. Minimap or overview toggle (S).
2. ✅ In-HUD reaction prompts instead of `confirm()` (done: the decision picker).
3. Threat overlay (M).
4. ✅ Campaign map edges and hover previews (route lines and node briefs).
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
3. Boss arenas and more set pieces (M); the act themes are done.
4. Campaign events (M).
5. Story extras: ✅ failed-run readout (draft text); Choir chatter and act-boss flavour (S each). The UI direction is in [`DESIGN.md`](DESIGN.md): Tiers 1–2 are done, Tiers 3–4 are next.
6. Model polish, effects, terrain, audio (M). ✅ Graphics pass done (see `docs/DESIGN.md` → Graphics): tone mapping, bloom and grade, per-act atmosphere, event-driven combat effects, HUD polish, mech portraits. Audio is still to do.

### 6. Balance (after content)
The first full pass is done (see Done → Balance pass). Remaining:
- Tier-3 fight length: Burning Eye Cantors (22 rounds), Voice of the Eye (19) and Cleanroom Wardens (18, 3/30 at the round cap) are still long; target 8–14. Ablation finds no single cause in Cleanroom Wardens (giving Sterile Field a recharge changed nothing), so this looks like T3 durability vs LL10 damage on the long map.
- Hunter Cell (T1) and Warden Strike Team (T2) elites are a little easy (97%).
- The Lance (LL5/LL10) is lost far more often than its squadmates (17–29 of 30 fights against bosses); check whether the AI over-commits it.
- Hymn of Blades' Hymn of Warding is the only at-will (no recharge) overshield left in the roster.
- tier-1 openers; official-encounter scale (needs an LCP)
- Between-battle event values

### 7. Tooling
1. ✅ CI (done: `.github/workflows/ci.yml`).
2. ✅ Split `battle.ts` (done: `rules/battle/`).
3. ✅ Deterministic replays (done: ⤓ export and `npm run replay`).
4. ✅ Bundle code-splitting (done: battle screen and Three.js load with the first battle).
5. ✅ Mid-battle save/resume, full undo and golden battles (done).

### Later or optional
- Official NPC optional features (173 left).
- Official NPC deployables and the partial NPC scripts.
- NPC Line/Cone/Burst attacks that list a Range (the origin may be any point in range; no player weapon uses this).
- Level-aware encounter warnings.

### Out of scope
- Pilots on foot: Eject, Mount, Dismount, Jockey, pilot gear.
