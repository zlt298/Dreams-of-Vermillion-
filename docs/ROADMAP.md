# Dreams of Vermillion: Roadmap

These are the fixes and improvements planned after the first playable build. The milestones are listed in priority order.

Each item is sized:

| size | effort |
|---|---|
| S | under 1 hour |
| M | a few hours |
| L | a day or more |

Sprite art is shelved for now; Milestone 6 replaces it with procedural models.

✅ marks finished items. Notes on how they were done:
- **M1.1 rulings:** checked against COMP/CON's own combat code in `vendor/compcon`, which encodes the core book. Changes: armor now applies per damage type; Skirmish is limited to once per turn; reaching 0 stress schedules a meltdown at the end of the next turn instead of an instant explosion; Grunts are destroyed by external heat; Ultra NPCs refresh reactions every turn. Each ruling has a test.
- **M1.2 performance:** caches for the map, line of sight and cover, plus per-unit script lists and a single pathfinding pass. Mean AI turn went from 29 ms to about 17–20 ms (`npm run bench`). The p95 is still around 50 ms.
- **M2.1 reactions:** each mech has a per-reaction policy of auto, ask or off. "Ask" currently uses a synchronous browser confirm dialog, because the engine resolves attacks synchronously.
- **M2.4 previews:** attack previews now run inside a state sandbox. This also fixed a bug where hovering an attack or running AI evaluation triggered script side effects, such as Shrike Armor damage or consuming once-per-round bonuses.

### Milestone 1: Correctness and stability (do first)
1. ✅ **Verify rules rulings against the core book (M).** These are assumptions I made while building that need confirming:
   - excess heat and excess damage carry over after stress/structure
   - Resistance rounds up
   - each weapon attacks once per turn
   - NPCs can't crit
   - 1-stress NPCs become Exposed instead of rolling the overheating table
   - Grunts ignore damage from misses and successful saves
   - stand-up rules for Prone

   Each ruling becomes a named test in `tests/rules.test.ts`, with the logic in `game/src/rules/battle.ts`.
2. ✅ **Performance hotspots (M).**
   - `Battle.effectiveMap()` copies the whole tile array on every line-of-sight and cover call. Cache it and invalidate the cache only when cover deployables spawn or are destroyed.
   - `cover()` loops over every unit's scripts. Precompute which units have `adjustCover`.
   - AI `planFor` evaluates around 120 positions × targets. Cache line of sight per position and turn.
   - Target: under 50 ms per AI turn on an 18×18 map.
3. ✅ **Animation pacing (S).** The backlog catch-up in `render/scene.ts` `wait()` works, but long AI turns still lag. Add a "skip animations" toggle and cap each turn's queue time.
4. ✅ **Battle-end robustness (S).** `BattleScreen.advance()` depends on `busy` and `view.idle()`. Add a timeout fallback so the debrief always appears. Add a Playwright regression test based on the scratchpad `run.cjs`.
5. **Save migration (S).** `run/run.ts` saves to `dov.run.v1` with no migration. Add `version` handling and wipe incompatible saves gracefully.
6. **Import edge cases (S).**
   - Pilots are currently matched on re-import by id *or* callsign, which can collide. Prefer id and confirm when matching by callsign.
   - Handle pilots with no mechs or a missing favourite mech.
   - Test against real COMP/CON exports from the user.

### Milestone 2: Playability and UX
1. ✅ **Reaction prompts (M).** Brace, Overwatch and the chosen talent/system reactions are currently auto-policy only. Add an optional "ask me" mode: the engine pauses with a pending-reaction state, and the HUD shows a yes/no prompt. Files: `battle.ts`, `ui/battle-ui.ts`.
2. ✅ **Undo the last move (S),** allowed only if nothing was revealed or triggered. Store the position and moveLeft before each standard move.
3. ✅ **Turn-order and initiative bar (S).** Show which units have activated and which are still ready on each side.
4. ✅ **Attack-preview polish (S).** Show the damage range, the crit chance, and whether the attack would kill the target or cause structure damage. Do this before committing to the attack.
5. **Threat overlay (M).** A toggle that shades every tile hostiles can hit next turn, using reach plus speed and overwatch threat.
6. **Campaign map edges (S).** Draw connection lines between nodes and show sitrep and enemy-tier previews on hover (`ui/app.ts`).
7. **Hangar quality of life (S):** sort and filter the roster, a mech sheet modal, an SP-overflow warning, and highlighting of LCP content.
8. **Settings screen (S):** animation speed, auto-policies by default, colour-blind palette, camera sensitivity.
9. **Mobile and touch support (M):** tap to select, long-press for tooltips, collapsible panels.

### Milestone 3: Rules fidelity
Driven by `npm run coverage -- --list`. Currently manual: 1 trait, 8 core systems, 8 weapons, 46 systems, 2 mods, 22 talent ranks, plus 39 partial items.

1. **Finish the partial scripts first (M).** Covers Drake Fortress cover sections, Mourning Cloak teleport moves, Goblin Reactive Code, Napoleon Heavy Shielding everywhere, and the leadership dice, exemplar and stormbringer choices.
2. **Remaining core systems (L):**
   - Barbarossa Apocalypse Rail
   - Raleigh Thunder God
   - Hydra OROCHI drones
   - Goblin Symbiosis
   - Pegasus Ushabti Omnigun
   - Sherman COREBURN
   - Black Witch Mag Field
   - Dusk Wing Hall of Mirrors
3. **Drone and deployable framework (L).** Drones that move and act on the owner's turn, recall and redeploy, and deployable auras. These unlock many systems: Aegis, Sentinel, Assassin, Hive, Lotus, ICEOUT, Perimeter Command Plate.
4. **Remaining systems and talents (L)** in batches by manufacturer, with a unit test per script.
5. **Pilots on foot (L):** Eject, Mount, Dismount, Jockey, pilot weapons and armour from `pilot_gear`.
6. **Grapple rules completion (M):** contested-hull drag, size interactions, and grapple ending on movement.
7. **Missing environment rules (M):** elevation and LOS for flying units, zero-g and difficult areas from systems, and lingering object damage to cover.

### Milestone 4: AI
1. **Lookahead for focus fire and kill priority (M).** Make units coordinate on one target rather than each picking a greedy one.
2. **Role scripts (M).** Defenders body-block, Support stays in range of damaged allies, Controllers sequence lock-on before allied attacks.
3. **Use reactions and the remaining NPC options (S),** including grapple and ram and when to Hide.
4. **Difficulty levels (S).** Scale AI caution and randomness, and the encounter budget multiplier, in `enemies/ruleset.ts` `BUDGET_PER_PC`.

### Milestone 5: Content and balance
1. **Balance pass with levelled builds (M).** The sim currently uses LL0 pregens at LL3 and LL6, which skews results. Add sample LL3 and LL6 COMP/CON builds as fixtures, and tune T2/T3 teams and the Furnace Saint so player wins fall within the skill's target ranges.
2. **More teams via the `generate-enemies` skill (S each).** Aim for 4+ teams per tier per kind so runs don't repeat.
3. **Sitrep variety (M).** Use each team's `sitrep` hint, and add Escort and Recon (scan targets) objectives.
4. **Map biomes and set pieces (M).** Hand-authored chunks spliced into `run/mapgen.ts`, plus boss arenas.
5. **Campaign events (M).** Narrative nodes with choices: reserves, bonds, risk and reward.
6. **Reserves from lancer-data (S).** Replace the custom rewards with `reserves.json` entries where they're mechanically usable.

### Milestone 6: Presentation (sprites shelved)
1. **Procedural low-poly mech kit (L).** Instead of sprites, build each token in `render/scene.ts` from modular primitives: torso, legs, arms and a weapon-type prop chosen from the unit's loadout. Size, role and manufacturer palette drive the shapes. This gives distinct silhouettes per frame and NPC without generated art.
2. **Effects (M):** particle muzzle flashes, explosions, smoke and fire areas, shield domes and hit sparks.
3. **Terrain detail (S):** procedural texture variation, building props, a skybox.
4. **Audio (M):** sounds for weapon types, impacts, UI clicks and ambient music, with volume settings.
5. **Revisit sprites later (optional).** Use a consistent pipeline, for example rendering the procedural models out as sprites, or a single-model generator with img2img from those renders.

### Milestone 7: Tooling and tech debt
1. **CI (S):** a GitHub Action that runs typecheck, vitest, validate-enemies and coverage, and fails if coverage drops.
2. **Split `battle.ts` (M).** It's now about 1,300 lines. Split it into `combat.ts`, `movement.ts`, `damage.ts` and `tech.ts`, as originally planned.
3. **Deterministic replays (M).** Log battle intents plus the seed to reproduce bugs, and add a "copy replay" button.
4. **Bundle size (S).** Code-split Three.js and the UI. Vite warns about chunks over 500 kB.
5. **Verify vendored COMP/CON runs locally (S).** Check that `yarn && yarn dev` works in `vendor/compcon`, and document Node version requirements.

### Suggested order
- **Next session:** M1.1–1.4 and M2.1–2.4.
- **After that:** M5.1 balance, then M6.1 procedural models.
- **Ongoing:** M3 in batches, and M7.1 CI early.
