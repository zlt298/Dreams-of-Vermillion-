# Dreams of Vermillion: sprite list and image-generation prompts

Each entry has a **file name**, a **canvas size**, and a **prompt** you can paste into an image generator.

To keep everything consistent, put the matching **style block** (§0) in front of every prompt from that section.

The mechs are original interpretations of each frame's role and manufacturer. Don't ask the generator to copy Massif's official art.

---

## 0. Shared style blocks

### 0a. Units: mechs, NPCs, drones

> Isometric game sprite, orthographic camera looking down at about 35°, the classic isometric view. A single subject, centred, standing on an invisible ground plane at the bottom-centre of the canvas, full body in frame with a small margin. Transparent background with no ground, no shadow and no scenery. Gritty, grounded sci-fi mecha with readable chunky silhouettes, painted-metal materials with wear, chipped paint, grime and panel lines. Key light from the upper left and soft ambient fill. A thin dark outline for readability at small sizes. No text, logos, UI or watermark.

**Views.** Generate each unit twice:
- **"facing toward the viewer, three-quarter front view, turned to the lower-right"**
- **"facing away, three-quarter back view, turned to the upper-left"**

Mirror the two images horizontally to get all four isometric facings.

**Canvas size by unit size:**

| unit size | canvas |
|---|---|
| ½ and 1 | 256×256 |
| 2 | 512×512 |
| 3 | 768×768 |

**Team colours.** Player mechs use off-white and gunmetal with **cyan (#4FC3FF) accent lights and trim**. Enemies use their faction colour (given per unit) with **red-orange accent lights**.

### 0b. Terrain textures

> Top-down orthographic texture, seamless and tileable on all four edges, square, evenly lit with no strong directional shadows. Muted, desaturated colours for a dusty frontier colony world with a faint red tint. No objects that cross the tile edge. No text.

### 0c. Props and deployables

The same as 0a, at 256×256, single view (they don't rotate meaningfully).

### 0d. Effects

> Game VFX sprite on a pure black background (it will be additive-blended), bright emissive colours, soft glow, no outline, centred. Deliver as a horizontal sprite sheet with N frames of equal width.

### 0e. Icons

> Flat game UI icon, 128×128, a single bold white glyph with a 2px dark outline on a transparent background. Readable at 24px. Minimal detail, no text.

---

## 1. Player mech frames (29)

Use style block **0a**. Every player mech gets **cyan accent lights** plus the manufacturer look:

| manufacturer | look |
|---|---|
| **GMS** | utilitarian, mass-produced, boxy, olive-grey and off-white |
| **IPS-N** | heavy naval-industrial, thick plating, hazard stripes, navy and bone |
| **SSC** | sleek, elegant, lightweight, insect- and moth-inspired, ivory and gold |
| **HORUS** | unsettling, asymmetric, organic-glitch, black with sickly-green glow |
| **Harrison Armory** | imperial heavy, ornate brass trim, energy weapons, crimson and black |

| # | file | size | prompt |
|---|---|---|---|
| 1 | `mech_everest.png` | 1 | Balanced general-purpose humanoid mech, the workhorse frame. Squared shoulders, a simple visor head, a rifle in one hand and a heavy blade sheathed on the back. Clean olive-grey and off-white plating, a GMS utilitarian look, dependable and plain. |
| 2 | `mech_blackbeard.png` | 1 | Aggressive brawler mech, hunched forward. A thick chain-axe in one fist and a grappling harpoon launcher on the opposite forearm with coiled cable. An exposed glowing reactor vent on the chest. Navy-and-bone IPS-N plating with hazard stripes. |
| 3 | `mech_drake.png` | 2 | Massive walking fortress. Wide, low and heavy, with a huge rotary assault cannon on one arm and stacked armour slabs. Stabiliser feet like ship anchors. IPS-N naval steel, navy and bone, with rivets. |
| 4 | `mech_lancaster.png` | 2 | Large support mech, a mobile repair rig. Broad torso with cargo hard-points, a latch drone clamped to the shoulder, crane-like manipulator arms and welding tools. Insulated orange-and-navy IPS-N panels. |
| 5 | `mech_nelson.png` | 1 | Lean, fast cavalry mech in a charging stance. A long war-pike or lance, large thruster packs on the back and legs, swept-back head fins. IPS-N navy with bone stripes. |
| 6 | `mech_raleigh.png` | 1 | Gunslinger mech with a six-chamber revolver-cannon arm (a big drum magazine) and bandoliers of shells across the chest. Wide-brimmed head plating. IPS-N navy and brass. |
| 7 | `mech_tortuga.png` | 2 | Turtle-like sentinel mech. A domed armoured back shell, a long shotgun-cannon braced on its hip, and many sensor lenses. Squat and patient. IPS-N navy with green accents. |
| 8 | `mech_vlad.png` | 1 | Cruel melee mech covered in spikes and barbs. A stake-driver arm and shrike-thorn armour plates. Lean and predatory. Dark navy with rust-red highlights. |
| 9 | `mech_black_witch.png` | 1 | Slender electromagnetic controller mech with floating ferrous plates orbiting its shoulders and a magnetic field emitter in its palm. Ivory and gold SSC finish with an arcing blue glow. |
| 10 | `mech_deaths_head.png` | 1 | Tall sniper mech with an extremely long precision rifle, a skull-like sensor head with a cluster of lenses, and a stabilising tail-spike. Ivory, gold and black SSC styling. |
| 11 | `mech_dusk_wing.png` | ½ | Small, delicate hovering mech with moth-wing holographic cloak panels shimmering iridescent, plus a tiny pistol. Ivory and pearlescent violet. It floats above the ground. |
| 12 | `mech_metalmark.png` | 1 | Agile stealth mech with active-camouflage panels partly flickering transparent, a long rail-rifle, and a butterfly-wing sensor array. Ivory and gold SSC. |
| 13 | `mech_monarch.png` | 2 | Large artillery mech with banks of missile silos on its back and shoulders, missile hatches open, and stabiliser legs. Regal ivory, gold and royal-blue SSC finish. |
| 14 | `mech_mourning_cloak.png` | 1 | Assassin mech with a flowing tattered cloak of dark material, a long variable-sword, and a faceless head with a single slit. Black and ivory with gold edges, plus a slight blinkspace distortion around it. |
| 15 | `mech_swallowtail.png` | 1 | Scout mech with tall swallowtail-shaped sensor vanes, a light rifle and a lean build. Ivory with teal and gold accents. |
| 16 | `mech_balor.png` | 2 | Grotesque swarm mech whose hull is partly made of a writhing grey nanite cloud. A bulky silhouette with shifting particles. Black HORUS plating with sickly-green glow. |
| 17 | `mech_goblin.png` | ½ | Small, hunched hacker mech, almost gremlin-like, with oversized antenna arrays and a dripping-code green glow. Black and green HORUS. |
| 18 | `mech_gorgon.png` | 2 | Tall, menacing mech with a crown of serpent-like sensor stalks and a single hypnotic glowing eye. Imposing and still. Black and acid-green HORUS. |
| 19 | `mech_hydra.png` | 1 | Drone-carrier mech with four small serpentine drones docked on its back and shoulders, plus a multi-segment tail. Black HORUS with green running lights. |
| 20 | `mech_manticore.png` | 1 | Unstable reactor mech with a cracked chest crackling with lightning, slag-encrusted armour, and a lightning-generator spine. Black and molten orange. |
| 21 | `mech_minotaur.png` | 1 | Labyrinth hacker mech with horned head sensors and geometric maze patterns etched and glowing on its armour. Black and green HORUS. |
| 22 | `mech_pegasus.png` | 1 | Eerie artillery mech with an impossible, constantly-shifting floating gun (the "omnigun") hovering beside it, fragmenting at the edges. Black HORUS with white glitch artefacts. |
| 23 | `mech_barbarossa.png` | 3 | Colossal siege walker with an enormous spinal rail-cannon running the length of its body. Fortress-like, crimson and black Harrison Armory livery with brass trim. |
| 24 | `mech_genghis.png` | 1 | Flamethrower assault mech with fuel tanks on its back, a nozzle-arm and heat-vent fins. Scorched crimson and black Harrison Armory plating. |
| 25 | `mech_iskander.png` | 2 | Mine-layer mech with grenade launchers and mine dispensers on its shoulders and boxy ammunition racks. Crimson and black with brass. |
| 26 | `mech_napoleon.png` | ½ | Compact, squat shield mech with a glossy black aegis field partly enveloping it and stasis projectors. Crimson and black with brass. |
| 27 | `mech_saladin.png` | 2 | Tall defensive mech with a large hexagonal energy shield projector on one arm. Shimmering tachyon field, crimson and black. |
| 28 | `mech_sherman.png` | 1 | Heavy energy-artillery mech with a huge plasma-cannon arm with charge coils and glowing reactor vents. Crimson, black and brass Harrison Armory. |
| 29 | `mech_tokugawa.png` | 1 | Samurai-styled energy brawler with an overheating glowing plasma blade and a radiant exposed reactor. Crimson and black lacquer with brass. |

**Cockpit portrait (optional):** for any frame, a *"bust portrait of the mech's head and shoulders, three-quarter view, 512×512, dark gradient background"* for the hangar screen.

---

## 2. Enemy units

Use style block **0a**. These are all original factions; the hex code after each faction is its primary paint colour.

### Tier 1

**Scrapjaw Raiders (rusty welded junk, #B5473A)**

| file | size | prompt |
|---|---|---|
| `npc_scrapjaw_ripper.png` | 1 | Cheap, patched-together scavenger mech with a hydraulic meat-cleaver bolted to one arm and mismatched plates. Rust-red, held together with welds. Small and expendable. |
| `npc_scrapjaw_boss_rig.png` | 1 | Bigger scavenger boss mech with a riveter shotgun, a spiked chain flail and trophy scrap armour. Rust-red with yellow hazard paint. |
| `npc_scrapjaw_lobber.png` | 1 | Scavenger artillery mech with a crude junk mortar tube on its back and a pistol. Orange-rust. |
| `npc_scrapjaw_patcher.png` | 1 | Scavenger mechanic mech with welding torches, a smoke canister and a tool rack. Rust with green paint. |

**Vermillion Colonial Guard (militia red, #C0392B)**

| file | size | prompt |
|---|---|---|
| `npc_bulwark.png` | 2 | Riot mech with a huge tower shield and a shield-bash stance. Grey (#7F8C8D) with red insignia stripes. |
| `npc_guard_rifleman.png` | 1 | Disciplined militia mech with a service rifle and bayonet, upright soldierly posture. Red and grey. |
| `npc_signals_officer.png` | 1 | Comms mech with a big antenna mast, a jamming dish and a sidearm. Purple (#9B59B6) and grey. |
| `npc_warden_picket.png` | 1 | Light infantry walker with a rifle. Plain red, mass-produced. |
| `npc_red_warden.png` (**boss**) | 2 | Towering fortress walker with a rotary cannon arm and a seismic pile-driver ram. Deep crimson (#A61C1C) with ancient battle damage. |

**Corpro Security (#E67E22 / #C0392B / #8E44AD)**

| file | size | prompt |
|---|---|---|
| `npc_longshot.png` | 1 | Sleek corporate sniper mech with a gauss rifle and spotter optics. Orange and white. |
| `npc_hound.png` | 1 | Fast corporate hunter mech with a monoblade, SMG and pursuit thrusters. Red and white. |
| `npc_overseer.png` | 1 | Corporate tech mech with a hardlight barrier projector and neural-lash emitter. Purple and white. |

### Tier 2

**The Ash Choir (fire cult, ember and ash)**

| file | size | prompt |
|---|---|---|
| `npc_ash_cantor.png` | 1 | Robed cult mech swinging a smoking censer flail, with speaker-grilles like singing mouths. Purple (#A35BD1) and soot. |
| `npc_ember_zealot.png` | 1 | Fanatic mech with a glowing branding-lance, a flare pistol and flames licking its plating. Ember orange (#E0562B). |
| `npc_kiln_bulwark.png` | 2 | Furnace-bodied defender with a kiln-door chest glowing inside and a battering ram. Brown (#8A6D5A) and soot-black. |
| `npc_ash_thrall.png` | 1 | Emaciated, smouldering husk-mech with cinder claws. Charred brown-red. |
| `npc_furnace_saint.png` (**boss**) | 2 | Hovering cathedral-frame with a reactor halo, a plasma mortar and censer cannons. Burning orange (#FF7B29), radiating heat shimmer. |

**Gallowglass Company (professional mercenaries)**

| file | size | prompt |
|---|---|---|
| `npc_gallowglass_sergeant.png` | 1 | Veteran merc commander with a battle carbine, a shock baton and a command antenna. Red (#C0392B) with tactical-grey. |
| `npc_gallowglass_gunner.png` | 1 | Merc heavy gunner with a heavy machine gun, a frag launcher and a deployed bipod. Ochre (#D68910). |
| `npc_gallowglass_lance.png` | 1 | Merc line trooper with an assault rifle and combat knife. Brick red (#B03A2E). |

**Warden Strike Team (elite colonial guard)**

| file | size | prompt |
|---|---|---|
| `npc_warden_knight.png` | 1 | Duelist mech with a hardlight sabre, an arc pistol and phase thrusters. Bright red (#E74C3C) with silver. |
| `npc_warden_hexer.png` | 1 | Electronic-warfare mech with spiked sensor crown and needle pistol. Purple (#8E44AD). |
| `npc_warden_bastion.png` | 2 | Shield-bearer mech with a tower maul and an aegis field emitter. Grey (#7F8C8D) and red. |
| `npc_warden_trooper.png` | 1 | Basic soldier mech with a rifle. Red. |

### Tier 3

**Knights of the Black Tithe (militant order)**

| file | size | prompt |
|---|---|---|
| `npc_tithe_paladin.png` | 2 | Armoured knight-mech with a lance-hammer and storm bolter, consecrated plate engraved with scripture, and a banner on its back. Slate (#5D6D7E) and black. |
| `npc_tithe_templar.png` | 1 | Crusader mech with a penitent blade and flame spitter. Blood red (#922B21) and black. |
| `npc_tithe_inquisitor.png` | 1 | Hooded inquisitor mech with an incense-tech mast and a censure pistol. Dark purple (#6C3483). |
| `npc_tithe_serf.png` | 1 | Crude peasant levy walker with a long pike. Dark red (#7B241C). |

**Harrow Syndicate (cybernetic hunters)**

| file | size | prompt |
|---|---|---|
| `npc_harrow_netrunner.png` | 1 | Cyberpunk hacker mech with trailing data cables, a holographic shroud and a needle SMG. Purple (#9B59B6) neon. |
| `npc_harrow_reaver.png` | 1 | Feral close-combat mech with twin chainblades and a shotcannon on overclocked legs. Red (#C0392B) with black. |
| `npc_harrow_eye.png` | 1 | Sniper mech with a long railgun and a cyclopean scope head. Orange (#E67E22). |
| `npc_harrow_ganger.png` | 1 | Street-gang light walker with a shock carbine. Dark red. |

**Tessellate Swarm (crystalline xenofauna, not mechs)**

| file | size | prompt |
|---|---|---|
| `npc_tessellate_brood.png` | 1 | Insect-like alien predator with a body of faceted teal crystal plates and rending mandibles, low to the ground. Teal (#5FB3A1). |
| `npc_tessellate_spitter.png` | 1 | Crystalline alien with a swollen acid sac and dripping glowing-green spit. Teal (#3E9C7C). |
| `npc_tessellate_matriarch.png` | 2 | Huge crystalline alien queen with a crushing tail, spine volleys and chitin plates. Deep teal (#2A7F6F). |

**The Dream (final boss faction)**

| file | size | prompt |
|---|---|---|
| `npc_vermillion_engine.png` (**final boss**) | 2 | A walking reactor-cathedral with a siege cannon, a whip-like crimson energy lash and missile pods. Red glass windows glowing from within, dream-like haze. Deep vermillion (#B3122E). |
| `npc_engine_acolyte.png` | 1 | Support walker with healing hymn emitters and red-glass ward plates. Green (#27AE60) and crimson. |
| `npc_dreamer_husk.png` | 1 | Shambling half-organic, half-machine husk with grasping hands and a red glow in its eyes. Dark red (#8E2A2A). |

---

## 3. Drones, deployables and props

Use style block **0c**, 256×256, with a cyan accent for player-owned items.

| file | prompt |
|---|---|
| `dep_jericho_cover.png` | Folding hard-cover barrier section: a thick armoured wall panel on stubby legs, waist-high to a mech, with hazard stripes. |
| `dep_turret_drone.png` | Small turret drone clamped onto a surface, with a tiny rotating gun and a blinking sensor. |
| `dep_restock_drone.png` | Small hovering supply drone carrying an ammo crate. |
| `dep_aegis_generator.png` | Squat shield generator pylon projecting a faint dome. |
| `dep_portable_bunker.png` | Unfolded armoured bunker emplacement with firing slits. Large footprint; make it 512×512. |
| `dep_hive_drone.png` | Drone releasing a grey nanite swarm cloud. |
| `dep_sentinel_drone.png` | Floating sensor-sphere drone with a red scanning beam. |
| `dep_tempest_drone.png` | Large armoured drone crackling with lightning. |
| `dep_lotus_projector.png` | Petal-shaped holographic scout drone. |
| `dep_generic_drone.png` | Simple hovering quadcopter combat drone (fallback). |
| `prop_mine.png` | Flat disc-shaped proximity mine half-buried in dirt, with a blinking red light. |
| `prop_wreck_size1.png` | Smoking wreckage of a destroyed mech: twisted, burnt, collapsed. |
| `prop_wreck_size2.png` | A larger wreck, 512×512. |
| `prop_crate.png` | Stack of military supply crates. |
| `prop_barricade.png` | Sandbag and concrete barricade, waist-high. |

---

## 4. Terrain

Use style block **0b**: square, seamless, 512×512 top textures, plus optional 512×256 side-wall textures for blocks.

| file | prompt |
|---|---|
| `tile_ground_a.png` | Dusty reddish-brown packed earth with sparse dry grass tufts and small pebbles. |
| `tile_ground_b.png` | A variant of the ground with tyre and mech footprints and scattered gravel. |
| `tile_ground_colony.png` | Cracked concrete pavement with faded painted lines and drains. |
| `tile_forest.png` | Top-down canopy of hardy alien conifers and shrubs, dark green with red-tinged leaves. |
| `tile_rubble.png` | Broken concrete chunks, rebar and scattered debris (difficult terrain). |
| `tile_water.png` | Shallow murky water with ripples and a slick reflective surface. |
| `tile_hazard.png` | Glowing molten slag or leaking reactor coolant, orange-hot cracks with warning chevrons at the edges. |
| `tile_block_top.png` | Rooftop of an industrial building: vents, pipes and access hatches. |
| `wall_block_side.png` | Side wall of a prefab colony building: corrugated metal and concrete with a strip of lit amber windows near the top. Seamless horizontally, 512×256. |
| `tile_zone_control.png` | Semi-transparent painted capture-zone marking: a yellow chevron border. |
| `tile_zone_extract.png` | Semi-transparent green extraction landing-pad marking with an "H"-like pad symbol (a geometric shape, not text). |

**Backdrop (optional, 1920×1080):** A wide panorama of a dusty red frontier planet at dusk, a colony skyline and a huge rust-red gas giant on the horizon. Painterly, dark and moody. This one is not tileable.

---

## 5. Effects

Use style block **0d**.

| file | frames | prompt |
|---|---|---|
| `fx_muzzle_flash.png` | 4 | Bright yellow-white kinetic muzzle flash. |
| `fx_tracer.png` | 1 | Thin, elongated glowing orange tracer streak, 256×32. |
| `fx_energy_bolt.png` | 4 | Cyan-blue plasma bolt. |
| `fx_impact_kinetic.png` | 6 | Sparks and debris burst. |
| `fx_impact_energy.png` | 6 | Blue-white energy splash with arcs. |
| `fx_explosion.png` | 8 | Fiery orange explosion with black smoke, expanding then fading. |
| `fx_reactor_meltdown.png` | 10 | Huge white-hot reactor detonation with a shockwave ring. |
| `fx_burn.png` | 6 (loop) | Small flickering flames for burning units. |
| `fx_smoke_cloud.png` | 6 (loop) | Grey drifting smoke cloud (soft cover). |
| `fx_heat_shimmer.png` | 6 (loop) | Orange heat haze and venting steam (danger zone). |
| `fx_shield_bubble.png` | 6 (loop) | Translucent hexagonal energy dome. |
| `fx_overshield.png` | 6 (loop) | Thin glowing cyan barrier outline. |
| `fx_tech_hack.png` | 6 | Purple glitchy data-stream arcing to a target (invade). |
| `fx_lock_on.png` | 4 (loop) | Red targeting reticle rotating. |
| `fx_heal.png` | 6 | Green repair sparks and wrench-like nanite glow rising. |
| `fx_teleport.png` | 6 | Violet blink distortion implosion. |

---

## 6. UI icons

Use style block **0e**, 128×128.

**Statuses:**

| icon | glyph |
|---|---|
| `icon_impaired` | cracked crosshair |
| `icon_slowed` | snail / down-chevrons |
| `icon_immobilized` | chained boot |
| `icon_jammed` | broken radio waves |
| `icon_lockon` | crosshair with lock |
| `icon_shredded` | torn armour plate |
| `icon_stunned` | spiral stars |
| `icon_exposed` | open reactor with a heat flame |
| `icon_prone` | fallen figure |
| `icon_hidden` | closed eye |
| `icon_invisible` | dashed eye outline |
| `icon_engaged` | crossed swords |
| `icon_danger_zone` | thermometer in red |
| `icon_braced` | shield with brace lines |
| `icon_shutdown` | power symbol |
| `icon_burn` | flame |
| `icon_grappled` | grabbing hand |

**Actions:**

| icon | glyph |
|---|---|
| `icon_move` | footprints |
| `icon_boost` | thruster flame |
| `icon_skirmish` | single bullet |
| `icon_barrage` | double bullets |
| `icon_tech` | chip |
| `icon_invade` | chip with lightning |
| `icon_bolster` | chip with plus |
| `icon_scan` | radar sweep |
| `icon_overcharge` | lightning in a gear |
| `icon_stabilize` | snowflake and wrench |
| `icon_core` | glowing reactor core |
| `icon_hide` | bush |
| `icon_search` | magnifier |
| `icon_ram` | fist with impact lines |
| `icon_grapple` | hook |
| `icon_reload` | circular arrows with magazine |
| `icon_end_turn` | hourglass |
| `icon_auto_ai` | robot head |

**Damage types:**

| icon | glyph |
|---|---|
| `icon_kinetic` | bullet |
| `icon_explosive` | burst |
| `icon_energy` | lightning |
| `icon_heat` | thermometer |
| `icon_burn_dmg` | flame |

**Campaign map nodes (256×256, coloured instead of white):**

| icon | glyph and colour |
|---|---|
| `node_combat` | crossed blades, steel |
| `node_elite` | skull, red |
| `node_supply` | supply crate, amber |
| `node_rest` | tent and campfire, green |
| `node_boss` | crowned skull, crimson |

**Title logo (1024×512, transparent):** The words "DREAMS OF VERMILLION" in a bold, condensed, military-stencil sci-fi typeface. Vermillion red (#E8442E) with a subtle glow and a thin orange underline, and a faint mech silhouette behind it. (Image models often garble lettering; consider generating only the emblem and setting the text in a font.)

---

### Integration notes
- File names match what the renderer will look up. Unit sprites are keyed by frame id (`mech_<frame>`) or by the NPC unit name in snake_case (`npc_<name>`).
- Billboarded unit sprites replace the current box tokens. Pick the facing by camera rotation: front views for the two "toward camera" facings, back views for the other two, and mirror horizontally as needed.
- For new enemy teams made with the `generate-enemies` skill, add a line per unit: *"<role> mech/creature, <weapons>, <faction look>, <hex colour>"*, using style block 0a.
