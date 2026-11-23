// Imports official NPC classes from a Lancer Content Pack (.lcp, a zip of JSON files) the player owns.
//
// The pack is read in the browser and the converted classes are stored only in that browser's
// localStorage. LCP content is paid/copyrighted: nothing from it is bundled or committed.
//
// Supported layouts:
//   - v1 packs: npc_classes.json + npc_features.json (+ npc_templates.json)
//   - v2/v3 packs: one npcc_<class>.json per class (class object first, then its features)
// Templates in the pack are not imported: the game implements the official templates itself.
import { unzipSync, strFromU8 } from 'fflate'
import type { Effect, StatusId, Stat } from '../rules/types'
import type { Feature, NpcStats, Role, Tier, WeaponFeature } from '../enemies/ruleset'
import { hasScript } from '../rules/effects/registry'

/** Fully automated: structured data covers it, or a hand-written script implements it. */
export function featureAutomated(f: OfficialFeature): boolean {
  return !f.partial || hasScript(`npc:${f.id}`)
}

export interface OfficialFeature {
  id: string
  name: string
  base: boolean
  /** converted feature per tier (index 0 = tier 1) */
  byTier: Feature[]
  /** true when only part (or none) of the rules text is automated */
  partial: boolean
}

export interface OfficialClass {
  id: string
  name: string
  role: Role
  /** full stats per tier (index 0 = tier 1), before templates */
  stats: NpcStats[]
  features: OfficialFeature[]
}

export interface OfficialPack {
  name: string
  version: string
  classes: OfficialClass[]
}

// ------------------------------------------------------------------ reading
/** A list field from pack JSON: anything that isn't an array (missing, {}, a number…) reads as empty. */
const arr = (x: any): any[] => (Array.isArray(x) ? x : [])

export function readLcp(bytes: Uint8Array): OfficialPack {
  let files: Record<string, Uint8Array>
  try { files = unzipSync(bytes) } catch { throw new Error('Not a valid .lcp file (expected a zip archive)') }
  const json: Record<string, any> = {}
  for (const [path, data] of Object.entries(files)) {
    if (!path.endsWith('.json')) continue
    try { json[path.split('/').pop()!] = JSON.parse(strFromU8(data)) } catch { /* skip malformed file */ }
  }
  const manifest = json['lcp_manifest.json'] ?? {}
  const classes: OfficialClass[] = []
  if (Array.isArray(json['npc_classes.json'])) {
    // v1 layout
    const feats = new Map<string, any>(arr(json['npc_features.json']).filter((f: any) => f && typeof f === 'object').map((f: any) => [f.id, f]))
    for (const c of json['npc_classes.json']) {
      if (!c || typeof c !== 'object') continue
      const ids: [string, boolean][] = [...arr(c.base_features).map((id: string): [string, boolean] => [id, true]), ...arr(c.optional_features).map((id: string): [string, boolean] => [id, false])]
      const raw = ids.map(([id, base]) => feats.get(id) && { ...feats.get(id), base }).filter(Boolean)
      const cls = convertClass(c, raw)
      if (cls) classes.push(cls)
    }
  } else {
    // v2/v3 layout: npcc_*.json = [classObject, ...features]
    for (const [name, arr] of Object.entries(json)) {
      if (!/^npcc_.*\.json$/.test(name) || !Array.isArray(arr) || !arr.length) continue
      const [c, ...raw] = arr
      const cls = convertClass(c, raw.filter((f: any) => f && typeof f === 'object' && !f.deprecated).map((f: any) => ({ ...f, base: !!f.base })))
      if (cls) classes.push(cls)
    }
  }
  if (!classes.length) throw new Error('No NPC classes found in this pack')
  classes.sort((a, b) => a.name.localeCompare(b.name))
  return { name: String(manifest.name ?? 'Unnamed pack'), version: String(manifest.version ?? '?'), classes }
}

// ------------------------------------------------------------------ helpers
const ROLE: Record<string, Role> = { striker: 'Striker', artillery: 'Artillery', controller: 'Controller', defender: 'Defender', support: 'Support', biological: 'Biological' }

/** Value for a tier from a number, an array per tier, or a "{a/b/c}" string. */
export function tierVal(v: any, tier: Tier): any {
  if (Array.isArray(v)) return v[Math.min(v.length, tier) - 1]
  if (typeof v === 'string') {
    const m = v.match(/^\{([^}]+)\}$/)
    if (m) { const parts = m[1].split('/'); const x = parts[Math.min(parts.length, tier) - 1]; return isNaN(Number(x)) ? x : Number(x) }
    if (v.trim() !== '' && !isNaN(Number(v))) return Number(v)
  }
  return v
}

/** Replace {a/b/c} tier placeholders in rules text and strip HTML. */
export function tierText(text: any, tier: Tier): string {
  return String(text ?? '').replace(/\{([^}]+)\}/g, (_m, g) => { const p = g.split('/'); return p[Math.min(p.length, tier) - 1] }).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase())

function convertClass(c: any, raw: any[]): OfficialClass | null {
  if (!c?.id || !c?.name || !c?.stats || typeof c.stats !== 'object') return null
  const role = ROLE[String(c.role ?? '').toLowerCase()] ?? 'Striker'
  const st = c.stats
  const stats = ([1, 2, 3] as Tier[]).map(t => {
    const n = (k: string, d = 0) => Number(tierVal(st[k], t) ?? d) || d
    const s: NpcStats = {
      hp: n('hp', 10), armor: n('armor'), evasion: n('evade', 8), edef: n('edef', 8), heatcap: n('heatcap'), speed: n('speed', 4), sensors: n('sensor', 8),
      save: n('save', 10), size: Number(tierVal(st.size, t)) || 1, hull: n('hull'), agi: n('agility'), sys: n('systems'), eng: n('engineering'),
      structure: n('structure', 1), stress: n('stress', 1), activations: n('activations', 1), attackBonus: t, techAttack: n('systems'),
    }
    return s
  })
  // a malformed feature is skipped rather than failing the whole pack
  const features = raw.map(f => { try { return convertFeature(f) } catch { return null } }).filter((x): x is OfficialFeature => !!x)
  return { id: String(c.id), name: titleCase(String(c.name)), role, stats, features }
}

// ------------------------------------------------------------------ rules-text parsing
const STATUS_WORDS: [RegExp, StatusId][] = [
  [/impaired/i, 'impaired'], [/slowed/i, 'slowed'], [/immobilized/i, 'immobilized'], [/jammed/i, 'jammed'],
  [/shredded/i, 'shredded'], [/stunned/i, 'stunned'], [/prone/i, 'prone'], [/exposed/i, 'exposed'], [/lock on/i, 'lockon'],
]
const SAVE_WORDS: Record<string, Stat> = { hull: 'hull', agility: 'agi', systems: 'sys', engineering: 'eng' }

/** Pull the common mechanical riders out of a feature's text (statuses, heat, burn, knockback). */
export function parseEffects(text: string): { effects: Effect[]; complete: boolean } {
  const effects: Effect[] = []
  if (!text) return { effects, complete: true }
  const saveM = text.match(/\b(hull|agility|systems|engineering) save\b/i)
  const save = saveM ? SAVE_WORDS[saveM[1].toLowerCase()] : undefined
  const duration = /until the end of (their|its|the target's) next turn/i.test(text) ? 'next_turn_end_target' as const : /until the end of (your|the \w+'s) next turn/i.test(text) ? 'next_turn_end_source' as const : 'next_turn_end_target' as const
  for (const [re, id] of STATUS_WORDS) {
    const m = text.match(new RegExp(`(becomes?|are|is|knocked|knocks? (?:them|the target)|gains?|inflicts?|and)\\s+(?:\\w+\\s+)?${re.source}`, 'i'))
    if (m && !/(?:clear|ignore|immun)/i.test(text.slice(Math.max(0, (m.index ?? 0) - 20), m.index))) effects.push({ do: 'status', status: id, duration, ...(save ? { save } : {}) })
  }
  const heat = text.match(/\b(?:takes?|deals?|\+)\s*(\d+)\s+heat\b/i)
  if (heat) effects.push({ do: 'heat', val: Number(heat[1]), ...(save ? { save } : {}) })
  const burn = text.match(/\b(\d+)\s+burn\b/i)
  if (burn) effects.push({ do: 'burn', val: Number(burn[1]), ...(save ? { save } : {}) })
  const kb = text.match(/knock(?:ed|s)?\s+(?:\w+\s+)?back\s+(\d+)|knockback\s+(\d+)/i)
  if (kb) effects.push({ do: 'push', val: Number(kb[1] ?? kb[2]), ...(save ? { save } : {}) })
  // anything beyond these riders (conditions, choices, movement, area effects…) is shown as text only
  const sentences = text.split(/(?<=\.)\s+/).filter(s => s.trim())
  const complete = effects.length > 0 && sentences.length <= 2
  return { effects, complete }
}

/** "Blast/Burst N … <Stat> save or take X <type> damage (half on success)" → a system feature. */
export function parseAreaSave(text: string): { target: 'tile_blast' | 'self_burst' | 'line' | 'cone'; range?: number; radius: number; save: Stat; effects: Effect[] } | null {
  const shape = text.match(/\b(Blast|Burst|Line|Cone)\s+(\d+)/i)
  const dmg = text.match(/\b(hull|agility|systems|engineering) save or (?:take|be dealt)\s+(\d+(?:d\d+)?(?:\s*\+\s*\d+)?)\s+(kinetic|energy|explosive|burn|heat)\s+damage/i)
  if (!shape || !dmg) return null
  const save = SAVE_WORDS[dmg[1].toLowerCase()]
  const type = titleCase(dmg[3])
  const range = Number(text.match(/\bRange\s+(\d+)/i)?.[1]) || undefined
  const kind = shape[1].toLowerCase()
  const burst = kind === 'burst'
  const half = /half damage/i.test(text)
  return {
    target: burst ? 'self_burst' : kind === 'line' ? 'line' : kind === 'cone' ? 'cone' : 'tile_blast', range: burst || kind === 'line' || kind === 'cone' ? undefined : range ?? 8, radius: Number(shape[2]), save,
    effects: [type === 'Heat' ? { do: 'heat', val: dmg[2].replace(/\s/g, '') } : { do: 'damage', damage: [{ type, val: dmg[2].replace(/\s/g, '') }], saveHalf: half }],
  }
}

const STATUS_IDS: Record<string, StatusId> = { slow: 'slowed', slowed: 'slowed', lock_on: 'lockon', lockon: 'lockon', impaired: 'impaired', immobilized: 'immobilized', jammed: 'jammed', shredded: 'shredded', stunned: 'stunned', prone: 'prone', exposed: 'exposed' }
const DURATIONS = new Set(['end_of_turn', 'next_turn_end_target', 'next_turn_end_source', 'start_of_next_turn_target', 'until_cleared', 'scene'])

/** On-hit / on-crit riders: plain text (v1) or structured `{ detail, add_status }` (v2/v3). */
function riderOf(v: any, tier: Tier): { text: string; effects: Effect[]; complete: boolean } {
  if (!v) return { text: '', effects: [], complete: true }
  if (Array.isArray(v)) {
    const parts = v.map(x => riderOf(x, tier))
    return { text: parts.map(p => p.text).filter(Boolean).join(' '), effects: parts.flatMap(p => p.effects), complete: parts.every(p => p.complete) }
  }
  if (typeof v === 'object') {
    const text = tierText(v.detail ?? '', tier)
    const effects: Effect[] = []
    for (const st of arr(v.add_status)) {
      if (!st || typeof st !== 'object') continue
      const id = STATUS_IDS[String(st.id ?? '').toLowerCase()]
      if (!id) continue
      const save = st.save ? SAVE_WORDS[String(st.save).toLowerCase()] : undefined
      effects.push({ do: 'status', status: id, duration: DURATIONS.has(st.duration) ? st.duration : id === 'lockon' ? 'until_cleared' : 'next_turn_end_target', ...(save ? { save } : {}) })
    }
    // heat / burn / knockback riders only appear in the text
    const extra = parseEffects(text).effects.filter(e => e.do !== 'status')
    const structured = effects.length > 0
    return { text, effects: [...effects, ...extra], complete: structured && !(v.add_special?.length) }
  }
  const text = tierText(v, tier)
  const p = parseEffects(text)
  return { text, effects: p.effects, complete: !text || p.complete }
}

const WEAPON_TYPES = ['Melee', 'CQB', 'Rifle', 'Cannon', 'Launcher', 'Nexus', 'Spool'] as const
const SIZES = ['Auxiliary', 'Main', 'Heavy', 'Superheavy'] as const

function tags(f: any, tier: Tier) {
  return arr(f.tags).filter((t: any) => t?.id && t.id !== 'tg_recharge' && t.id !== 'tg_limited' && t.id !== 'tg_reaction' && t.id !== 'tg_npc_trait')
    .map((t: any) => (t.val != null ? { id: t.id, val: tierVal(t.val, tier) } : { id: t.id }))
}
const tagNum = (f: any, id: string, tier: Tier) => { const t = arr(f.tags).find((x: any) => x?.id === id); return t ? Number(tierVal(t.val, tier)) || undefined : undefined }

function convertFeature(f: any): OfficialFeature | null {
  if (!f?.id || !f?.name) return null
  const type = String(f.type ?? '').toLowerCase()
  const action = Array.isArray(f.actions) ? f.actions[0] : undefined
  let partial = false
  const byTier = ([1, 2, 3] as Tier[]).map((tier): Feature => {
    const name = titleCase(String(f.name))
    const trig = action?.trigger ?? f.trigger
    const text = tierText([f.effect, trig && `Trigger: ${trig}`, action?.detail, f.on_hit && `On hit: ${riderOf(f.on_hit, tier).text}`].filter(Boolean).join(' '), tier)
    const recharge = tagNum(f, 'tg_recharge', tier)
    const uses = tagNum(f, 'tg_limited', tier)
    if (type === 'weapon') {
      const wt = String(f.weapon_type ?? '')
      const words = wt.split(/[\s/]+/)
      const hit = riderOf(f.on_hit, tier)
      const crit = riderOf(f.on_crit, tier)
      const onHitText = hit.text
      if ((hit.text && !hit.complete) || (crit.text && !crit.complete)) partial = true
      const w: WeaponFeature = {
        type: 'weapon', name,
        weaponType: (WEAPON_TYPES.find(t => words.includes(t)) ?? 'Rifle') as WeaponFeature['weaponType'],
        size: SIZES.find(s => words.includes(s)) ?? 'Main',
        range: arr(f.range).filter((r: any) => r && typeof r === 'object').map((r: any) => ({ type: titleCase(String(r.type)), val: Number(tierVal(r.val, tier)) || 1 })),
        damage: arr(f.damage).filter((d: any) => d && typeof d === 'object').map((d: any) => ({ type: titleCase(String(d.type)), val: tierVal(d.val ?? d.damage, tier) })),
        tags: tags(f, tier),
        accuracy: Number(tierVal(f.accuracy, tier)) || undefined,
        attackBonus: Number(tierVal(f.attack_bonus, tier)) || 0,
        smart: arr(f.tags).some((t: any) => t?.id === 'tg_smart'),
        onHit: [...hit.effects, ...(onHitText ? [{ do: 'text' as const, text: onHitText }] : [])],
        onCrit: [...crit.effects, ...(crit.text ? [{ do: 'text' as const, text: crit.text }] : [])],
        recharge, uses, text: tierText(f.effect, tier) || undefined,
      }
      if (!w.range.length) w.range = [{ type: w.weaponType === 'Melee' ? 'Threat' : 'Range', val: w.weaponType === 'Melee' ? 1 : 5 }] as any
      return w
    }
    if (type === 'tech' || /tech/i.test(action?.activation ?? '') || f.tech_type) {
      const parsed = parseEffects(text)
      if (!parsed.complete) partial = true
      const full = /full/i.test(action?.activation ?? f.tech_type ?? '')
      return {
        type: 'tech', name, kind: full ? 'full' : 'quick', onHit: [...parsed.effects, { do: 'text', text }],
        attackBonus: f.attack_bonus != null ? Number(tierVal(f.attack_bonus, tier)) || 0 : undefined,
        accuracy: Number(tierVal(f.accuracy, tier)) || undefined, recharge, uses, text,
      }
    }
    if (type === 'reaction') {
      partial = true
      const trig = String(action?.trigger ?? f.trigger ?? '').toLowerCase()
      const trigger = /melee/.test(trig) && /hit/.test(trig) ? 'hit_by_melee' : /miss/.test(trig) ? 'attacked_and_missed' : /adjacent/.test(trig) && /move|enter/.test(trig) ? 'enemy_moves_adjacent' : /ally|allied/.test(trig) ? 'ally_attacked_adjacent' : 'damaged'
      return { type: 'reaction', name, trigger, frequency: /scene/i.test(action?.frequency ?? '') ? '1/scene' : '1/round', effects: [{ do: 'text', text }], text }
    }
    // area attacks forcing a save ("…Blast 2… must succeed on a Hull save or take 8 kinetic damage")
    const area = parseAreaSave(text)
    if (area) {
      const full = /full action/i.test(text) || /full/i.test(action?.activation ?? '')
      return { type: 'system', name, activation: full ? 'full' : 'quick', ...area, recharge, uses, text }
    }
    // traits and systems: stat bonuses, resistances, immunities and flight are automated, the rest is text
    const stats: Partial<NpcStats> = {}
    const STAT_IDS: Record<string, keyof NpcStats> = { hp: 'hp', armor: 'armor', evasion: 'evasion', evade: 'evasion', edef: 'edef', speed: 'speed', sensor: 'sensors', sensors: 'sensors', heatcap: 'heatcap', structure: 'structure', stress: 'stress', save: 'save' }
    for (const b of [...arr(f.bonuses), ...(f.bonus && typeof f.bonus === 'object' ? Object.entries(f.bonus).map(([id, val]) => ({ id, val })) : [])] as any[]) {
      if (!b || typeof b !== 'object') continue
      const k = STAT_IDS[String(b.id).toLowerCase()]
      const v = Number(tierVal(b.val, tier))
      if (k && v) stats[k] = ((stats[k] as number) ?? 0) + v
    }
    const resist = [...arr(f.add_resist), ...(f.resistance ? [].concat(f.resistance) : [])].map((r: any) => (typeof r === 'string' ? r : r?.type ?? r?.val)).filter(Boolean).map(titleCase)
    const immune = [...(f.immunity ? [].concat(f.immunity) : [])].map((x: any) => String(x).toLowerCase())
    const flying = /\bcan fly\b|\bflies\b|\bfly when/i.test(text)
    const automated = Object.keys(stats).length > 0 || resist.length > 0 || immune.length > 0 || flying
    if (!automated || (text.split(/(?<=\.)\s+/).length > 1)) partial = true
    return { type: 'trait', name, ...(Object.keys(stats).length ? { stats } : {}), ...(resist.length ? { resist } : {}), ...(immune.length ? { immune } : {}), ...(flying ? { flying } : {}), text }
  })
  return { id: String(f.id), name: titleCase(String(f.name)), base: !!f.base, byTier, partial }
}

// ------------------------------------------------------------------ browser storage
const KEY = 'dov-official-npcs'

export function loadPacks(): OfficialPack[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
export function savePacks(packs: OfficialPack[]): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(packs)); return true } catch { return false }
}
/** Add (or replace, by name) a pack. Returns false if the browser refused to store it. */
export function storePack(pack: OfficialPack): boolean {
  return savePacks([...loadPacks().filter(p => p.name !== pack.name), pack])
}
export function removePack(name: string) { savePacks(loadPacks().filter(p => p.name !== name)) }
export function officialClasses(): OfficialClass[] { return loadPacks().flatMap(p => p.classes) }
