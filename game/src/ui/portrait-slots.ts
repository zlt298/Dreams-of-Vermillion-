// Mech portraits outside battle, without pulling Three.js into the menu bundle: screens emit an empty
// <img> slot, then fillPortraits() loads render/portrait.ts on demand and fills them in.
import type { Unit } from '../rules/types'

const pending = new Map<string, Unit>()
let seq = 0

/** Placeholder markup for a unit's portrait. */
export function portraitSlot(u: Unit, cls = 'portrait'): string {
  const id = `p${++seq}`
  pending.set(id, u)
  return `<img class="${cls}" data-portrait="${id}" alt="">`
}

/** Render every pending portrait slot under `root`. */
export async function fillPortraits(root: HTMLElement) {
  const els = [...root.querySelectorAll<HTMLImageElement>('img[data-portrait]')]
  if (!els.length) return
  const { portraitFor } = await import('../render/portrait')
  for (const el of els) {
    const u = pending.get(el.dataset.portrait!)
    pending.delete(el.dataset.portrait!)
    if (!u || !el.isConnected) continue
    const src = portraitFor(u)
    if (src) el.src = src
    else el.remove()
  }
  if (pending.size > 200) pending.clear()
}
