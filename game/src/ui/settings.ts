// Player settings: animation speed, graphics quality, motion and colour palette. Stored in
// localStorage; applyPrefs() mirrors motion and palette onto <html> so CSS and the renderer can follow.
export type Motion = 'system' | 'reduce' | 'full'
export type Palette = 'standard' | 'cb'
export type GfxPref = 'auto' | 'high' | 'low'

const get = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const set = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* storage unavailable */ } }

export const prefs = {
  get speed(): number { const v = Number(get('dov.animSpeed')); return [0, 1, 2, 4].includes(v) && get('dov.animSpeed') !== null ? v : 1 },
  set speed(v: number) { set('dov.animSpeed', String(v)) },
  get gfx(): GfxPref { const v = get('dov.gfx'); return v === 'high' || v === 'low' ? v : 'auto' },
  set gfx(v: GfxPref) { set('dov.gfx', v === 'auto' ? null : v) },
  get motion(): Motion { const v = get('dov.motion'); return v === 'reduce' || v === 'full' ? v : 'system' },
  set motion(v: Motion) { set('dov.motion', v === 'system' ? null : v); applyPrefs() },
  get palette(): Palette { return get('dov.palette') === 'cb' ? 'cb' : 'standard' },
  set palette(v: Palette) { set('dov.palette', v === 'cb' ? 'cb' : null); applyPrefs() },
}

/** Whether motion should be reduced, from the setting or (by default) the system preference. */
export function motionReduced(): boolean {
  const m = prefs.motion
  if (m !== 'system') return m === 'reduce'
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
export const colourBlind = () => prefs.palette === 'cb'

/** A touch-first device (coarse pointer): tap-based tooltips, touch copy, larger targets. */
export function isTouch(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}
/**
 * A phone: touch-first with a short side under about 500 px (landscape phones are up to ~932 px
 * wide). Turns on the compact phone layout; tablets and narrow desktop windows keep the desktop one.
 */
export function isPhone(): boolean {
  return isTouch() && Math.min(window.innerWidth, window.innerHeight) <= 500 && Math.max(window.innerWidth, window.innerHeight) <= 1000
}

export function applyPrefs() {
  const h = document.documentElement
  h.dataset.motion = motionReduced() ? 'reduce' : 'full'
  h.dataset.palette = prefs.palette
  h.toggleAttribute('data-touch', isTouch())
  h.toggleAttribute('data-phone', isPhone())
  h.toggleAttribute('data-portrait', window.innerHeight > window.innerWidth)
}

/** The settings form (shared by the title screen and the in-battle settings dialog). */
export function settingsForm(): string {
  const row = (name: string, label: string, help: string, opts: [string, string][], cur: string) =>
    `<div class="setting"><div><b>${label}</b><div class="muted small">${help}</div></div><div class="seg" role="radiogroup" aria-label="${label}">${opts.map(([v, l]) => `<button data-set="${name}" data-v="${v}" role="radio" aria-checked="${v === cur}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div></div>`
  return `<div class="settings">
    ${row('speed', 'Animation speed', 'How fast moves and attacks play. Skip jumps straight to the result.', [['1', '×1'], ['2', '×2'], ['4', '×4'], ['0', 'Skip']], String(prefs.speed))}
    ${row('gfx', 'Graphics quality', 'High adds bloom, film grain, ambient particles and practical lights. Auto picks low on phones, tablets and software rendering.', [['auto', 'Auto'], ['high', 'High'], ['low', 'Low']], prefs.gfx)}
    ${row('motion', 'Motion', 'Reduce turns off camera shake, pulsing, wipes and flashes.', [['system', 'System'], ['reduce', 'Reduce'], ['full', 'Full']], prefs.motion)}
    ${row('palette', 'Colour palette', 'Colour-blind swaps red/green for orange/blue in health, routes and field overlays.', [['standard', 'Standard'], ['cb', 'Colour-blind']], prefs.palette)}
  </div>`
}

/** Wire a rendered settings form; `onChange` lets a live battle apply the new values. */
export function bindSettings(root: HTMLElement, onChange?: (name: string, value: string) => void) {
  root.querySelectorAll<HTMLElement>('[data-set]').forEach(b => b.addEventListener('click', () => {
    const name = b.dataset.set!, v = b.dataset.v!
    if (name === 'speed') prefs.speed = Number(v)
    if (name === 'gfx') prefs.gfx = v as GfxPref
    if (name === 'motion') prefs.motion = v as Motion
    if (name === 'palette') prefs.palette = v as Palette
    root.querySelectorAll<HTMLElement>(`[data-set="${name}"]`).forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)) })
    onChange?.(name, v)
  }))
}
