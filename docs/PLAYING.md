# Playing Dreams of Vermillion

How to build pilots, how a run works, and the battle controls. For running the game, see the [README](../README.md).

## Building pilots

### In the game

In the **Hangar**, choose **New pilot**, or **Edit** on any pilot card. The builder covers what the rules engine uses:
- License Level
- HASE
- license ranks
- talents and their ranks
- core bonuses, including the mount-targeted and extra-mount ones
- frame, weapons per mount, weapon mods and systems

Every change is checked live against the LANCER build rules (`game/src/rules/legality.ts`), and a budget bar shows HASE, talents, licenses, core bonuses and SP. The pickers only offer gear that fits the mount and that your license ranks allow. A build with errors can't be saved. Unspent points only trigger a warning.

During a run, each pilot on the campaign map has an **Edit build** button. Builds made during a run stay in the run; your roster pilots are not changed. A refit keeps damage, spent Repairs, destroyed gear and used Limited charges.

**Act levels.** Each act is fought at a fixed License Level: act 1 at LL2, act 2 at LL5, act 3 at LL8. LL2 means two license ranks, so pilots can field a licensed frame from the first fight, and +3 per act keeps a build recognizable after a level-up.
- **Starting a run.** A chosen pilot at another level gets a run-only copy fitted to LL2. A lower-level pilot (such as an LL0 COMP/CON pregen) keeps its build and gets the new points to spend; a higher-level one keeps what LL2 allows, and gear its licenses no longer cover is removed. The **Squad preparation** screen then asks you to finish each fitted build in the builder. The run starts once every pilot is legal, has all points spent and has at least one weapon.
- **After each act boss.** The squad moves to the new level, and the level-up screen holds the run until every pilot is ready again. Use **Level up** for each pilot, or re-import a COMP/CON pilot (or a pre-built squad) at the right level; these match by id or callsign.

**Pre-built squads.** The hangar's squad picker adds a ready-made squad to the roster and picks it. There are three themed squads at LL2, LL5 and LL8, each with four legal pilots that have every point spent and one Striker, Defender, Controller and Artillery frame. Each pilot flies the same frame at every level, and each level's build is the previous one plus the new points, so the squad you meet in act 1 is still recognizable in act 3. Each act's picker labels them Easy, Medium or Hard by how many mechs they tend to lose against that act's enemies (AI-vs-AI sims), and the order changes by act. The labels were measured at the old LL0/LL10 act levels and are provisional until re-simulated:

| squad | act 1 (LL2) | act 2 (LL5) | act 3 (LL8) |
|---|---|---|---|
| **Brawlers:** melee and armour | Medium | Medium | Easy |
| **Long Guns:** rifles, cannons and missiles | Easy | Hard | Hard |
| **Drone Wing:** drones and deployables | Hard | Easy | Medium |

The picker also has the LL2/LL5/LL8 sample squad (Drake, Monarch, Saladin, Blackbeard; a new roster starts with the LL2 one) and, in act 1, the LL0 COMP/CON pregens, which are fitted up to LL2 when the run starts. The themed squads are generated and checked by `npx tsx scripts/make-squads.ts`, the sample squads by `npx tsx scripts/make-samples.ts`.

### In COMP/CON

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

It uses the pilot's favourite mech and its active loadout: frame, weapons, mods, systems, talents and ranks, core bonuses, license ranks, HASE and License Level. Imported pilots can be edited further in the in-game builder. Content that isn't in `lancer-data` (LCP items) is flagged.

## The campaign and battles

- **Campaign.** Three acts with branching node maps. Node types are ⚔ combat, ☠ elite, ⬢ supply, ⛺ rest and ♛ boss. Act *n* uses tier-*n* enemies. Sitreps include Basic Combat, Control, Holdout, Extraction and Assassination.
- **Three looks.**
  - Act 1 is fought outside, where the lance is intercepted.
  - Act 2 is inside an industrial park: warehouse rows, container stacks, pipe runs, steam vents, scrap and chemical spills, all under sodium light.
  - Act 3 is a white cleanroom of lab modules and glass partitions, broken open by Martian regolith with dunes, rock outcrops, red dust and breaches.
  - Quick skirmish picks the look from the enemy tier.
- **Story.** In-universe Union documents bracket the campaign: a priority transmission at the start, an after-action report after act 1, an intercepted transmission after act 2 and a debrief after the final fight. They type out as a console readout. Hold any key or mouse button to skip; recovered documents can be replayed from **Title → Transmissions**. Every run is framed as one of the casket's **forecast iterations**: the title and campaign map show the iteration number, a lost run plays the casket's failed-iteration log, and the campaign map carries live casket telemetry. The UI palette shifts with each act. See [`docs/DESIGN.md`](DESIGN.md). The final boss is always *The Voice of the Eye*, the Choir of the Second Dawn's prophet in the Cinnabar Annex casket vault. Texts: `game/src/data/story.ts`.
- **Tag tooltips.** Hover any tag (AP, Reliable 2, Blast 2, Loading, Smart…) on weapon cards, Hangar weapon lines or the battle log to read its rules. System chips and weapon cards show their rules text on hover too.
- **Graphics.** Each act has its own lighting, backdrop, drifting particles (dust, embers, red regolith) and practical lights. Attacks are animated by weapon type (tracers, arcing missiles, beams, melee slashes); kills explode and leave smouldering wrecks; heat, burning, overshield and Lock On show on the mechs; round banners and an end-of-battle stamp frame the fight. The **◈ high / ◇ low** button in the battle top bar toggles bloom, film grain, particles and extra lights (software GL starts on low). Pilots get rendered mech portraits in the Hangar, on the campaign dossiers and in the unit panel.
- **Field overlays.** Smoke, terrain zones, drone fields, barriers and auras are tinted on the map by effect, and listed when you hover a tile. Press **V** to toggle.
- **Between-battle events.** After each won combat:
  - 25%: nothing happens.
  - 50%: a minor find (+1, free).
  - 15%: a gamble (a minor sacrifice for +2).
  - 10%: a hard choice (a heavy sacrifice such as a Structure or Stress, a destroyed system or a stunned first round, for a big or permanent benefit).
  - There are six of each kind, in `game/src/run/events.ts`.
- **Persistent damage.** HP, structure, stress, repairs, destroyed gear, Limited uses and CORE power carry between fights.
- **Recovery.** Spend Repairs at LANCER costs in field repairs. A rest is a full repair that reprints destroyed mechs.
- **Stand-ins.** Until then, a pilot whose mech was destroyed flies a stock LL0 Everest stand-in. Its damage doesn't carry over.
- **Progression.** Each act is fought at a fixed License Level: act 1 LL2, act 2 LL5, act 3 LL8, against tier 1, 2 and 3 enemies. After an act boss the squad goes up three levels (+3 talent ranks, license ranks and mech skill points, and a core bonus at LL3/6/9), and the run continues only once every build is legal with all points spent. Spend them with **Level up** on the level-up screen, or re-import updated COMP/CON builds.
- **Battles:**
  - Initiative alternates between sides: pick any ready lancer to activate.
  - Every lancer action is supported. Standard move (it can be split), Boost, Skirmish (plus an aux on the same mount), Barrage, Quick/Full Tech (Invade, Lock On, Bolster, Scan), Overcharge, Stabilize, CORE power, Hide/Search, Ram/Grapple/Improvised, Disengage, Shut Down/Boot Up, Self-Destruct.
  - **Weapons and reloading.** A weapon can attack again in the same turn whenever an action allows it (for example Skirmish, then Overcharge and Skirmish again with the same weapon), unless its own tags say otherwise. There is no Reload action: **Stabilize** (a full action) reloads all Loading weapons as its extra option, and some gear (the Autoloader Drone, the Raleigh's Full Metal Jacket) reloads too. When Stabilize could do more than one extra thing (clear burn, clear a condition or reload), you choose.
  - Systems, traits and talents add their own actions.
  - Hovering a target shows the hit chance, cover, and every accuracy and difficulty source.
  - **Auto (AI)** lets the tactical AI take a lancer's turn.
  - Controls: **Q/E** rotate, **WASD** or right-drag pan, wheel zoom, **Enter** end turn (asks if actions are unused), **Esc** cancel, **Tab** cycle lancers, **1–9** skirmish with a weapon (**Shift** to barrage), **B** boost, **O** overcharge, **T** threat overlay, **V** field overlays, hold **Alt** for every unit label, **L**/**R** toggle the log and roster, **?** lists them all. On touch screens: drag to pan, pinch to zoom, tap once to preview and again to confirm.
  - **Settings** (title screen, or ⚙ in battle): animation speed, graphics quality, motion (reduce turns off shake, pulses and wipes) and a colour-blind palette.

## Saving and undo

- **Battles save as you play.** The battle in progress is saved after every action, so closing the tab or reloading doesn't lose it: **Continue run** goes straight back into the fight, exactly where it was.
- **Undo** (the ↶ button or Ctrl+Z) takes back your last action, however far it went (moves, attacks, systems, ending your turn and the enemy turns that followed). It isn't available while the enemy is acting or once the battle is over. Dice are seeded, so repeating the same action gives the same roll.
- **Bug reports.** The **⤓** button in the battle header downloads the battle as a replay file (see [ENGINE.md](ENGINE.md#battle-replays-bug-reports)).
