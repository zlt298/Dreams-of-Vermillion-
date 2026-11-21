import './ui/style.css'
import './rules/effects/scripts'
import { App } from './ui/app'

const app = new App(document.getElementById('app')!)
;(window as any).__dov = app
