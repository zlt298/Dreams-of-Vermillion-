// Roguelike campaign layer: a branching node map over three acts (tiers 1-3), persistent mech
// damage between fights, Lancer-style repairs at rest, rewards, and localStorage saves.
import { importPilots, type PilotBuild } from '../import/compcon'
import pregens from '../data/pregens/pregens.json'
import { applyPrototypeConfig } from '../rules/effects/scripts/weapons2'
import { buildMechUnit, dropSystemBonuses } from '../rules/stats'
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
  /** Prototype Weapon set-up (weapon type, damage type) until the next Full Repair */
  proto?: Record<string, { type: string; damage: string; revision?: string[] }>
  /** Bonded: the Bondmate's pilot id */
  bondmate?: string
  /** Grease Monkey 3: the supply drop was called since the last Full Repair */
  supplyDropUsed?: boolean
  /** OSIRIS: the next Gate of Hurl Into the Duat (persists between scenes, resets at a rest or Full Repair) */
  duatGate?: number
  /** unit flags named 'keep:…' that last between scenes until a Full Repair (Sherman ZF4 charges) */
  keep?: Record<string, unknown>
  /** Manticore Castigation State (set at a rest or Full Repair) */
  castigation?: boolean
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
  /** combat nodes whose between-battle event has been rolled */
  eventsSeen?: string[]
  /** forecast iteration number of this run (cosmetic framing, ui/forecast.ts) */
  iteration?: number
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

/** A fresh condition that keeps what lasts the whole run (the Bonded talent's Bondmate). */
export function resetCondition(run: RunState, p: PilotBuild): MechCondition {
  const c = freshCondition(p)
  const mate = run.condition[p.id]?.bondmate
  if (mate) c.bondmate = mate
  if (run.condition[p.id]?.castigation) c.castigation = true
  return c
}

/** Manticore: push it into the Castigation State or bring it out of one (at a rest or Full Repair). */
export function setCastigation(run: RunState, pilotId: string, on: boolean) {
  const c = run.condition[pilotId]
  if (on) c.castigation = true
  else delete c.castigation
}

/**
 * Extra max HP from permanent boons. MechCondition.hp is kept relative to the mech's own max HP
 * (what freshCondition and the repairs use), so the boon is added in battle and taken off again after.
 */
export function permHpBonus(run: RunState, pilotId: string): number {
  return run.boons.filter(b => b.reward === 'perm_hp2' && (!b.pilotId || b.pilotId === pilotId)).length * 2
}

/** Lowest stored HP that still means "1 HP left in battle" (stored HP doesn't include permanent HP boons). */
export function minHp(run: RunState, pilotId: string): number {
  return 1 - permHpBonus(run, pilotId)
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
    if (c.destroyed) { out.push(standInUnit(p)); continue }
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
      if (c.destroyedSystems.includes(s.dataId)) { s.destroyed = true; dropSystemBonuses(u, s) }
      if (c.limited[s.dataId] != null && s.usesLeft != null) s.usesLeft = c.limited[s.dataId]
    }
    u.flags.pilotId = p.id
    if (c.bondmate) u.flags.bondmatePilot = c.bondmate
    if (c.duatGate) u.flags.duatGate = c.duatGate
    if (c.keep) Object.assign(u.flags, structuredClone(c.keep))
    if (c.castigation) u.flags.castigation = true
    for (const w of u.weapons) if (w.dataId && c.proto?.[w.dataId]) applyPrototypeConfig(w, c.proto[w.dataId].type, c.proto[w.dataId].damage, true, c.proto[w.dataId].revision)
    for (const b of run.boons.filter(b => !b.pilotId || b.pilotId === p.id)) applyBoon(u, b.reward)
    out.push(u)
  }
  return out
}

/** The stock LL0 Everest a pilot flies while their own mech waits to be reprinted (COMP/CON's Assault pregen). */
const STAND_IN = (pregens as any[]).find(x => x.name === 'Assault')
/**
 * A destroyed mech's pilot fights in a fresh stock Everest until the next rest reprints their own. Losing a mech
 * otherwise snowballs: a squad down one mech loses about three times as many in its next fight.
 */
export function standInUnit(p: PilotBuild): Unit {
  const build = importPilots(structuredClone(STAND_IN))[0]
  const u = buildMechUnit(build)
  u.name = `${p.callsign} (stand-in)`
  u.flags.pilotId = p.id
  u.flags.standIn = true
  return u
}

function applyBoon(u: Unit, id: string) {
  switch (id) {
    // one battle
    case 'plating': case 'plating_one': u.overshield = Math.max(u.overshield, 4); break
    case 'intel': u.bonuses.push({ id: 'attack', accuracy: 1, condition: '{first_round}' }); break
    case 'intel2': u.bonuses.push({ id: 'attack', accuracy: 1, condition: '{early_rounds}' }); break
    case 'tech_booster': u.bonuses.push({ id: 'tech_attack', accuracy: 1 } as any); break
    case 'hotload': u.bonuses.push({ id: 'damage', val: 1 }); break
    case 'impaired_start': u.statuses.push({ id: 'impaired', clockUnit: u.id, turnsLeft: 1 }); break
    case 'stunned_start': u.statuses.push({ id: 'stunned', clockUnit: u.id, turnsLeft: 1 }); break
    // permanent (rest of the run)
    case 'perm_hp2': u.stats.hp += 2; u.hp += 2; break
    case 'perm_acc': u.bonuses.push({ id: 'attack', accuracy: 1 }); break
    case 'perm_armor': u.stats.armor = Math.min(4, u.stats.armor + 1); break
    case 'perm_evade': u.stats.evasion += 1; u.stats.edef += 1; break
  }
}
/** Boons that last one battle (the rest are permanent). */
export const ONE_BATTLE_BOONS = ['plating', 'plating_one', 'intel', 'intel2', 'tech_booster', 'hotload', 'impaired_start', 'stunned_start']

/** After a battle: write unit state back into the run. Heat/statuses clear at end of scene. */
export function recordBattle(run: RunState, node: RunNode, units: Unit[], won: boolean) {
  for (const u of units) {
    const pid = u.flags.pilotId as string | undefined
    // a stand-in's damage doesn't carry over: the pilot's own mech stays destroyed until the next rest
    if (!pid || u.kind !== 'mech' || u.flags.standIn) continue
    const c = run.condition[pid]
    // lost in blinkspace (Mourning Cloak): gone for the scene, back after the rest
    const v = u.flags.vanished as { hp: number; structure: number; stress: number } | undefined
    const gone = u.destroyed && !v
    c.destroyed = gone
    c.hp = gone ? 0 : (v ? v.hp : u.hp) - permHpBonus(run, pid)
    c.structure = gone ? 0 : v ? v.structure : u.structure
    c.stress = gone ? 0 : v ? v.stress : u.stress
    c.repairs = u.repairs
    c.overchargeLevel = u.overchargeLevel
    // a CORE whose text refunds it when unused this scene (Barbarossa Charge Rail never fired)
    c.coreAvailable = u.coreAvailable || !!u.flags.refundCore
    const keep = Object.fromEntries(Object.entries(u.flags).filter(([k]) => k.startsWith('keep:')))
    if (Object.keys(keep).length) c.keep = keep
    // Balor Self-Perpetuating: the rest after the fight restores its HP without repairs
    if (!gone && !v && u.frameId === 'mf_balor') c.hp = u.stats.hp - permHpBonus(run, pid)
    // gear taken off in a refit keeps its destroyed mark (refitting it back is not a free repair)
    c.destroyedWeapons = [...u.weapons.filter(w => w.destroyed && w.dataId).map(w => w.dataId!), ...c.destroyedWeapons.filter(id => !u.weapons.some(w => w.dataId === id))]
    c.destroyedSystems = [...u.systems.filter(s => s.destroyed).map(s => s.dataId), ...c.destroyedSystems.filter(id => !u.systems.some(s => s.dataId === id))]
    for (const w of u.weapons) if (w.dataId && w.usesLeft != null) c.limited[w.dataId] = w.usesLeft
    for (const w of u.weapons) if (w.dataId && w.flags?.protoLocked) (c.proto ??= {})[w.dataId] = { type: w.flags.protoType, damage: w.flags.protoDamage, ...(w.flags.protoRevision ? { revision: [...w.flags.protoRevision] } : {}) }
    if (u.flags.bondmatePilot) c.bondmate = u.flags.bondmatePilot
    if (u.flags.duatGate != null) c.duatGate = u.flags.duatGate
    for (const s of u.systems) if (s.usesLeft != null) c.limited[s.dataId] = s.usesLeft
  }
  // one-battle boons are consumed
  run.boons = run.boons.filter(b => !ONE_BATTLE_BOONS.includes(b.reward))
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
  // a squad whose own mechs are all destroyed still fights on in stand-ins: only a lost battle ends the run
}

/** Rest node / between acts: Lancer full repair (restores everything, reprints destroyed mechs). */
export function fullRepair(run: RunState, reprint = true) {
  for (const p of run.squad) {
    const c = run.condition[p.id]
    if (c.destroyed && !reprint) continue
    run.condition[p.id] = resetCondition(run, p)
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
  // only gear that is fitted can be repaired (entries for gear taken off in a refit wait until it is fitted again)
  for (const w of new Set(c.destroyedWeapons)) { const x = u.weapons.find(y => y.dataId === w); if (x) out.push({ id: `w:${w}`, label: `Repair ${x.name}`, cost: 1 }) }
  for (const s of new Set(c.destroyedSystems)) { const x = u.systems.find(y => y.dataId === s); if (x) out.push({ id: `s:${s}`, label: `Repair ${x.name}`, cost: 1 }) }
  // Grease Monkey (talent): replenish Limited uses while resting
  const gm = p.talents.find(t => t.id === 't_grease_monkey')?.rank ?? 0
  if (gm >= 1 && limitedSpent(u, c).length) out.push({ id: 'gm_limited', label: 'Unsanctioned Capacity Upgrade: +1 use of every Limited item', cost: 2 })
  if (gm >= 3 && !c.supplyDropUsed) out.push({ id: 'gm_supply', label: 'Friends in High Places: supply drop (every mech +1 Limited use, +1 Structure)', cost: 0 })
  return out
}

/** Limited weapons and systems of this mech with uses spent (data id and full uses). Prototype weapons reroll theirs. */
function limitedSpent(u: Unit, c: MechCondition): { id: string; max: number }[] {
  const out: { id: string; max: number }[] = []
  for (const x of [...u.weapons, ...u.systems]) {
    if (!x.dataId || x.usesLeft == null || x.usesLeft < 0) continue
    const left = c.limited[x.dataId]
    if (left != null && left < x.usesLeft && !out.some(o => o.id === x.dataId)) out.push({ id: x.dataId, max: x.usesLeft })
  }
  return out
}
/** +1 use of every spent Limited item (Grease Monkey). */
function refillOne(p: PilotBuild, c: MechCondition) {
  for (const l of limitedSpent(buildMechUnit(p), c)) c.limited[l.id] = Math.min(l.max, c.limited[l.id] + 1)
}

export function applyRepair(run: RunState, pilotId: string, optId: string) {
  const p = run.squad.find(p => p.id === pilotId)!
  const c = run.condition[pilotId]
  const opt = repairOptions(p, c).find(o => o.id === optId)
  if (!opt || c.repairs < opt.cost) throw new Error('Not enough repairs')
  const u = buildMechUnit(p)
  c.repairs -= opt.cost
  if (optId === 'hp') c.hp = u.stats.hp
  // core p.82: 2 Repairs restore 1 Structure; full HP is a separate repair
  else if (optId === 'structure') c.structure++
  else if (optId === 'stress') c.stress++
  else if (optId.startsWith('w:')) c.destroyedWeapons = c.destroyedWeapons.filter(x => x !== optId.slice(2))
  else if (optId.startsWith('s:')) c.destroyedSystems = c.destroyedSystems.filter(x => x !== optId.slice(2))
  else if (optId === 'gm_limited') refillOne(p, c)
  else if (optId === 'gm_supply') {
    // you and your allies: +1 use of every Limited item and 1 Structure, free (above the Repair Cap too)
    c.supplyDropUsed = true
    for (const q of run.squad) {
      const qc = run.condition[q.id]
      if (!qc || qc.destroyed) continue
      refillOne(q, qc)
      qc.structure = Math.min(buildMechUnit(q).stats.structure, qc.structure + 1)
    }
  }
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
    case 'reprint': if (pilotId) run.condition[pilotId] = resetCondition(run, run.squad.find(p => p.id === pilotId)!); break
    case 'cool': for (const c of Object.values(run.condition)) c.overchargeLevel = 0; break
  }
}

/**
 * The squad's License Level in each act: act 1 LL2, act 2 LL5, act 3 LL8. LL2 lets pilots field a licensed
 * frame from the first fight, and +3 per act keeps a pilot recognizable after a level-up. Act n still fights
 * tier-n enemies (the core book pairs T2 with LL5-8 and T3 with LL9-12).
 */
export const ACT_LEVEL: Record<number, number> = { 1: 2, 2: 5, 3: 8 }
export const actLevel = (act: number) => ACT_LEVEL[act] ?? ACT_LEVEL[ACTS]

/**
 * Level the squad up after an act boss: every pilot goes to the new act's License Level (grit and HP now).
 * The new talent, license, skill and core bonus points still have to be spent: the run map holds the squad
 * at the level-up screen until each build is legal and fully spent (in the builder, or re-imported).
 */
export function levelUp(run: RunState) {
  const level = actLevel(run.act)
  for (const p of run.squad) {
    // the act boss already fully repaired the squad; what was earned or paid since (a Field Repair Kit
    // above the Repair Cap, a pact's destroyed system, spent charges...) must survive the level-up
    const c = run.condition[p.id] ?? freshCondition(p)
    const was = buildMechUnit(p).stats
    if (p.level < level) p.level = level
    const now = buildMechUnit(p).stats
    run.condition[p.id] = {
      ...c,
      // the new License Level's grit comes with full HP
      hp: c.destroyed ? c.hp : now.hp,
      structure: Math.min(now.structure, c.structure),
      stress: Math.min(now.stress, c.stress),
      repairs: Math.max(0, c.repairs + now.repcap - was.repcap),
    }
  }
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
    // like a refit, a re-import is not a repair: damage, destroyed gear and a destroyed mech carry over
    refitPilot(run, { ...b, id: run.squad[i].id })
  }
  return report
}

/**
 * Swap a squad pilot's build for one edited in the in-game builder or re-imported (same id). This is
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
  // gear in the new build, and the most uses each Limited item can hold
  const u = buildMechUnit(build)
  const maxUses: Record<string, number> = {}
  for (const x of [...u.weapons, ...u.systems]) if (x.dataId && x.usesLeft != null) maxUses[x.dataId] = Math.max(maxUses[x.dataId] ?? 0, x.usesLeft)
  const limited: Record<string, number> = {}
  for (const [id, n] of Object.entries(c.limited)) limited[id] = maxUses[id] != null ? Math.min(maxUses[id], n) : n
  run.condition[old.id] = {
    ...fresh,
    hp: c.destroyed ? fresh.hp : Math.max(minHp(run, old.id), Math.min(now.hp, now.hp - (was.hp - c.hp))),
    structure: Math.min(now.structure, c.structure),
    stress: Math.min(now.stress, c.stress),
    // Repairs spent stay spent; Repairs above the cap (Field Repair Kit, events) stay too
    repairs: Math.max(0, c.repairs + now.repcap - was.repcap),
    overchargeLevel: c.overchargeLevel,
    destroyed: c.destroyed,
    coreAvailable: c.coreAvailable,
    // kept even for gear no longer fitted: putting it back later must not repair it for free
    destroyedWeapons: [...c.destroyedWeapons],
    destroyedSystems: [...c.destroyedSystems],
    limited,
    // the Prototype Weapon set-up lasts until the next Full Repair (only applied to matching weapons)
    ...(c.proto ? { proto: structuredClone(c.proto) } : {}),
    ...(c.bondmate ? { bondmate: c.bondmate } : {}),
    ...(c.duatGate ? { duatGate: c.duatGate } : {}),
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

/** A saved condition entry with every field present and of the right type; bad or missing fields are taken from `fresh`. */
function repairCondition(c: any, fresh: MechCondition): MechCondition {
  if (!c || typeof c !== 'object') return fresh
  const out: any = { ...fresh, ...c }
  for (const k of ['hp', 'structure', 'stress', 'repairs', 'overchargeLevel'] as const) if (typeof out[k] !== 'number' || !Number.isFinite(out[k])) out[k] = fresh[k]
  for (const k of ['destroyed', 'coreAvailable'] as const) if (typeof out[k] !== 'boolean') out[k] = fresh[k]
  for (const k of ['destroyedWeapons', 'destroyedSystems'] as const) out[k] = Array.isArray(out[k]) ? out[k].filter((x: unknown) => typeof x === 'string') : []
  if (!out.limited || typeof out.limited !== 'object' || Array.isArray(out.limited)) out.limited = {}
  return out
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
  // repair: every squad pilot has a complete condition entry (missing or malformed fields come from a fresh one)
  for (const p of r.squad) r.condition[p.id] = repairCondition(r.condition[p.id], freshCondition(p))
  return r as RunState
}

export function loadRun(): RunState | null {
  lastLoadProblem = null
  let raw: string | null = null
  try { raw = localStorage.getItem(SAVE_KEY) } catch { return null }
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    lastLoadProblem = 'Your saved run could not be read and was discarded.'
    try { localStorage.removeItem(SAVE_KEY) } catch { /* ignore */ }
    return null
  }
  let run: RunState | null = null
  try { run = migrateRun(parsed) } catch (e) { lastLoadProblem = `Your saved run could not be loaded (${(e as Error).message}).` }
  // a save from a newer version of the game is kept for that version, not deleted
  const newer = typeof (parsed as any)?.version === 'number' && (parsed as any).version > SAVE_VERSION
  if (!run && !newer) { try { localStorage.removeItem(SAVE_KEY) } catch { /* ignore */ } }
  return run
}
