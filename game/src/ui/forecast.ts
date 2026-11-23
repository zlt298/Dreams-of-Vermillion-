// The campaign framing: every run is one of the MENHIT casket's forecast iterations.
// Persists the iteration counter and renders the cosmetic casket-telemetry panel.
import type { RunState } from '../run/run'
import { SIM_CONDITIONING } from '../data/story'

const ITER_KEY = 'dov-iterations'

/** How many runs (forecast iterations) have been started in this browser. */
export function iterationCount(): number {
  try { const n = Number(localStorage.getItem(ITER_KEY)); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 } catch { return 0 }
}

/** Start a new iteration and return its number. */
export function nextIteration(): number {
  const n = iterationCount() + 1
  try { localStorage.setItem(ITER_KEY, String(n)) } catch { /* storage unavailable */ }
  return n
}

export const iterLabel = (n: number) => String(n).padStart(4, '0')

/** Casket telemetry: cosmetic, driven by run state. The cycle grows ~5h per node cleared. */
export function telemetryPanel(run: RunState): string {
  const cleared = run.nodes.filter(n => n.cleared).length
  // seconds overdue: starts at the opening transmission's 00:41:17, grows with progress
  const secs = 41 * 60 + 17 + cleared * (5 * 3600 + 31 * 60 + 7) + (run.seed % 3600)
  const hh = Math.floor(secs / 3600), mm = Math.floor(secs / 60) % 60, ss = secs % 60
  const clock = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  const cond = SIM_CONDITIONING[run.act] ?? 'FAILING'
  const name = run.act >= 3
    ? `<span class="glitch" data-alt="H█████">MENHIT</span> // H<span class="redact">█████</span>`
    : run.act === 2 ? 'MENHIT // <span class="redact">█</span>' : 'MENHIT'
  const row = (k: string, v: string, cls = '') => `<div class="trow"><span>${k}</span><b class="${cls}">${v}</b></div>`
  return `<aside class="telemetry" aria-label="Casket telemetry (flavour)">
    <div class="thead">&gt;&gt; CASKET TELEMETRY</div>
    ${row('CYCLE STATUS', `OVERDUE // ${clock}`, 'warnc')}
    ${row('COMBAT SIM', cond, run.act >= 3 ? 'bad' : run.act === 2 ? 'warnc' : '')}
    ${row('FORECAST ITER.', run.iteration ? iterLabel(run.iteration) : '<span class="redact">████</span>')}
    ${row('SELF-DESIGNATION', name)}
  </aside>`
}
