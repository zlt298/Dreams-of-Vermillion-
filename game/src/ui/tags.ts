// Hoverable tag explanations. Tags (AP, Reliable 2, Blast 2, Loading...) render as chips with a
// `data-tip`; one global tooltip (installTagTips) shows the rules text anywhere in the UI.
import { Lancer } from '../data/lancer'
import { esc } from './dom'

const strip = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

/** Short labels for common weapon tags (lancer-data names are sometimes long). */
const SHORT: Record<string, string> = {
  tg_ap: 'AP', tg_heat_self: 'Heat {VAL} (self)', tg_heat_target: 'Heat {VAL}', tg_range: 'Range {VAL}', tg_recharge: 'Recharge {VAL}+',
}
/** Clearer wording where lancer-data's description is aimed at systems rather than weapons. */
const DESC: Record<string, string> = {
  tg_range: 'Attacks can target characters up to {VAL} spaces away that you have line of sight to.',
}
const RANGE_TAG: Record<string, string> = {
  Range: 'tg_range', Threat: 'tg_threat', Blast: 'tg_blast', Burst: 'tg_burst', Line: 'tg_line', Cone: 'tg_cone', Thrown: 'tg_thrown',
}

const fill = (s: string, val: unknown) => s.replace(/\{VAL\}/g, val != null && val !== '' ? String(val) : 'X')

/** Display name and rules text for a tag id (falls back to a tidied id). */
export function tagInfo(id: string, val?: unknown): { name: string; desc: string } {
  const t = Lancer.tags.get(id) as { name?: string; description?: string } | undefined
  const name = fill(SHORT[id] ?? t?.name ?? id.replace(/^tg_/, '').replace(/_/g, ' '), val).replace(/\s*\(X\)|\s+X$/, '')
  const raw = DESC[id] ?? t?.description
  const desc = raw ? strip(fill(raw, val)) : ''
  return { name, desc }
}

/** A hoverable chip for a tag. */
export function tagChip(id: string, val?: unknown, label?: string): string {
  const { name, desc } = tagInfo(id, val)
  return desc ? `<span class="tagtip" data-tip="${esc(`${name}: ${desc}`)}">${esc(label ?? name)}</span>` : esc(label ?? name)
}

/** A hoverable chip for a range entry (Range 10, Threat 3, Blast 2…). */
export function rangeChip(type: string, val: unknown): string {
  const id = RANGE_TAG[type]
  return id ? tagChip(id, val, `${type} ${val}`) : esc(`${type} ${val}`)
}

// ------------------------------------------------------------------ annotate free text
// Capitalised tag phrases as they appear in rules text and the battle log.
const PHRASES: [RegExp, string][] = [
  [/\bAP\b/g, 'tg_ap'], [/\bArmor-Piercing\b/g, 'tg_ap'],
  [/\bReliable(?: (\d+))?\b/g, 'tg_reliable'], [/\bLoading\b/g, 'tg_loading'], [/\bSmart\b/g, 'tg_smart'], [/\bSeeking\b/g, 'tg_seeking'],
  [/\bArcing\b/g, 'tg_arcing'], [/\bInaccurate\b/g, 'tg_inaccurate'], [/\bAccurate\b/g, 'tg_accurate'], [/\bKnockback(?: (\d+))?\b/g, 'tg_knockback'],
  [/\bOverkill\b/g, 'tg_overkill'], [/\bOrdnance\b/g, 'tg_ordnance'], [/\bLimited(?: (\d+))?\b/g, 'tg_limited'], [/\bIrreducible\b/g, 'tg_irreducible'],
  [/\bRecharge (\d+)\+/g, 'tg_recharge'], [/\bThrown (\d+)\b/g, 'tg_thrown'], [/\bBlast (\d+)\b/g, 'tg_blast'], [/\bBurst (\d+)\b/g, 'tg_burst'],
  [/\bLine (\d+)\b/g, 'tg_line'], [/\bCone (\d+)\b/g, 'tg_cone'], [/\bThreat (\d+)\b/g, 'tg_threat'], [/\bDanger Zone\b/g, 'tg_danger_zone'],
  [/\bQuick Tech\b/g, 'tg_quick_tech'], [/\bFull Tech\b/g, 'tg_full_tech'], [/\bInvade\b/g, 'tg_invade'],
]

/** Wrap known tag phrases in (already escaped) HTML text with hoverable chips. */
export function annotateTags(html: string): string {
  // split out existing tags so we never touch markup
  return html.split(/(<[^>]+>)/).map(part => {
    if (part.startsWith('<')) return part
    const hits: { start: number; end: number; chip: string }[] = []
    for (const [re, id] of PHRASES) {
      re.lastIndex = 0
      for (const m of part.matchAll(re)) {
        const start = m.index!, end = start + m[0].length
        if (hits.some(h => start < h.end && end > h.start)) continue
        const { name, desc } = tagInfo(id, m[1])
        if (desc) hits.push({ start, end, chip: `<span class="tagtip" data-tip="${esc(`${name}: ${desc}`)}">${m[0]}</span>` })
      }
    }
    if (!hits.length) return part
    hits.sort((a, b) => a.start - b.start)
    let out = '', i = 0
    for (const h of hits) { out += part.slice(i, h.start) + h.chip; i = h.end }
    return out + part.slice(i)
  }).join('')
}

// ------------------------------------------------------------------ the global tooltip
let installed = false
/** One floating tooltip for every `[data-tip]` element on the page. */
export function installTagTips(doc: Document = document) {
  if (installed) return
  installed = true
  const tip = doc.createElement('div')
  tip.className = 'tagtip-pop'
  doc.body.appendChild(tip)
  let current: HTMLElement | null = null
  const place = (x: number, y: number) => {
    const w = tip.offsetWidth, h = tip.offsetHeight
    const vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight
    tip.style.left = `${Math.max(8, Math.min(vw - w - 8, x + 14))}px`
    tip.style.top = `${y + 18 + h > vh ? Math.max(8, y - h - 12) : y + 18}px`
  }
  const hide = () => { current = null; tip.style.display = 'none' }
  doc.addEventListener('mouseover', e => {
    const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null
    if (!el) { if (current) hide(); return }
    if (el === current) return
    current = el
    tip.textContent = el.dataset.tip ?? ''
    tip.style.display = 'block'
    place(e.clientX, e.clientY)
  })
  doc.addEventListener('mousemove', e => {
    if (!current) return
    if (!current.isConnected) return hide() // the HUD re-rendered under the cursor
    place(e.clientX, e.clientY)
  })
  doc.addEventListener('mousedown', hide)
  doc.addEventListener('scroll', hide, true)
}
