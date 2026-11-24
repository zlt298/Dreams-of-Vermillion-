# Engine and development

The rules engine, its coverage and known deviations, testing, replays, the code layout and deployment.

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
Frame traits             29       0      0       0    100%
Core systems             29       0      0       0    100%
Weapons                  32       0     53       0    100%
Systems                 120       0      4       0    100%
Mods                      5       0      3       0    100%
Talent ranks             81       0      6       0    100%
Core bonuses             13       0     17       0    100%
TOTAL 392/392 (100%) fully executed by the engine, 0 partially
```

- **auto**: fully described by structured data (bonuses, damage, ranges, tags, on-hit statuses).
- **scripted**: hand-written in `game/src/rules/effects/scripts/`.
- **partial**: a script that approximates part of the item.
- **manual**: actions that aren't executed yet. They still appear in the action bar marked `*`, and using one logs its rules text for you to resolve by hand.

To add fidelity, register a script keyed by the item id in `game/src/rules/effects/scripts/`. The hooks are listed in `registry.ts`. `tests/integration/stress-every-frame.test.ts` builds every frame, system, talent and core bonus into mechs and auto-battles them to catch runtime errors.

### Known deviations and house rules
- Square grid with diagonals counting as 1. Range and threat include the vertical gap.
- Rules follow the core book: hard cover must be adjacent to the target and at least as large as it (distant obstructions give soft cover); Blast cover is measured from the blast centre; armor comes off an attack's total once; one reaction per turn, each type once per round; wreckage is hard cover and difficult terrain. Being 2+ levels above cover negates it.
- Wreckage can be crossed (as difficult terrain) but you can't end a move on it.
- Mines follow the core book (planted adjacent, not next to another mine; arm at the end of your turn; set off by entering an adjacent space; Hidden from the other side until found with Search for Mines, then disarmable), with one house rule: **your own side never sets off your mines** (the Smoke Mine, which is meant for allies, excepted).
- Destructible terrain is a house rule: each level of a terrain block has 10 HP and Evasion 5, and a block with no levels left becomes rubble.
- Player decisions (reactions, firing modes, effect choices) appear in an in-HUD picker. Per-mech policies (auto / ask / off) cover Brace, Overwatch and other reactions; the AI and Auto turns take the default.
- Flight altitude is abstract (one level). Flyers land when Immobilized or Stunned, when they fail an Agility save after Structure or Stress damage, or when they end a turn without moving (unless they hover). Each flying move follows a straight line (hover excepted); flyers pass over ground obstructions and dangerous terrain.
- Teleporting spends a whole movement (up to Speed) however far it goes, still provokes Overwatch, is stopped by Immobilized and Grapple, and never causes a fall. Climbing is free up to your Size in levels, then 2 movement per extra level. Each specific reaction refreshes at round start. Falls happen at once, not at the end of the turn (house rule).
- You can INVADE a willing ally: it succeeds automatically, deals no heat and isn't an attack (useful with beneficial invade options).
- Not implemented (out of scope): pilots on foot (Eject, Mount, Jockey), and narrative skill checks and downtime. Lifting, dragging, carrying and jumping aren't generic actions (only the items that do them).

### Saving, undo and checks
- **Battles save as you play.** The battle in progress is saved after every action, so closing the tab or reloading doesn't lose it: **Continue run** goes straight back into the fight, exactly where it was.
- **Undo** (the ↶ button or Ctrl+Z) takes back your last action, however far it went (moves, attacks, systems, ending your turn and the enemy turns that followed). It isn't available while the enemy is acting or once the battle is over. Dice are seeded, so repeating the same action gives the same roll.
- **Golden battles:** six pinned AI-vs-AI fights (`tests/integration/golden/`). If a change alters how they play out, the test fails; if that was intended, re-pin with `npm run golden` and commit `tests/integration/golden/battles.json`.
- **CI** (`.github/workflows/ci.yml`) runs the typecheck, all tests, the build and the end-to-end campaign run on every push and pull request.
- The battle screen and Three.js load with the first battle, so the title and hangar open faster.

### Battle replays (bug reports)
Every battle records its seed, starting state and every top-level command: player actions, AI turns, and the decisions taken in the HUD picker. The **⤓** button in the battle header downloads it as `dov-battle-<time>.json` (with an optional note). `cd game && npm run replay -- <file> [--upto N] [--log N]` replays it headlessly, prints the log tail and checks the final state hash against the export. `--upto N` stops just before command N, to inspect the state ahead of a bug. Scripts can call `window.__dov.exportBattle()`, and `src/replay/replay.ts` exports `exportBattle`, `replayBattle` and `stateHash`.

Engine rule for replays: change battle state only through `Battle` methods. UI toggles go through `setProfile`, `setWeaponFlag` and `setPolicy`. Anything mutated directly isn't recorded and breaks the replay.

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
game/src/rules         engine: battle.ts (entry), battle/ (below), grid.ts, stats.ts, effects/ (registry, generic, coverage, scripts)
game/src/rules/battle  core.ts: the Battle class (state + one-line typed stubs); logic by area:
                       turns, damage, movement, attacks, actions, terrain (grapples too), tech, fields (mines, areas), decisions
game/src/enemies       enemy ruleset, validator, builder, catalog
game/src/ai            utility-based tactical AI
game/src/run           campaign layer, map generator
game/src/render        Three.js isometric view
game/src/ui            screens and battle HUD
data/enemies           enemy team files
docs/                  enemy ruleset
.github/workflows      GitHub Pages deploy
```

### Deploying to GitHub Pages

`.github/workflows/pages.yml` runs the tests, builds `game/dist` and publishes it on every push to `main` (or by hand from the Actions tab). One-time setup, with the repo public:

1. Settings → Pages → **Source: GitHub Actions**.
2. Push to `main`, or run **Deploy to GitHub Pages** from the Actions tab.

The build uses relative asset paths (`base: './'` in `vite.config.ts`), so it works under any subpath. To smoke-test a production build: `npm run build && npx vite preview`, or point the e2e test at any URL with `E2E_URL=<url> npm run e2e`.
