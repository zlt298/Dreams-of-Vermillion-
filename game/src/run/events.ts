// Random events between combats: 25% nothing, 50% a minor find (+1), 15% a minor sacrifice for +2,
// 10% a heavy sacrifice (on the scale of losing a Structure) for a huge benefit.
import { Rng } from '../rules/rng'
import { buildMechUnit } from '../rules/stats'
import { minHp, resetCondition, type RunNode, type RunState } from './run'

export type EventTier = 'find' | 'gamble' | 'pact'

export interface RunEvent {
  id: string
  tier: EventTier
  title: string
  /** flavour */
  text: string
  /** the mechanical effect, shown under the flavour */
  effect: string
  /** a mech must be chosen */
  needsMech: boolean
  /** can this mech pay the cost? (true or the reason it can't) */
  eligible?(run: RunState, pilotId: string): true | string
  apply(run: RunState, pilotId?: string): string
}

// ------------------------------------------------------------------ helpers
const cond = (run: RunState, id: string) => run.condition[id]
const alive = (run: RunState) => run.squad.filter(p => !run.condition[p.id]?.destroyed)
const name = (run: RunState, id?: string) => run.squad.find(p => p.id === id)?.callsign ?? 'the squad'
const boon = (run: RunState, reward: string, pilotId?: string) => run.boons.push({ reward, pilotId })
const notDestroyed = (run: RunState, id: string): true | string => (cond(run, id)?.destroyed ? 'Destroyed' : true)
const both = (...xs: (true | string)[]) => xs.find(x => x !== true) ?? true

/** Limited items on a pilot's mech with their maximum uses. */
function limitedItems(run: RunState, id: string): { dataId: string; max: number }[] {
  const p = run.squad.find(x => x.id === id)
  if (!p) return []
  const u = buildMechUnit(p)
  return [...u.weapons, ...u.systems].filter(x => x.usesLeft != null && x.dataId).map(x => ({ dataId: x.dataId!, max: x.usesLeft! }))
}
function intactSystems(run: RunState, id: string): string[] {
  const p = run.squad.find(x => x.id === id)
  if (!p) return []
  const c = cond(run, id)
  return p.mech.systems.filter(s => !c.destroyedSystems.includes(s))
}
function destroySystem(run: RunState, id: string, seed: number): string {
  const sys = intactSystems(run, id)
  const pick = sys[new Rng(seed).int(0, sys.length - 1)]
  cond(run, id).destroyedSystems.push(pick)
  return pick
}

// ------------------------------------------------------------------ the events
export const EVENTS: RunEvent[] = [
  // ---------------- minor finds (+1)
  {
    id: 'field_kit', tier: 'find', title: 'Abandoned Field Kit', needsMech: true,
    text: 'A Union med-crate half-sunk in a drainage ditch, seals intact.', effect: '+1 Repair to one mech.',
    eligible: notDestroyed,
    apply: (run, id) => { cond(run, id!).repairs++; return `${name(run, id)} gains 1 Repair.` },
  },
  {
    id: 'coolant', tier: 'find', title: 'Coolant Cache', needsMech: true,
    text: 'A cracked coolant tank, still under pressure. Enough to flush one reactor.', effect: "Reset one mech's overcharge track.",
    eligible: notDestroyed,
    apply: (run, id) => { cond(run, id!).overchargeLevel = 0; return `${name(run, id)}'s overcharge track resets.` },
  },
  {
    id: 'magazines', tier: 'find', title: 'Spare Magazines', needsMech: true,
    text: "A dead Choir picket's ammunition racks. Most of it fits.", effect: '+1 use to every Limited weapon and system on one mech (or +1 Repair if it has none).',
    eligible: notDestroyed,
    apply: (run, id) => {
      const c = cond(run, id!)
      const items = limitedItems(run, id!)
      if (!items.length) { c.repairs++; return `${name(run, id)} gains 1 Repair.` }
      for (const it of items) c.limited[it.dataId] = (c.limited[it.dataId] ?? it.max) + 1
      return `${name(run, id)} restocks its Limited items (+1 each).`
    },
  },
  {
    id: 'plating', tier: 'find', title: 'Salvaged Plating', needsMech: true,
    text: 'Armour panels peeled off a burned-out hauler. They bolt on well enough.', effect: 'One mech starts the next battle with 4 overshield.',
    eligible: notDestroyed,
    apply: (run, id) => { boon(run, 'plating_one', id); return `${name(run, id)} bolts on salvaged plating.` },
  },
  {
    id: 'chatter', tier: 'find', title: 'Intercepted Chatter', needsMech: false,
    text: 'The Choir sings on an open channel. Somewhere in the hymn are their positions.', effect: 'Every mech gets +1 accuracy in the next battle’s first round.',
    apply: run => { boon(run, 'intel'); return 'The lance maps the Choir’s positions.' },
  },
  {
    id: 'booster', tier: 'find', title: 'Signal Booster', needsMech: true,
    text: 'A Union relay mast, still powered. One mech can slave its EWAR suite to it.', effect: 'One mech gets +1 accuracy on tech attacks in the next battle.',
    eligible: notDestroyed,
    apply: (run, id) => { boon(run, 'tech_booster', id); return `${name(run, id)} patches into the relay.` },
  },
  // ---------------- minor sacrifice for +2
  {
    id: 'burning_warehouse', tier: 'gamble', title: 'Burning Warehouse', needsMech: true,
    text: 'A crate of mech-grade plating sits in a warehouse going up in flames. Someone could go in after it.',
    effect: 'One mech takes 6 damage (not below 1 HP) and gains a permanent +2 HP.',
    eligible: notDestroyed,
    apply: (run, id) => { const c = cond(run, id!); c.hp = Math.max(minHp(run, id!), c.hp - 6); boon(run, 'perm_hp2', id); return `${name(run, id)} comes out scorched, carrying reinforced plating.` },
  },
  {
    id: 'reactor_tap', tier: 'gamble', title: 'Reactor Tap', needsMech: true,
    text: 'A broken generator still holds charge. Bleeding it into your reactor is not sanctioned procedure.',
    effect: "One mech marks +1 on its overcharge track and recharges its CORE.",
    eligible: (run, id) => both(notDestroyed(run, id), cond(run, id).coreAvailable ? 'CORE already charged' : true),
    apply: (run, id) => { const c = cond(run, id!); c.overchargeLevel = Math.min(3, c.overchargeLevel + 1); c.coreAvailable = true; return `${name(run, id)}'s CORE hums back to life.` },
  },
  {
    id: 'strip_wreck', tier: 'gamble', title: 'Strip the Wreck', needsMech: true,
    text: 'Your own spares could make ablative plating for the whole lance, if someone gives them up.',
    effect: 'One mech spends 1 Repair; every mech starts the next battle with 4 overshield.',
    eligible: (run, id) => both(notDestroyed(run, id), cond(run, id).repairs < 1 ? 'No Repairs to spend' : true),
    apply: (run, id) => { cond(run, id!).repairs--; boon(run, 'plating'); return `${name(run, id)} hands over its spares; the lance is plated up.` },
  },
  {
    id: 'relay_spike', tier: 'gamble', title: 'Choir Relay Spike', needsMech: true,
    text: 'A Choir relay node, still singing. A pilot could jack in and pull their battle plan, and take some of the song with them.',
    effect: 'That mech starts the next battle Impaired; every mech gets +1 accuracy for the next battle’s first two rounds.',
    eligible: notDestroyed,
    apply: (run, id) => { boon(run, 'impaired_start', id); boon(run, 'intel2'); return `${name(run, id)} pulls the plan. The hymn won't leave their head.` },
  },
  {
    id: 'hot_loaded', tier: 'gamble', title: 'Hot-Loaded Rounds', needsMech: true,
    text: 'The fab bay can overpack ammunition, at the cost of what you already carry.',
    effect: 'One mech loses all charges of one Limited item (or 1 Repair if it has none); its weapons deal +1 damage next battle.',
    eligible: (run, id) => both(notDestroyed(run, id), limitedItems(run, id).some(it => (cond(run, id).limited[it.dataId] ?? it.max) > 0) || cond(run, id).repairs >= 1 ? true : 'Nothing to give up'),
    apply: (run, id) => {
      const c = cond(run, id!)
      const items = limitedItems(run, id!).filter(it => (c.limited[it.dataId] ?? it.max) > 0)
      if (items.length) c.limited[items[0].dataId] = 0
      else c.repairs = Math.max(0, c.repairs - 1)
      boon(run, 'hotload', id)
      return `${name(run, id)} loads hot rounds.`
    },
  },
  {
    id: 'shortcut', tier: 'gamble', title: 'The Collapsing Shortcut', needsMech: false,
    text: 'The floor of the old processing hall is failing. Dropping through it saves hours, if you don’t mind the landing.',
    effect: 'Every mech takes 2 damage (not below 1 HP) and gains +1 Repair.',
    apply: run => { for (const p of alive(run)) { const c = cond(run, p.id); c.hp = Math.max(minHp(run, p.id), c.hp - 2); c.repairs++ } return 'The lance drops through. Bruised, but ahead of schedule.' },
  },
  // ---------------- heavy sacrifice for a huge benefit
  {
    id: 'targeting_core', tier: 'pact', title: 'Navy Wreck Targeting Core', needsMech: true,
    text: 'A crashed Navy cutter’s fire-control core, still warm. Fitting it means tearing out one of your own systems.',
    effect: 'One mech has a random system destroyed; it gains a permanent +1 accuracy on all attacks.',
    eligible: (run, id) => both(notDestroyed(run, id), intactSystems(run, id).length ? true : 'No intact systems'),
    apply: (run, id) => { const s = destroySystem(run, id!, run.battlesWon * 31 + 7); boon(run, 'perm_acc', id); return `${name(run, id)} fits the Navy core (${s} destroyed).` },
  },
  {
    id: 'through_fire', tier: 'pact', title: 'Through the Fire', needsMech: true,
    text: 'A bulkhead is coming down. One mech can hold it while the rest of the lance gets through to a working repair bay.',
    effect: 'That mech loses 1 Structure; every other mech gets a full repair.',
    eligible: (run, id) => both(notDestroyed(run, id), cond(run, id).structure < 2 ? 'Needs 2+ Structure' : true),
    apply: (run, id) => {
      cond(run, id!).structure--
      for (const p of run.squad) if (p.id !== id && !run.condition[p.id].destroyed) run.condition[p.id] = { ...resetCondition(run, p), limited: {}, overchargeLevel: 0, coreAvailable: run.condition[p.id].coreAvailable }
      return `${name(run, id)} holds the door. The others are made whole.`
    },
  },
  {
    id: 'voice_static', tier: 'pact', title: 'A Voice in the Static', needsMech: true,
    text: 'Something in the casket reaches out through one pilot’s neural link. It is gentle, and it is enormous. Every reactor in the lance answers.',
    effect: 'That mech is Stunned for the next battle’s first round; every mech’s CORE is recharged.',
    eligible: notDestroyed,
    apply: (run, id) => { boon(run, 'stunned_start', id); for (const p of alive(run)) cond(run, p.id).coreAvailable = true; return `${name(run, id)} hears it. Every CORE comes alive.` },
  },
  {
    id: 'choir_armoury', tier: 'pact', title: 'Choir Armoury', needsMech: true,
    text: 'A reinforced Choir vault. Breaching it means running a reactor well past safe limits.',
    effect: 'One mech loses 1 Stress; it gains a permanent +1 Armor (max 4).',
    eligible: (run, id) => both(notDestroyed(run, id), cond(run, id).stress < 2 ? 'Needs 2+ Stress' : true),
    apply: (run, id) => { cond(run, id!).stress--; boon(run, 'perm_armor', id); return `${name(run, id)} breaches the vault and refits.` },
  },
  {
    id: 'ram_gate', tier: 'pact', title: 'Ram the Gate', needsMech: true,
    text: 'Behind a blast gate, an intact print bay. Someone has to go through the gate first.',
    effect: 'One mech loses 1 Structure; every destroyed mech is reprinted and every mech gains +2 Repairs.',
    eligible: (run, id) => both(notDestroyed(run, id), cond(run, id).structure < 2 ? 'Needs 2+ Structure' : true),
    apply: (run, id) => {
      cond(run, id!).structure--
      for (const p of run.squad) { if (run.condition[p.id].destroyed) run.condition[p.id] = resetCondition(run, p); run.condition[p.id].repairs += 2 }
      return `${name(run, id)} smashes the gate. The print bay hums.`
    },
  },
  {
    id: 'prototype_actuators', tier: 'pact', title: 'Prototype Actuators', needsMech: true,
    text: 'Unproven SSC actuators from a sealed Annex lab. They need the space one of your systems is using.',
    effect: 'One mech has a random system destroyed; it gains a permanent +1 Evasion and +1 E-Defense.',
    eligible: (run, id) => both(notDestroyed(run, id), intactSystems(run, id).length ? true : 'No intact systems'),
    apply: (run, id) => { const s = destroySystem(run, id!, run.battlesWon * 17 + 3); boon(run, 'perm_evade', id); return `${name(run, id)} installs the actuators (${s} pulled).` },
  },
]

/** The event after a combat node (deterministic per node), or null for "nothing happens". */
export function rollEvent(node: RunNode): RunEvent | null {
  const rng = new Rng(node.seed ^ 0xe7e7)
  const r = rng.next()
  const tier: EventTier | null = r < 0.25 ? null : r < 0.75 ? 'find' : r < 0.9 ? 'gamble' : 'pact'
  if (!tier) return null
  return rng.pick(EVENTS.filter(e => e.tier === tier))
}
