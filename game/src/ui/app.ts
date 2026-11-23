// Screen flow: Title → Hangar (import COMP/CON pilots, pick squad) → Run map → Battle →
// Debrief (repairs / rewards) → … → Victory or defeat.
import { Lancer } from '../data/lancer'
import type { PilotBuild } from '../import/compcon'
import { Battle } from '../rules/battle'
import { buildMechUnit, mechSP } from '../rules/stats'
import { scriptIdsFor, getScript } from '../rules/effects/registry'
import { buildTeam } from '../enemies/build'
import { catalog, teamsFor, validTeams } from '../enemies/catalog'
import { generateMap, themeForAct } from '../run/mapgen'
import {
  type RunState, type RunNode, newRun, availableNodes, nodeTier, sitrepFor, squadUnits, recordBattle, fullRepair,
  repairOptions, applyRepair, permHpBonus, rollRewards, applyReward, levelUp, replacePilots, refitPilot, chooseTeam, saveRun, loadRun, ACTS, actLevel, lastLoadProblem,
} from '../run/run'
// the battle screen (and Three.js) load on demand: the title, hangar and campaign map don't need them
import type { BattleScreen, UndoEntry } from './battle-ui'
import { exportBattle, replayBattle, withoutLastAction } from '../replay/replay'
import { saveBattle, loadBattle, clearBattle } from '../run/battle-save'
import { rangeChip, tagChip } from './tags'
import type { Weapon } from '../rules/types'
import { featureAutomated, loadPacks, readLcp, removePack, storePack, officialClasses } from '../import/lcp'
import { generateOfficialTeam } from '../enemies/official'
import { Rng } from '../rules/rng'
import { STORY, STORY_ORDER, type StoryId, ACT_LOCATIONS, NODE_BRIEFS, failedReadout } from '../data/story'
import { iterationCount, iterLabel, nextIteration, telemetryPanel } from './forecast'
import { rollEvent, type RunEvent } from '../run/events'
import { playInterlude, RA_EYE_SVG } from './interlude'
import { loadRoster, addToRoster, saveRoster, pregenBuilds, readFiles, sampleSquad, squadPresets } from './roster'
import { esc } from './dom'
import { alertDialog, confirmDialog, toast } from './modal'
import { settingsForm, bindSettings } from './settings'
import { builderScreen } from './builder-screen'
import { portraitSlot, fillPortraits } from './portrait-slots'
import { fitToLevel, readyProblems } from './builder'
import { validateBuild } from '../rules/legality'
import { classify } from '../rules/effects/coverage'

const MAX_SQUAD = 4

/** The hangar's squad picker: themed squads per act level, plus the COMP/CON pregens and the sample squads. */
function squadOptions(): string {
  const presets = squadPresets()
  const group = (level: number, act: number, extra: string) => `<optgroup label="LL${level} — act ${act}">${presets.filter(s => s.level === level).map(s => `<option value="${esc(s.id)}">${esc(s.name)} (LL${level}) — ${esc(s.pilots.map(p => p.callsign).join(', '))}</option>`).join('')}${extra}</optgroup>`
  return `<option value="">Add a pre-built squad…</option>${group(0, 1, '<option value="pregens">COMP/CON pregens (LL0)</option>')}${group(5, 2, '<option value="ll5">Sample squad (LL5) — Drake, Monarch, Saladin, Blackbeard</option>')}${group(10, 3, '<option value="ll10">Sample squad (LL10) — Drake, Monarch, Saladin, Blackbeard</option>')}`
}
function squadPilots(id: string): PilotBuild[] {
  if (id === 'pregens') return pregenBuilds()
  if (id === 'll5' || id === 'll10') return sampleSquad(id === 'll5' ? 5 : 10)
  return squadPresets().find(s => s.id === id)?.pilots ?? []
}

export class App {
  root: HTMLElement
  roster: PilotBuild[] = loadRoster()
  run: RunState | null = loadRun()
  battle: BattleScreen | null = null
  squadPick = new Set<string>()
  /** Run-only copies of the chosen pilots while they're fitted to the act 1 level, before the run starts. */
  prep: PilotBuild[] | null = null
  /** Original License Level of each prep pilot that was fitted to the act 1 level (by id). */
  prepFrom = new Map<string, number>()

  constructor(root: HTMLElement) {
    this.root = root
    if (!this.roster.length) this.roster = addToRoster([], pregenBuilds().slice(0, 4))
    this.title()
  }

  private disposeInterlude: (() => void) | null = null

  /** Teardown hooks for the current screen (observers, listeners). */
  private cleanups: (() => void)[] = []

  private clear() {
    for (const f of this.cleanups.splice(0)) f()
    this.disposeInterlude?.()
    this.disposeInterlude = null
    this.battle?.dispose()
    this.battle = null
    this.root.innerHTML = ''
  }

  // ------------------------------------------------------------------ title
  title() {
    this.clear()
    this.setAct(null)
    const bad = catalog.filter(c => c.errors.length)
    const iter = iterationCount()
    const live = this.run && !this.run.over
    const item = (go: string, label: string, caption: string, cls = '') =>
      `<button data-go="${go}" class="${cls}"><span class="ml">${label}</span><span class="mc">${caption}</span></button>`
    this.root.innerHTML = `<div class="screen title">
      <div class="title-eye" aria-hidden="true">${RA_EYE_SVG}</div>
      <p class="band">UNION TACTICAL BAND // LANCE OCHRE</p>
      <h1>DREAMS OF VERMILLION</h1><p class="sub">a LANCER tactics roguelike</p>
      ${iter ? `<p class="iter">FORECAST ITERATION ${iterLabel(iter)}${live ? ' // IN PROGRESS' : ''}</p>` : ''}
      <div class="menu">
        ${live ? item('continue', `Continue run (Act ${this.run!.act}, ${this.run!.battlesWon} wins)`, `resume operation · ${esc(ACT_LOCATIONS[this.run!.act] ?? '')}`, 'primary') : ''}
        ${item('hangar', 'New run — choose squad', iter ? 'reseed the forecast' : 'answer the priority flash', live ? '' : 'primary')}
        ${item('skirmish', 'Quick skirmish', 'simulated engagement')}
        ${item('official', 'Official NPCs (import .lcp)', 'hostile pattern library')}
        ${unlockedStories().length ? item('archive', 'Transmissions', 'recovered documents') : ''}
        ${item('settings', 'Settings', 'speed · graphics · motion · colour')}
        ${item('help', 'How to play', 'field manual')}
      </div>
      ${lastLoadProblem ? `<p class="bad small">${esc(lastLoadProblem)}</p>` : ''}
      <p class="muted small">${validTeams().length} enemy teams loaded${bad.length ? ` · <span class="bad">${bad.length} invalid team file(s): ${bad.map(b => esc(b.file)).join(', ')}</span>` : ''} · lancer-data ${esc('4.0.12')}</p>
      <p class="muted small">Unofficial, non-commercial fan project, not affiliated with Massif Press. LANCER is © Massif Press; COMP/CON and lancer-data are GPL-3.0.</p>
    </div>`
    this.on('[data-go]', el => {
      const g = el.dataset.go
      if (g === 'continue') {
          // a battle was in progress: go straight back into it
          const saved = loadBattle()
          const node = saved && this.run && saved.runSeed === this.run.seed ? this.run.nodes.find(n => n.id === saved.nodeId && !n.cleared) : undefined
          if (node) this.startBattle(node)
          else this.runMap()
        }
      if (g === 'hangar') this.hangar('run')
      if (g === 'skirmish') this.hangar('skirmish')
      if (g === 'help') this.help()
      if (g === 'settings') this.settings()
      if (g === 'official') this.officialNpcs()
      if (g === 'archive') this.archive()
    })
  }

  // ------------------------------------------------------------------ official NPCs (LCP import)
  officialNpcs(msg = '') {
    this.clear()
    const packs = loadPacks()
    const mode = officialMode()
    const rows = packs.map(p => {
      const feats = p.classes.flatMap(c => c.features)
      return `<tr><td><b>${esc(p.name)}</b> <span class="muted">v${esc(p.version)}</span></td><td>${p.classes.length} classes</td><td>${feats.filter(featureAutomated).length}/${feats.length} features fully automated</td><td><button data-rm="${esc(p.name)}" class="warn">Remove</button></td></tr>`
    }).join('')
    this.root.innerHTML = `<div class="screen"><h2>Official NPCs</h2>
      <p>Import the official NPC classes from a LANCER content pack (<code>.lcp</code>) you own, such as <i>Lancer CORE NPCs</i>. The pack stays in <b>this browser only</b> (local storage); nothing is uploaded or added to the game files.</p>
      <p class="muted small">Weapons, stats, tags, flight, resistances and Blast/Burst save attacks are automated. Other rules text (most reactions and conditional traits) is shown in the unit panel but not enforced. Templates use the game's own implementation of the official Grunt, Veteran, Elite, Commander, Ultra and Mercenary rules.</p>
      ${msg ? `<p class="${msg.startsWith('✓') ? '' : 'bad'}">${esc(msg)}</p>` : ''}
      <label class="filebtn">Import .lcp<input type="file" accept=".lcp,.zip" multiple></label>
      ${packs.length ? `<table class="packs">${rows}</table>` : '<p class="muted">No packs imported.</p>'}
      <h3>Use in campaigns</h3>
      <div class="menu row">${(['off', 'mixed', 'only'] as const).map(m => `<button data-mode="${m}" class="${m === mode ? 'primary' : ''}">${{ off: 'Off: hand-made teams only', mixed: 'Mixed: half the fights', only: 'Only official NPCs' }[m]}</button>`).join('')}</div>
      <button data-go="back">Back</button></div>`
    this.on('[data-go]', () => this.title())
    this.on('[data-mode]', el => { setOfficialMode(el.dataset.mode as any); this.officialNpcs() })
    this.on('[data-rm]', el => { void confirmDialog(`Remove ${el.dataset.rm}?`, 'Its NPC classes stop appearing in encounters. You can import the pack again later.', { ok: 'Remove', danger: true }).then(ok => { if (ok) { removePack(el.dataset.rm!); this.officialNpcs('✓ Removed.') } }) })
    this.root.querySelector<HTMLInputElement>('input[type=file]')!.addEventListener('change', async e => {
      const files = [...((e.target as HTMLInputElement).files ?? [])]
      const out: string[] = []
      for (const f of files) {
        try {
          const pack = readLcp(new Uint8Array(await f.arrayBuffer()))
          out.push(storePack(pack) ? `✓ ${pack.name} v${pack.version}: ${pack.classes.length} classes.` : `${f.name}: the browser refused to store it (storage full or disabled).`)
        } catch (err) { out.push(`${f.name}: ${(err as Error).message}`) }
      }
      if (out.length && officialMode() === 'off' && loadPacks().length) setOfficialMode('mixed')
      this.officialNpcs(out.join(' '))
    })
  }

  settings() {
    this.clear()
    this.setAct(null)
    this.root.innerHTML = `<div class="screen center settings-screen"><h2>Settings</h2><p class="muted">Saved in this browser. They also open from the ⚙ button during battle.</p>${settingsForm()}<button data-go="back" class="primary">Back</button></div>`
    bindSettings(this.root)
    this.on('[data-go]', () => this.title())
  }

  help() {
    this.clear()
    this.root.innerHTML = `<div class="screen help"><h2>How to play</h2>
      <ol>
        <li><b>Build lancers in COMP/CON.</b> Use the <a href="https://compcon.app" target="_blank" rel="noopener noreferrer">COMP/CON web app</a> (or run it locally from <code>vendor/compcon</code>). In the pilot roster, open a pilot → <i>Export</i> → <i>Save as file (.json)</i>.</li>
        <li><b>Import them in the Hangar</b> (drag-and-drop or the file picker). The COMP/CON pregens are available too.</li>
        <li><b>Pick up to ${MAX_SQUAD} pilots</b> and start a run. Each act's boss raises your License Level; re-import updated builds between acts.</li>
      </ol>
      <h3>Battle controls</h3>
      <ul>
        <li>On your side's turn, pick any ready lancer and <b>Activate</b> it (initiative alternates between sides, as in LANCER).</li>
        <li>Click blue tiles to move (moves can be split). <b>Skirmish</b>/<b>Barrage</b> on a weapon card, then click a target; hover for hit chance, cover and accuracy breakdown.</li>
        <li>Tech, systems, core powers, stabilize, overcharge, ram/grapple, hide/search… are on the action bar. <b>Enter</b> ends the turn, <b>Ctrl+Z</b> undoes a move that revealed nothing, <b>Esc</b> cancels, <b>Tab</b> cycles lancers.</li>
        <li>Camera: <b>Q/E</b> rotate, <b>WASD</b>/right-drag pan, wheel zoom.</li>
        <li>Brace and Overwatch are reactions. Each mech has a policy per reaction: <b>auto</b> (decided for you), <b>ask</b> (you're prompted when it matters) or <b>off</b>.</li>
        <li>Actions marked * are text-only: their rules are logged for you to resolve by hand (see the coverage report).</li>
      </ul>
      <button data-go="back" class="primary">Back</button></div>`
    this.on('[data-go]', () => this.title())
  }

  // ------------------------------------------------------------------ hangar
  hangar(purpose: 'run' | 'skirmish' | 'reimport') {
    this.clear()
    this.setAct(purpose === 'reimport' ? this.run?.act ?? null : null)
    if (!this.squadPick.size) this.roster.slice(0, MAX_SQUAD).forEach(p => this.squadPick.add(p.id))
    const cards = this.roster.map(p => pilotCard(p, this.squadPick.has(p.id))).join('')
    this.root.innerHTML = `<div class="screen hangar">
      <div class="hhead"><h2>${purpose === 'reimport' ? 'Re-import updated pilots' : 'Hangar'}</h2>
        <div><button data-go="new" title="Build a pilot and mech here, without COMP/CON">New pilot</button><a class="filebtn linkbtn" href="https://compcon.app" target="_blank" rel="noopener noreferrer" title="Opens the official COMP/CON web app in a new tab">Open COMP/CON ↗</a><label class="filebtn">Import COMP/CON .json<input type="file" accept=".json,application/json" multiple></label>
        <select data-squadsel title="Adds a ready-made squad to the roster and picks it">${squadOptions()}</select>
        ${purpose !== 'reimport' ? `<button data-go="start" class="primary">${purpose === 'run' ? 'Begin run' : 'Choose enemies'} (${this.squadPick.size}/${MAX_SQUAD})</button>` : '<button data-go="done" class="primary">Done</button>'}
        <button data-go="back">Back</button></div></div>
      <div class="drop">Drop COMP/CON pilot exports here</div>
      <p class="muted small">Build pilots here with <i>New pilot</i> or <i>Edit</i>, or in COMP/CON: open the pilot → <i>Export</i> → <i>Save as file (.json)</i>, and drop the file here.</p>
      <div class="errors"></div>
      <div class="pilots">${cards || '<p class="muted">No pilots yet.</p>'}</div></div>`
    void fillPortraits(this.root)
    const input = this.root.querySelector('input[type=file]') as HTMLInputElement
    const doImport = async (files: FileList | File[]) => {
      const { builds, errors } = await readFiles(files)
      let note = ''
      if (purpose === 'reimport' && this.run) {
        const r = replacePilots(this.run, builds)
        saveRun(this.run)
        const parts = [
          r.replaced.length ? `Updated: ${r.replaced.join(', ')}` : '',
          r.byCallsign.length ? `Matched by callsign: ${r.byCallsign.join(', ')}` : '',
          r.ambiguous.length ? `Not updated (several squad pilots share the callsign): ${r.ambiguous.join(', ')}` : '',
          r.unmatched.length ? `Not in this run's squad: ${r.unmatched.join(', ')}` : '',
        ].filter(Boolean)
        note = parts.join(' · ')
      }
      this.roster = addToRoster(this.roster, builds)
      builds.forEach(b => this.squadPick.size < MAX_SQUAD && this.squadPick.add(b.id))
      this.hangar(purpose)
      const box = this.root.querySelector('.errors') as HTMLElement
      box.innerHTML = (note ? `<div class="muted">${esc(note)}</div>` : '') + errors.map(e => `<div class="bad">${esc(e)}</div>`).join('')
    }
    input.addEventListener('change', () => input.files && doImport(input.files))
    const drop = this.root.querySelector('.screen') as HTMLElement
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragging') })
    drop.addEventListener('dragleave', () => drop.classList.remove('dragging'))
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragging'); if (e.dataTransfer?.files) void doImport(e.dataTransfer.files) })
    this.on('[data-pick]', el => {
      const id = el.dataset.pick!
      if (this.squadPick.has(id)) this.squadPick.delete(id)
      else if (this.squadPick.size < MAX_SQUAD) this.squadPick.add(id)
      this.hangar(purpose)
    })
    this.on('[data-edit]', el => {
      const orig = this.roster.find(p => p.id === el.dataset.edit)
      if (orig) this.openBuilder(orig, `Edit ${orig.callsign}`, () => this.hangar(purpose), p => {
        // during a run, editing a squad pilot from here refits it like a re-import does
        if (purpose === 'reimport' && this.run) { refitPilot(this.run, p); saveRun(this.run) }
      })
    })
    const sel = this.root.querySelector('[data-squadsel]') as HTMLSelectElement | null
    sel?.addEventListener('change', () => {
      const pilots = squadPilots(sel.value)
      if (!pilots.length) return
      // mid-run, a pre-built squad updates the run's pilots with the same callsigns, like a COMP/CON re-import
      if (purpose === 'reimport' && this.run) { replacePilots(this.run, pilots); saveRun(this.run) }
      this.roster = addToRoster(this.roster, pilots)
      this.squadPick = new Set(pilots.slice(0, MAX_SQUAD).map(p => p.id))
      this.hangar(purpose)
    })
    this.on('[data-remove]', el => {
      // removal is instant, with an Undo toast (no confirmation step)
      const id = el.dataset.remove!
      const index = this.roster.findIndex(p => p.id === id)
      const removed = this.roster[index]
      const wasPicked = this.squadPick.has(id)
      this.roster = this.roster.filter(p => p.id !== id)
      this.squadPick.delete(id)
      saveRoster(this.roster)
      this.hangar(purpose)
      if (removed) toast(`Removed ${removed.callsign} from the Hangar.`, {
        label: 'Undo',
        run: () => {
          if (this.roster.some(p => p.id === id)) return
          this.roster = [...this.roster.slice(0, index), removed, ...this.roster.slice(index)]
          if (wasPicked && this.squadPick.size < MAX_SQUAD) this.squadPick.add(id)
          saveRoster(this.roster)
          if (this.root.querySelector('.screen.hangar')) this.hangar(purpose)
        },
      })
    })
    this.on('[data-go]', el => {
      const g = el.dataset.go
      if (g === 'back') this.title()
      if (g === 'done') this.runMap()
      if (g === 'new') this.openBuilder(undefined, 'New pilot', () => this.hangar(purpose), p => { if (this.squadPick.size < MAX_SQUAD) this.squadPick.add(p.id) })
      if (g === 'start') {
        const squad = this.roster.filter(p => this.squadPick.has(p.id))
        if (!squad.length) return void alertDialog('No pilots in the squad', 'Add at least one pilot to the squad first.')
        if (purpose === 'run') this.prepareRun(squad)
        else this.skirmishSetup(squad)
      }
    })
  }

  /** Open the in-game builder; the saved pilot goes into the roster, then `after` runs and we go `back`. */
  openBuilder(build: PilotBuild | undefined, title: string, back: () => void, after?: (p: PilotBuild) => void, lockLevel = false) {
    this.clear()
    builderScreen(this.root, {
      build, title, lockLevel, onCancel: back,
      onSave: p => { this.roster = addToRoster(this.roster, [p]); after?.(p); back() },
    })
  }

  skirmishSetup(squad: PilotBuild[]) {
    this.clear()
    const official = officialClasses()
    const offTeams = official.length ? ([1, 2, 3] as const).flatMap(tier => (['standard', 'elite', 'boss'] as const).map(kind => generateOfficialTeam(official, tier, kind, squad.length, Math.floor(Math.random() * 1e6)))) : []
    const teams = [...validTeams(), ...offTeams]
    this.root.innerHTML = `<div class="screen"><h2>Quick skirmish</h2><p class="muted">Choose an enemy team (from <code>data/enemies/</code>${offTeams.length ? ', plus random encounters from your imported official NPCs' : ''}).</p>
      <div class="teams">${teams.map(t => `<button data-team="${esc(t.id)}"><b>${esc(t.name)}</b><br><span class="muted">T${t.tier} ${esc(t.kind ?? 'standard')} · ${t.units.reduce((a, u) => a + (u.count ?? 1), 0)} units</span><br><span class="small">${esc(t.theme ?? '')}</span></button>`).join('')}</div>
      <button data-go="back">Back</button></div>`
    this.on('[data-go]', () => this.hangar('skirmish'))
    this.on('[data-team]', el => {
      const team = teams.find(t => t.id === el.dataset.team)!
      const seed = Math.floor(Math.random() * 1e6)
      const map = generateMap(seed, { theme: themeForAct(team.tier) })
      const units = squad.map(p => buildMechUnit(p))
      const enemies = buildTeam(team, units.length)
      units.forEach((u, i) => (u.pos = map.deployPlayer[i]))
      enemies.forEach((u, i) => (u.pos = map.deployEnemy[i % map.deployEnemy.length]))
      const b = new Battle({ map, units: [...units, ...enemies], seed, sitrep: { id: team.sitrep === 'control' ? 'control' : 'standard', name: team.sitrep === 'control' ? 'Control' : 'Basic Combat', rounds: 3, zone: map.zones?.find(z => z.name === 'control')?.tiles, description: team.sitrep === 'control' ? 'Hold the zone for 3 rounds or destroy all hostiles.' : 'Destroy all hostile forces.' } })
      b.start()
      this.clear()
      this.setAct(team.tier)
      this.mountBattle(b, { title: team.name, onEnd: w => this.simpleEnd(w) })
    })
  }

  simpleEnd(w: 'player' | 'enemy') {
    this.clear()
    this.root.innerHTML = `<div class="screen center"><h1 class="${w}">${w === 'player' ? 'VICTORY' : 'DEFEAT'}</h1><button data-go="t" class="primary">Title</button></div>`
    this.on('[data-go]', () => this.title())
  }

  // ------------------------------------------------------------------ run map
  runMap() {
    const run = this.run
    if (!run) return this.title()
    if (run.over) return this.runOver()
    if (run.pendingLevelUp) {
      const done = `act${run.act - 1}` as StoryId
      return STORY[done] ? this.story(done, () => this.levelUpScreen()) : this.levelUpScreen()
    }
    if (run.squad.some(p => readyProblems(p, actLevel(run.act)).length)) return this.levelUpScreen()
    this.clear()
    this.setAct(run.act)
    const avail = new Set(availableNodes(run).map(n => n.id))
    const icon: Record<string, string> = { combat: '⚔', elite: '☠', rest: '⛺', supply: '⬢', boss: '♛' }
    const brief = (n: RunNode) => {
      if (n.kind === 'boss') return n.act === ACTS ? NODE_BRIEFS.finale : NODE_BRIEFS.boss
      if (n.kind === 'combat' || n.kind === 'elite') return `${NODE_BRIEFS[n.sitrep ?? 'standard'] ?? NODE_BRIEFS.standard}${n.kind === 'elite' ? ' ' + NODE_BRIEFS.elite : ''}`
      return NODE_BRIEFS[n.kind] ?? n.kind
    }
    const acts = [1, 2, 3].map(act => {
      const layers = [...new Set(run.nodes.filter(n => n.act === act).map(n => n.layer))]
      const ahead = act > run.act
      const head = ahead
        ? `Phase ${act} · <span class="redact" title="Not yet reached">██████ ████</span>`
        : `Phase ${act} · ${esc(ACT_LOCATIONS[act] ?? '')} <span class="muted small">(Act ${act} · Tier ${act})</span>`
      return `<div class="act ${act === run.act ? 'current' : ''} ${ahead ? 'ahead' : ''}"><h3>${head}</h3><div class="layers">${layers.map(l => `<div class="layer">${run.nodes.filter(n => n.act === act && n.layer === l).map(n => `<button class="node ${n.kind} ${n.cleared ? 'cleared' : ''} ${avail.has(n.id) ? 'avail' : ''} ${run.current === n.id ? 'here' : ''}" data-node="${n.id}" aria-disabled="${!avail.has(n.id)}" aria-label="${esc(ahead ? `${n.kind}, not yet reached` : `${n.kind}: ${brief(n)}`)}">${icon[n.kind]}</button>`).join('')}</div>`).join('<div class="arrow">›</div>')}</div></div>`
    }).join('')
    const squad = run.squad.map((p, i) => {
      const c = run.condition[p.id]
      const u = buildMechUnit(p)
      const unspent = validateBuild(p).warnings.some(w => /unspent|unchosen/.test(w))
      const damaged = !c.destroyed && (c.hp < u.stats.hp || c.structure < u.stats.structure || c.stress < u.stats.stress)
      const stamp = c.destroyed ? '<span class="stamp bad">DESTROYED — REPRINT PENDING</span>' : damaged ? '<span class="stamp warnc">DAMAGED</span>' : '<span class="stamp good">OPERATIONAL</span>'
      return `<div class="sq dossier ${c.destroyed ? 'dead' : ''}">${portraitSlot(u, 'portrait sm')}<div class="dh"><span class="desig">OCHRE-${i + 1}</span>${stamp}</div><b>${esc(p.callsign)}</b> <span class="muted">LL${p.level} ${esc(Lancer.frames.get(p.mech.frameId)?.name ?? '')}</span> <button class="small ${unspent ? 'primary' : ''}" data-refit="${esc(p.id)}" title="Spend points and change the loadout. Damage and spent Repairs carry over.">${unspent ? 'Level up' : 'Edit build'}</button><br>${c.destroyed ? '<span class="muted">Reprinted at the next rest.</span>' : `HP ${c.hp + permHpBonus(run, p.id)}/${u.stats.hp + permHpBonus(run, p.id)} · S ${c.structure}/${u.stats.structure} · R ${c.stress}/${u.stats.stress} · Repairs ${c.repairs}${c.coreAvailable ? ' · CORE ready' : ''}`}</div>`
    }).join('')
    this.root.innerHTML = `<div class="screen runmap"><div class="hhead"><div><p class="band">OPERATION <span class="redact">████████</span> // PHASE ${run.act} OF 3${run.iteration ? ` // ITERATION ${iterLabel(run.iteration)}` : ''}</p><h2>Campaign — Act ${run.act} <span class="loc">${esc(ACT_LOCATIONS[run.act] ?? '')}</span></h2></div><div><button data-go="repairs">Field repairs</button><button data-go="reimport">Re-import pilots</button><button data-go="abandon" class="warn">Abandon run</button><button data-go="title">Title</button></div></div>
      <div class="opsboard"><div class="opsmain"><div class="squad">${squad}</div>${acts}
      <p class="muted small">⚔ combat · ☠ elite · ⬢ supply · ⛺ rest (full repair) · ♛ act boss · hover a node for its brief</p></div>${telemetryPanel(run)}</div></div>`
    this.on('[data-node]', el => { if (avail.has(el.dataset.node!)) this.enterNode(run.nodes.find(n => n.id === el.dataset.node)!) })
    this.nodeCards(run, avail, brief)
    this.drawEdges(run, avail)
    void fillPortraits(this.root)
    this.on('[data-refit]', el => {
      const p = run.squad.find(x => x.id === el.dataset.refit)
      if (p) this.runBuilder(p, `Refit ${p.callsign} (LL${p.level})`, () => this.runMap(), b => { refitPilot(run, b); saveRun(run) })
    })
    this.on('[data-go]', el => {
      const g = el.dataset.go
      if (g === 'title') this.title()
      if (g === 'repairs') this.repairs()
      if (g === 'reimport') this.hangar('reimport')
      if (g === 'abandon') void confirmDialog('Abandon this run?', 'The run and its progress are deleted. This cannot be undone.', { ok: 'Abandon run', danger: true }).then(ok => { if (ok) { this.run = null; saveRun(null); clearBattle(); this.title() } })
    })
  }

  /** Styled hover/focus card for campaign nodes: what it is, the brief, the stakes, and whether it can be entered. */
  private nodeCards(run: RunState, avail: Set<string>, brief: (n: RunNode) => string) {
    const card = document.createElement('div')
    card.className = 'nodecard'
    card.setAttribute('role', 'tooltip')
    this.root.querySelector('.runmap')?.appendChild(card)
    const KIND: Record<string, string> = { combat: 'Engagement', elite: 'Elite engagement', supply: 'Supply depot', rest: 'Stand-down', boss: 'Act objective' }
    const SITREP: Record<string, string> = { standard: 'Basic Combat', holdout: 'Holdout', control: 'Control', extraction: 'Extraction', assassination: 'Assassination' }
    const show = (el: HTMLElement) => {
      const n = run.nodes.find(x => x.id === el.dataset.node)
      if (!n) return
      const ahead = n.act > run.act
      const fight = n.kind === 'combat' || n.kind === 'elite' || n.kind === 'boss'
      const stakes = n.kind === 'elite' ? 'Tougher hostiles. Win to choose a supply reward.' : n.kind === 'boss' ? `Ends Act ${n.act}. Win for a supply reward${n.act < ACTS ? ' and +5 License Levels' : ''}.` : n.kind === 'combat' ? 'After the fight: field repairs, and sometimes an event.' : n.kind === 'supply' ? 'No fight. Choose one item.' : 'No fight. Full repair; destroyed mechs are reprinted.'
      const state = n.cleared ? '<span class="good">✓ Cleared</span>' : avail.has(n.id) ? '<span class="warnc">▶ Available: click to enter</span>' : run.current === n.id ? 'You are here' : '<span class="muted">Locked: reach it through a connected node</span>'
      card.innerHTML = ahead
        ? `<div class="nk">${esc(KIND[n.kind] ?? n.kind)}</div><p><span class="redact">████ ███ ██████</span></p><div class="muted small">Not yet reached.</div>`
        : `<div class="nk">${esc(KIND[n.kind] ?? n.kind)}${fight && n.kind !== 'boss' ? ` · ${esc(SITREP[n.sitrep ?? 'standard'] ?? '')}` : ''}${fight ? ` <span class="muted">Tier ${n.act}</span>` : ''}</div><p>${esc(brief(n))}</p><div class="small">${esc(stakes)}</div><div class="small st">${state}</div>`
      const r = el.getBoundingClientRect()
      card.style.display = 'block'
      const w = card.offsetWidth, h = card.offsetHeight
      let x = r.right + 10, y = r.top + r.height / 2 - h / 2
      if (x + w > window.innerWidth - 8) x = r.left - w - 10
      y = Math.max(8, Math.min(window.innerHeight - h - 8, y))
      card.style.left = `${x}px`
      card.style.top = `${y}px`
    }
    const hide = () => { card.style.display = 'none' }
    this.root.querySelectorAll<HTMLElement>('[data-node]').forEach(el => {
      el.addEventListener('mouseenter', () => show(el))
      el.addEventListener('focus', () => show(el))
      el.addEventListener('mouseleave', hide)
      el.addEventListener('blur', hide)
    })
  }

  /** SVG route lines between connected campaign nodes, redrawn when the layout changes. */
  private drawEdges(run: RunState, avail: Set<string>) {
    const ns = 'http://www.w3.org/2000/svg'
    const draw = () => {
      for (const layers of this.root.querySelectorAll<HTMLElement>('.runmap .layers')) {
        layers.querySelector('svg.edges')?.remove()
        const box = layers.getBoundingClientRect()
        const svg = document.createElementNS(ns, 'svg')
        svg.setAttribute('class', 'edges')
        svg.setAttribute('width', String(layers.scrollWidth))
        svg.setAttribute('height', String(layers.scrollHeight))
        const centre = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2, r: r.width / 2 } }
        for (const el of layers.querySelectorAll<HTMLElement>('[data-node]')) {
          const n = run.nodes.find(x => x.id === el.dataset.node)
          if (!n) continue
          const a = centre(el)
          for (const id of n.next) {
            const tEl = layers.querySelector(`[data-node="${id}"]`)
            if (!tEl) continue
            const b = centre(tEl)
            const t = run.nodes.find(x => x.id === id)
            const state = n.cleared && t?.cleared ? 'done' : (run.current === n.id || (n.cleared && !run.current)) && avail.has(id) ? 'open' : n.act > run.act ? 'ahead' : ''
            const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1
            const line = document.createElementNS(ns, 'path')
            const x1 = a.x + (dx / len) * (a.r + 3), y1 = a.y + (dy / len) * (a.r + 3)
            const x2 = b.x - (dx / len) * (b.r + 3), y2 = b.y - (dy / len) * (b.r + 3)
            const mx = (x1 + x2) / 2
            line.setAttribute('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`)
            line.setAttribute('class', `edge ${state}`)
            svg.appendChild(line)
          }
        }
        layers.prepend(svg)
      }
    }
    const raf = requestAnimationFrame(draw)
    const target = this.root.querySelector('.runmap')
    const ro = typeof ResizeObserver === 'function' && target ? new ResizeObserver(() => draw()) : null
    if (ro && target) ro.observe(target)
    this.cleanups.push(() => { cancelAnimationFrame(raf); ro?.disconnect() })
  }

  enterNode(n: RunNode) {
    const run = this.run!
    if (n.kind === 'rest') {
      fullRepair(run, true)
      n.cleared = true
      run.current = n.id
      run.log.push(`Act ${n.act}: rested and fully repaired.`)
      saveRun(run)
      return this.notice('Rest', 'Your squad rests. All mechs receive a full repair: HP, structure, stress, repairs, limited uses and CORE power are restored, and destroyed mechs are reprinted.', () => this.runMap())
    }
    if (n.kind === 'supply') return this.supply(n)
    this.startBattle(n)
  }

  startBattle(n: RunNode) {
    const run = this.run!
    const tier = nodeTier(n)
    const kind = n.kind === 'boss' ? 'boss' : n.kind === 'elite' ? 'elite' : 'standard'
    const official = officialClasses()
    const mode = officialMode()
    const useOfficial = official.length > 0 && (mode === 'only' || (mode === 'mixed' && new Rng(n.seed ^ 0x51a7).next() < 0.5))
    // the finale is always the Choir's prophet in the casket vault
    const finale = n.kind === 'boss' && n.act === ACTS ? validTeams().find(t => t.id === FINAL_BOSS) : undefined
    const team = finale ?? (useOfficial ? generateOfficialTeam(official, tier, kind, run.squad.length, n.seed) : chooseTeam(run, n, teamsFor(tier, kind, n.layer + 1)))
    n.teamId = team.id
    const map = generateMap(n.seed, { theme: themeForAct(n.act) })
    const units = squadUnits(run)
    const enemies = buildTeam(team, units.length)
    units.forEach((u, i) => (u.pos = map.deployPlayer[i]))
    enemies.forEach((u, i) => (u.pos = map.deployEnemy[i % map.deployEnemy.length]))
    const hvt = [...enemies].sort((a, b) => (b.flags.budget ?? 1) - (a.flags.budget ?? 1))[0]
    const sitrep = sitrepFor(n.kind === 'boss' ? { ...n, sitrep: 'standard' } : n, map, hvt?.id)
    const title = finale ? `CINNABAR ANNEX // CASKET VAULT — ${team.name}` : `${team.name} (Act ${n.act} ${n.kind})`
    // a battle already under way at this node (the page was closed or reloaded): resume it
    const saved = loadBattle()
    let b: Battle
    if (saved && saved.runSeed === run.seed && saved.nodeId === n.id) {
      b = replayBattle(saved.data)
    } else {
      b = new Battle({ map, units: [...units, ...enemies], seed: n.seed, sitrep })
      b.start()
    }
    this.clear()
    this.setAct(n.act)
    this.mountBattle(b, {
      title,
      save: bt => saveBattle({ runSeed: run.seed, nodeId: n.id, title, data: exportBattle(bt) }),
      onEnd: w => {
        clearBattle()
        recordBattle(run, n, this.battle!.b.units, w === 'player')
        saveRun(run)
        if (w === 'player' && !run.over) this.debrief(n)
        else this.runOver()
      },
    })
  }

  /**
   * Show a battle with saving and undo wired in. Undo restores an in-session snapshot (fast); with none left
   * (after a reload) the battle is rebuilt by replaying every recorded command except the last player action.
   */
  async mountBattle(b: Battle, o: { title: string; onEnd: (w: 'player' | 'enemy') => void; save?: (b: Battle) => void }, undoStack: UndoEntry[] = []) {
    this.battle?.dispose()
    this.battle = null
    const { BattleScreen } = await import('./battle-ui')
    this.battle = new BattleScreen(this.root, b, {
      title: o.title,
      onEnd: o.onEnd,
      onSaved: o.save,
      undoStack,
      onRemount: (bt, stack) => this.mountBattle(bt, o, stack),
      onUndoReplay: bt => {
        const x = withoutLastAction(exportBattle(bt), bt)
        if (!x) return
        const rebuilt = replayBattle(x)
        rebuilt.say('↶ Undone.')
        o.save?.(rebuilt)
        this.mountBattle(rebuilt, o)
      },
    })
  }

  debrief(n: RunNode) {
    const run = this.run!
    const rewards = n.kind === 'elite' || n.kind === 'boss' ? rollRewards(n.seed + 1, run) : []
    if (!rewards.length) return this.repairs()
    this.rewardPick(rewards, () => this.repairs())
  }

  supply(n: RunNode) {
    const run = this.run!
    n.cleared = true
    run.current = n.id
    saveRun(run)
    this.rewardPick(rollRewards(n.seed, run), () => this.runMap())
  }

  rewardPick(rewards: ReturnType<typeof rollRewards>, then: () => void) {
    const run = this.run!
    this.clear()
    const needsPilot = (id: string) => ['repairs', 'core', 'reprint'].includes(id)
    this.root.innerHTML = `<div class="screen"><h2>Supplies</h2><p class="muted">Choose one.</p><div class="rewards">${rewards.map(r => `<div class="reward"><b>${esc(r.name)}</b><p>${esc(r.text)}</p>${needsPilot(r.id) ? run.squad.filter(p => r.id !== 'reprint' || run.condition[p.id].destroyed).map(p => `<button data-r="${r.id}" data-p="${p.id}">${esc(p.callsign)}</button>`).join('') : `<button data-r="${r.id}" class="primary">Take</button>`}</div>`).join('')}</div><button data-skip="1">Skip</button></div>`
    this.on('[data-r]', el => { applyReward(run, el.dataset.r!, el.dataset.p); saveRun(run); then() })
    this.on('[data-skip]', () => then())
  }

  repairs() {
    const run = this.run!
    this.clear()
    const rows = run.squad.map(p => {
      const c = run.condition[p.id]
      const opts = repairOptions(p, c)
      return `<div class="sq ${c.destroyed ? 'dead' : ''}"><b>${esc(p.callsign)}</b> — Repairs left: <b>${c.repairs}</b><br>${c.destroyed ? '<span class="bad">Destroyed: reprinted at the next rest.</span>' : opts.length ? opts.map(o => `<button data-p="${p.id}" data-o="${esc(o.id)}" ${c.repairs < o.cost ? 'disabled' : ''}>${esc(o.label)} (${o.cost})</button>`).join('') : '<span class="muted">Fully operational.</span>'}</div>`
    }).join('')
    this.root.innerHTML = `<div class="screen"><h2>Field repairs</h2><p class="muted">Spend Repairs between engagements (LANCER costs: 1 for full HP, 2 per structure or stress, 1 per destroyed weapon/system). Heat and statuses have cleared.</p>${rows}<button data-go="map" class="primary">Continue</button></div>`
    this.on('[data-o]', el => { try { applyRepair(run, el.dataset.p!, el.dataset.o!); saveRun(run) } catch (e) { void alertDialog('Repair not possible', (e as Error).message) } this.repairs() })
    this.on('[data-go]', () => this.maybeEvent(() => this.runMap()))
  }

  // ------------------------------------------------------------------ between-battle events
  /** After a won combat: maybe a random event (rolled once per node). */
  maybeEvent(then: () => void) {
    const run = this.run!
    const node = run.nodes.find(n => n.id === run.current)
    if (!node || !['combat', 'elite', 'boss'].includes(node.kind) || run.over || run.eventsSeen?.includes(node.id)) return then()
    run.eventsSeen = [...(run.eventsSeen ?? []), node.id]
    saveRun(run)
    const ev = rollEvent(node)
    if (!ev) return then()
    this.eventScreen(ev, then)
  }

  eventScreen(ev: RunEvent, then: () => void) {
    const run = this.run!
    this.clear()
    const label = { find: 'Find', gamble: 'Gamble', pact: 'Hard choice' }[ev.tier]
    const mechs = run.squad.map(p => {
      const ok = ev.eligible ? ev.eligible(run, p.id) : true
      return `<button data-ev="${esc(p.id)}" ${ok === true ? '' : 'disabled'} title="${esc(ok === true ? '' : ok)}" class="${ev.tier === 'find' ? 'primary' : ''}">${esc(p.callsign)}${ok === true ? '' : ` <span class="muted small">(${esc(ok)})</span>`}</button>`
    }).join('')
    const anyEligible = run.squad.some(p => !ev.eligible || ev.eligible(run, p.id) === true)
    this.root.innerHTML = `<div class="screen center event ${ev.tier}">
      <div class="evtag">${label}</div>
      <h2>${esc(ev.title)}</h2>
      <p class="evtext">${esc(ev.text)}</p>
      <p class="eveffect">${esc(ev.effect)}</p>
      ${ev.needsMech
        ? `<p class="muted small">${ev.tier === 'find' ? 'Who takes it?' : 'Who pays the price?'}</p><div class="menu row">${mechs}</div>`
        : `<div class="menu row"><button data-ev="" class="primary">${ev.tier === 'find' ? 'Take it' : 'Accept'}</button></div>`}
      ${ev.tier !== 'find' || (ev.needsMech && !anyEligible) ? '<button data-skip="1">Leave it</button>' : ''}
    </div>`
    this.on('[data-ev]', el => {
      const msg = ev.apply(run, el.dataset.ev || undefined)
      run.log.push(`Act ${run.act}: ${ev.title}: ${msg}`)
      saveRun(run)
      this.notice(ev.title, msg, then)
    })
    this.on('[data-skip]', () => { run.log.push(`Act ${run.act}: ${ev.title}: left alone.`); saveRun(run); then() })
  }

  /**
   * After an act boss (and whenever a squad pilot isn't ready for the act): every pilot is at the act's
   * License Level, and the run can't go on until each build is legal with every point spent — in the
   * builder here, or by re-importing a COMP/CON pilot at the right level.
   */
  levelUpScreen() {
    const run = this.run!
    if (run.pendingLevelUp) { levelUp(run); saveRun(run) }
    const level = actLevel(run.act)
    this.clear()
    this.setAct(run.act)
    this.root.innerHTML = this.gateHtml({
      title: run.act > 1 ? `Act ${run.act - 1} complete — level up to LL${level}` : `Squad not ready for Act 1 (LL${level})`,
      intro: `Act ${run.act} is fought at <b>License Level ${level}</b>. Spend each pilot's new talent, license, mech skill and core bonus points before you continue: use <b>Level up</b>, or level them in COMP/CON and <b>Re-import</b> them (matched by id or callsign). Damage and Repairs carry over.`,
      pilots: run.squad, level,
      extra: '<button data-go="reimport">Re-import from COMP/CON</button>',
      go: `Continue to Act ${run.act}`,
    })
    this.on('[data-fit]', el => {
      const p = run.squad.find(x => x.id === el.dataset.fit)
      if (!p) return
      const draft = p.level === level ? p : fitToLevel(p, level)
      this.runBuilder(draft, `Level up ${p.callsign} (LL${level})`, () => this.levelUpScreen(), b => { refitPilot(run, b); saveRun(run) })
    })
    this.on('[data-go]', el => {
      if (el.dataset.go === 'reimport') return this.hangar('reimport')
      if (el.dataset.go === 'go' && run.squad.every(p => !readyProblems(p, level).length)) this.runMap()
    })
  }

  /** A squad-readiness screen: each pilot's problems at `level`, a button to fix it, and the go button once all are ready. */
  private gateHtml(o: { title: string; intro: string; pilots: PilotBuild[]; level: number; extra: string; go: string; back?: boolean; from?: Map<string, number> }): string {
    const rows = o.pilots.map(p => {
      const probs = readyProblems(p, o.level)
      const label = p.level !== o.level ? `Rebuild at LL${o.level}` : probs.length ? 'Level up' : 'Edit build'
      return `<div class="sq dossier"><div class="dh"><b>${esc(p.callsign)}</b>${probs.length ? '<span class="stamp warnc">NOT READY</span>' : '<span class="stamp good">READY</span>'}</div>
        <span class="muted">LL${p.level} ${esc(Lancer.frames.get(p.mech.frameId)?.name ?? '')}${o.from?.has(p.id) ? ` · fitted from LL${o.from.get(p.id)}` : ''} · ${p.mech.mounts.flatMap(m => m.slots).filter(x => x.weaponId).length} weapons, ${p.mech.systems.length} systems</span>
        <button class="small ${probs.length ? 'primary' : ''}" data-fit="${esc(p.id)}">${label}</button>
        ${probs.length ? `<ul class="small">${probs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`
    }).join('')
    const ready = o.pilots.every(p => !readyProblems(p, o.level).length)
    return `<div class="screen gate"><h2>${o.title}</h2><p>${o.intro}</p><div class="squad">${rows}</div>
      <div>${o.extra}<button data-go="go" class="primary" ${ready ? '' : 'disabled'} title="${ready ? '' : 'Every pilot must be legal with all points spent'}">${o.go}</button>${o.back ? '<button data-go="back">Back</button>' : ''}</div></div>`
  }

  /** The builder for a run's pilot: the edit stays in the run (the roster copy is never changed). LL is locked. */
  runBuilder(build: PilotBuild, title: string, back: () => void, save: (p: PilotBuild) => void) {
    this.clear()
    builderScreen(this.root, { build, title, lockLevel: true, onCancel: back, onSave: p => { save(p); back() } })
  }

  /**
   * Start a run: act 1 is fought at LL0. Pilots at another level (or with unspent points) get a run-only
   * copy fitted to LL0 that must be finished in the builder before the run begins.
   */
  prepareRun(squad: PilotBuild[]) {
    const level = actLevel(1)
    this.prep = squad.map(p => (p.level === level ? structuredClone(p) : fitToLevel(p, level)))
    this.prepFrom = new Map(squad.filter(p => p.level !== level).map(p => [p.id, p.level]))
    // straight in when nothing was changed; a fitted pilot is always shown so its cut-down build can be finished
    if (!this.prepFrom.size && this.prep.every(p => !readyProblems(p, level).length)) return this.beginRun()
    this.prepScreen()
  }

  private prepScreen() {
    const pilots = this.prep!
    const level = actLevel(1)
    this.clear()
    this.root.innerHTML = this.gateHtml({
      title: `Squad preparation — Act 1 (LL${level})`,
      intro: `Every run starts at <b>License Level ${level}</b> (act 2 is LL${actLevel(2)}, act 3 LL${actLevel(3)}). Pilots at another level have been fitted to LL${level} for this run, keeping what that level allows — your roster pilots are not changed. Finish each build: it must be legal with every point spent.`,
      pilots, level, extra: '', go: 'Begin run', back: true, from: this.prepFrom,
    })
    this.on('[data-fit]', el => {
      const i = pilots.findIndex(x => x.id === el.dataset.fit)
      if (i < 0) return
      const draft = pilots[i].level === level ? pilots[i] : fitToLevel(pilots[i], level)
      this.runBuilder(draft, `Prepare ${pilots[i].callsign} (LL${level})`, () => this.prepScreen(), b => { pilots[i] = b })
    })
    this.on('[data-go]', el => {
      if (el.dataset.go === 'back') { this.prep = null; return this.hangar('run') }
      if (el.dataset.go === 'go' && pilots.every(p => !readyProblems(p, level).length)) this.beginRun()
    })
  }

  private beginRun() {
    const squad = this.prep!
    this.prep = null
    clearBattle()
    this.run = newRun(squad)
    this.run.iteration = nextIteration()
    saveRun(this.run)
    this.story('opening', () => this.runMap())
  }

  runOver() {
    const run = this.run!
    if (run.over === 'victory' && !run.story?.includes('finale')) return this.story('finale', () => this.runOver())
    const act = Math.min(ACTS, run.act)
    if (run.over === 'defeat' && !run.story?.includes('failed')) {
      run.story = [...(run.story ?? []), 'failed']
      saveRun(run)
      const doc = failedReadout({ act, iteration: run.iteration ?? 1, battlesWon: run.battlesWon, location: ACT_LOCATIONS[act] ?? '[REDACTED]' })
      this.clear()
      this.disposeInterlude = playInterlude(this.root, doc.title, doc.text, () => { this.disposeInterlude = null; this.runOver() })
      return
    }
    this.clear()
    const won = run.over === 'victory'
    const it = run.iteration ? iterLabel(run.iteration) : ''
    this.root.innerHTML = `<div class="screen center ${won ? '' : 'iteration-failed'}">
      ${it ? `<p class="band">FORECAST ITERATION ${it} // ${won ? 'FIRST CLEAN RUN ON RECORD' : 'OUTCOME: RED'}</p>` : ''}
      <h1 class="${won ? 'player' : 'enemy'}">${won ? 'CAMPAIGN COMPLETE' : 'SQUAD LOST'}</h1>
      <p>${run.battlesWon} battles won across ${act} act(s).</p><h4 class="muted">${won ? 'Operation record' : 'Loss record'}</h4><div class="log small">${run.log.map(l => `<div>${esc(l)}</div>`).join('')}</div>
      <button data-go="t" class="primary">${won ? 'Title' : 'Title — reseed the forecast'}</button></div>`
    this.on('[data-go]', () => { this.run = null; saveRun(null); this.title() })
  }

  // ------------------------------------------------------------------ story interludes
  /** Play a story interlude once per run (it's also unlocked in the title screen's archive). */
  story(id: StoryId, then: () => void) {
    const run = this.run
    if (run?.story?.includes(id)) return then()
    if (run) { run.story = [...(run.story ?? []), id]; saveRun(run) }
    unlockStory(id)
    this.replayStory(id, then)
  }
  replayStory(id: StoryId, then: () => void) {
    this.clear()
    this.disposeInterlude = playInterlude(this.root, STORY[id].title, STORY[id].text, () => { this.disposeInterlude = null; then() })
  }
  archive() {
    this.clear()
    const open = unlockedStories()
    this.root.innerHTML = `<div class="screen center"><h2>Transmissions</h2><p class="muted">Recovered documents. More are unlocked as you advance.</p>
      <div class="menu">${STORY_ORDER.map(id => open.includes(id) ? `<button data-s="${id}">${esc(STORY[id].title)}</button>` : '<button disabled>[REDACTED]</button>').join('')}</div>
      <button data-go="back">Back</button></div>`
    this.on('[data-s]', el => this.replayStory(el.dataset.s as StoryId, () => this.archive()))
    this.on('[data-go]', () => this.title())
  }

  notice(title: string, text: string, then: () => void) {
    this.clear()
    this.root.innerHTML = `<div class="screen center"><h2>${esc(title)}</h2><p>${esc(text)}</p><button class="primary" data-go="ok">Continue</button></div>`
    this.on('[data-go]', then)
  }

  /** Tint the whole UI for an act (style.css `[data-act]` palettes); null = neutral. */
  private setAct(act: number | null) {
    if (act) this.root.dataset.act = String(Math.max(1, Math.min(3, act)))
    else delete this.root.dataset.act
  }

  private on(sel: string, f: (el: HTMLElement) => void) {
    this.root.querySelectorAll<HTMLElement>(sel).forEach(el => el.addEventListener('click', () => f(el)))
  }
}

/** Weapon name with hoverable range and tag chips (Hangar). */
function weaponLine(w: Weapon): string {
  const pr = w.profiles[w.profileIndex]
  const bits = [...pr.range.map(r => rangeChip(r.type, r.val)), ...pr.tags.map(t => tagChip(t.id, t.val))]
  return `${esc(w.name)}${bits.length ? ` <span class="muted">(${bits.join(', ')})</span>` : ''}`
}

function pilotCard(p: PilotBuild, picked: boolean): string {
  const f = Lancer.frames.get(p.mech.frameId)
  let u
  try { u = buildMechUnit(p) } catch { u = null }
  const sp = mechSP(p)
  const ids = u ? scriptIdsFor(u) : []
  const cov = u ? classify(u) : { manual: [] as string[] }
  return `<div class="pilot ${picked ? 'picked' : ''}">
    <div class="ph"><b>${esc(p.callsign)}</b> <span class="muted">${esc(p.name)} · LL${p.level}</span>
      <span><button data-pick="${esc(p.id)}" class="${picked ? 'primary' : ''}">${picked ? '✓ In squad' : 'Add to squad'}</button><button data-edit="${esc(p.id)}" class="small">Edit</button><button data-remove="${esc(p.id)}" class="warn small">✕</button></span></div>${u ? portraitSlot(u) : ''}
    <div><b>${esc(p.mech.name)}</b> — ${esc(f ? `${f.source} ${f.name}` : p.mech.frameId)} · HASE ${p.mechSkills.join('/')} · SP ${sp.used}/${sp.max}</div>
    ${u ? `<div class="muted small">HP ${u.stats.hp} · ARM ${u.stats.armor} · EVA ${u.stats.evasion} · E-DEF ${u.stats.edef} · HEAT ${u.stats.heatcap} · SPD ${u.stats.speed} · Structure ${u.stats.structure} · Stress ${u.stats.stress}</div>
    <div class="small">⚔ ${u.weapons.map(w => weaponLine(w)).join(' · ')}</div><div class="small">⚙ ${u.systems.map(s => esc(s.name)).join(', ') || '—'}</div>
    <div class="small muted">Talents: ${p.talents.map(t => `${esc(Lancer.talents.get(t.id)?.name ?? t.id)} ${t.rank}`).join(', ') || '—'}${p.coreBonuses.length ? ` · Core bonuses: ${p.coreBonuses.map(c => esc(Lancer.coreBonuses.get(c)?.name ?? c)).join(', ')}` : ''}</div>` : '<div class="bad">Frame not in lancer-data — cannot fly this mech.</div>'}
    ${p.unknown.length ? `<div class="bad small">Unknown content (LCP?): ${p.unknown.map(esc).join(', ')}</div>` : ''}
    ${cov.manual.length ? `<div class="warn small" title="${esc(cov.manual.join(', '))}">${cov.manual.length} rule(s) resolved manually</div>` : ''}
    ${ids.length && getScript('') ? '' : ''}
  </div>`
}

type OfficialMode = 'off' | 'mixed' | 'only'
function officialMode(): OfficialMode {
  try { const v = localStorage.getItem('dov-official-mode'); return v === 'mixed' || v === 'only' ? v : 'off' } catch { return 'off' }
}
function setOfficialMode(m: OfficialMode) { try { localStorage.setItem('dov-official-mode', m) } catch { /* storage unavailable */ } }

const FINAL_BOSS = 't3-boss-voice-of-the-eye'
const STORY_KEY = 'dov-story-unlocked'
function unlockedStories(): StoryId[] {
  try { const v = JSON.parse(localStorage.getItem(STORY_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x: string) => x in STORY) : [] } catch { return [] }
}
function unlockStory(id: StoryId) {
  try { const s = new Set(unlockedStories()); s.add(id); localStorage.setItem(STORY_KEY, JSON.stringify([...s])) } catch { /* storage unavailable */ }
}
