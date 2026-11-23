// Story interludes: a document typed out like a console readout.
// - Holding any key or mouse button fast-forwards the typing; holding for HOLD_TO_SKIP ms skips it.
// - Once the readout is complete, a fresh press continues.
// - Now and then, for two frames, the burning solar eye flashes behind the text (very faint).
import { motionReduced } from './settings'
const HOLD_TO_SKIP = 1200
const CHAR_MS = 10
const FAST_CHARS_PER_FRAME = 40
const REDACT = /\[REDACTED\]|\[NO RECORD\]/g
/** Phrases that may set off the eye flash as they're typed (at most MAX_FLASHES per document). */
const OMENS = /SOLAR EYE|\bRA\b|red dreams|is red|red beer|THE EYE|RED PIGMENT|the moon went with it/gi
const MAX_FLASHES = 3

type Token = { text: string; redacted: boolean }

function tokenize(text: string): Token[] {
  const out: Token[] = []
  let last = 0
  for (const m of text.matchAll(REDACT)) {
    for (const ch of text.slice(last, m.index)) out.push({ text: ch, redacted: false })
    out.push({ text: m[0], redacted: true })
    last = m.index! + m[0].length
  }
  for (const ch of text.slice(last)) out.push({ text: ch, redacted: false })
  return out
}

/** Burning solar eye (sun disc, rays and the eye of Ra), drawn in SVG. */
export const RA_EYE_SVG = `<svg viewBox="0 0 200 200" aria-hidden="true">
  <defs>
    <radialGradient id="ra-sun" cx="50%" cy="46%" r="55%">
      <stop offset="0" stop-color="#ffe7a3"/><stop offset=".45" stop-color="#ff7a1a"/><stop offset=".8" stop-color="#c0160e"/><stop offset="1" stop-color="#4a0303" stop-opacity="0"/>
    </radialGradient>
    <filter id="ra-burn" x="-30%" y="-30%" width="160%" height="160%">
      <feTurbulence type="fractalNoise" baseFrequency="0.035 0.09" numOctaves="2" seed="7" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="9" xChannelSelector="R" yChannelSelector="G"/>
      <feGaussianBlur stdDeviation="0.6"/>
    </filter>
  </defs>
  <g filter="url(#ra-burn)">
    <g fill="#ff4a14" opacity=".75">${Array.from({ length: 16 }, (_, i) => `<polygon points="97,26 103,26 100,4" transform="rotate(${i * 22.5} 100 92)"/>`).join('')}</g>
    <circle cx="100" cy="92" r="64" fill="url(#ra-sun)"/>
    <g fill="none" stroke="#2a0402" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M44 66 Q100 34 158 62"/>
      <path d="M46 94 Q100 56 156 92 Q100 122 46 94 Z"/>
      <path d="M92 118 L84 156"/>
      <path d="M112 116 Q118 146 142 146 Q158 144 154 128 Q150 118 140 124"/>
    </g>
    <circle cx="100" cy="91" r="15" fill="#2a0402"/>
    <circle cx="100" cy="91" r="5" fill="#ff9a3c"/>
  </g>
</svg>`

/**
 * Play a document in `root`. Calls `onDone` when the reader continues or skips.
 * Returns a disposer (also called automatically on completion).
 */
export function playInterlude(root: HTMLElement, title: string, text: string, onDone: () => void): () => void {
  root.innerHTML = `<div class="screen interlude" role="dialog" aria-label="${title}">
    <div class="ra-eye">${RA_EYE_SVG}</div>
    <pre class="tx" aria-live="off"></pre>
    <div class="ix-foot"><span class="ix-hint">HOLD ANY KEY OR MOUSE BUTTON TO SKIP</span><span class="ix-bar"><i></i></span></div>
  </div>`
  const screen = root.querySelector<HTMLElement>('.interlude')!
  const pre = root.querySelector<HTMLElement>('.tx')!
  const eye = root.querySelector<HTMLElement>('.ra-eye')!
  const hint = root.querySelector<HTMLElement>('.ix-hint')!
  const bar = root.querySelector<HTMLElement>('.ix-bar i')!
  const cursor = document.createElement('span')
  cursor.className = 'ix-cursor'
  cursor.textContent = '▌'
  pre.appendChild(cursor)

  const tokens = tokenize(text)
  // token indices where an omen phrase ends: candidates for the eye flash
  const omenAt = new Set<number>()
  {
    let pos = 0
    const ends: number[] = []
    for (const m of text.matchAll(OMENS)) ends.push(m.index! + m[0].length)
    tokens.forEach((t, i) => { pos += t.text.length; if (ends.some(e => e > pos - t.text.length && e <= pos)) omenAt.add(i) })
  }
  const reduceMotion = motionReduced()

  let i = 0
  let budget = 0
  let last = performance.now()
  let held = false
  let heldFor = 0
  let pressedAfterDone = false
  let flashes = 0
  let lastFlash = -1e9
  let finished = false
  let disposed = false
  let raf = 0

  const append = (t: Token) => {
    if (t.redacted) {
      const s = document.createElement('span')
      s.className = 'redact'
      s.title = t.text
      s.textContent = t.text.replace(/[^\s]/g, '█')
      pre.insertBefore(s, cursor)
    } else {
      const prev = cursor.previousSibling
      if (prev && prev.nodeType === Node.TEXT_NODE) (prev as Text).data += t.text
      else pre.insertBefore(document.createTextNode(t.text), cursor)
    }
  }
  const delayAfter = (t: Token) => {
    if (t.redacted) return 120
    if (t.text === '\n') return 70
    if (t.text === '.' && tokens[i]?.text === '.') return 60
    return CHAR_MS
  }

  /** Two-frame flash of the burning eye. */
  const flash = () => {
    if (reduceMotion || flashes >= MAX_FLASHES) return
    flashes++
    lastFlash = performance.now()
    eye.style.opacity = String(0.1 + Math.random() * 0.06)
    eye.style.transform = `translate(-50%, -50%) scale(${1 + Math.random() * 0.04}) rotate(${(Math.random() - 0.5) * 4}deg)`
    requestAnimationFrame(() => {
      eye.style.opacity = String(0.16 + Math.random() * 0.05)
      requestAnimationFrame(() => { eye.style.opacity = '0' })
    })
  }

  const finishTyping = () => {
    while (i < tokens.length) append(tokens[i++])
    finished = true
    cursor.classList.add('blink')
    hint.textContent = 'PRESS ANY KEY TO CONTINUE'
    bar.style.width = '0'
    pre.scrollTop = pre.scrollHeight
  }

  const exit = () => {
    if (disposed) return
    dispose()
    onDone()
  }

  const frame = (now: number) => {
    if (disposed) return
    const dt = Math.min(100, now - last)
    last = now
    if (held) {
      heldFor += dt
      bar.style.width = `${Math.min(100, (heldFor / HOLD_TO_SKIP) * 100)}%`
      if (heldFor >= HOLD_TO_SKIP) { if (!finished) finishTyping(); return exit() }
    }
    if (!finished) {
      if (held) {
        for (let n = 0; n < FAST_CHARS_PER_FRAME && i < tokens.length; n++) append(tokens[i++])
      } else {
        budget += dt
        while (i < tokens.length && budget >= 0) {
          const t = tokens[i++]
          append(t)
          budget -= delayAfter(t)
          if (omenAt.has(i - 1) && now - lastFlash > 2500 && Math.random() < 0.75) flash()
        }
      }
      // one unprompted flash somewhere in the middle, if no omen has fired yet
      if (!flashes && i > tokens.length * 0.55 && Math.random() < 0.02) flash()
      pre.scrollTop = pre.scrollHeight
      if (i >= tokens.length) finishTyping()
    }
    raf = requestAnimationFrame(frame)
  }

  const down = (e: Event) => {
    if ((e as KeyboardEvent).repeat) return
    if (e.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta'].includes((e as KeyboardEvent).key)) return
    held = true
    heldFor = 0
    pressedAfterDone = finished
  }
  const up = () => {
    if (!held) return
    held = false
    heldFor = 0
    bar.style.width = '0'
    if (finished && pressedAfterDone) exit()
  }
  const blur = () => { held = false; heldFor = 0; bar.style.width = '0' }

  window.addEventListener('keydown', down)
  window.addEventListener('keyup', up)
  screen.addEventListener('pointerdown', down)
  window.addEventListener('pointerup', up)
  window.addEventListener('blur', blur)
  raf = requestAnimationFrame(frame)

  function dispose() {
    disposed = true
    cancelAnimationFrame(raf)
    window.removeEventListener('keydown', down)
    window.removeEventListener('keyup', up)
    screen.removeEventListener('pointerdown', down)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('blur', blur)
  }
  return dispose
}
