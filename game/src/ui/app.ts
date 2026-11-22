// Screen flow: Title → Hangar (import COMP/CON pilots, pick squad) → Run map → Battle →
// Debrief (repairs / rewards) → … → Victory or defeat.
import { Lancer } from '../data/lancer'
import type { PilotBuild } from '../import/compcon'
import { Battle } from '../rules/battle'
import { buildMechUnit, mechSP } from '../rules/stats'
import { scriptIdsFor, getScript } from '../rules/effects/registry'
import { buildTeam } from '../enemies/build'
import { catalog, teamsFor, validTeams } from '../enemies/catalog'
import { generateMap } from '../run/mapgen'
import {
  type RunState, type RunNode, newRun, availableNodes, nodeTier, sitrepFor, squadUnits, recordBattle, fullRepair,
  repairOptions, applyRepair, rollRewards, applyReward, levelUp, replacePilots, chooseTeam, saveRun, loadRun, ACTS, LL_PER_ACT, lastLoadProblem,
} from '../run/run'
import { BattleScreen } from './battle-ui'
import { featureAutomated, loadPacks, readLcp, removePack, storePack, officialClasses } from '../import/lcp'
import { generateOfficialTeam } from '../enemies/official'
import { Rng } from '../rules/rng'
import { loadRoster, addToRoster, saveRoster, pregenBuilds, readFiles, sampleSquad } from './roster'
import { esc } from './dom'
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

  private clear() {
    this.battle?.dispose()
    this.battle = null
    this.root.innerHTML = ''
  }

  // ------------------------------------------------------------------ title
  title() {
    this.clear()
    const bad = catalog.filter(c => c.errors.length)
    this.root.innerHTML = `<div class="screen title">
      <h1>DREAMS OF VERMILLION</h1><p class="sub">a LANCER tactics roguelike</p>
      <div class="menu">
        ${this.run && !this.run.over ? `<button data-go="continue" class="primary">Continue run (Act ${this.run.act}, ${this.run.battlesWon} wins)</button>` : ''}
        <button data-go="hangar" class="${this.run && !this.run.over ? '' : 'primary'}">New run — choose squad</button>
        <button data-go="skirmish">Quick skirmish</button>
        <button data-go="official">Official NPCs (import .lcp)</button>
        <button data-go="help">How to play</button>
      </div>
      ${lastLoadProblem ? `<p class="bad small">${esc(lastLoadProblem)}</p>` : ''}
      <p class="muted small">${validTeams().length} enemy teams loaded${bad.length ? ` · <span class="bad">${bad.length} invalid team file(s): ${bad.map(b => esc(b.file)).join(', ')}</span>` : ''} · lancer-data ${esc('4.0.12')}</p>
      <p class="muted small">Unofficial fan project for personal use. LANCER is © Massif Press; COMP/CON and lancer-data are GPL-3.0.</p>
    </div>`
    this.on('[data-go]', el => {
      const g = el.dataset.go
      if (g === 'continue') this.runMap()
      if (g === 'hangar') this.hangar('run')
      if (g === 'skirmish') this.hangar('skirmish')
      if (g === 'help') this.help()
      if (g === 'official') this.officialNpcs()
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
        <li><b>Build lancers in COMP/CON.</b> Run it from <code>vendor/compcon</code> (<code>yarn && yarn dev</code>) or use the web app: <a href="https://compcon.app" target="_blank" rel="noopener noreferrer">compcon.app ↗</a>. In the pilot roster, open a pilot → <i>Export</i> → <i>Save as file (.json)</i>.</li>
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
    if (!this.squadPick.size) this.roster.slice(0, MAX_SQUAD).forEach(p => this.squadPick.add(p.id))
    const cards = this.roster.map(p => pilotCard(p, this.squadPick.has(p.id))).join('')
    this.root.innerHTML = `<div class="screen hangar">
      <div class="hhead"><h2>${purpose === 'reimport' ? 'Re-import updated pilots' : 'Hangar'}</h2>
        <div><a class="filebtn linkbtn" href="https://compcon.app" target="_blank" rel="noopener noreferrer" title="Opens the official COMP/CON web app in a new tab">Open COMP/CON ↗</a><label class="filebtn">Import COMP/CON .json<input type="file" accept=".json,application/json" multiple></label>
        <button data-go="pregens">Add COMP/CON pregens</button>
        <button data-go="ll5" title="Legal LL5 builds (act 2 level): Drake, Monarch, Saladin, Blackbeard">Add sample LL5 squad</button>
        <button data-go="ll10" title="Legal LL10 builds (act 3 level): Drake, Monarch, Saladin, Blackbeard">Add sample LL10 squad</button>
        ${purpose !== 'reimport' ? `<button data-go="start" class="primary">${purpose === 'run' ? 'Begin run' : 'Choose enemies'} (${this.squadPick.size}/${MAX_SQUAD})</button>` : '<button data-go="done" class="primary">Done</button>'}
        <button data-go="back">Back</button></div></div>
      <div class="drop">Drop COMP/CON pilot exports here</div>
      <p class="muted small">Build or level up pilots in COMP/CON, then open the pilot → <i>Export</i> → <i>Save as file (.json)</i>, and drop the file here.</p>
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
      if (g === 'pregens') { this.roster = addToRoster(this.roster, pregenBuilds()); this.hangar(purpose) }
      if (g === 'll5' || g === 'll10') { this.roster = addToRoster(this.roster, sampleSquad(g === 'll5' ? 5 : 10)); this.hangar(purpose) }
      if (g === 'start') {
        const squad = this.roster.filter(p => this.squadPick.has(p.id))
        if (!squad.length) return alert('Pick at least one pilot')
        if (purpose === 'run') { this.run = newRun(squad.map(p => structuredClone(p))); saveRun(this.run); this.runMap() }
        else this.skirmishSetup(squad)
      }
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
      const map = generateMap(seed)
      const units = squad.map(p => buildMechUnit(p))
      const enemies = buildTeam(team, units.length)
      units.forEach((u, i) => (u.pos = map.deployPlayer[i]))
      enemies.forEach((u, i) => (u.pos = map.deployEnemy[i % map.deployEnemy.length]))
      const b = new Battle({ map, units: [...units, ...enemies], seed, sitrep: { id: team.sitrep === 'control' ? 'control' : 'standard', name: team.sitrep === 'control' ? 'Control' : 'Basic Combat', rounds: 3, zone: map.zones?.find(z => z.name === 'control')?.tiles, description: team.sitrep === 'control' ? 'Hold the zone for 3 rounds or destroy all hostiles.' : 'Destroy all hostile forces.' } })
      b.start()
      this.clear()
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
    if (run.pendingLevelUp) return this.levelUpScreen()
    this.clear()
    const avail = new Set(availableNodes(run).map(n => n.id))
    const icon: Record<string, string> = { combat: '⚔', elite: '☠', rest: '⛺', supply: '⬢', boss: '♛' }
    const acts = [1, 2, 3].map(act => {
      const layers = [...new Set(run.nodes.filter(n => n.act === act).map(n => n.layer))]
      return `<div class="act ${act === run.act ? 'current' : ''}"><h3>Act ${act} · Tier ${act}</h3><div class="layers">${layers.map(l => `<div class="layer">${run.nodes.filter(n => n.act === act && n.layer === l).map(n => `<button class="node ${n.kind} ${n.cleared ? 'cleared' : ''} ${avail.has(n.id) ? 'avail' : ''} ${run.current === n.id ? 'here' : ''}" data-node="${n.id}" ${avail.has(n.id) ? '' : 'disabled'} title="${n.kind}${n.sitrep && (n.kind === 'combat' || n.kind === 'elite') ? ' · ' + n.sitrep : ''}">${icon[n.kind]}</button>`).join('')}</div>`).join('<div class="arrow">›</div>')}</div></div>`
    }).join('')
    const squad = run.squad.map(p => {
      const c = run.condition[p.id]
      const u = buildMechUnit(p)
      return `<div class="sq ${c.destroyed ? 'dead' : ''}"><b>${esc(p.callsign)}</b> <span class="muted">LL${p.level} ${esc(Lancer.frames.get(p.mech.frameId)?.name ?? '')}</span><br>${c.destroyed ? '<span class="bad">DESTROYED — reprint at a rest</span>' : `HP ${c.hp}/${u.stats.hp} · S ${c.structure}/${u.stats.structure} · R ${c.stress}/${u.stats.stress} · Repairs ${c.repairs}${c.coreAvailable ? ' · CORE ready' : ''}`}</div>`
    }).join('')
    this.root.innerHTML = `<div class="screen runmap"><div class="hhead"><h2>Campaign — Act ${run.act}</h2><div><button data-go="repairs">Field repairs</button><button data-go="reimport">Re-import pilots</button><button data-go="abandon" class="warn">Abandon run</button><button data-go="title">Title</button></div></div>
      <div class="squad">${squad}</div>${acts}
      <p class="muted small">⚔ combat · ☠ elite · ⬢ supply · ⛺ rest (full repair) · ♛ act boss</p></div>`
    this.on('[data-node]', el => this.enterNode(run.nodes.find(n => n.id === el.dataset.node)!))
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
    const team = useOfficial ? generateOfficialTeam(official, tier, kind, run.squad.length, n.seed) : chooseTeam(run, n, teamsFor(tier, kind, n.layer + 1))
    n.teamId = team.id
    const map = generateMap(n.seed)
    const units = squadUnits(run)
    const enemies = buildTeam(team, units.length)
    units.forEach((u, i) => (u.pos = map.deployPlayer[i]))
    enemies.forEach((u, i) => (u.pos = map.deployEnemy[i % map.deployEnemy.length]))
    const hvt = [...enemies].sort((a, b) => (b.flags.budget ?? 1) - (a.flags.budget ?? 1))[0]
    const sitrep = sitrepFor(n.kind === 'boss' ? { ...n, sitrep: 'standard' } : n, map, hvt?.id)
    const b = new Battle({ map, units: [...units, ...enemies], seed: n.seed, sitrep })
    b.start()
    this.clear()
    this.battle = new BattleScreen(this.root, b, {
      title: `${team.name} (Act ${n.act} ${n.kind})`,
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
    this.on('[data-go]', () => this.runMap())
  }

  levelUpScreen() {
    const run = this.run!
    this.clear()
    this.root.innerHTML = `<div class="screen center"><h2>Act ${run.act - 1} complete!</h2>
      <p>Your pilots advance to <b>License Level ${Math.min(12, run.squad[0].level + LL_PER_ACT)}</b>. Grit and HP increase automatically.</p>
      <p>To spend the new talent, license and core bonus points, level the pilots up in COMP/CON, export them, and use <i>Re-import pilots</i> on the campaign map (they're matched by id or callsign).</p>
      <button data-go="ok" class="primary">Continue to Act ${run.act}</button></div>`
    this.on('[data-go]', () => { levelUp(run); saveRun(run); this.runMap() })
  }

  runOver() {
    const run = this.run!
    this.clear()
    const won = run.over === 'victory'
    this.root.innerHTML = `<div class="screen center"><h1 class="${won ? 'player' : 'enemy'}">${won ? 'CAMPAIGN COMPLETE' : 'SQUAD LOST'}</h1>
      <p>${run.battlesWon} battles won across ${Math.min(ACTS, run.act)} act(s).</p><div class="log small">${run.log.map(l => `<div>${esc(l)}</div>`).join('')}</div>
      <button data-go="t" class="primary">Title</button></div>`
    this.on('[data-go]', () => { this.run = null; saveRun(null); this.title() })
  }

  notice(title: string, text: string, then: () => void) {
    this.clear()
    this.root.innerHTML = `<div class="screen center"><h2>${esc(title)}</h2><p>${esc(text)}</p><button class="primary" data-go="ok">Continue</button></div>`
    this.on('[data-go]', then)
  }

  private on(sel: string, f: (el: HTMLElement) => void) {
    this.root.querySelectorAll<HTMLElement>(sel).forEach(el => el.addEventListener('click', () => f(el)))
  }
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
      <span><button data-pick="${esc(p.id)}" class="${picked ? 'primary' : ''}">${picked ? '✓ In squad' : 'Add to squad'}</button><button data-remove="${esc(p.id)}" class="warn small">✕</button></span></div>
    <div><b>${esc(p.mech.name)}</b> — ${esc(f ? `${f.source} ${f.name}` : p.mech.frameId)} · HASE ${p.mechSkills.join('/')} · SP ${sp.used}/${sp.max}</div>
    ${u ? `<div class="muted small">HP ${u.stats.hp} · ARM ${u.stats.armor} · EVA ${u.stats.evasion} · E-DEF ${u.stats.edef} · HEAT ${u.stats.heatcap} · SPD ${u.stats.speed} · Structure ${u.stats.structure} · Stress ${u.stats.stress}</div>
    <div class="small">⚔ ${u.weapons.map(w => esc(w.name)).join(', ')}</div><div class="small">⚙ ${u.systems.map(s => esc(s.name)).join(', ') || '—'}</div>
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
