# Dreams of Vermillion: UI design direction

## Context
The story documents (`game/src/data/story.ts`) build a strong world: Lance OCHRE, the Union tactical band, the MENHIT casket that "has seen this before, [REDACTED] times", FORECAST ITERATIONS, the Choir singing on open channels, and the solar eye. Outside the four interludes, though, the UI reads like a dev tool: "a LANCER tactics roguelike", "Campaign — Act 2", "SQUAD LOST", "Supplies". The world only appears between acts.

The goal is to carry that voice into every screen without hurting clarity or touching the rules engine. All changes are in `game/src/ui/*`, `style.css` and text data.

## Core idea: every run is one forecast iteration
The lore already supports this: MENHIT keeps re-running one forecast, its outcome is "red", and fragment 3 says "You came closer than the last [REDACTED] of you." So the roguelike loop becomes the fiction:
- A persistent **iteration counter** (localStorage, like `dov-story-unlocked` in `app.ts`) goes up on each new run.
- Losing a run is not "SQUAD LOST". It is **ITERATION n FAILED // OUTCOME: RED**, and the forecast restarts.
- Winning is the "FIRST CLEAN RUN ON RECORD" from the finale. The game already says this, and the counter makes it pay off.

## Proposals, in priority order

### Tier 1: framing (S–M each, biggest payoff)
1. **Failed-run readout** (it's already in the roadmap §5.5). Add a short `failed` document per act to `story.ts` and play it with `playInterlude` before `runOver()` on defeat. It's a casket log: `FORECAST ITERATION 0047 // TERMINATED`, how far the lance got, and the NHP's addendum. After that, `runOver` shows the iteration stamp and the run log titled as a "loss record".
2. **Title screen as a terminal boot.**
   - The tagline becomes `UNION TACTICAL BAND // LANCE OCHRE`, with the plain "a LANCER tactics roguelike" kept in small type.
   - Reuse `RA_EYE_SVG` (`ui/interlude.ts`) at about 4% opacity behind the title, with a slow breathing pulse. It's static under `prefers-reduced-motion`.
   - Add the line `FORECAST ITERATION 0047`, which only appears once the counter is above 0.
   - Menu labels get in-universe captions under the plain ones. For example, "Continue run" has the caption "resume operation · Act 2". Clarity stays first.
3. **Act-tinted UI palette.** Set `data-act="1|2|3"` on `#app` and give each act its own `--accent`/`--panel`/background gradient to match the map themes in `run/mapgen.ts` and `render/scene.ts`:
   - Act 1: dusk ochre.
   - Act 2: sodium amber with a slightly green-black panel.
   - Act 3: cleanroom white panels with arterial red accents and regolith dust.

   The whole HUD then shifts as the lance goes deeper. This is CSS only, plus one attribute set in `App.runMap`/`startBattle`.

### Tier 2: the campaign map as an ops board (M)
4. **Header and location names.** Use `OPERATION [REDACTED] // PHASE 2 — CINNABAR ANNEX, INDUSTRIAL PARK`. Acts not reached yet show `[REDACTED]` (using the existing `.redact` style) instead of their tier label, so you can't see what's ahead in the story.
5. **Live casket telemetry panel.** This is the recurring `>> CASKET TELEMETRY` block from the documents, made live and driven by run state:
   - `CYCLE STATUS: OVERDUE // hh:mm:ss`, which grows with each node cleared.
   - `COMBAT SIM CONDITIONING`: HOLDING, then DEGRADED, then FAILING, by act.
   - `SELF-DESIGNATION`: in act 3 it glitches between `MENHIT // H█████`, as in the act 2 intercept.

   It's purely cosmetic, a small fixed panel with a typed-in style, and it gives the map a ticking pressure that matches the story.
6. **Squad cards as personnel dossiers.**
   - Designations `OCHRE-1…4`.
   - A status stamp: OPERATIONAL, DAMAGED or `DESTROYED — REPRINT PENDING`.
   - The current stats stay underneath.
7. **Node hover briefs** (this ties into roadmap §3.4). Each tooltip gives a one-line in-universe sitrep, such as "HOLDOUT — Choir reinforcements inbound. Hold 8 rounds.", in place of the bare "combat · holdout".

### Tier 3: battle presence (M)
8. **Pre-battle sitrep card.** A 2–3 s console overlay before the first player turn: location, hostile designation (team `faction` and `theme` already exist in `data/enemies/*.json`) and the objective. Any key dismisses it. It reuses the interlude typing at a faster speed. For the finale, the card is `CASKET VAULT` with one eye flash.
9. **Open-channel chatter.** A UI-only "COMMS" line type in the log panel, styled in italic amber and kept apart from the rules log (no changes to `Battle.log`). It fires on these events:
   - round start
   - the first enemy kill
   - a lancer taking structure damage
   - a boss activating

   Lines come from a new `CHATTER` table in `story.ts`, keyed by faction: Choir hymn fragments, merc radio and Annex security klaxons. Line choice is seeded from the battle seed, so it's deterministic.
10. **Topbar as the tactical band.** Prefix it with `UNION TAC BAND //`, and replace the end states "VICTORY/DEFEAT" with `ENGAGEMENT CLOSED` and `SIGNAL LOST`. Rules text in the description line stays plain.

### Tier 4: between battles (S each)
11. **In-universe event tags.**
    - Find becomes `SALVAGE`, Gamble becomes `RISK ASSESSMENT`, Hard choice becomes `UNSANCTIONED`.
    - "Supplies" becomes `REQUISITION`, "Field repairs" becomes `FIELD MAINTENANCE LOG`, and "Rest" becomes `STAND-DOWN`.
    - The `voice_static` event gets a glitch treatment: a scanline overlay, one eye flash, and text that types out.
12. **Transmissions archive as a document locker.** File numbers, an unread marker on newly unlocked documents, and failed-iteration logs collected as they're earned (so a loss leaves you with something).
13. **Help renamed "Field manual"**, with the same content.

### Cross-cutting: NHP bleed, which gets stronger over time
Rare, subtle signal artifacts whose frequency scales with act and iteration count:
- a one-frame eye flash at the start of an act 3 battle
- a `[REDACTED]` block flickering over a UI label for about 100 ms
- the telemetry name glitch

Reusing the `flash()` logic from `interlude.ts` (moved into a small shared `ui/signal.ts`) keeps the cap of at most N per screen. All of it is off under `prefers-reduced-motion`, and a **"Signal artifacts" toggle** goes into the Settings screen from roadmap §3.6.

## Status
- **Done:** Tier 1 (items 1–3) and Tier 2 (items 4–7). The code is in `ui/forecast.ts`, `ui/app.ts` (`title`, `runMap`, `runOver`, `setAct`) and the act-palette section of `ui/style.css`.
- **Next:** Tiers 3–4, then NHP bleed.
- **New text:** All new in-universe text is in `data/story.ts`, below the `DRAFT — owner to rewrite` marker. It was drafted in the documents' voice and is waiting for the owner's pass.

## Guardrails
- Plain-language labels stay visible everywhere. In-universe text is a caption or tone, never the only description of a control.
- The rules engine, saves and tests are unchanged. The only new persisted keys are `dov-iterations` and `dov-story-read`.
- **Story text is the owner's** (`story.ts` header: "Written by the project owner"). Every new line (failed readouts, chatter, telemetry, briefs) goes in `story.ts` as a marked draft for the owner to rewrite.

## Critical files
- `game/src/ui/app.ts`: title, runMap, runOver, eventScreen, rewardPick, repairs, archive, help
- `game/src/ui/battle-ui.ts`: `render()` topbar, log panel, battle start/end
- `game/src/ui/interlude.ts`: reuse `RA_EYE_SVG`, the typing and `flash()`; extract shared signal helpers into `ui/signal.ts` (Tier 3+)
- `game/src/ui/forecast.ts`: iteration counter and casket telemetry (done)
- `game/src/ui/style.css`: act palettes, dossier, telemetry, comms and sitrep-card styles
- `game/src/data/story.ts`: `failed` readouts, `CHATTER`, `TELEMETRY` and `BRIEFS` tables

## Verification
- `cd game && npm run typecheck && npm test`: no rules regressions.
- `npm run e2e`: the campaign still completes, and the GPU-leak check passes (the sitrep card and chatter must dispose cleanly).
- Run the `run` skill or `npm run dev` with Playwright screenshots of: the title (iteration 0 and >0), the act 1, 2 and 3 campaign maps (palette, telemetry, redacted acts), a battle start card, comms lines in the log, the defeat readout, and the archive.
- Check `prefers-reduced-motion` (Playwright `reducedMotion: 'reduce'`): no flashes or flicker.
