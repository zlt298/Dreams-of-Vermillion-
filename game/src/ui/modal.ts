// In-game dialogs that replace the browser's confirm(), alert() and prompt(): styled like the HUD
// decision picker, keyboard-driven (Enter confirms, Esc cancels) and never blocking the page.
import { esc } from './dom'

interface DialogOpts {
  title: string
  text?: string
  ok?: string
  cancel?: string | null
  danger?: boolean
  input?: { placeholder?: string; value?: string }
}

function open(o: DialogOpts): Promise<{ ok: boolean; value: string }> {
  return new Promise(resolve => {
    const el = document.createElement('div')
    el.className = 'picker modal'
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'true')
    el.innerHTML = `<div class="picker-box ${o.danger ? 'danger' : ''}"><h3>${esc(o.title)}</h3>${o.text ? `<p>${esc(o.text).replace(/\n/g, '<br>')}</p>` : ''}
      ${o.input ? `<input class="modal-input" type="text" placeholder="${esc(o.input.placeholder ?? '')}" value="${esc(o.input.value ?? '')}">` : ''}
      <div class="modal-btns">${o.cancel !== null ? `<button data-r="0">${esc(o.cancel ?? 'Cancel')} <kbd>Esc</kbd></button>` : ''}<button data-r="1" class="${o.danger ? 'warn' : 'primary'}">${esc(o.ok ?? 'OK')} <kbd>Enter</kbd></button></div></div>`
    const input = el.querySelector<HTMLInputElement>('.modal-input')
    const prev = document.activeElement as HTMLElement | null
    const done = (ok: boolean) => {
      window.removeEventListener('keydown', key, true)
      el.remove()
      prev?.focus?.()
      resolve({ ok, value: input?.value ?? '' })
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true) }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(o.cancel === null) }
      else if (!input || e.target !== input) e.stopPropagation() // the game behind ignores keys while a dialog is open
    }
    // the second click of a double-click on the button that opened the dialog lands on the backdrop: don't let it cancel
    const opened = performance.now()
    el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button[data-r]') as HTMLElement | null
      if (b) done(b.dataset.r === '1')
      else if (e.target === el && o.cancel !== null && performance.now() - opened > 400) done(false)
    })
    window.addEventListener('keydown', key, true)
    document.body.appendChild(el)
    ;(input ?? el.querySelector<HTMLElement>('button[data-r="1"]'))?.focus()
  })
}

export async function confirmDialog(title: string, text = '', opts: { ok?: string; cancel?: string; danger?: boolean } = {}): Promise<boolean> {
  return (await open({ title, text, ...opts })).ok
}
export async function alertDialog(title: string, text = ''): Promise<void> {
  await open({ title, text, ok: 'OK', cancel: null })
}
/** Text input; resolves null when cancelled. */
export async function promptDialog(title: string, text = '', placeholder = ''): Promise<string | null> {
  const r = await open({ title, text, ok: 'OK', input: { placeholder } })
  return r.ok ? r.value : null
}

/** A toast at the bottom of the screen, optionally with one action (e.g. Undo). */
export function toast(msg: string, action?: { label: string; run: () => void }, ms = 6000) {
  document.querySelectorAll('.app-toast').forEach(t => t.remove())
  const t = document.createElement('div')
  t.className = 'app-toast'
  t.setAttribute('role', 'status')
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="primary">${esc(action.label)}</button>` : ''}`
  if (action) t.querySelector('button')!.addEventListener('click', () => { t.remove(); action.run() })
  document.body.appendChild(t)
  setTimeout(() => t.remove(), ms)
}
