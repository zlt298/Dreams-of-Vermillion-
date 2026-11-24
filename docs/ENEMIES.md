# Enemies

## An original NPC ruleset

Massif's NPC data is a paid content pack, so the bundled enemies use an **original ruleset** modelled on LANCER's NPC structure. Roles: Striker, Artillery, Controller, Defender, Support, Biological. Tiers: 1–3. Templates follow the official rules: Grunt, Veteran (with a Veteran trait), Elite (two turns), Commander, Ultra (two turns, Deadly, Juggernaut, Legendary), Mercenary. Features are written in a small effect DSL, and an encounter budget keeps teams fair.

- Rules: [`docs/enemy-ruleset.md`](enemy-ruleset.md). The code lives in `game/src/enemies/ruleset.ts` and `validate.ts`.
- Teams: `data/enemies/*.json`. The game loads every valid file automatically. Twenty teams ship, covering all tiers and including three bosses. They're named for the campaign's factions: the Choir of the Second Dawn, the Annex's print anomalies and subverted security, Choir-paid mercenaries, and the Martian incursion.
- **Generate more with Claude.** The project skill [`.claude/skills/generate-enemies`](../.claude/skills/generate-enemies/SKILL.md) designs teams from the ruleset, writes the JSON and validates it. Ask Claude Code something like *"generate two tier-2 enemy teams themed around rogue terraforming drones"* or *"make a tier 3 boss"*.
- Validate: `cd game && npm run validate-enemies`.
- Balance check: `npx tsx scripts/simulate.ts 10 [team-id]` runs AI vs AI on 18×36 maps. Tier 1 faces the LL2 sample squad, tier 2 the LL5 one and tier 3 the LL8 one (the squad's level in acts 1, 2 and 3).

### Official NPCs from your own content pack

If you own the NPC content pack (for example *Lancer CORE NPCs*, `.lcp`), import it from **Title → Official NPCs**. Both the v1 and v2/v3 pack layouts are read.

- The pack is converted in your browser and stored **only in that browser's local storage**. It is never uploaded, bundled or committed (`*.lcp` is git-ignored).
- Classes become units with their official tier stats, base features and 0–2 optional features. Weapons (including structured on-hit conditions), stats, tags, flight, resistances and Blast/Burst/Line/Cone save attacks are automated from the data.
- Base class features have hand-written scripts in `game/src/rules/effects/official.ts`, keyed by feature id. These include reactions like Hunker Down and Barrel Roll, Guardian cover, Siege Armor, Assassin's and Sniper's Marks, Leap, Avalanche Charge and the Witch's hacks. Of the core pack's 116 base features, 81 are fully automated and 16 approximated. Deployable- and mine-based ones (turrets, mines, Javelin Rockets) and the Squad are still text only, as are most optional features.
- Coverage: `LCP=/path/to/pack.lcp npm run coverage -- --list`.
- **Use in campaigns:** Off, Mixed (half the fights) or Only. Encounters follow the core book's guidance (grunt packs, one Elite per two players, one Ultra for bosses) within the usual budget. Quick skirmish also lists random official encounters.
- Balance check: `LCP=/path/to/pack.lcp npx tsx scripts/simulate.ts 10 official` (reads the pack at runtime).
