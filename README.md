# Dreams of Vermillion

A personal, non-commercial **LANCER** tactics roguelike. You build lancers in **COMP/CON**, import them, and fight increasingly dangerous enemy teams on a 2.5D isometric grid in the style of XCOM. The rules engine follows the LANCER core book.

> Unofficial fan project for personal use only. LANCER is © Massif Press. COMP/CON and `@massif/lancer-data` are GPL-3.0, so this project is GPL-3.0 too.

## Quick start

```bash
git clone --recurse-submodules <this repo>      # or: git submodule update --init
cd game
npm install
npm run dev                                     # open http://localhost:5173
```

The four COMP/CON pregens are pre-loaded, so you can start a run straight away.

## Building pilots in COMP/CON

`vendor/compcon` is COMP/CON v3, a pinned git submodule kept for reference and for local use:

```bash
cd vendor/compcon && yarn && yarn dev           # or use the hosted COMP/CON web app
```

To get a pilot into the game:

1. In COMP/CON, create a pilot and mech.
2. Open the pilot, choose **Export**, then **Save as file (.json)**.
3. In the game's **Hangar**, drag and drop the file (or use **Import COMP/CON .json**).

The importer accepts:
- v3 "Save Pilot" exports
- raw v3 or v2 pilot data
- COMP/CON's pregen templates

It uses the pilot's favourite mech and its active loadout: frame, weapons, mods, systems, talents and ranks, core bonuses, HASE and License Level. Content that isn't in `lancer-data` (LCP items) is flagged.

## The game

- **Campaign.** Three acts with branching node maps. Node types are ⚔ combat, ☠ elite, ⬢ supply, ⛺ rest and ♛ boss. Act *n* uses tier-*n* enemies. Sitreps include Basic Combat, Control, Holdout, Extraction and Assassination.
- **Persistent damage.** HP, structure, stress, repairs, destroyed gear, Limited uses and CORE power carry between fights.
- **Recovery.** Spend Repairs at LANCER costs in field repairs. A rest is a full repair that reprints destroyed mechs.
- **Progression.** Each act boss grants +5 License Levels (act 1 LL0, act 2 LL5, act 3 LL10, matching the core book NPC tiers), which raises grit and HP. Re-import updated COMP/CON builds to spend your talent, license and core-bonus points.
- **Battles:**
  - Initiative alternates between sides: pick any ready lancer to activate.
  - Every lancer action is supported. Standard move (it can be split), Boost, Skirmish (plus an aux on the same mount), Barrage, Quick/Full Tech (Invade, Lock On, Bolster, Scan), Overcharge, Stabilize, CORE power, Hide/Search, Ram/Grapple/Improvised, Disengage, Reload, Shut Down/Boot Up, Self-Destruct.
  - Systems, traits and talents add their own actions.
  - Hovering a target shows the hit chance, cover, and every accuracy and difficulty source.
  - **Auto (AI)** lets the tactical AI take a lancer's turn.
  - Controls: **Q/E** rotate, **WASD** or right-drag pan, wheel zoom, **Enter** end turn, **Esc** cancel, **Tab** cycle lancers.

## Rules engine (`game/src/rules`)

It is deterministic (seeded) and has no UI code, so tests and the AI run headless.

| area | what's modelled |
|---|---|
| Combat | d20 + grit/tech attack, accuracy/difficulty d6s, crits (2d6 → 4d6 keep 2), cover (soft −1 / hard −2), line of sight on a 3D height map, Engaged, Prone, Lock On, Invisible (50%), Stunned (max 5 evasion) |
| Damage | Armor (once per attack), Resistance, Exposed (double), Shredded, AP, Irreducible, overshield, Burn (immediate, plus an Engineering check each turn), heat |
| Structure and stress | the official structure and overheating tables, including multiple-1s results, system trauma, direct hit and meltdown countdowns |
| Weapon tags | Accurate, Inaccurate, Arcing, Seeking, Smart, Reliable, Knockback, Loading, Overkill, Heat (self), Limited, Burn, Heat (target), Threat, Thrown; Blast, Burst, Line and Cone areas |
| Statuses | all of them, with LANCER durations ("until the end of the target's next turn" etc.) and immunities |
| Movement | speed, difficult terrain, climbing costs, falling damage, engagement stops, size 1/2/3 footprints, push and pull, mines, hazards |
| Reactions | Brace and Overwatch (per-mech auto policies), plus every scripted reaction |

### Rules coverage

`npm run coverage` reports how much of `lancer-data` the engine executes. `npm run coverage -- --list` names every item still resolved manually or approximated.

```
section            scripted partial   auto  manual   done%
Frame traits             26       2      0       1     90%
Core systems             19       2      0       8     66%
Weapons                  19       5     53       8     85%
Systems                  59      15      4      46     51%
Mods                      2       1      3       2     63%
Talent ranks             49      10      6      22     63%
Core bonuses              9       4     17       0     87%
TOTAL 266/392 (68%) fully executed by the engine, 39 partially
```

- **auto**: fully described by structured data (bonuses, damage, ranges, tags, on-hit statuses).
- **scripted**: hand-written in `game/src/rules/effects/scripts/`.
- **partial**: a script that approximates part of the item.
- **manual**: actions that aren't executed yet. They still appear in the action bar marked `*`, and using one logs its rules text for you to resolve by hand.

To add fidelity, register a script keyed by the item id in `game/src/rules/effects/scripts/`. The hooks are listed in `registry.ts`. `tests/scripts.test.ts` builds every frame, system, talent and core bonus into mechs and auto-battles them to catch runtime errors.

### Known deviations and house rules
- Square grid with diagonals counting as 1. Range and threat include the vertical gap.
- Rules follow the core book: hard cover must be adjacent to the target and at least as large as it (distant obstructions give soft cover); Blast cover is measured from the blast centre; armor comes off an attack's total once; one reaction per turn, each type once per round; wreckage is hard cover and difficult terrain. Being 2+ levels above cover negates it.
- Wreckage can be crossed (as difficult terrain) but you can't end a move on it.
- Each weapon can attack once per turn via Skirmish or Barrage. Reactions and free attacks are exempt.
- Reactions that need a player decision (most talent and system reactions, Brace, Overwatch) fire automatically under a sensible policy.
- Not implemented:
  - pilots on foot (Eject, Mount, Jockey)
  - skill checks and downtime
  - a handful of complex items: Barbarossa's Apocalypse Rail, Hydra's OROCHI drones, Goblin's Symbiosis, Mimic Gun, Siege Cannon and others (see `--list`)

## Enemies: an original NPC ruleset + Claude skill

Massif's NPC data is a paid content pack, so the bundled enemies use an **original ruleset** modelled on LANCER's NPC structure. Roles: Striker, Artillery, Controller, Defender, Support, Biological. Tiers: 1–3. Templates follow the official rules: Grunt, Veteran (with a Veteran trait), Elite (two turns), Commander, Ultra (two turns, Deadly, Juggernaut, Legendary), Mercenary. Features are written in a small effect DSL, and an encounter budget keeps teams fair.

- Rules: [`docs/enemy-ruleset.md`](docs/enemy-ruleset.md). The code lives in `game/src/enemies/ruleset.ts` and `validate.ts`.
- Teams: `data/enemies/*.json`. The game loads every valid file automatically. Twelve teams ship, covering all tiers and including three bosses.
- **Generate more with Claude.** The project skill [`.claude/skills/generate-enemies`](.claude/skills/generate-enemies/SKILL.md) designs teams from the ruleset, writes the JSON and validates it. Ask Claude Code something like *"generate two tier-2 enemy teams themed around rogue terraforming drones"* or *"make a tier 3 boss"*.
- Validate: `cd game && npm run validate-enemies`.
- Balance check: `npx tsx scripts/simulate.ts 10 [team-id]` runs AI vs AI on 18×36 maps. Tier 1 faces the LL0 pregens, tier 2 the LL5 sample squad and tier 3 the LL10 sample squad (the squad's level in acts 2 and 3).

### Official NPCs from your own content pack

If you own the NPC content pack (for example *Lancer CORE NPCs*, `.lcp`), import it from **Title → Official NPCs**. Both the v1 and v2/v3 pack layouts are read.

- The pack is converted in your browser and stored **only in that browser's local storage**. It is never uploaded, bundled or committed (`*.lcp` is git-ignored).
- Classes become units with their official tier stats, base features and 0–2 optional features. Weapons (including structured on-hit conditions), stats, tags, flight, resistances and Blast/Burst/Line/Cone save attacks are automated from the data.
- Base class features have hand-written scripts in `game/src/rules/effects/official.ts`, keyed by feature id. These include reactions like Hunker Down and Barrel Roll, Guardian cover, Siege Armor, Assassin's and Sniper's Marks, Leap, Avalanche Charge and the Witch's hacks. Of the core pack's 116 base features, 81 are fully automated and 16 approximated. Deployable- and mine-based ones (turrets, mines, Javelin Rockets) and the Squad are still text only, as are most optional features.
- Coverage: `LCP=/path/to/pack.lcp npm run coverage -- --list`.
- **Use in campaigns:** Off, Mixed (half the fights) or Only. Encounters follow the core book's guidance (grunt packs, one Elite per two players, one Ultra for bosses) within the usual budget. Quick skirmish also lists random official encounters.
- Balance check: `LCP=/path/to/pack.lcp npx tsx scripts/simulate.ts 10 official` (reads the pack at runtime).

## Roadmap

Planned fixes and improvements are in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Development

```bash
cd game
npm test               # vitest: importer, rules, enemies, AI, full-content stress test
npm run typecheck
npm run coverage
npm run validate-enemies
npm run build          # static build in game/dist
```

```
vendor/compcon/        COMP/CON v3 (submodule, reference)
game/src/data          lancer-data index + COMP/CON pregens
game/src/import        COMP/CON pilot importer
game/src/rules         engine: battle.ts, grid.ts, stats.ts, effects/ (registry, generic, coverage, scripts)
game/src/enemies       enemy ruleset, validator, builder, catalog
game/src/ai            utility-based tactical AI
game/src/run           campaign layer, map generator
game/src/render        Three.js isometric view
game/src/ui            screens and battle HUD
data/enemies           enemy team files
docs/                  enemy ruleset
```
