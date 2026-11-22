import './ui/style.css'
import './rules/effects/scripts'
import { App } from './ui/app'
import { installTagTips } from './ui/tags'

installTagTips()

const app = new App(document.getElementById('app')!)
;(window as any).__dov = app
