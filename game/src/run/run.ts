// Roguelike campaign layer: a branching node map over three acts (tiers 1-3), persistent mech
// damage between fights, Lancer-style repairs at rest, rewards, and localStorage saves.
import type { PilotBuild } from '../import/compcon'
import { buildMechUnit } from '../rules/stats'
import { Rng } from '../rules/rng'
import type { Sitrep } from '../rules/battle'
import type { Unit } from '../rules/types'
import type { EnemyTeam, Tier } from '../enemies/ruleset'

export type NodeKind = 'combat' | 'elite' | 'rest' | 'supply' | 'boss'

export interface RunNode {
  id: string
  act: number
  layer: number
  kind: NodeKind
  next: string[]
  teamId?: string
  sitrep?: Sitrep['id']
  seed: number
  cleared?: boolean
}

export interface MechCondition {
  hp: number
  structure: number
  stress: number
  repairs: number
  overchargeLevel: number
  destroyed: boolean
  coreAvailable: boolean
  destroyedWeapons: string[]   // weapon dataIds destroyed (system trauma)
  destroyedSystems: string[]
  limited: Record<string, number> // uses left per item dataId
}

export interface Reward { id: string; name: string; text: string }

export interface RunState {
  version: 1
  seed: number
  squad: PilotBuild[]
  condition: Record<string, MechCondition>   // by pilot id
  nodes: RunNode[]
  current: string | null       // node id last cleared (null = start)
  act: number
  boons: { pilotId?: string; reward: string }[]
  log: string[]
  over?: 'victory' | 'defeat'
  battlesWon: number
  pendingLevelUp?: boolean
  /** story interludes already shown in this run */
  story?: string[]
}

export const ACTS = 3
const LAYERS = 6
const SAVE_KEY = 'dov.run.v1'

export function newRun(squad: PilotBuild[], seed = Date.now() % 1_000_000): RunState {
  const rng = new Rng(seed)
  const nodes: RunNode[] = []
  let prevLayer: RunNode[] = []
  for (let act = 1; act <= ACTS; act++) {
    for (let layer = 0; layer < LAYERS; layer++) {
      const isBoss = layer === LAYERS - 1
      const count = isBoss ? 1 : layer === 0 ? 2 : rng.int(2, 3)
      const cur: RunNode[] = []
      for (let i = 0; i < count; i++) {
        let kind: NodeKind
        if (isBoss) kind = 'boss'
        else if (layer === 0) kind = 'combat'
        else if (layer === LAYERS - 2) kind = i === 0 ? 'rest' : rng.pick(['combat', 'supply', 'elite'] as const)
        else kind = rng.pick(['combat', 'combat', 'combat', 'elite', 'supply', 'rest'] as const)
        cur.push({ id: `a${act}l${layer}n${i}`, act, layer, kind, next: [], seed: rng.int(1, 1_000_000), sitrep: pickSitrep(rng, kind) })
      }
      // connect previous layer to this one (each node ≥1 outgoing, each new node ≥1 incoming)
      if (prevLayer.length) {
        prevLayer.forEach((p, i) => {
          const j = Math.min(cur.length - 1, Math.round((i / Math.max(1, prevLayer.length - 1)) * (cur.length - 1)))
          p.next.push(cur[j].id)
          if (rng.next() < 0.45 && cur[j + 1]) p.next.push(cur[j + 1].id)
        })
        cur.forEach((c, j) => {
          if (!prevLayer.some(p => p.next.includes(c.id))) prevLayer[Math.min(prevLayer.length - 1, j)].next.push(c.id)
        })
      }
      nodes.push(...cur)
      prevLayer = cur
    }
  }
  const run: RunState = { version: 1, seed, squad, condition: {}, nodes, current: null, act: 1, boons: [], log: [], battlesWon: 0 }
  for (const p of squad) run.condition[p.id] = freshCondition(p)
  return run
}

function pickSitrep(rng: Rng, kind: NodeKind): Sitrep['id'] {
  if (kind === 'boss') return 'standard'
  if (kind === 'elite') return rng.pick(['standard', 'standard', 'assassination'] as const)
  return rng.pick(['standard', 'standard', 'control', 'holdout', 'extraction'] as const)
}

export function freshCondition(p: PilotBuild): MechCondition {
  const u = buildMechUnit(p)
  return {
    hp: u.stats.hp, structure: u.stats.structure, stress: u.stats.stress, repairs: u.stats.repcap, overchargeLevel: 0,
    destroyed: false, coreAvailable: true, destroyedWeapons: [], destroyedSystems: [], limited: {},
  }
}

export function availableNodes(run: RunState): RunNode[] {
  if (!run.current) return run.nodes.filter(n => n.act === 1 && n.layer === 0)
  const cur = run.nodes.find(n => n.id === run.current)!
  return cur.next.map(id => run.nodes.find(n => n.id === id)!).filter(Boolean)
}

export function nodeTier(n: RunNode): Tier {
  return Math.min(3, n.act) as Tier
}

export function sitrepFor(n: RunNode, map: { zones?: { name: string; tiles: { x: number; y: number }[] }[] }, targetId?: string): Sitrep {
  const zone = (name: string) => map.zones?.find(z => z.name === name)?.tiles
  switch (n.sitrep) {
    case 'holdout': return { id: 'holdout', name: 'Holdout', rounds: 8, description: 'Survive 8 rounds or destroy all hostiles.' }
    case 'control': return { id: 'control', name: 'Control', rounds: 3, zone: zone('control'), description: 'Hold the marked zone (no hostiles inside) at the end of 3 rounds, or destroy all hostiles.' }
    case 'extraction': return { id: 'extraction', name: 'Extraction', zone: zone('extraction'), description: 'Get every surviving lancer into the extraction zone, or destroy all hostiles.' }
    case 'assassination': return { id: 'assassination', name: 'Assassination', targetId, description: 'Destroy the marked high-value target.' }
    default: return { id: 'standard', name: 'Basic Combat', description: 'Destroy all hostile forces.' }
  }
}

/** Build battle units for the squad, applying persistent damage and boons. */
export function squadUnits(run: RunState): Unit[] {
  const out: Unit[] = []
  for (const p of run.squad) {
    const c = run.condition[p.id] ?? freshCondition(p)
    if (c.destroyed) continue
    const u = buildMechUnit(p)
    u.hp = Math.min(u.stats.hp, c.hp)
    u.structure = c.structure
    u.stress = c.stress
    u.repairs = c.repairs
    u.overchargeLevel = c.overchargeLevel
    u.coreAvailable = c.coreAvailable
    for (const w of u.weapons) {
      if (w.dataId && c.destroyedWeapons.includes(w.dataId)) w.destroyed = true
      if (w.dataId && c.limited[w.dataId] != null && w.usesLeft != null) w.usesLeft = c.limited[w.dataId]
    }
    for (const s of u.systems) {
      if (c.destroyedSystems.includes(s.dataId)) s.destroyed = true
      if (c.limited[s.dataId] != null && s.usesLeft != null) s.usesLeft = c.limited[s.dataId]
    }
    u.flags.pilotId = p.id
    for (const b of run.boons.filter(b => !b.pilotId || b.pilotId === p.id)) applyBoon(u, b.reward)
    out.push(u)
  }
  return out
}

function applyBoon(u: Unit, id: string) {
  switch (id) {
    case 'plating': u.overshield = Math.max(u.overshield, 4); break
    case 'intel': u.bonuses.push({ id: 'attack', accuracy: 1, condition: '{first_round}' }); break
  }
}

/** After a battle: write unit state back into the run. Heat/statuses clear at end of scene. */
export function recordBattle(run: RunState, node: RunNode, units: Unit[], won: boolean) {
  for (const u of units) {
    const pid = u.flags.pilotId as string | undefined
    if (!pid || u.kind !== 'mech') continue
    const c = run.condition[pid]
    c.destroyed = u.destroyed
    c.hp = u.destroyed ? 0 : u.hp
    c.structure = u.destroyed ? 0 : u.structure
    c.stress = u.destroyed ? 0 : u.stress
    c.repairs = u.repairs
    c.overchargeLevel = u.overchargeLevel
    c.coreAvailable = u.coreAvailable
    c.destroyedWeapons = u.weapons.filter(w => w.destroyed && w.dataId).map(w => w.dataId!)
    c.destroyedSystems = u.systems.filter(s => s.destroyed).map(s => s.dataId)
    for (const w of u.weapons) if (w.dataId && w.usesLeft != null) c.limited[w.dataId] = w.usesLeft
    for (const s of u.systems) if (s.usesLeft != null) c.limited[s.dataId] = s.usesLeft
  }
  // one-battle boons are consumed
  run.boons = run.boons.filter(b => !['plating', 'intel'].includes(b.reward))
  if (won) {
    node.cleared = true
    run.current = node.id
    run.battlesWon++
    run.log.push(`Act ${node.act}: cleared ${node.kind} (${node.teamId ?? ''}).`)
    if (node.kind === 'boss') {
      if (node.act >= ACTS) run.over = 'victory'
      else { run.act = node.act + 1; run.pendingLevelUp = true; fullRepair(run, true) }
    }
  } else {
    run.over = 'defeat'
    run.log.push(`Act ${node.act}: the squad was defeated.`)
  }
  if (Object.values(run.condition).every(c => c.destroyed)) run.over = 'defeat'
}

/** Rest node / between acts: Lancer full repair (restores everything, reprints destroyed mechs). */
export function fullRepair(run: RunState, reprint = true) {
  for (const p of run.squad) {
    const c = run.condition[p.id]
    if (c.destroyed && !reprint) continue
    run.condition[p.id] = freshCondition(p)
  }
}

export interface RepairOption { id: string; label: string; cost: number }

/** Field repairs available for one mech (Lancer repair costs). */
export function repairOptions(p: PilotBuild, c: MechCondition): RepairOption[] {
  const u = buildMechUnit(p)
  const cheapStruct = u.bonuses.some(b => b.id === 'cheap_struct')
  const out: RepairOption[] = []
  if (c.destroyed) return out
  if (c.hp < u.stats.hp) out.push({ id: 'hp', label: 'Restore all HP', cost: 1 })
  if (c.structure < u.stats.structure) out.push({ id: 'structure', label: 'Repair 1 structure', cost: cheapStruct ? 1 : 2 })
  if (c.stress < u.stats.stress) out.push({ id: 'stress', label: 'Repair 1 reactor stress', cost: 2 })
  for (const w of c.destroyedWeapons) out.push({ id: `w:${w}`, label: `Repair ${u.weapons.find(x => x.dataId === w)?.name ?? w}`, cost: 1 })
  for (const s of c.destroyedSystems) out.push({ id: `s:${s}`, label: `Repair ${u.systems.find(x => x.dataId === s)?.name ?? s}`, cost: 1 })
  return out
}

export function applyRepair(run: RunState, pilotId: string, optId: string) {
  const p = run.squad.find(p => p.id === pilotId)!
  const c = run.condition[pilotId]
  const opt = repairOptions(p, c).find(o => o.id === optId)
  if (!opt || c.repairs < opt.cost) throw new Error('Not enough repairs')
  const u = buildMechUnit(p)
  c.repairs -= opt.cost
  if (optId === 'hp') c.hp = u.stats.hp
  else if (optId === 'structure') { c.structure++; c.hp = u.stats.hp }
  else if (optId === 'stress') c.stress++
  else if (optId.startsWith('w:')) c.destroyedWeapons = c.destroyedWeapons.filter(x => x !== optId.slice(2))
  else if (optId.startsWith('s:')) c.destroyedSystems = c.destroyedSystems.filter(x => x !== optId.slice(2))
}

export const REWARDS: Reward[] = [
  { id: 'repairs', name: 'Field Repair Kit', text: '+2 Repairs for one mech (can exceed its Repair Cap).' },
  { id: 'plating', name: 'Ablative Plating', text: 'Every mech starts the next battle with 4 overshield.' },
  { id: 'intel', name: 'Forward Intel', text: '+1 accuracy on all attacks during the next battle\'s first round.' },
  { id: 'core', name: 'Core Battery', text: 'Recharge one mech\'s CORE power.' },
  { id: 'reprint', name: 'Emergency Print', text: 'Reprint one destroyed mech at full condition.' },
  { id: 'cool', name: 'Coolant Flush', text: 'Reset every mech\'s overcharge track.' },
]

export function rollRewards(seed: number, run: RunState): Reward[] {
  const rng = new Rng(seed)
  const pool = REWARDS.filter(r => r.id !== 'reprint' || Object.values(run.condition).some(c => c.destroyed))
  return rng.shuffle([...pool]).slice(0, 3)
}

export function applyReward(run: RunState, id: string, pilotId?: string) {
  switch (id) {
    case 'repairs': if (pilotId) run.condition[pilotId].repairs += 2; break
    case 'plating': run.boons.push({ reward: 'plating' }); break
    case 'intel': run.boons.push({ reward: 'intel' }); break
    case 'core': if (pilotId) run.condition[pilotId].coreAvailable = true; break
    case 'reprint': if (pilotId) run.condition[pilotId] = freshCondition(run.squad.find(p => p.id === pilotId)!); break
    case 'cool': for (const c of Object.values(run.condition)) c.overchargeLevel = 0; break
  }
}

/** License levels gained per act boss: act 1 LL0, act 2 LL5, act 3 LL10 (core book NPC tiers: T2 LL5-8, T3 LL9-12). */
export const LL_PER_ACT = 5

/** Level the squad up after an act boss: +5 LL (grit/HP). Talents/licenses come from re-importing. */
export function levelUp(run: RunState) {
  for (const p of run.squad) p.level = Math.min(12, p.level + LL_PER_ACT)
  for (const p of run.squad) run.condition[p.id] = freshCondition(p)
  run.pendingLevelUp = false
}

/** Replace pilots with re-imported COMP/CON builds (matched by id or callsign). */
export interface ReplaceReport { replaced: string[]; byCallsign: string[]; ambiguous: string[]; unmatched: string[] }

/**
 * Replace squad pilots with re-imported COMP/CON builds. Match by COMP/CON id first; fall back to
 * callsign only when exactly one squad pilot has that callsign (otherwise it's reported as ambiguous).
 */
export function replacePilots(run: RunState, builds: PilotBuild[]): ReplaceReport {
  const report: ReplaceReport = { replaced: [], byCallsign: [], ambiguous: [], unmatched: [] }
  const taken = new Set<number>()
  for (const b of builds) {
    let i = run.squad.findIndex(p => p.id === b.id)
    if (i >= 0) report.replaced.push(b.callsign)
    else {
      const same = run.squad.map((p, k) => (p.callsign.toLowerCase() === b.callsign.toLowerCase() && !taken.has(k) ? k : -1)).filter(k => k >= 0)
      if (same.length === 1) { i = same[0]; report.byCallsign.push(b.callsign) }
      else if (same.length > 1) { report.ambiguous.push(b.callsign); continue }
      else { report.unmatched.push(b.callsign); continue }
    }
    taken.add(i)
    const old = run.squad[i]
    run.squad[i] = { ...b, id: old.id }
    run.condition[old.id] = freshCondition(run.squad[i])
  }
  return report
}

/**
 * Swap a squad pilot's build for one edited in the in-game builder (same id). Unlike a re-import this is
 * not a repair: damage taken, spent Repairs, destroyed gear, used Limited charges and CORE use carry over.
 */
export function refitPilot(run: RunState, build: PilotBuild): boolean {
  const i = run.squad.findIndex(p => p.id === build.id)
  if (i < 0) return false
  const old = run.squad[i]
  const c = run.condition[old.id] ?? freshCondition(old)
  const was = buildMechUnit(old).stats
  run.squad[i] = build
  const now = buildMechUnit(build).stats
  const fresh = freshCondition(build)
  run.condition[old.id] = {
    ...fresh,
    hp: c.destroyed ? fresh.hp : Math.max(1, Math.min(now.hp, now.hp - (was.hp - c.hp))),
    structure: Math.min(now.structure, c.structure),
    stress: Math.min(now.stress, c.stress),
    repairs: Math.max(0, Math.min(now.repcap, now.repcap - (was.repcap - c.repairs))),
    overchargeLevel: c.overchargeLevel,
    destroyed: c.destroyed,
    coreAvailable: c.coreAvailable,
    destroyedWeapons: [...c.destroyedWeapons],
    destroyedSystems: [...c.destroyedSystems],
    limited: { ...c.limited },
  }
  return true
}

export function chooseTeam(run: RunState, node: RunNode, teams: EnemyTeam[]): EnemyTeam {
  const rng = new Rng(node.seed)
  const used = new Set(run.nodes.filter(n => n.cleared && n.teamId).map(n => n.teamId))
  const fresh = teams.filter(t => !used.has(t.id))
  return rng.pick(fresh.length ? fresh : teams)
}

// ------------------------------------------------------------------ persistence
export const SAVE_VERSION = 1

/** Upgrade functions keyed by the version they upgrade *from*. Add one per breaking change. */
const MIGRATIONS: Record<number, (r: any) => any> = {}

/** Set when the last loadRun() had to discard or repair a save; the title screen shows it. */
export let lastLoadProblem: string | null = null

export function saveRun(run: RunState | null) {
  try {
    if (run) localStorage.setItem(SAVE_KEY, JSON.stringify({ ...run, version: SAVE_VERSION }))
    else localStorage.removeItem(SAVE_KEY)
  } catch { /* storage unavailable */ }
}

/** Structural check so a corrupted or foreign save can't crash the game. */
export function validateRun(r: any): string | null {
  if (!r || typeof r !== 'object') return 'not an object'
  if (!Array.isArray(r.squad) || !r.squad.length) return 'no squad'
  for (const p of r.squad) if (!p?.id || !p?.mech?.frameId || !Array.isArray(p.mech.mounts)) return 'malformed pilot'
  if (!Array.isArray(r.nodes) || !r.nodes.length) return 'no campaign map'
  if (!r.condition || typeof r.condition !== 'object') return 'no mech condition'
  if (r.current != null && !r.nodes.some((n: any) => n.id === r.current)) return 'current node missing'
  return null
}

export function migrateRun(raw: any): RunState | null {
  let r = raw
  let v = typeof r?.version === 'number' ? r.version : 0
  if (v > SAVE_VERSION) { lastLoadProblem = 'This save was made by a newer version of the game and was not loaded.'; return null }
  while (v < SAVE_VERSION) {
    const m = MIGRATIONS[v]
    if (!m) { lastLoadProblem = `Your saved run (format v${v}) is from an incompatible older version and was discarded.`; return null }
    r = m(r)
    v++
  }
  r.version = SAVE_VERSION
  const bad = validateRun(r)
  if (bad) { lastLoadProblem = `Your saved run was damaged (${bad}) and was discarded.`; return null }
  // repair: make sure every squad pilot has a condition entry
  for (const p of r.squad) if (!r.condition[p.id]) r.condition[p.id] = freshCondition(p)
  return r as RunState
}

export function loadRun(): RunState | null {
  lastLoadProblem = null
  let raw: string | null = null
  try { raw = localStorage.getItem(SAVE_KEY) } catch { return null }
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { lastLoadProblem = 'Your saved run could not be read and was discarded.'; return null }
  let run: RunState | null = null
  try { run = migrateRun(parsed) } catch (e) { lastLoadProblem = `Your saved run could not be loaded (${(e as Error).message}).` }
  if (!run) { try { localStorage.removeItem(SAVE_KEY) } catch { /* ignore */ } }
  return run
}
