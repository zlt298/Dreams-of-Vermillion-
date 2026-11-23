// Battle screen: XCOM-style HUD over the isometric view. Every player command goes through the
// Battle API (same rules as the AI); the enemy side is driven by the tactical AI.
import { Lancer } from '../data/lancer'
import { pickNextUnit, runAiTurn } from '../ai/ai'
import { annotateTags, rangeChip, tagChip, tagInfo } from './tags'
import { type Battle, type ChoiceQuestion, stripHtml } from '../rules/battle'
import { exportBattle, type BattleExport } from '../replay/replay'
import { blastTiles, burstTiles, coneTiles, key, lineTiles, footprint } from '../rules/grid'
import type { CustomAction } from '../rules/effects/registry'
import { hasTag, tagVal } from '../rules/stats'
import type { Pos, Unit, Weapon } from '../rules/types'
import { BattleView, type Highlight } from '../render/scene'
import { esc } from './dom'

type Mode =
  | { k: 'idle' }
  | { k: 'move' }
  | { k: 'attack'; action: 'skirmish' | 'barrage' | 'aux'; weapon: Weapon; first?: { weapon: Weapon; aim: { targetId?: string; tile?: Pos } }; via?: 'skirmish' | 'barrage'; queue?: Weapon[] }
  | { k: 'barrage-pick'; first: { weapon: Weapon; aim: { targetId?: string; tile?: Pos } } }
  | { k: 'tech'; tech: 'invade' | 'lockon' | 'bolster' | 'scan' }
  | { k: 'custom'; action: CustomAction }
  | { k: 'melee'; what: 'ram' | 'grapple' | 'improvised' }

const TAG_NAMES: Record<string, string> = {
  tg_ap: 'AP', tg_accurate: 'Accurate', tg_inaccurate: 'Inaccurate', tg_arcing: 'Arcing', tg_seeking: 'Seeking', tg_smart: 'Smart',
  tg_reliable: 'Reliable', tg_knockback: 'Knockback', tg_loading: 'Loading', tg_overkill: 'Overkill', tg_heat_self: 'Heat (self)',
  tg_limited: 'Limited', tg_unique: 'Unique', tg_ordnance: 'Ordnance', tg_burn: 'Burn', tg_thrown: 'Thrown', tg_irreducible: 'Irreducible',
}

export class BattleScreen {
  root: HTMLElement
  b: Battle
  view: BattleView
  hud: HTMLDivElement
  selected: Unit | null = null
  mode: Mode = { k: 'idle' }
  hoverTile: Pos | null = null
  tooltip: HTMLDivElement
  busy = false
  onEnd: (winner: 'player' | 'enemy') => void
  private ended = false
  title: string

  constructor(root: HTMLElement, b: Battle, opts: { onEnd: (w: 'player' | 'enemy') => void; title?: string }) {
    this.root = root
    this.b = b
    this.onEnd = opts.onEnd
    this.title = opts.title ?? 'Engagement'
    root.innerHTML = `<div class="battle"><div class="viewport"></div><div class="hud"></div><div class="tooltip"></div></div>`
    this.view = new BattleView(root.querySelector('.viewport') as HTMLElement, b)
    this.hud = root.querySelector('.hud') as HTMLDivElement
    this.tooltip = root.querySelector('.tooltip') as HTMLDivElement
    this.view.onTileClick = (p, e) => this.clickTile(p, e)
    this.view.onUnitClick = (u, e) => this.clickUnit(u, e)
    this.view.onTileHover = p => {
      // pointermove fires many times per tile: only do work when the hovered tile changes
      const k = p ? `${p.x},${p.y}` : ''
      if (k === this.hoverKey) return
      this.hoverKey = k
      this.hoverTile = p
      this.updateHover()
    }
    // player decisions: defer, so the command is rolled back, the HUD asks, and it is replayed
    b.chooser = () => undefined
    this.hud.addEventListener('click', e => this.onHudClick(e))
    this.hud.addEventListener('mouseover', e => this.onHudHover(e))
    window.addEventListener('keydown', this.onKey)
    const first = b.combatants('player')[0]
    if (first) this.view.focus(first.pos)
    this.render()
    void this.advance()
  }

  dispose() {
    window.removeEventListener('keydown', this.onKey)
    this.b.chooser = undefined
    this.picker?.remove()
    this.previewCache.clear()
    this.view.dispose()
  }
  private hoverKey = ''
  showFields = true
  private highlightKey = ''
  private previewCache = new Map<string, ReturnType<Battle['previewDetail']>>()
  private cachedPreview(a: Unit, w: Weapon, t: Unit) {
    const k = `${a.id}:${a.pos.x},${a.pos.y}:${w.uid}:${w.profileIndex}:${t.id}:${this.b.eventCount}`
    let d = this.previewCache.get(k)
    if (!d) {
      if (this.previewCache.size > 200) this.previewCache.clear()
      d = this.b.previewDetail(a, w, t, 600)
      this.previewCache.set(k, d)
    }
    return d
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { this.mode = this.b.active?.side === 'player' ? { k: 'move' } : { k: 'idle' }; this.render() }
    if (e.key === 'Tab') {
      e.preventDefault()
      const ready = this.b.combatants('player').filter(u => u.activationsLeft > 0 || u.activeTurn)
      if (ready.length) { const i = ready.indexOf(this.selected!); this.select(ready[(i + 1) % ready.length]) }
    }
    if ((e.key === 'v' || e.key === 'V') && !e.ctrlKey && !e.metaKey) { this.showFields = !this.showFields; this.toast(this.showFields ? 'Field overlays on [V]' : 'Field overlays off [V]'); this.updateHighlights() }
    if (e.key === 'Enter' && this.b.active?.side === 'player') this.cmd(() => this.b.endTurn(this.b.active!), true)
    if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && this.b.active?.side === 'player' && this.b.canUndoMove(this.b.active)) { e.preventDefault(); this.cmd(() => this.b.undoMove(this.b.active!)) }
  }

  // ------------------------------------------------------------------ flow
  private async advance() {
    if (this.busy) return
    this.busy = true
    try {
      await this.view.idle()
      while (!this.b.winner && this.b.currentSide === 'enemy' && !this.b.activeId) {
        const u = pickNextUnit(this.b, 'enemy')
        if (!u) break
        this.selected = u
        this.view.focus(u.pos)
        this.render()
        await sleep(250)
        let answers: number[] = []
        for (;;) {
          const r = this.b.transaction(() => runAiTurn(this.b, u), answers)
          if ('pending' in r) { this.render(); answers = [...answers, await this.ask(r.pending)]; continue }
          if (r.error) console.error(r.error)
          break
        }
        this.render()
        await this.view.idle()
        await sleep(200)
      }
    } finally {
      this.busy = false
    }
    if (this.b.winner && !this.ended) {
      this.render()
      await this.view.idle(4000)
      await sleep(600)
      if (this.ended) return
      this.ended = true
      this.onEnd(this.b.winner as 'player' | 'enemy')
      return
    }
    if (this.b.currentSide === 'player' && !this.b.activeId) {
      const ready = this.b.combatants('player').filter(u => u.activationsLeft > 0)
      const chained = this.b.chainTurn ? this.b.unit(this.b.chainTurn) : undefined
      if (chained && chained.side === 'player' && chained.activationsLeft > 0) this.selected = chained
      else if (!this.selected || this.selected.side !== 'player' || this.selected.activationsLeft <= 0) this.selected = ready[0] ?? null
    }
    this.render()
  }

  private cmd(f: () => void, thenAdvance = false, answers: number[] = []) {
    const r = this.b.transaction(f, answers, { rollbackOnError: true })
    if ('pending' in r) {
      this.render()
      void this.ask(r.pending).then(i => this.cmd(f, thenAdvance, [...answers, i]))
      return
    }
    if (r.error) this.toast(r.error.message)
    this.view.syncUnits()
    if (this.b.active?.side === 'player' && this.mode.k === 'idle') this.mode = { k: 'move' }
    this.render()
    if (thenAdvance || !this.b.activeId || this.b.winner) void this.advance()
    if (this.b.winner) setTimeout(() => { if (!this.ended) void this.advance() }, 1500)
  }

  /** Prompt the optional auxiliary follow-up attacks (no bonus damage); Esc skips. */
  private offerAux(a: Unit, queue: Weapon[], via: 'skirmish' | 'barrage') {
    const usable = queue.filter(w => this.b.weaponUsable(a, w) === true && !this.b.firedThisTurn(a, w))
    if (!usable.length || a.destroyed) return
    const [aux, ...rest] = usable
    this.mode = { k: 'attack', action: 'aux', weapon: aux, via, queue: rest }
    this.toast(`Optional: fire ${aux.name} (auxiliary on a mount you fired, no bonus damage) — Esc to skip`)
  }
  /** The battle so far as a replay file (seed, starting state, commands). */
  exportBattle(note?: string): BattleExport { return exportBattle(this.b, note) }
  private downloadBattle() {
    const note = window.prompt('Optional: what went wrong? (saved in the file)') ?? undefined
    const data = JSON.stringify(this.exportBattle(note || undefined))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
    a.download = `dov-battle-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    this.toast('Battle exported: replay it with `npm run replay -- <file>`')
  }
  private picker: HTMLDivElement | null = null
  /** Show a decision in the HUD; number keys pick, Esc takes the default. */
  ask(q: ChoiceQuestion): Promise<number> {
    this.picker?.remove()
    return new Promise(resolve => {
      const el = document.createElement('div')
      el.className = 'picker'
      const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
      el.innerHTML = `<div class="picker-box"><div class="picker-unit">${esc(q.unit.name)}</div><h3>${esc(q.title)}</h3>${q.text ? `<p>${esc(q.text).replace(/\n/g, '<br>')}</p>` : ''}<div class="picker-opts">${q.options.map((o, i) => `<button data-i="${i}" class="${i === q.defaultIndex ? 'default' : ''}"><b>${i + 1}</b> ${esc(o.label)}${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</button>`).join('')}</div><div class="picker-foot">Keys 1–${q.options.length} · Esc: ${esc(q.options[q.defaultIndex]?.label ?? '')}</div></div>`
      const done = (i: number) => { window.removeEventListener('keydown', key, true); el.remove(); this.picker = null; resolve(i) }
      const key = (e: KeyboardEvent) => {
        const n = parseInt(e.key, 10)
        if (n >= 1 && n <= q.options.length) { e.preventDefault(); e.stopPropagation(); done(n - 1) }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(q.defaultIndex) }
      }
      el.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button[data-i]') as HTMLElement | null; if (b) done(+b.dataset.i!) })
      window.addEventListener('keydown', key, true)
      this.root.querySelector('.battle')!.appendChild(el)
      this.picker = el
      this.view.focus(q.unit.pos)
    })
  }
  toast(msg: string) {
    const t = document.createElement('div')
    t.className = 'toast'
    t.textContent = msg
    this.root.appendChild(t)
    setTimeout(() => t.remove(), 2600)
  }

  select(u: Unit) {
    this.selected = u
    this.view.focus(u.pos)
    if (u.activeTurn && u.side === 'player') this.mode = { k: 'move' }
    this.render()
  }

  // ------------------------------------------------------------------ clicks
  private clickUnit(u: Unit, e: MouseEvent) {
    const a = this.b.active
    if (a && a.side === 'player' && this.mode.k !== 'idle' && this.mode.k !== 'move') { this.useOnTarget(u, u.pos); return }
    if (a && a.side === 'player' && this.mode.k === 'move' && u === a) return
    this.selected = u
    this.render()
    void e
  }

  private clickTile(p: Pos, _e: MouseEvent) {
    const a = this.b.active
    const occupant = this.b.alive().find(u => footprint(u).some(q => q.x === p.x && q.y === p.y))
    if (!a || a.side !== 'player') { if (occupant) { this.selected = occupant; this.render() } return }
    if (this.mode.k === 'move') {
      if (occupant && occupant !== a) { this.selected = occupant; this.render(); return }
      this.cmd(() => { this.b.move(a, p, { mode: 'standard' }) })
      return
    }
    this.useOnTarget(occupant, p)
  }

  private useOnTarget(target: Unit | undefined, tile: Pos) {
    const a = this.b.active!
    const m = this.mode
    if (m.k === 'attack') {
      const aoe = this.b.isAoE(this.b.profile(m.weapon))
      const aim = aoe ? { tile } : { targetId: target?.id }
      // no character there: a single-target skirmish can be aimed at a terrain block instead
      if (!aoe && !target) {
        if (m.action === 'skirmish' && tile && this.b.map.tiles[tile.y * this.b.map.w + tile.x]?.kind === 'block') {
          this.cmd(() => { const r = this.b.attackTerrain(a, m.weapon, tile); if (!r.ok) throw new Error(r.reason); this.mode = { k: 'move' } })
        }
        return
      }
      if (m.action === 'skirmish' || m.action === 'aux') {
        this.cmd(() => {
          const r = m.action === 'aux' ? this.b.weaponAttack(a, m.weapon, aim, m.via ?? 'skirmish', { noBonusDamage: true }) : this.b.skirmish(a, m.weapon, aim)
          if (!r.ok) throw new Error(r.reason)
          if (m.action === 'aux') this.b.markFired(a, m.weapon)
          this.mode = { k: 'move' }
          // barrage: continue with the remaining mounts' auxiliaries (one per mount)
          if (m.action === 'aux' && m.queue?.length) this.offerAux(a, m.queue.filter(w => w.mountIndex !== m.weapon.mountIndex), 'barrage')
          if (m.action === 'skirmish') {
            const aux = a.weapons.find(w => w !== m.weapon && w.size === 'Auxiliary' && w.mountIndex === m.weapon.mountIndex && m.weapon.mountIndex >= 0 && this.b.weaponUsable(a, w) === true && !this.b.firedThisTurn(a, w))
            if (aux && !a.destroyed) { this.mode = { k: 'attack', action: 'aux', weapon: aux }; this.toast(`Optional: fire ${aux.name} (same mount, no bonus damage) — Esc to skip`) }
          }
        })
      } else if (m.action === 'barrage') {
        if (!m.first) {
          if (m.weapon.size === 'Superheavy') this.cmd(() => { const r = this.b.barrage(a, { weapon: m.weapon, aim }); if (!r.ok) throw new Error(r.reason); this.mode = { k: 'move' }; this.offerAux(a, this.b.auxFollowUps(a, [m.weapon]), 'barrage') })
          else { this.mode = { k: 'barrage-pick', first: { weapon: m.weapon, aim } }; this.render(); this.toast('Barrage: choose the second weapon') }
        } else {
          const first = m.first
          this.cmd(() => { const r = this.b.barrage(a, first, { weapon: m.weapon, aim }); if (!r.ok) throw new Error(r.reason); this.mode = { k: 'move' }; this.offerAux(a, this.b.auxFollowUps(a, [first.weapon, m.weapon]), 'barrage') })
        }
      }
      return
    }
    if (m.k === 'tech') {
      if (!target) return
      this.cmd(() => {
        if (m.tech === 'invade') this.b.invade(a, target)
        else if (m.tech === 'lockon') this.b.lockOn(a, target)
        else if (m.tech === 'bolster') this.b.bolster(a, target)
        else if (m.tech === 'scan') this.toast(this.b.scan(a, target))
        this.mode = { k: 'move' }
      })
      return
    }
    if (m.k === 'custom') {
      const act = m.action
      if ((act.target === 'enemy' || act.target === 'ally' || act.target === 'unit') && !target) return
      this.cmd(() => { this.b.useCustom(a, act, act.target === 'tile' ? tile : target); this.mode = { k: 'move' } })
      return
    }
    if (m.k === 'melee' && target) {
      this.cmd(() => {
        if (m.what === 'ram') this.b.ram(a, target)
        else if (m.what === 'grapple') this.b.grapple(a, target)
        else this.b.improvisedAttack(a, target)
        this.mode = { k: 'move' }
      })
    }
  }

  private onHudClick(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null
    if (!el || el.classList.contains('disabled')) return
    const act = el.dataset.act!
    const arg = el.dataset.arg
    const a = this.b.active
    const sel = this.selected
    switch (act) {
      case 'select': { const u = this.b.unit(arg); if (u) this.select(u); return }
      case 'activate':
        // SEKHMET Protocol: the NHP plays this mech's turn
        if (sel?.flags.sekhmet) { this.cmd(() => { runAiTurn(this.b, sel); this.mode = { k: 'idle' } }, true); this.toast('SEKHMET has control.'); return }
        if (sel) this.cmd(() => { this.b.beginTurn(sel); this.mode = { k: 'move' } })
        return
      case 'end': if (a) this.cmd(() => { this.b.endTurn(a); this.mode = { k: 'idle' } }, true); return
      case 'undo': if (a) this.cmd(() => this.b.undoMove(a)); return
      case 'auto':
        if (a && a.side === 'player') this.cmd(() => { runAiTurn(this.b, a); this.mode = { k: 'idle' } }, true)
        else if (sel && sel.side === 'player' && !this.b.activeId && sel.activationsLeft > 0 && this.b.currentSide === 'player') this.cmd(() => { runAiTurn(this.b, sel); this.mode = { k: 'idle' } }, true)
        return
      case 'cancel': this.mode = a ? { k: 'move' } : { k: 'idle' }; this.render(); return
      case 'export': this.downloadBattle(); return
      case 'rotl': this.view.rotate(-1); return
      case 'rotr': this.view.rotate(1); return
      case 'gfx': this.view.setQuality(this.view.quality === 'high' ? 'low' : 'high'); this.toast(`Graphics: ${this.view.quality} quality`); this.render(); return
      case 'speed': { const order = [1, 2, 4, 0]; this.view.setSpeed(order[(order.indexOf(this.view.speed) + 1) % order.length]); this.render(); return }
      case 'finish': if (this.b.winner && !this.ended) { this.ended = true; this.onEnd(this.b.winner as 'player' | 'enemy') } return
      case 'policy':
        if (sel && (arg === 'brace' || arg === 'overwatch' || arg === 'reactions')) {
          const order = ['auto', 'ask', 'off'] as const
          this.b.setPolicy(sel, arg, order[(order.indexOf(sel.policies[arg] ?? 'ask') + 1) % order.length])
          this.render()
        }
        return
    }
    if (!a) return
    const w = a.weapons.find(w => w.uid === arg)
    switch (act) {
      case 'skirmish': if (w) { this.mode = { k: 'attack', action: 'skirmish', weapon: w }; this.render() } return
      case 'barrage':
        if (w) {
          if (this.mode.k === 'barrage-pick') { if (w === this.mode.first.weapon) return this.toast('Pick a different weapon'); this.mode = { k: 'attack', action: 'barrage', weapon: w, first: this.mode.first } }
          else this.mode = { k: 'attack', action: 'barrage', weapon: w }
          this.render()
        }
        return
      case 'shape': if (w && a) { this.b.setWeaponFlag(a, w, 'shape', w.flags?.shape === 'line' ? 'cone' : 'line'); this.previewCache.clear(); this.render() } return
      case 'throughbolt': if (w && a) { this.b.setWeaponFlag(a, w, 'throughbolt', !w.flags?.throughbolt); this.render() } return
      case 'profile': if (w && arg && a) { const i = Number(el.dataset.i); this.cmd(() => { this.b.setProfile(a, w, i) }) } return
      case 'reload': if (w) this.cmd(() => this.b.reload(a, w)); return
      case 'boost': this.cmd(() => this.b.boost(a)); return
      case 'overcharge': this.cmd(() => this.b.overcharge(a)); return
      case 'stab-cool': this.cmd(() => this.b.stabilize(a, 'cool')); return
      case 'stab-repair': this.cmd(() => this.b.stabilize(a, 'repair')); return
      case 'core': this.cmd(() => this.b.activateCore(a)); return
      case 'hide': this.cmd(() => this.b.hide(a)); return
      case 'search': this.cmd(() => this.b.search(a)); return
      case 'disengage': this.cmd(() => this.b.disengage(a)); return
      case 'shutdown': this.cmd(() => this.b.shutDown(a)); return
      case 'bootup': this.cmd(() => this.b.bootUp(a)); return
      case 'standup': this.cmd(() => this.b.standUp(a)); return
      case 'breakgrapple': this.cmd(() => this.b.breakGrapple(a)); return
      case 'releasegrapple': this.cmd(() => this.b.releaseGrapple(a)); return
      case 'selfdestruct': if (confirm('Initiate self-destruct? The mech explodes at the end of its next turn.')) this.cmd(() => this.b.selfDestruct(a)); return
      case 'fulltech': this.cmd(() => this.b.fullTech(a)); return
      case 'tech': this.mode = { k: 'tech', tech: arg as any }; this.render(); return
      case 'melee': this.mode = { k: 'melee', what: arg as any }; this.render(); return
      case 'custom': {
        const ca = this.b.customActions(a).find(x => x.key === arg)
        if (!ca) return
        if (ca.target === 'none' || ca.target === 'self') this.cmd(() => { this.b.useCustom(a, ca, a); this.mode = { k: 'move' } })
        else { this.mode = { k: 'custom', action: ca }; this.render() }
        return
      }
    }
  }

  private onHudHover(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest('[data-tip]') as HTMLElement | null
    if (!el) return
    el.title = el.dataset.tip ?? ''
  }

  // ------------------------------------------------------------------ highlights & preview
  private updateHighlights() {
    const a = this.b.active
    // highlights only depend on the mode, the acting unit, the hovered tile and battle state
    const m = this.mode
    const modeKey = m.k + ('weapon' in m ? m.weapon.uid : '') + ('tech' in m ? m.tech : '') + ('action' in m && typeof m.action === 'object' ? m.action.key : '') + ('what' in m ? m.what : '')
    const key = `${modeKey}|${a?.id}|${a?.pos.x},${a?.pos.y}|${a?.moveLeft}|${this.hoverKey}|${this.b.eventCount}|${this.showFields}`
    if (key === this.highlightKey) return
    this.highlightKey = key
    const hs: Highlight[] = []
    // persistent fields first, so action highlights draw on top
    if (this.showFields) for (const f of this.b.fieldOverlays()) hs.push({ tiles: f.tiles, color: FIELD_COLORS[f.effect], opacity: f.effect === 'barrier' ? 0.4 : 0.22 })
    this.view.setPath(null)
    if (a && a.side === 'player') {
      const m = this.mode
      if (m.k === 'move' && a.moveLeft > 0 && this.b.canMove(a, 'standard') === true) {
        const r = this.b.reachable(a, a.moveLeft)
        hs.push({ tiles: [...r.values()].map(v => v.pos).filter(p => p.x !== a.pos.x || p.y !== a.pos.y), color: 0x3d9be9, opacity: 0.28 })
        if (this.hoverTile) {
          const p = this.b.pathTo(a, this.hoverTile, a.moveLeft)
          if (p) this.view.setPath(p.path)
        }
      }
      if (m.k === 'attack') {
        const pr = this.b.profile(m.weapon)
        if (this.b.isAoE(pr)) {
          const blast = pr.range.find(r => r.type === 'Blast')
          if (blast) hs.push({ tiles: this.tilesWithin(a, this.b.weaponReach(a, m.weapon)), color: 0xff9640, opacity: 0.12 })
          if (this.hoverTile) {
            const t = this.b.aoeTiles(a, m.weapon, this.hoverTile)
            if (typeof t !== 'string') hs.push({ tiles: t, color: 0xff5a1f, opacity: 0.45 })
          }
        } else {
          hs.push({ tiles: this.tilesWithin(a, this.b.weaponReach(a, m.weapon)), color: 0xff5050, opacity: 0.1 })
          for (const t of this.b.alive()) if (this.b.hostile(a, t) && this.b.validTarget(a, m.weapon, t) === true) hs.push({ tiles: footprint(t), color: 0xff2020, opacity: 0.5 })
        }
      }
      if (m.k === 'tech') {
        hs.push({ tiles: this.tilesWithin(a, a.stats.sensors), color: 0x9b59b6, opacity: 0.08 })
        for (const t of this.b.alive()) {
          const okSide = m.tech === 'bolster' ? !this.b.hostile(a, t) && t !== a : this.b.hostile(a, t)
          if (okSide && (m.tech === 'bolster' || this.b.techTargetValid(a, t) === true)) hs.push({ tiles: footprint(t), color: 0xc77dff, opacity: 0.5 })
        }
      }
      if (m.k === 'custom') {
        const ca = m.action
        if (ca.range) hs.push({ tiles: this.tilesWithin(a, ca.range), color: 0xffd166, opacity: 0.1 })
        if (this.hoverTile && ca.area) {
          const t = ca.area.shape === 'blast' ? blastTiles(this.b.map, this.hoverTile, ca.area.size) : ca.area.shape === 'burst' ? burstTiles(this.b.map, a, ca.area.size) : ca.area.shape === 'line' ? lineTiles(this.b.map, a, this.hoverTile, ca.area.size) : coneTiles(this.b.map, a, this.hoverTile, ca.area.size)
          hs.push({ tiles: t, color: 0xffa500, opacity: 0.45 })
        }
      }
      if (m.k === 'melee') for (const t of this.b.alive()) if (this.b.hostile(a, t) && this.b.adjacent(a, t)) hs.push({ tiles: footprint(t), color: 0xff2020, opacity: 0.5 })
      hs.push({ tiles: footprint(a), color: 0x7ff3ff, opacity: 0.35 })
    }
    if (this.b.sitrep.id === 'assassination' && this.b.sitrep.targetId) {
      const t = this.b.unit(this.b.sitrep.targetId)
      if (t && !t.destroyed) hs.push({ tiles: footprint(t), color: 0xffd700, opacity: 0.35 })
    }
    this.view.setHighlights(hs)
  }
  private tilesWithin(u: Unit, r: number): Pos[] {
    return burstTiles(this.b.map, u, r)
  }

  private updateHover() {
    this.updateHighlights()
    const a = this.b.active
    const t = this.hoverTile ? this.b.alive().find(u => footprint(u).some(q => q.x === this.hoverTile!.x && q.y === this.hoverTile!.y)) : undefined
    let html = ''
    if (a && t && this.mode.k === 'attack' && !this.b.isAoE(this.b.profile(this.mode.weapon))) {
      const v = this.b.validTarget(a, this.mode.weapon, t)
      if (v !== true) html = `<b>${esc(t.name)}</b><br><span class="bad">${esc(v)}</span>`
      else {
        const p = this.b.previewAttack(a, this.mode.weapon, t)
        const d = this.cachedPreview(a, this.mode.weapon, t)
        const pct = (x: number) => `${Math.round(x * 100)}%`
        const lethal = d.lethal > 0
          ? `<br><span class="${d.lethal >= 0.5 ? 'good' : 'warnc'}">${d.lethalLabel === 'destroy' ? 'Destroys target' : 'Causes STRUCTURE damage'}: ${pct(d.lethal)}</span>`
          : ''
        html = `<b>${esc(t.name)}</b> — <span class="big">${pct(p.chance)}</span> to hit · crit ${pct(d.critChance)}
          <br>damage on hit <b>${d.minDmg}–${d.maxDmg}</b> (avg ${d.avgDmg.toFixed(1)})${d.heat ? ` + ${d.heat.toFixed(1)} heat` : ''}${d.reliable ? ` · ${d.reliable} on a miss (Reliable)` : ''}
          <br><span class="muted">target HP ${t.hp}/${t.stats.hp}${t.overshield ? ` +${t.overshield} OS` : ''} · ARM ${t.stats.armor}${t.resist.length ? ` · resists ${esc(t.resist.join('/'))}` : ''}</span>${lethal}
          <br>cover: ${p.cover}${p.ctx.reasons.length ? '<br>' + p.ctx.reasons.map(esc).join('<br>') : ''}`
      }
    } else if (a && t && this.mode.k === 'tech' && this.mode.tech === 'invade') {
      const chance = Math.max(0, Math.min(1, (21 - (t.stats.edef - a.stats.techAttack)) / 20))
      html = `<b>${esc(t.name)}</b> — ${Math.round(chance * 100)}% to hit (vs E-DEF ${t.stats.edef})`
    } else if (t) {
      html = unitTooltip(this.b, t)
    } else if (a && this.hoverTile && this.mode.k === 'move') {
      const p = this.b.pathTo(a, this.hoverTile, a.moveLeft)
      if (p) {
        const tile = this.b.map.tiles[this.hoverTile.y * this.b.map.w + this.hoverTile.x]
        html = `move cost ${p.cost}/${a.moveLeft} · elevation ${tile.h}${tile.kind !== 'ground' ? ' · ' + tile.kind : ''}`
      }
    }
    // terrain blocks can be shot at (house rule: 10 HP per level, Evasion 5)
    if (!html && !t && this.hoverTile) {
      const h = this.hoverTile, tile = this.b.map.tiles[h.y * this.b.map.w + h.x]
      if (tile?.kind === 'block') {
        const dmg = this.b.terrainDamage.get(`${h.x},${h.y}`) ?? 0
        html = `<b>Terrain</b> — ${tile.h} level(s) · top section ${10 - dmg}/10 HP · Evasion 5${this.mode.k === 'attack' && this.mode.action === 'skirmish' ? '<br>Click to attack it.' : ''}`
      }
    }
    // fields covering the hovered tile
    if (this.hoverTile && this.showFields) {
      const h = this.hoverTile
      const fs = this.b.fieldOverlays().filter(f => f.tiles.some(q => q.x === h.x && q.y === h.y))
      if (fs.length) html += `${html ? '<hr>' : ''}${[...new Set(fs.map(f => f.label))].map(l => `<div class="small"><span style="color:#${FIELD_COLORS[fs.find(f => f.label === l)!.effect].toString(16).padStart(6, '0')}">■</span> ${esc(l)}</div>`).join('')}`
    }
    this.tooltip.innerHTML = html
    this.tooltip.style.display = html ? 'block' : 'none'
  }

  // ------------------------------------------------------------------ HUD
  render() {
    this.updateHighlights()
    const b = this.b
    const a = b.active
    const sel = this.selected && !this.selected.destroyed ? this.selected : a ?? null
    const s = b.sitrep
    const top = `<div class="topbar">
      <div><b>${esc(this.title)}</b> · ${esc(s.name)}${s.rounds && s.id === 'holdout' ? ` (${b.round}/${s.rounds})` : ''}${s.id === 'control' ? ` (held ${b.sitrepScore ?? 0}/${s.rounds})` : ''} — <span class="muted">${esc(s.description)}</span></div>
      <div>Round ${b.round} · <span class="${b.currentSide}">${b.winner ? (b.winner === 'player' ? 'VICTORY' : 'DEFEAT') : b.currentSide === 'player' ? 'Your move' : 'Enemy activity'}</span>
      <button data-act="rotl" title="Rotate (Q)">⟲</button><button data-act="rotr" title="Rotate (E)">⟳</button><button data-act="speed" title="Animation speed (click to cycle; ⏭ skips animations)">${this.view.speed === 0 ? '⏭ skip' : '×' + this.view.speed}</button><button data-act="gfx" title="Graphics quality: high adds bloom, film grain, ambient particles and practical lights">${this.view.quality === 'high' ? '◈ high' : '◇ low'}</button><button data-act="export" title="Download this battle as a replay file (for bug reports: replay it with npm run replay)">⤓</button>${b.winner && !this.ended ? '<button data-act="finish" class="primary">Continue ▶</button>' : ''}</div></div>`
    const roster = (side: 'player' | 'enemy') => b.units.filter(u => u.side === side && (u.kind === 'mech' || u.kind === 'npc')).map(u => {
      const hp = Math.max(0, u.hp)
      return `<div class="card ${u === sel ? 'sel' : ''} ${u.destroyed ? 'dead' : ''} ${u.activeTurn ? 'active' : ''}" data-act="select" data-arg="${u.id}">
        <div class="nm">${esc(u.name)} <span class="muted">${u.kind === 'mech' ? esc(Lancer.frames.get(u.frameId!)?.name ?? '') : `T${u.tier} ${esc(u.role ?? '')}${u.templates?.length ? ' ' + u.templates.join('/') : ''}`}</span>${u.activationsLeft > 0 && !u.destroyed ? ' <span class="ready">●</span>' : ''}</div>
        <div class="bar hp"><i style="width:${(hp / u.stats.hp) * 100}%"></i></div><div class="row muted">HP ${hp}/${u.stats.hp}${u.overshield ? ` +${u.overshield}OS` : ''}${u.stats.heatcap ? ` · H ${u.heat}/${u.stats.heatcap}` : ''}${u.kind === 'mech' || u.stats.structure > 1 ? ` · S ${u.structure} · R ${u.stress}` : ''}${u.burn ? ` · 🔥${u.burn}` : ''}</div>
      </div>`
    }).join('')
    const left = `<div class="panel left"><h4>Lancers</h4>${roster('player')}<h4>Hostiles</h4>${roster('enemy')}</div>`
    const log = `<div class="panel log">${b.log.slice(-60).map(l => `<div class="l ${l.kind ?? ''}">${annotateTags(esc(l.text))}</div>`).join('')}</div>`
    const bottom = `<div class="panel bottom">${sel ? this.unitPanel(sel) : '<span class="muted">Select a unit.</span>'}</div>`
    this.hud.innerHTML = top + this.initiativeBar() + left + log + bottom
    const lg = this.hud.querySelector('.log')
    if (lg) lg.scrollTop = lg.scrollHeight
  }

  /** Who has acted this round, who is ready, who is acting now. */
  private initiativeBar(): string {
    const b = this.b
    const chip = (u: Unit) => {
      const state = u.destroyed ? 'dead' : u.activeTurn ? 'acting' : u.activationsLeft > 0 ? 'ready' : 'done'
      const short = u.name.length > 14 ? u.name.slice(0, 13) + '…' : u.name
      const pips = u.stats.activations > 1 && !u.destroyed ? `<span class="pips">${'●'.repeat(u.activationsLeft)}${'○'.repeat(Math.max(0, u.stats.activations - u.activationsLeft - (u.activeTurn ? 1 : 0)))}</span>` : ''
      const tip = `${u.name}: ${state === 'ready' ? 'ready to activate' : state === 'acting' ? 'acting now' : state === 'done' ? 'already activated this round' : 'destroyed'}`
      return `<span class="chip ${u.side} ${state} ${u === this.selected ? 'sel' : ''}" data-act="select" data-arg="${u.id}" title="${esc(tip)}">${esc(short)}${pips}</span>`
    }
    const side = (s: 'player' | 'enemy') => b.units.filter(u => u.side === s && (u.kind === 'mech' || u.kind === 'npc')).sort((x, y) => Number(x.destroyed) - Number(y.destroyed)).map(chip).join('')
    const turn = b.winner ? '' : b.currentSide === 'player' ? '◀ your side acts' : 'enemy acts ▶'
    return `<div class="initiative"><div class="side player">${side('player')}</div><div class="turnmark ${b.currentSide}">R${b.round}<br>${turn}</div><div class="side enemy">${side('enemy')}</div></div>`
  }

  private btn(act: string, label: string, ok: true | string, arg = '', extra = '') {
    const dis = ok !== true
    return `<button class="${dis ? 'disabled' : ''} ${extra}" data-act="${act}" data-arg="${esc(arg)}" ${dis ? `title="${esc(ok as string)}"` : ''}>${label}</button>`
  }

  private unitPanel(u: Unit): string {
    const b = this.b
    const mine = u.side === 'player' && (u.kind === 'mech' || u.kind === 'npc')
    const a = b.active
    const isActive = a === u
    const f = u.frameId ? Lancer.frames.get(u.frameId) : undefined
    const st = u.stats
    const statusTxt = (u.statuses.map(s => s.id) as string[]).concat(b.has(u, 'engaged') ? ['engaged'] : [], b.has(u, 'dangerzone') ? ['danger zone'] : [])
    let head = `<div class="uhead"><div><b>${esc(u.name)}</b> ${f ? `<span class="muted">${esc(u.pilotName ?? '')} · ${esc(f.source)} ${esc(f.name)}</span>` : `<span class="muted">${u.kind === 'npc' ? `Tier ${u.tier} ${esc(u.role ?? '')} ${esc((u.templates ?? []).join(' '))}` : esc(u.kind)}</span>`}
      <div class="stats">HP ${u.hp}/${st.hp} · ARM ${st.armor} · EVA ${st.evasion} · E-DEF ${st.edef} · HEAT ${u.heat}/${st.heatcap} · SPD ${st.speed} · SENS ${st.sensors} · SAVE ${st.save}${u.kind === 'mech' ? ` · TECH +${st.techAttack} · GRIT +${st.grit} · REP ${u.repairs}` : ` · ATK +${st.attackBonus}`} · H${st.hull} A${st.agi} S${st.sys} E${st.eng}</div>
      ${statusTxt.length ? `<div class="statuses">${statusTxt.map(s => `<span class="status">${esc(s)}</span>`).join('')}</div>` : ''}</div>`
    if (mine) head += `<div class="policies" title="Reaction policy (click to cycle): auto = decided for you, ask = the HUD asks you, off = never">${(['brace', 'overwatch', 'reactions'] as const).map(k => `<label class="${u.policies[k] ?? 'ask'}" data-act="policy" data-arg="${k}">${({ brace: 'Brace', overwatch: 'Overwatch', reactions: 'Other reactions' })[k]}: ${u.policies[k] ?? 'ask'}</label>`).join('')}</div>`
    head += '</div>'
    const wcards = u.weapons.map(w => this.weaponCard(u, w, isActive)).join('')
    let actions = ''
    if (mine && !isActive && b.currentSide === 'player' && !b.activeId && u.activationsLeft > 0) actions = `<div class="actions">${this.btn('activate', '▶ Activate', true, '', 'primary')}${this.btn('auto', 'Auto (AI turn)', true)}</div>`
    if (isActive && u.side === 'player') {
      const q = b.canSpend(u, 'quick'), fu = b.canSpend(u, 'full'), pr = b.canSpend(u, 'protocol')
      const qa = (action: string) => b.canSpend(u, 'quick', action)
      const qt = b.canQuickTech(u)
      const jam = b.has(u, 'jammed') ? 'Jammed' : true
      const and = (x: true | string, y: true | string) => (x === true ? y : x)
      const custom = b.customActions(u)
      const fr = u.frameId ? Lancer.frames.get(u.frameId) : undefined
      const actLabel = (x: string) => ({ quick: 'Q', full: 'F', protocol: 'P', free: 'free', reaction: 'R', quick_tech: 'QT', full_tech: 'FT' } as Record<string, string>)[x] ?? x
      const ecoTxt = `<span class="eco">Move ${u.moveLeft} · Actions ${u.actionsLeft}${u.flags.bonusQuick ? `+${u.flags.bonusQuick}` : ''}${u.flags.fullTechLeft ? ` · tech ${u.flags.fullTechLeft}` : ''} · Reactions ${u.reactionsLeft} · OC ${['1', '1d3', '1d6', '1d6+4'][u.overchargeLevel]}</span>`
      actions = `<div class="actions">${ecoTxt}
        ${this.mode.k !== 'move' && this.mode.k !== 'idle' ? this.btn('cancel', '✕ Cancel (Esc)', true, '', 'warn') : ''}
        ${b.has(u, 'prone') ? this.btn('standup', 'Stand Up', b.canStandUp(u)) : ''}
        ${this.btn('boost', 'Boost [Q]', and(qa('boost'), b.has(u, 'slowed') || b.has(u, 'immobilized') ? 'Slowed/immobilized' : b.has(u, 'prone') ? 'Prone: stand up first' : true))}
        ${this.btn('overcharge', 'Overcharge', u.overchargedThisTurn ? 'Once per turn' : u.kind === 'mech' ? true : 'Mechs only')}
        ${this.btn('tech', 'Invade [QT]', and(b.canQuickTech(u, 'invade'), jam), 'invade')}${this.btn('tech', 'Lock On [QT]', and(b.canQuickTech(u, 'lock_on'), jam), 'lockon')}${this.btn('tech', 'Bolster [QT]', and(b.canQuickTech(u, 'bolster'), jam), 'bolster')}${this.btn('tech', 'Scan [QT]', and(b.canQuickTech(u, 'scan'), jam), 'scan')}${this.btn('fulltech', 'Full Tech [F]', and(fu, jam))}
        ${this.btn('stab-cool', 'Stabilize: Cool [F]', fu)}${this.btn('stab-repair', 'Stabilize: Repair [F]', and(fu, u.repairs > 0 ? true : 'No repairs'))}
        ${this.btn('disengage', 'Disengage [F]', fu)}${this.btn('hide', 'Hide [Q]', and(qa('hide'), b.canHide(u) ? true : 'Need cover / out of sight'))}${this.btn('search', 'Search [Q]', qa('search'))}
        ${this.btn('melee', 'Ram [Q]', qa('ram'), 'ram')}${this.btn('melee', 'Grapple [Q]', qa('grapple'), 'grapple')}${this.btn('melee', 'Improvised [F]', fu, 'improvised')}
        ${b.grapples.some(g => g.d === u.id) ? this.btn('breakgrapple', 'Break Grapple [Q]', qa('break_grapple')) : ''}${b.grapples.some(g => g.a === u.id) ? this.btn('releasegrapple', 'Release Grapple [Free]', true) : ''}
        ${b.has(u, 'shutdown') ? this.btn('bootup', 'Boot Up [F]', u.actionsLeft >= 2 ? true : 'Needs full action') : this.btn('shutdown', 'Shut Down [Q]', qa('shut_down'))}
        ${fr ? this.btn('core', `CORE: ${esc(fr.core_system.active_name ?? fr.core_system.name)} [${actLabel((fr.core_system.activation ?? 'quick').toLowerCase())}]`, u.coreAvailable ? (fr.core_system.activation === 'Protocol' ? pr : fr.core_system.activation === 'Full' ? fu : q) : 'Core power spent', '', 'core') : ''}
        ${this.btn('selfdestruct', 'Self-Destruct', qa('self_destruct'), '', 'warn')}
        ${this.b.canUndoMove(u) ? this.btn('undo', '↶ Undo move', true) : ''}${this.btn('auto', 'Auto (AI)', true)}${this.btn('end', 'End Turn ⏎', true, '', 'primary')}
      </div>
      ${custom.length ? `<div class="actions systems"><span class="eco">Systems & traits</span>${custom.map(c => `<button class="${c.usable(b, u) === true ? '' : 'disabled'}" data-act="custom" data-arg="${esc(c.key)}" title="${esc(c.text)}${c.usable(b, u) !== true ? ' — ' + esc(c.usable(b, u) as string) : ''}">${esc(c.name)} [${actLabel(c.activation)}]${c.text.startsWith('[manual]') ? '*' : ''}</button>`).join('')}</div>` : ''}`
      if (this.mode.k === 'barrage-pick') actions = `<div class="hint">Barrage: choose the second weapon below.</div>` + actions
      if (this.mode.k === 'attack') actions = `<div class="hint">${this.mode.action === 'aux' ? 'Optional aux attack — ' : ''}Choose a target for <b>${esc(this.mode.weapon.name)}</b>. ${this.b.isAoE(this.b.profile(this.mode.weapon)) ? 'Click a tile to aim the area.' : ''}</div>` + actions
      if (this.mode.k === 'tech') actions = `<div class="hint">Choose a target for ${this.mode.tech.toUpperCase()}.</div>` + actions
      if (this.mode.k === 'custom') actions = `<div class="hint">${esc(this.mode.action.name)}: ${esc(this.mode.action.text)}</div>` + actions
      if (this.mode.k === 'melee') actions = `<div class="hint">Choose an adjacent target to ${this.mode.what}.</div>` + actions
    }
    const sysList = u.systems.length ? `<div class="syslist">${u.systems.map(s => `<span class="sys ${s.destroyed ? 'destroyed' : ''}" data-tip="${esc(sysText(s))}">${esc(s.name)}${s.usesLeft != null ? ` (${s.usesLeft})` : ''}${!s.charged ? ' ⌛' : ''}</span>`).join('')}</div>` : ''
    return head + actions + `<div class="weapons">${wcards}</div>` + sysList
  }

  private weaponCard(u: Unit, w: Weapon, active: boolean): string {
    const b = this.b
    const pr = b.profile(w)
    const ranges = b.ranges(u, w).map(r => rangeChip(r.type, r.val)).join(', ')
    const dmg = pr.damage.map(d => `${d.val} ${d.type}`).join(' + ')
    const tags = pr.tags.filter(t => !['tg_npc_weapon', 'tg_npc_trait', 'tg_npc_system'].includes(t.id)).map(t => tagChip(t.id, t.val, `${TAG_NAMES[t.id] ?? tagInfo(t.id, t.val).name}${TAG_NAMES[t.id] && t.val != null && t.val !== '' ? ' ' + t.val : ''}`)).join(', ')
    const usable = b.weaponUsable(u, w)
    const fired = b.firedThisTurn(u, w) ? 'Already attacked this turn' : true
    const q = b.canSpend(u, 'quick'), fu = b.canSpend(u, 'full')
    const all = (...xs: (true | string)[]) => xs.find(x => x !== true) ?? true
    let btns = ''
    if (active && u.side === 'player') {
      if (this.mode.k === 'barrage-pick') btns = this.btn('barrage', 'Barrage #2', all(usable, fired), w.uid, 'primary')
      else {
        btns = (w.size !== 'Superheavy' ? this.btn('skirmish', 'Skirmish [Q]', all(b.canSpend(u, 'quick', w.tech ? `tech:${w.uid}` : 'skirmish'), usable, fired), w.uid) : '') + this.btn('barrage', 'Barrage [F]', all(fu, usable, fired), w.uid)
        if (!w.loaded && !w.destroyed) btns += this.btn('reload', 'Reload [Q]', b.canSpend(u, 'quick', 'reload'), w.uid)
        if (w.profiles.length > 1) btns += w.profiles.map((p, i) => (i === w.profileIndex ? '' : `<button data-act="profile" data-arg="${w.uid}" data-i="${i}" title="Switch profile">${esc(p.name)}</button>`)).join('')
        if (pr.range.some(r => r.type === 'Line') && pr.range.some(r => r.type === 'Cone')) btns += `<button data-act="shape" data-arg="${w.uid}" title="Fire as a Cone or a Line">${w.flags?.shape === 'line' ? 'Line' : 'Cone'} (switch)</button>`
        if (w.modId === 'wm_throughbolt_rounds') btns += `<button data-act="throughbolt" data-arg="${w.uid}" class="${w.flags?.throughbolt ? 'on' : ''}" title="Throughbolt round: punch a Line 3 path through terrain (2 AP kinetic to everything on it), then attack from its end">Throughbolt: ${w.flags?.throughbolt ? 'ON' : 'off'}</button>`
      }
    }
    const fx = [pr.onHit, pr.onCrit].flat().map(e => (e.do === 'text' ? stripHtml(e.text) : e.do === 'status' ? `${e.status}${e.save ? ` (${e.save} save)` : ''}` : e.do)).join('; ')
    const note = (pr.text ? stripHtml(pr.text) + ' ' : '') + fx
    return `<div class="wcard ${w.destroyed ? 'destroyed' : ''} ${usable !== true ? 'unusable' : ''}"${note.trim() ? ` data-tip="${esc(note)}"` : ''}>
      <div class="nm">${esc(w.name)}${w.profiles.length > 1 ? ` <span class="muted">[${esc(pr.name)}]</span>` : ''} <span class="muted">${esc(w.size)} ${esc(w.type)}</span>${w.usesLeft != null ? ` <span class="uses">${w.usesLeft} uses</span>` : ''}${!w.loaded ? ' <span class="bad">UNLOADED</span>' : ''}${!w.charged ? ' <span class="bad">recharging</span>' : ''}${w.destroyed ? ' <span class="bad">DESTROYED</span>' : ''}</div>
      <div class="row">${ranges} · <b>${esc(dmg || '—')}</b>${tags ? ` · <span class="muted">${tags}</span>` : ''}</div>
      ${btns ? `<div class="wbtns">${btns}</div>` : ''}</div>`
  }
}

function sysText(s: { dataId: string; feature?: any; name: string }): string {
  if (s.feature) return s.feature.text ?? s.feature.type
  const d = Lancer.systems.get(s.dataId)
  return d ? stripHtml(d.effect ?? (d.actions ?? []).map(a => a.detail ?? '').join(' ')) : ''
}

export function unitTooltip(b: Battle, u: Unit): string {
  const st = u.statuses.map(s => s.id).join(', ')
  return `<b>${esc(u.name)}</b> ${u.side === 'enemy' ? '<span class="bad">hostile</span>' : ''}<br>HP ${u.hp}/${u.stats.hp} · ARM ${u.stats.armor} · EVA ${u.stats.evasion} · E-DEF ${u.stats.edef}${u.stats.heatcap ? ` · HEAT ${u.heat}/${u.stats.heatcap}` : ''}${st ? `<br>${esc(st)}` : ''}${u.flags.description ? `<br><i>${esc(u.flags.description)}</i>` : ''}`
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export { hasTag, tagVal, key }

/** Overlay colours for persistent fields, by what they do. */
const FIELD_COLORS: Record<string, number> = {
  protect: 0x45d483, harm: 0xff5a5a, control: 0xc77dff, reveal: 0xffd166, barrier: 0x7ff3ff, terrain: 0x9c6b3c,
}
