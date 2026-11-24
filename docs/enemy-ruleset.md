# Dreams of Vermillion: enemy generation ruleset

This is an original NPC framework for the game, built on LANCER's NPC structure: roles, tiers, templates and features. Every enemy team is a JSON file in `data/enemies/`. The game loads all valid files into its encounter pool. Files that fail validation are listed on the title screen.

The authoritative numbers are in `game/src/enemies/ruleset.ts`, and `game/src/enemies/validate.ts` enforces them. This document explains them. Check any file with:

```bash
cd game && npm run validate-enemies              # all files
cd game && npm run validate-enemies -- ../data/enemies/my-team.json
```

---

## 1. Team file

```jsonc
{
  "id": "t2-ash-choir",            // kebab-case, unique, prefix with tier is conventional
  "name": "The Ash Choir",
  "faction": "…", "theme": "one-line flavour used for picking & display",
  "tier": 2,                        // 1, 2 or 3 → appears in act 1, 2 or 3
  "designedFor": 4,                 // squad size it is balanced for (the game rescales)
  "depth": [1, 6],                  // optional: node layers (1-6) it may appear on
  "kind": "standard",               // standard | elite | boss
  "sitrep": "standard",             // hint only: standard | control | holdout | extraction | assassination
  "description": "…",
  "units": [ /* EnemyUnitDef */ ]
}
```

### Budget

Each unit costs budget:

| unit | cost |
|---|---|
| standard | 1 |
| Grunt | 0.25 (+0.25 per extra template) |
| Veteran | 1.5 |
| Commander | 1.75 |
| Elite | 2 |
| Mercenary | 1.25 |
| Ultra | 4 |

Multiple non-Grunt templates cost the most expensive one, plus 0.5 for each extra template. The total is multiplied by `count`.

**Target budget** = `designedFor × per-PC rate × kind multiplier`:

| tier | per-PC rate |
|---|---|
| 1 | 1.0 |
| 2 | 1.2 |
| 3 | 1.0 |

The kind multiplier is 1 for standard, 1.5 for elite and 1.75 for boss.

These rates were set on **attrition**, not win rate: in a run, damage carries over, so a fight the squad wins while losing a mech is a bad fight. Targets with a typical squad: about 0.2 mechs lost per standard fight, 0.5 per elite and 1 per boss (act 1 a little easier, act 3 a little harder). Tier-3 units are individually much stronger, which is why the tier-3 rate is below tier 2's. Every elite team keeps at least one Elite.

A team **may not exceed the target by more than 25%**. Going under 60% of the target produces a warning.

A **standard** team needs a budget of **at least 1 per player** (`designedFor`): the core book's standard fight has one or two NPCs per player, or three or four Grunts each (p.283). The validator refuses a standard team below that floor, and when the game rescales a standard team for a different squad size it tops the roster up (cheapest units first) so the floor still holds. The official-NPC generator follows the same floor.

Example: a tier-1 standard team for 4 PCs targets a budget of 4, with a maximum of 5 and a minimum of 4.

---

## 2. Unit definition

```jsonc
{
  "name": "Ash Cantor",
  "role": "Controller",            // Striker | Artillery | Controller | Defender | Support | Biological
  "templates": ["Elite"],          // optional: Grunt | Veteran | Elite | Commander | Ultra | Mercenary
  "count": 1,                      // 1-8 copies
  "color": "#9b59b6",              // optional token colour
  "stats": { "hp": 14 },           // optional overrides, within tolerances (§4)
  "features": [ /* §5 */ ],
  "mechWeapons": ["mw_assault_rifle"], // Mercenary only: up to 2 lancer-data weapon ids
  "veterancy": "agi",              // Veteran only: hull | agi | sys | eng (default: the role's best skill)
  "veteranTraits": ["deadly"],     // Veteran only: one trait per tier from §5.1 (T2 two, T3 three)
  "description": "flavour shown on hover"
}
```

## 3. Roles: tier-1 baseline stats

| Role | HP | Armor | Evasion | E-Def | Heat cap | Speed | Sensors | Size | Hull | Agi | Sys | Eng |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Striker | 12 | 0 | 10 | 8 | 6 | 5 | 10 | 1 | 1 | 2 | 0 | 0 |
| Artillery | 10 | 0 | 6 | 8 | 8 | 3 | 15 | 1 | 0 | 0 | 1 | 1 |
| Controller | 10 | 0 | 8 | 12 | 8 | 4 | 15 | 1 | 0 | 0 | 2 | 1 |
| Defender | 18 | 2 | 6 | 6 | 6 | 3 | 10 | 2 | 2 | −1 | 0 | 1 |
| Support | 12 | 1 | 8 | 10 | 8 | 4 | 15 | 1 | 0 | 0 | 1 | 2 |
| Biological | 14 | 0 | 8 | 4 | — | 5 | 8 | 1 | 2 | 1 | −2 | 0 |

Biological units have no heat cap: any heat they would take is dealt to them as Energy damage instead.

How each role plays:

- **Striker**: closes in and hits hard. The AI accepts danger to get into range.
- **Artillery**: long range, often Arcing or AoE. The AI keeps 4+ spaces from hostiles.
- **Controller**: tech and statuses. Applies Jammed, Impaired, Lock On, Slowed and heat.
- **Defender**: tough and slow. Protects allies with reactions and pushes. The AI stays near allies.
- **Support**: heals, overshields and buffs. The AI stays near allies.
- **Biological**: monsters and swarms. Heat-immune, low E-Def.

### Tier scaling, added to the baseline

| Tier | HP | HP (Defender) | Evasion | E-Def | Armor | Save target | Attack bonus | Positive HASE | Heat cap |
|---|---|---|---|---|---|---|---|---|---|
| 1 | +0 | +0 | +0 | +0 | +0 | 10 | +1 | +0 | +0 |
| 2 | +4 | +6 | +1 | +1 | +0 | 12 | +2 | +1 | +2 |
| 3 | +8 | +12 | +2 | +2 | +1 | 14 | +3 | +2 | +4 |

Tech attack = attack bonus + Sys (if positive). Every unit starts with 1 structure, 1 stress and 1 activation.

## 4. Stat overrides: allowed deviation from the computed baseline

| stat | tolerance |
|---|---|
| hp | ±30% |
| armor, hull, agi, sys, eng | ±1 |
| evasion, edef, heatcap, speed | ±2 |
| sensors | ±5 |

`structure`, `stress`, `activations`, `save`, `attackBonus` and `techAttack` cannot be overridden. They come from the tier and templates only. Traits may still shift stats through `"stats"` (see §5.4), which counts as one of the unit's features.

## 5. Templates

| Template | Effect | Feature slots |
|---|---|---|
| **Grunt** | 1 HP, 1 structure, 1 stress, and it can never gain more (trait `stats` and `stats` overrides can't raise them; the Grunt template is applied after every other template). It keeps its Armor. Any damage destroys it, including Reliable damage on a miss and heat from an enemy. A successful save leaves it completely unharmed (no half damage). **Rank and File**: can't be a Veteran, Elite or Ultra. Grunts are glass cannons: dangerous, and they soak up player actions. | −1 |
| **Veteran** | +1 structure, +1 stress. **Veterancy**: +1 accuracy on checks and saves with one skill (`veterancy`). **One Veteran trait per tier** (`veteranTraits`, §5.1: T1 one, T2 two, T3 three). Can score critical hits. | 0 |
| **Elite** | +1 structure, +1 stress (rolls on the structure and overheating tables). **Two separate turns each round**; its reactions still refresh only once per round. **Specialist Kit**: one extra feature. Can't be a Grunt or Ultra. | +1 |
| **Commander** | +1 structure, +1 stress. **Voice of Authority**: 1/round reaction, an ally may reroll a failed attack, check or save (not while the Commander is Jammed). **Military Discipline**: adjacent allies get +1 accuracy on attacks, checks and saves (not while the Commander is Jammed). | 0 |
| **Ultra** | +3 structure, +3 stress (4 each), +5 HP. **Two turns each round** (three if facing 5+ hostiles); its reactions refresh at each of its turns. **Deadly** (+1d6 on crits), **Juggernaut** (clears a condition at turn start, repairs a destroyed weapon/system at turn end), **Legendary** (structure/overheat checks rolled twice, keep the better), **Reflex** (Overwatch any number of times per round). Can score critical hits. Use at most one per encounter. | +3 |
| **Mercenary** | **Opportunist**: +1 accuracy when the target is engaged by an ally. House rule: may carry up to 2 licensed mech weapons from lancer-data (`mechWeapons`); Superheavy only at tier 3. | 0 |

These follow the official LANCER templates. Only Veterans and Ultras can score critical hits; other NPCs can't. Ultra can't combine with Grunt or Elite.

### 5.1 Veteran traits

A Veteran takes one distinct trait per tier. (Older files may give a single `veteranTrait`; it counts as one entry.)

| trait | Effect |
|---|---|
| `deadly` | +1d6 damage on critical hits |
| `feign_death` | The first time it would be destroyed (a crushing hit included) it survives on 1 HP and becomes Hidden |
| `hacker` | +2 heat on successful tech attacks |
| `hardened_target` | +1 accuracy on Systems saves; tech attacks against it take +1 difficulty |
| `insulated` | Immune to Burn |
| `legendary` | Structure and overheating checks are rolled twice; it keeps the better result |
| `lightning_reflexes` | Heavy and Superheavy attacks against it miss on a d6 roll of 5+ |
| `shock_armor` | Resistance to damage from Main weapons |
| `steel_jaw` | Auxiliary weapons deal at most 1 damage to it |

Base feature slots by tier: T1 3, T2 4, T3 5.

NPCs with 1 stress don't roll on the overheating table. When they exceed their heat cap they clear heat like a mech (heat beyond the cap carries over) and become **Exposed**.

**Critical hits.** Only Veterans and Ultras can score critical hits; every other NPC's 20s are ordinary hits. *House rule:* this ruleset's NPC weapons roll their damage dice (the core book gives NPCs fixed damage), and a Veteran's or Ultra's critical hit rolls that damage twice and keeps the higher, like a player's, before adding Deadly.

**Recharge.** At the start of each of its turns, an NPC with any spent Recharge item rolls **one** d6; every spent item whose Recharge target that roll meets is ready again.

**Improvised Attack.** An NPC's Improvised Attack is a melee attack at +1/+2/+3 (by tier) that deals a fixed 3/4/6 kinetic damage.

**Invade.** An NPC's Invade deals 2 heat and Impairs the target (no Slowed).

## 6. Features

Every unit needs at least one way to act: a weapon, a tech, a damaging or healing system, or `mechWeapons`.

### 6.1 Weapon
```jsonc
{ "type": "weapon", "name": "Pulse Rifle", "weaponType": "Rifle",   // Melee CQB Rifle Cannon Launcher Nexus Spool
  "range": [{ "type": "Range", "val": 10 }],                          // Range Threat Thrown Line Cone Blast Burst
  "damage": [{ "type": "Kinetic", "val": "1d6+2" }],                  // Kinetic Explosive Energy Burn Heat
  "tags": [{ "id": "tg_reliable", "val": 2 }],                        // any lancer-data tag id the engine supports (below)
  "accuracy": 0, "smart": false,                                      // smart → attacks E-Def
  "onHit": [ /* effects */ ], "onCrit": [],
  "recharge": 5,                                                      // Recharge 5+ (d6 at turn start); 4-6
  "uses": 2 }                                                         // Limited
```
Blast weapons need `Range` + `Blast`. Burst weapons are centred on the user. Supported tags:

| tag | effect |
|---|---|
| `tg_ap` | ignores armor |
| `tg_accurate` / `tg_inaccurate` | +1 accuracy / +1 difficulty |
| `tg_arcing` | no line of sight needed |
| `tg_seeking` | ignores cover, no line of sight needed |
| `tg_smart` | attacks E-Def |
| `tg_reliable` X | X damage on a miss |
| `tg_knockback` X | pushes X on a hit |
| `tg_loading` | must reload after firing |
| `tg_overkill` | reroll 1s, +1 heat to the attacker each time |
| `tg_heat_self` X | attacker takes X heat |
| `tg_burn` X | X burn on a hit |
| `tg_heat_target` X | X heat to the target on a hit |
| `tg_irreducible` | damage can't be reduced |

**Damage caps.** This is the average of the damage dice, ignoring Heat, for one attack:

| Role | T1 | T2 | T3 |
|---|---|---|---|
| Striker | 7 | 9 | 11 |
| Artillery | 6 | 8 | 10 |
| Controller | 4 | 6 | 8 |
| Defender | 5 | 7 | 9 |
| Support | 4 | 6 | 7 |
| Biological | 6 | 8 | 10 |

Average damage may exceed the band by up to **+35%**. The cap is adjusted as follows:

| case | cap multiplier |
|---|---|
| AoE | ×0.85 |
| Recharge or Limited | ×1.5 |
| Grunt | ×0.8 |

Damage below half the band produces a warning. For averages, `1d6` = 3.5, `1d3` = 2, `2d6` = 7, `1d6+2` = 5.5.

### 6.2 Tech
```jsonc
{ "type": "tech", "name": "Neural Lash", "kind": "quick",  // quick | full
  "range": 10,                                              // default: sensors
  "onHit": [{ "do": "heat", "val": 3 }, { "do": "status", "status": "impaired", "duration": "next_turn_end_target" }],
  "recharge": 5 }
```
A tech attack is a tech-attack roll against E-Def. It ignores cover.

### 6.3 System (active ability)
```jsonc
{ "type": "system", "name": "Repair Nanites", "activation": "quick",  // quick | full | protocol
  "target": "ally",                 // self | ally | enemy | self_burst | tile_blast
  "range": 5, "radius": 2,          // radius required for self_burst / tile_blast
  "save": "agi",                    // hostiles in the area may save against harmful effects
  "effects": [{ "do": "heal", "val": "1d6+2" }],
  "recharge": 5, "uses": 1, "heat": 2 }
```
In area systems, harmful effects apply only to hostiles and helpful effects (heal, overshield, clear heat, clear status) only to allies.

### 6.4 Trait (passive)
```jsonc
{ "type": "trait", "name": "Heavy Plating",
  "stats": { "armor": 1 },          // added on top of baseline
  "resist": ["Kinetic"],             // "all" is Ultra-only
  "immune": ["prone"],
  "hooks": [{ "on": "turn_start", "effects": [{ "do": "clear_heat", "val": 2 }], "target": "self" }] }
```
Hook triggers are `turn_start`, `turn_end`, `hit_by_melee`, `damaged`, `ally_destroyed_nearby` and `attacked_and_missed`. A hook's `target` is `self` (the default) or `trigger`, the unit that caused it.

Unit tokens fly if a trait name contains *flying*, *flight* or *hover*.

### 6.5 Reaction (uses the unit's 1 reaction per round; Ultras regain theirs at each of their turns)
```jsonc
{ "type": "reaction", "name": "Counter-Slash", "trigger": "hit_by_melee",
  "frequency": "1/round",          // or 1/scene
  "attackWith": "Monoblade",       // one of this unit's weapon names, and/or:
  "effects": [{ "do": "push", "val": 2 }] }
```
Triggers:

| trigger | when it fires |
|---|---|
| `hit_by_melee` | a melee attack hits this unit |
| `attacked_and_missed` | an attack against this unit misses |
| `damaged` | this unit takes damage |
| `enemy_moves_adjacent` | a hostile moves next to this unit |
| `ally_attacked_adjacent` | an adjacent ally is attacked |

Effects target the triggering character.

### 6.6 Effect DSL

| `do` | fields | notes |
|---|---|---|
| `status` | `status`, `duration`, `save?` | statuses: impaired, slowed, immobilized, jammed, lockon, shredded, stunned, exposed, prone, hidden, invisible |
| `damage` | `damage[]`, `save?`, `saveHalf?`, `ap?` | |
| `heat` | `val`, `save?` | |
| `burn` | `val`, `save?` | |
| `push` / `pull` | `val`, `save?` | spaces |
| `overshield` | `val` | |
| `heal` | `val` | |
| `clear_heat` | `val` or `"all"` | |
| `clear_status` | `status?` / `"any_negative"` | |
| `bonus_damage` | `val` | on-hit only |
| `text` | `text` | **not executed**: avoid (validator warns) |

Durations are `end_of_turn`, `next_turn_end_target` (the default), `next_turn_end_source`, `start_of_next_turn_target` and `until_cleared`. `save` is one of `hull`, `agi`, `sys` or `eng`, rolled against the unit's save target. An unsaveable **Stunned** produces a warning: use a save or Recharge.

## 7. Design guidance

- 3–6 distinct unit types per team, and 5–9 bodies total. Grunts pad numbers cheaply.
- Give every team a **tactical identity**, for example *"suppress and flank"*, *"heat-bomb the backline"* or *"shield wall with artillery"*.
- Every Elite, Ultra or Commander should have at least one reaction or recharge ability so it feels special.
- Bosses (`kind: "boss"`) should include an Ultra and some Grunts so the boss isn't swarmed.
- Prefer statuses with saves, and Recharge for spikes. Keep at-will damage inside the band.
- Names and flavour should be original: no Massif NPC names, no real brands.
