---
name: generate-enemies
description: Generate new AI-designed enemy teams for Dreams of Vermillion (the Lancer tactics roguelike) using the project's enemy ruleset, then validate them. Use when the user asks for new enemies, enemy teams, encounters, bosses, factions or more variety, optionally with a theme, tier (1-3), kind (standard/elite/boss), squad size or count.
---

# Generate enemy teams

You are designing original enemy teams for the Lancer-based roguelike in this repo. Each team is one JSON file in `data/enemies/` that the game loads automatically.

## Inputs (from the user's request; ask only if something essential is ambiguous)
- **theme / faction** (default: invent one that fits a dying frontier world called Vermillion)
- **tier**: 1, 2 or 3 (default: fill whichever tier has the fewest teams; check with `ls data/enemies`)
- **kind**: `standard`, `elite` or `boss` (default `standard`)
- **designedFor**: squad size (default 4)
- **count**: how many teams to make (default 1)

## Steps

1. **Read the rules first.** Read `docs/enemy-ruleset.md`, which has the stats tables, templates, budget, damage caps and effect DSL. Skim one or two existing files in `data/enemies/` at the same tier as reference. Don't copy them.
2. **Design on paper before writing JSON.**
   - Pick a tactical identity, for example *"bait-and-snare"*, *"heat-bomb the backline"* or *"shield wall with artillery"*.
   - Choose 3–6 unit types and 5–9 bodies.
   - Compute the budget: standard 1, Grunt 0.25, Veteran 1.5, Elite/Commander 2, Mercenary 1.25, Ultra 4, each × count. The total must be ≤ `designedFor × {1.0, 1.25, 1.5}[tier-1] × {1, 1.5, 2}[kind] × 1.25`.
   - Count features per unit: T1 3, T2 4, T3 5, plus template slots (Grunt −1, Veteran/Elite/Commander +1, Ultra +3).
   - For each weapon, check its average damage against the role/tier band in the doc (+35%, ×1.5 with recharge/uses, ×0.85 for AoE, ×0.8 for Grunts).
3. **Write the file** to `data/enemies/<id>.json`. Use the id `t<tier>-<kebab-name>`, which must be unique. Use only effect kinds, statuses, tags and triggers listed in the doc. Avoid `text` effects: the engine doesn't execute them. Use original names; never Massif NPC names or real brands.
4. **Validate**: `cd game && npm run validate-enemies -- ../data/enemies/<id>.json`. Fix every `error` and reconsider every `warn`, then re-run until it passes.
5. **Balance test** (recommended): `cd game && npx tsx scripts/simulate.ts 10 <team-id>` plays AI vs AI against a squad matched to the tier. Tier 1 faces the LL0 COMP/CON pregens, tier 2 the legal LL3 sample squad and tier 3 the LL6 sample squad (`game/src/data/squads/`). Battles run on 18×36 maps with a 30-round cap; set `MAX_ROUNDS` to change it. Ranged-heavy teams get more value from the long approach than melee swarms. Aim for:

   | kind | player win rate | mechs lost per fight |
   |---|---|---|
   | standard | 85–100% | 0.5–1.3 (attrition matters, because damage carries between fights) |
   | elite | 50–80% | 1–2 |
   | boss | 40–75% | ~2 |

   Use at least 10 seeds: 8-seed results swing a lot. Too easy means 100% wins with fewer than 0.5 mechs lost. Tune by adding or removing units within the budget before touching stats. Against real builds, bosses and elites often play harder than their budget suggests, so a "well under budget" warning on them is fine.
6. **Report** each team's name, identity, roster with budget, and validation and sim results. Don't commit unless asked.

## Quality checklist
- [ ] Every unit has a way to act; Elites/Ultras/Commanders have a reaction or recharge spike.
- [ ] Statuses that lock players out (stunned, immobilized, jammed) have saves or recharge.
- [ ] Ranges suit the role: Artillery 10–15 with Arcing or Blast; Strikers have Threat or short range.
- [ ] Mercenaries reference real lancer-data weapon ids (check `game/node_modules/@massif/lancer-data/lib/weapons.json`).
- [ ] A boss team contains an Ultra; a control/holdout `sitrep` hint suits the composition.
