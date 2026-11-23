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
  repairOptions, applyRepair, permHpBonus, rollRewards, applyReward, levelUp, replacePilots, refitPilot, chooseTeam, saveRun, loadRun, ACTS, LL_PER_ACT, lastLoadProblem,
} from '../run/run'
import { BattleScreen } from './battle-ui'
import { rangeChip, tagChip } from './tags'
import type { Weapon } from '../rules/types'
import { featureAutomated, loadPacks, readLcp, removePack, storePack, officialClasses } from '../import/lcp'
import { generateOfficialTeam } from '../enemies/official'
import { Rng } from '../rules/rng'
import { STORY, STORY_ORDER, type StoryId, ACT_LOCATIONS, NODE_BRIEFS, failedReadout } from '../data/story'
import { iterationCount, iterLabel, nextIteration, telemetryPanel } from './forecast'
import { rollEvent, type RunEvent } from '../run/events'
import { playInterlude, RA_EYE_SVG } from './interlude'
import { loadRoster, addToRoster, saveRoster, pregenBuilds, readFiles, sampleSquad } from './roster'
import { esc } from './dom'
import { builderScreen } from './builder-screen'
import { validateBuild } from '../rules/legality'
import { classify } from '../rules/effects/coverage'

const MAX_SQUAD = 4

export class App {
  root: HTMLElement
  roster: PilotBuild[] = loadRoster()
  run: RunState | null = loadRun()
  battle: BattleScreen | null = null
  squadPick = new Set<string>()

  constructor(root: HTMLElement) {
    this.root = root
    if (!this.roster.length) this.roster = addToRoster([], pregenBuilds().slice(0, 4))
    this.title()
  }

  private disposeInterlude: (() => void) | null = null

  private clear() {
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
        ${item('help', 'How to play', 'field manual')}
      </div>
      ${lastLoadProblem ? `<p class="bad small">${esc(lastLoadProblem)}</p>` : ''}
      <p class="muted small">${validTeams().length} enemy teams loaded${bad.length ? ` · <span class="bad">${bad.length} invalid team file(s): ${bad.map(b => esc(b.file)).join(', ')}</span>` : ''} · lancer-data ${esc('4.0.12')}</p>
      <p class="muted small">Unofficial, non-commercial fan project, not affiliated with Massif Press. LANCER is © Massif Press; COMP/CON and lancer-data are GPL-3.0.</p>
    </div>`
    this.on('[data-go]', el => {
      const g = el.dataset.go
      if (g === 'continue') this.runMap()
      if (g === 'hangar') this.hangar('run')
      if (g === 'skirmish') this.hangar('skirmish')
      if (g === 'help') this.help()
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
    this.on('[data-rm]', el => { if (confirm(`Remove ${el.dataset.rm}?`)) { removePack(el.dataset.rm!); this.officialNpcs('✓ Removed.') } })
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
        <button data-go="pregens">Add COMP/CON pregens</button>
        <button data-go="ll5" title="Legal LL5 builds (act 2 level): Drake, Monarch, Saladin, Blackbeard">Add sample LL5 squad</button>
        <button data-go="ll10" title="Legal LL10 builds (act 3 level): Drake, Monarch, Saladin, Blackbeard">Add sample LL10 squad</button>
        ${purpose !== 'reimport' ? `<button data-go="start" class="primary">${purpose === 'run' ? 'Begin run' : 'Choose enemies'} (${this.squadPick.size}/${MAX_SQUAD})</button>` : '<button data-go="done" class="primary">Done</button>'}
        <button data-go="back">Back</button></div></div>
      <div class="drop">Drop COMP/CON pilot exports here</div>
      <p class="muted small">Build pilots here with <i>New pilot</i> or <i>Edit</i>, or in COMP/CON: open the pilot → <i>Export</i> → <i>Save as file (.json)</i>, and drop the file here.</p>
      <div class="errors"></div>
      <div class="pilots">${cards || '<p class="muted">No pilots yet.</p>'}</div></div>`
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
    this.on('[data-remove]', el => {
      this.roster = this.roster.filter(p => p.id !== el.dataset.remove)
      this.squadPick.delete(el.dataset.remove!)
      saveRoster(this.roster)
      this.hangar(purpose)
    })
    this.on('[data-go]', el => {
      const g = el.dataset.go
      if (g === 'back') this.title()
      if (g === 'done') this.runMap()
      if (g === 'new') this.openBuilder(undefined, 'New pilot', () => this.hangar(purpose), p => { if (this.squadPick.size < MAX_SQUAD) this.squadPick.add(p.id) })
      if (g === 'pregens') { this.roster = addToRoster(this.roster, pregenBuilds()); this.hangar(purpose) }
      if (g === 'll5' || g === 'll10') { this.roster = addToRoster(this.roster, sampleSquad(g === 'll5' ? 5 : 10)); this.hangar(purpose) }
      if (g === 'start') {
        const squad = this.roster.filter(p => this.squadPick.has(p.id))
        if (!squad.length) return alert('Pick at least one pilot')
        if (purpose === 'run') { this.run = newRun(squad.map(p => structuredClone(p))); this.run.iteration = nextIteration(); saveRun(this.run); this.story('opening', () => this.runMap()) }
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
      this.battle = new BattleScreen(this.root, b, { title: team.name, onEnd: w => this.simpleEnd(w) })
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
      return `<div class="act ${act === run.act ? 'current' : ''} ${ahead ? 'ahead' : ''}"><h3>${head}</h3><div class="layers">${layers.map(l => `<div class="layer">${run.nodes.filter(n => n.act === act && n.layer === l).map(n => `<button class="node ${n.kind} ${n.cleared ? 'cleared' : ''} ${avail.has(n.id) ? 'avail' : ''} ${run.current === n.id ? 'here' : ''}" data-node="${n.id}" ${avail.has(n.id) ? '' : 'disabled'} title="${esc(ahead ? `${n.kind} · [REDACTED]` : `${n.kind}${n.sitrep && (n.kind === 'combat' || n.kind === 'elite') ? ' · ' + n.sitrep : ''}\n${brief(n)}`)}">${icon[n.kind]}</button>`).join('')}</div>`).join('<div class="arrow">›</div>')}</div></div>`
    }).join('')
    const squad = run.squad.map((p, i) => {
      const c = run.condition[p.id]
      const u = buildMechUnit(p)
      const unspent = validateBuild(p).warnings.some(w => /unspent|unchosen/.test(w))
      const damaged = !c.destroyed && (c.hp < u.stats.hp || c.structure < u.stats.structure || c.stress < u.stats.stress)
      const stamp = c.destroyed ? '<span class="stamp bad">DESTROYED — REPRINT PENDING</span>' : damaged ? '<span class="stamp warnc">DAMAGED</span>' : '<span class="stamp good">OPERATIONAL</span>'
      return `<div class="sq dossier ${c.destroyed ? 'dead' : ''}"><div class="dh"><span class="desig">OCHRE-${i + 1}</span>${stamp}</div><b>${esc(p.callsign)}</b> <span class="muted">LL${p.level} ${esc(Lancer.frames.get(p.mech.frameId)?.name ?? '')}</span> <button class="small ${unspent ? 'primary' : ''}" data-refit="${esc(p.id)}" title="Spend points and change the loadout. Damage and spent Repairs carry over.">${unspent ? 'Level up' : 'Edit build'}</button><br>${c.destroyed ? '<span class="muted">Reprinted at the next rest.</span>' : `HP ${c.hp + permHpBonus(run, p.id)}/${u.stats.hp + permHpBonus(run, p.id)} · S ${c.structure}/${u.stats.structure} · R ${c.stress}/${u.stats.stress} · Repairs ${c.repairs}${c.coreAvailable ? ' · CORE ready' : ''}`}</div>`
    }).join('')
    this.root.innerHTML = `<div class="screen runmap"><div class="hhead"><div><p class="band">OPERATION <span class="redact">████████</span> // PHASE ${run.act} OF 3${run.iteration ? ` // ITERATION ${iterLabel(run.iteration)}` : ''}</p><h2>Campaign — Act ${run.act} <span class="loc">${esc(ACT_LOCATIONS[run.act] ?? '')}</span></h2></div><div><button data-go="repairs">Field repairs</button><button data-go="reimport">Re-import pilots</button><button data-go="abandon" class="warn">Abandon run</button><button data-go="title">Title</button></div></div>
      <div class="opsboard"><div class="opsmain"><div class="squad">${squad}</div>${acts}
      <p class="muted small">⚔ combat · ☠ elite · ⬢ supply · ⛺ rest (full repair) · ♛ act boss · hover a node for its brief</p></div>${telemetryPanel(run)}</div></div>`
    this.on('[data-node]', el => this.enterNode(run.nodes.find(n => n.id === el.dataset.node)!))
    this.on('[data-refit]', el => {
      const p = run.squad.find(x => x.id === el.dataset.refit)
      if (p) this.openBuilder(p, `Refit ${p.callsign} (LL${p.level})`, () => this.runMap(), b => { refitPilot(run, b); saveRun(run) }, true)
    })
    this.on('[data-go]', el => {
      const g = el.dataset.go
      if (g === 'title') this.title()
      if (g === 'repairs') this.repairs()
      if (g === 'reimport') this.hangar('reimport')
      if (g === 'abandon' && confirm('Abandon this run?')) { this.run = null; saveRun(null); this.title() }
    })
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
    const b = new Battle({ map, units: [...units, ...enemies], seed: n.seed, sitrep })
    b.start()
    this.clear()
    this.setAct(n.act)
    this.battle = new BattleScreen(this.root, b, {
      title: finale ? `CINNABAR ANNEX // CASKET VAULT — ${team.name}` : `${team.name} (Act ${n.act} ${n.kind})`,
      onEnd: w => {
        recordBattle(run, n, b.units, w === 'player')
        saveRun(run)
        if (w === 'player' && !run.over) this.debrief(n)
        else this.runOver()
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
    this.on('[data-o]', el => { try { applyRepair(run, el.dataset.p!, el.dataset.o!); saveRun(run) } catch (e) { alert((e as Error).message) } this.repairs() })
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

  levelUpScreen() {
    const run = this.run!
    this.clear()
    this.root.innerHTML = `<div class="screen center"><h2>Act ${run.act - 1} complete!</h2>
      <p>Your pilots advance to <b>License Level ${Math.min(12, run.squad[0].level + LL_PER_ACT)}</b>. Grit and HP increase automatically.</p>
      <p>To spend the new talent, license and core bonus points, use <b>Level up</b> on each pilot on the campaign map. You can also level them up in COMP/CON and use <i>Re-import pilots</i> (matched by id or callsign).</p>
      <button data-go="ok" class="primary">Continue to Act ${run.act}</button></div>`
    this.on('[data-go]', () => { levelUp(run); saveRun(run); this.runMap() })
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
      <span><button data-pick="${esc(p.id)}" class="${picked ? 'primary' : ''}">${picked ? '✓ In squad' : 'Add to squad'}</button><button data-edit="${esc(p.id)}" class="small">Edit</button><button data-remove="${esc(p.id)}" class="warn small">✕</button></span></div>
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
