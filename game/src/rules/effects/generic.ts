// Data-driven actions generated straight from lancer-data structures (no hand-written script needed):
//  * system/weapon actions that carry structured damage + range (grenades, missiles, AoE saves)
//  * invade options (2 heat + logged effect)
//  * deployables: mines, drones, deployable cover
//  * multi-profile weapons: profile switching
// Anything else is exposed as a "text" action that logs its rules so the player can adjudicate.
import { Lancer, type ActionData, type DeployableData } from '../../data/lancer'
import type { Battle } from '../battle'
import { stripHtml } from '../battle'
import { blastTiles, burstTiles, coneTiles, distanceToTile, footprint, hasLineOfSightToTile, lineTiles, unitsOnTiles } from '../grid'
import { rollDice } from '../rng'
import { blankTurnState, defaultPolicies, nextUid, normalizeStatus } from '../stats'
import type { Pos, Stat, SystemInst, Unit, Weapon } from '../types'
import { getScript, type Activation, type CustomAction } from './registry'

const statOf = (s?: string): Stat | undefined =>
  s ? (({ hull: 'hull', agility: 'agi', agi: 'agi', systems: 'sys', sys: 'sys', engineering: 'eng', eng: 'eng' } as Record<string, Stat>)[s.toLowerCase()]) : undefined

export function activationOf(a?: string): Activation | null {
  switch ((a ?? '').toLowerCase()) {
    case 'quick': return 'quick'
    case 'full': return 'full'
    case 'protocol': return 'protocol'
    case 'free': return 'free'
    case 'reaction': return 'reaction'
    case 'quick tech': return 'quick_tech'
    case 'full tech': return 'full_tech'
    case 'invade': return 'quick_tech'
    default: return null
  }
}

/** Is this lancer-data action fully executable by the generic engine? */
export function actionIsStructured(a: ActionData): boolean {
  return !!(a.damage?.length && (a.range?.length || a.activation === 'Invade'))
}

function usesOk(sys: SystemInst | undefined): true | string {
  if (!sys) return true
  if (sys.destroyed) return 'Destroyed'
  if (sys.usesLeft === 0) return 'No uses left'
  return true
}

function spendUse(sys: SystemInst | undefined) {
  if (sys && sys.usesLeft != null) sys.usesLeft--
}

function rangeVal(a: { range?: { type: string; val: any }[] }, type: string): number | undefined {
  const r = a.range?.find(r => r.type === type)
  return r ? Number(r.val) : undefined
}

function damageAction(b: Battle, u: Unit, a: ActionData, keyBase: string, sys?: SystemInst): CustomAction {
  const blast = rangeVal(a, 'Blast'), burst = rangeVal(a, 'Burst'), line = rangeVal(a, 'Line'), cone = rangeVal(a, 'Cone')
  let range = rangeVal(a, 'Range') ?? rangeVal(a, 'Threat') ?? (a.activation === 'Invade' ? u.stats.sensors : 1)
  if (u.flags.assaultLauncher && sys && Lancer.systems.get(sys.dataId)?.tags?.some(t => t.id === 'tg_grenade')) range = Math.max(range, 15)
  const area = burst ? { shape: 'burst' as const, size: burst } : blast ? { shape: 'blast' as const, size: blast } : line ? { shape: 'line' as const, size: line } : cone ? { shape: 'cone' as const, size: cone } : undefined
  const isTech = a.activation === 'Invade' || a.activation === 'Quick Tech' || a.activation === 'Full Tech'
  return {
    key: keyBase,
    name: a.name,
    activation: activationOf(a.activation) ?? 'quick',
    text: stripHtml(a.detail ?? ''),
    target: burst ? 'self' : area ? 'tile' : 'enemy',
    range: burst ? undefined : range,
    techOption: a.activation === 'Invade' ? 'invade' : undefined,
    area,
    sourceUid: sys?.uid,
    usable: () => usesOk(sys),
    run: (bt, self, target) => {
      spendUse(sys)
      let victims: Unit[] = []
      if (area) {
        let tiles: Pos[] = []
        const aim = (target && 'x' in target ? target : (target as Unit | undefined)?.pos) ?? self.pos
        if (burst) tiles = burstTiles(bt.map, self, burst)
        else if (blast) {
          if (distanceToTile(bt.map, self, aim) > range) throw new Error('Out of range')
          if (!hasLineOfSightToTile(bt.effectiveMap(), self, aim)) throw new Error('No line of sight')
          tiles = blastTiles(bt.map, aim, blast)
        } else if (line) tiles = lineTiles(bt.map, self, aim, line)
        else if (cone) tiles = coneTiles(bt.map, self, aim, cone)
        bt.emit({ type: 'area', tiles, kind: 'attack' })
        victims = unitsOnTiles(bt.alive(), tiles).filter(v => v !== self)
      } else if (target && 'id' in target) victims = [target]
      const parts = (a.damage ?? []).map(d => ({ type: d.type, amount: rollDice(bt.rng, d.val).total, save: statOf(d.save), half: d.save_half }))
      for (const v of victims) {
        const save = parts.find(p => p.save)?.save
        if (save) {
          const ok = bt.save(v, save, self.stats.save || 10)
          if (ok && (!parts[0].half || v.isGrunt)) continue
          bt.applyDamage(v, parts.map(p => ({ type: p.type, amount: ok ? bt.halfOnSave(v, p.amount) : p.amount })), { source: self })
        } else {
          const ctx = isTech ? bt.techAttackRoll(self, v, a.name) : (() => {
            const c = bt.newAttackCtx(self, v, { mode: 'free', multiTarget: victims.length > 1 })
            if (bt.has(self, 'impaired')) c.difficulty++
            const cov = bt.cover(self, v)
            if (cov === 'hard') c.difficulty += 2
            else if (cov === 'soft') c.difficulty++
            bt.rollToHit(c)
            return c
          })()
          if (ctx.hit) bt.applyDamage(v, parts.map(p => ({ type: p.type, amount: p.amount })), { source: self, attack: ctx })
        }
      }
      if (a.detail && !a.damage?.length) bt.say(`  ${stripHtml(a.detail)}`)
    },
    aiScore: (bt, self, target) => {
      const avg = (a.damage ?? []).reduce((s, d) => s + (typeof d.val === 'number' ? d.val : rollAvg(d.val)), 0)
      return avg
    },
  }
}

function rollAvg(v: string): number {
  const m = v.match(/(\d*)d(\d+)([+-]\d+)?/)
  if (!m) return Number(v) || 0
  return (Number(m[1] || 1) * (Number(m[2]) + 1)) / 2 + Number(m[3] || 0)
}

function textAction(a: ActionData, keyBase: string, sys?: SystemInst): CustomAction | null {
  const act = activationOf(a.activation)
  if (!act || act === 'reaction') return null
  return {
    key: keyBase,
    name: a.name,
    activation: act,
    text: stripHtml(a.detail ?? ''),
    target: 'none',
    sourceUid: sys?.uid,
    usable: () => usesOk(sys),
    run: (bt, self) => {
      spendUse(sys)
      bt.say(`  [manual] ${stripHtml(a.detail ?? '')}`, 'warn')
    },
  }
}

export function deployableUnit(owner: Unit, d: DeployableData, pos: Pos): Unit {
  const isDrone = d.type === 'Drone'
  const size = d.size ?? (isDrone ? 0.5 : 1)
  const hpBonus = owner.bonuses.filter(b => b.id === (isDrone ? 'drone_hp' : 'deployable_hp')).reduce((a, b) => a + Number(b.val), 0)
  const resistAll = owner.bonuses.some(b => b.id === (isDrone ? 'drone_resist' : 'deployable_resist'))
  const hp = (d.hp ?? 5) + hpBonus
  const u: Unit = {
    id: nextUid('dep'),
    name: d.name,
    side: owner.side,
    kind: isDrone ? 'drone' : 'deployable',
    pos,
    flying: isDrone,
    stats: {
      hp, armor: d.armor ?? 0, evasion: d.evasion ?? 5, edef: d.edef ?? 5, heatcap: 0, speed: d.speed ?? 0, sensors: 10, save: owner.stats.save,
      techAttack: owner.stats.techAttack, structure: 1, stress: 1, repcap: 0, size: Math.min(size, 3), hull: 0, agi: 0, sys: 0, eng: 0, grit: owner.stats.grit,
      limitedBonus: 0, attackBonus: owner.stats.attackBonus, activations: 0,
    },
    hp, heat: 0, structure: 1, stress: 1, overshield: 0, burn: 0, repairs: 0, coreAvailable: false, coreActive: false, overchargeLevel: 0,
    statuses: [], resist: resistAll ? ['all'] : [], immune: [], weapons: [], systems: [], talents: [], coreBonuses: [],
    canCrit: false, ...blankTurnState(), activationsLeft: 0, bonuses: [], flags: { isCover: d.type === 'Deployable' && size >= 1 && !d.damage, dataName: d.name },
    destroyed: false, ownerId: owner.id, policies: defaultPolicies(),
  }
  return u
}

function deployAction(b: Battle, u: Unit, d: DeployableData, keyBase: string, sys?: SystemInst, parentActivation?: string): CustomAction | null {
  const act = activationOf(d.activation ?? parentActivation ?? 'Quick') ?? 'quick'
  const isMine = d.type === 'Mine'
  const range = isMine && u.flags.assaultLauncher ? 15 : rangeVal(d, 'Range') ?? 5
  const radius = rangeVal(d, 'Burst') ?? rangeVal(d, 'Blast') ?? 1
  const live = () => b.alive().filter(x => x.ownerId === u.id && x.flags.dataName === d.name).length
  return {
    key: keyBase,
    name: `Deploy ${d.name}`,
    activation: act === 'reaction' ? 'quick' : act,
    text: stripHtml(d.detail ?? ''),
    target: 'tile',
    range,
    area: isMine ? { shape: 'blast', size: radius } : undefined,
    sourceUid: sys?.uid,
    usable: (bt, self) => {
      const ok = usesOk(sys)
      if (ok !== true) return ok
      if (!isMine && d.type !== 'Rocket' && live() >= ((d as any).instances ?? 1)) return 'Already deployed'
      return true
    },
    run: (bt, self, target) => {
      const p = target && 'x' in target ? target : self.pos
      if (distanceToTile(bt.map, self, p) > range) throw new Error('Out of range')
      spendUse(sys)
      if (isMine) {
        const dmg = d.damage ?? []
        bt.placeMine(self, p, { name: d.name, radius, damage: dmg, save: statOf(dmg[0]?.save), saveHalf: (dmg[0] as any)?.save_half })
        if (!dmg.length) bt.say(`  [manual] ${stripHtml(d.detail ?? '')}`, 'warn')
        return
      }
      const unit = deployableUnit(self, d, p)
      const occupied = footprint(unit).some(q => bt.alive().some(o => footprint(o).some(z => z.x === q.x && z.y === q.y)))
      if (occupied) throw new Error('Space occupied')
      bt.spawn(unit)
      bt.say(`${self.name} deploys ${d.name}.`)
      if (d.detail) bt.say(`  ${stripHtml(d.detail)}`)
    },
  }
}

/** Generic, data-driven actions for a unit (skips items that have a script providing actions). */
export function genericActionsFor(b: Battle, u: Unit): CustomAction[] {
  const out: CustomAction[] = []
  if (u.kind !== 'mech') return out
  for (const s of u.systems) {
    if (s.destroyed || s.feature) continue
    if (getScript(s.dataId)?.actions) continue
    const d = Lancer.systems.get(s.dataId)
    if (!d) continue
    ;(d.actions ?? []).forEach((a, i) => {
      const named = { ...a, name: a.name ?? (d.actions!.length > 1 ? `${s.name} ${i + 1}` : s.name) }
      if (a.activation === 'Invade' || actionIsStructured(a)) out.push(damageAction(b, u, named, `${s.uid}:a${i}`, s))
      else { const t = textAction(named, `${s.uid}:a${i}`, s); if (t) out.push(t) }
    })
    ;(d.deployables ?? []).forEach((dep, i) => {
      const da = deployAction(b, u, dep, `${s.uid}:d${i}`, s, d.actions?.[0]?.activation)
      if (da) out.push(da)
    })
  }
  for (const w of u.weapons) {
    if (w.destroyed || !w.dataId) continue
    if (getScript(w.dataId)?.actions) continue
    const d = Lancer.weapons.get(w.dataId)
    if (!d) continue
    if (w.profiles.length > 1) {
      w.profiles.forEach((p, i) => {
        if (i === w.profileIndex) return
        const pd = d.profiles?.[w.profileIndex]
        const act = activationOf(pd?.actions?.[0]?.activation) ?? 'free'
        out.push({
          key: `${w.uid}:p${i}`, name: `${w.name}: ${p.name}`, activation: act, text: stripHtml(p.text ?? ''), target: 'none',
          usable: () => true,
          run: (bt, self) => {
            w.profileIndex = i
            bt.say(`${self.name} switches ${w.name} to ${p.name}.`)
            if (/slowed/i.test(p.text ?? '')) bt.addStatus(self, 'slowed', 'until_cleared', self, { profile: w.uid })
            else self.statuses = self.statuses.filter(s => !(s.id === 'slowed' && s.data?.profile === w.uid))
          },
        })
      })
    }
    ;(d.deployables ?? []).forEach((dep, i) => {
      const da = deployAction(b, u, dep, `${w.uid}:d${i}`)
      if (da) out.push(da)
    })
  }
  return out
}

export { normalizeStatus }
