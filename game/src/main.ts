import './ui/style.css'
import './rules/effects/scripts'
import { App } from './ui/app'
import { installTagTips } from './ui/tags'
import { applyPrefs } from './ui/settings'

applyPrefs()
try { matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', applyPrefs) } catch { /* old browsers */ }
// device flags (touch / phone / portrait) follow rotation and resizing
window.addEventListener('resize', applyPrefs)
window.addEventListener('orientationchange', applyPrefs)
installTagTips()

const app = new App(document.getElementById('app')!)
;(window as any).__dov = app
// battle replay export for bug reports and scripted checks
;(app as any).exportBattle = (note?: string) => app.battle?.exportBattle(note)
