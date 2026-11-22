// Battle screen: XCOM-style HUD over the isometric view. Every player command goes through the
// Battle API (same rules as the AI); the enemy side is driven by the tactical AI.
import { Lancer } from '../data/lancer'
import { pickNextUnit, runAiTurn } from '../ai/ai'
import { type Battle, stripHtml } from '../rules/battle'
import { blastTiles, burstTiles, coneTiles, key, lineTiles, footprint } from '../rules/grid'
import type { CustomAction } from '../rules/effects/registry'
import { hasTag, tagVal } from '../rules/stats'
import type { Pos, Unit, Weapon } from '../rules/types'
import { BattleView, type Highlight } from '../render/scene'
import { esc } from './dom'

type Mode =
  | { k: 'idle' }
  | { k: 'move' }
  | { k: 'attack'; action: 'skirmish' | 'barrage' | 'aux'; weapon: Weapon; first?: { weapon: Weapon; aim: { targetId?: string; tile?: Pos } } }
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
    this.view.onTileHover = p => { this.hoverTile = p; this.updateHover() }
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
    this.view.dispose()
  }

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { this.mode = this.b.active?.side === 'player' ? { k: 'move' } : { k: 'idle' }; this.render() }
    if (e.key === 'Tab') {
      e.preventDefault()
      const ready = this.b.combatants('player').filter(u => u.activationsLeft > 0 || u.activeTurn)
      if (ready.length) { const i = ready.indexOf(this.selected!); this.select(ready[(i + 1) % ready.length]) }
    }
    if (e.key === 'Enter' && this.b.active?.side === 'player') this.cmd(() => this.b.endTurn(this.b.active!), true)
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
        runAiTurn(this.b, u)
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
      if (!this.selected || this.selected.side !== 'player' || this.selected.activationsLeft <= 0) this.selected = ready[0] ?? null
    }
    this.render()
  }

  private cmd(f: () => void, thenAdvance = false) {
    try {
      f()
    } catch (err) {
      this.toast((err as Error).message)
    }
    this.view.syncUnits()
    if (this.b.active?.side === 'player' && this.mode.k === 'idle') this.mode = { k: 'move' }
    this.render()
    if (thenAdvance || !this.b.activeId || this.b.winner) void this.advance()
    if (this.b.winner) setTimeout(() => { if (!this.ended) void this.advance() }, 1500)
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
      if (!aoe && !target) return
      if (m.action === 'skirmish' || m.action === 'aux') {
        this.cmd(() => {
          const r = m.action === 'aux' ? this.b.weaponAttack(a, m.weapon, aim, 'skirmish', { noBonusDamage: true }) : this.b.skirmish(a, m.weapon, aim)
          if (!r.ok) throw new Error(r.reason)
          if (m.action === 'aux') this.b.markFired(a, m.weapon)
          this.mode = { k: 'move' }
          if (m.action === 'skirmish') {
            const aux = a.weapons.find(w => w !== m.weapon && w.size === 'Auxiliary' && w.mountIndex === m.weapon.mountIndex && m.weapon.mountIndex >= 0 && this.b.weaponUsable(a, w) === true && !this.b.firedThisTurn(a, w))
            if (aux && !a.destroyed) { this.mode = { k: 'attack', action: 'aux', weapon: aux }; this.toast(`Optional: fire ${aux.name} (same mount, no bonus damage) — Esc to skip`) }
          }
        })
      } else if (m.action === 'barrage') {
        if (!m.first) {
          if (m.weapon.size === 'Superheavy') this.cmd(() => { const r = this.b.barrage(a, { weapon: m.weapon, aim }); if (!r.ok) throw new Error(r.reason); this.mode = { k: 'move' } })
          else { this.mode = { k: 'barrage-pick', first: { weapon: m.weapon, aim } }; this.render(); this.toast('Barrage: choose the second weapon') }
        } else {
          const first = m.first
          this.cmd(() => { const r = this.b.barrage(a, first, { weapon: m.weapon, aim }); if (!r.ok) throw new Error(r.reason); this.mode = { k: 'move' } })
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
        if (sel) this.cmd(() => { this.b.beginTurn(sel); this.mode = { k: 'move' } })
        return
      case 'end': if (a) this.cmd(() => { this.b.endTurn(a); this.mode = { k: 'idle' } }, true); return
      case 'auto':
        if (a && a.side === 'player') this.cmd(() => { runAiTurn(this.b, a); this.mode = { k: 'idle' } }, true)
        else if (sel && sel.side === 'player' && !this.b.activeId && sel.activationsLeft > 0 && this.b.currentSide === 'player') this.cmd(() => { runAiTurn(this.b, sel); this.mode = { k: 'idle' } }, true)
        return
      case 'cancel': this.mode = a ? { k: 'move' } : { k: 'idle' }; this.render(); return
      case 'rotl': this.view.rotate(-1); return
      case 'rotr': this.view.rotate(1); return
      case 'speed': { const order = [1, 2, 4, 0]; this.view.setSpeed(order[(order.indexOf(this.view.speed) + 1) % order.length]); this.render(); return }
      case 'finish': if (this.b.winner && !this.ended) { this.ended = true; this.onEnd(this.b.winner as 'player' | 'enemy') } return
      case 'policy': if (sel && arg) { (sel.policies as any)[arg] = !(sel.policies as any)[arg]; this.render() } return
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
      case 'profile': if (w && arg) { const i = Number(el.dataset.i); this.cmd(() => { w.profileIndex = i }) } return
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
    const hs: Highlight[] = []
    this.view.setPath(null)
    if (a && a.side === 'player') {
      const m = this.mode
      if (m.k === 'move' && a.moveLeft > 0 && this.b.canMove(a, 'standard') === true && !this.b.has(a, 'prone')) {
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
        html = `<b>${esc(t.name)}</b> — <span class="big">${Math.round(p.chance * 100)}%</span> to hit<br>cover: ${p.cover}${p.ctx.reasons.length ? '<br>' + p.ctx.reasons.map(esc).join('<br>') : ''}<br>expected dmg ≈ ${p.expectedDamage.toFixed(1)}`
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
      <button data-act="rotl" title="Rotate (Q)">⟲</button><button data-act="rotr" title="Rotate (E)">⟳</button><button data-act="speed" title="Animation speed (click to cycle; ⏭ skips animations)">${this.view.speed === 0 ? '⏭ skip' : '×' + this.view.speed}</button>${b.winner && !this.ended ? '<button data-act="finish" class="primary">Continue ▶</button>' : ''}</div></div>`
    const roster = (side: 'player' | 'enemy') => b.units.filter(u => u.side === side && (u.kind === 'mech' || u.kind === 'npc')).map(u => {
      const hp = Math.max(0, u.hp)
      return `<div class="card ${u === sel ? 'sel' : ''} ${u.destroyed ? 'dead' : ''} ${u.activeTurn ? 'active' : ''}" data-act="select" data-arg="${u.id}">
        <div class="nm">${esc(u.name)} <span class="muted">${u.kind === 'mech' ? esc(Lancer.frames.get(u.frameId!)?.name ?? '') : `T${u.tier} ${esc(u.role ?? '')}${u.templates?.length ? ' ' + u.templates.join('/') : ''}`}</span>${u.activationsLeft > 0 && !u.destroyed ? ' <span class="ready">●</span>' : ''}</div>
        <div class="bar hp"><i style="width:${(hp / u.stats.hp) * 100}%"></i></div><div class="row muted">HP ${hp}/${u.stats.hp}${u.overshield ? ` +${u.overshield}OS` : ''}${u.stats.heatcap ? ` · H ${u.heat}/${u.stats.heatcap}` : ''}${u.kind === 'mech' || u.stats.structure > 1 ? ` · S ${u.structure} · R ${u.stress}` : ''}${u.burn ? ` · 🔥${u.burn}` : ''}</div>
      </div>`
    }).join('')
    const left = `<div class="panel left"><h4>Lancers</h4>${roster('player')}<h4>Hostiles</h4>${roster('enemy')}</div>`
    const log = `<div class="panel log">${b.log.slice(-60).map(l => `<div class="l ${l.kind ?? ''}">${esc(l.text)}</div>`).join('')}</div>`
    const bottom = `<div class="panel bottom">${sel ? this.unitPanel(sel) : '<span class="muted">Select a unit.</span>'}</div>`
    this.hud.innerHTML = top + left + log + bottom
    const lg = this.hud.querySelector('.log')
    if (lg) lg.scrollTop = lg.scrollHeight
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
    if (mine) head += `<div class="policies"><label class="${u.policies.autoBrace ? 'on' : ''}" data-act="policy" data-arg="autoBrace">auto-Brace</label><label class="${u.policies.autoOverwatch ? 'on' : ''}" data-act="policy" data-arg="autoOverwatch">auto-Overwatch</label></div>`
    head += '</div>'
    const wcards = u.weapons.map(w => this.weaponCard(u, w, isActive)).join('')
    let actions = ''
    if (mine && !isActive && b.currentSide === 'player' && !b.activeId && u.activationsLeft > 0) actions = `<div class="actions">${this.btn('activate', '▶ Activate', true, '', 'primary')}${this.btn('auto', 'Auto (AI turn)', true)}</div>`
    if (isActive && u.side === 'player') {
      const q = b.canSpend(u, 'quick'), fu = b.canSpend(u, 'full'), pr = b.canSpend(u, 'protocol')
      const qt = b.canQuickTech(u)
      const jam = b.has(u, 'jammed') ? 'Jammed' : true
      const and = (x: true | string, y: true | string) => (x === true ? y : x)
      const custom = b.customActions(u)
      const fr = u.frameId ? Lancer.frames.get(u.frameId) : undefined
      const actLabel = (x: string) => ({ quick: 'Q', full: 'F', protocol: 'P', free: 'free', reaction: 'R', quick_tech: 'QT', full_tech: 'FT' } as Record<string, string>)[x] ?? x
      const ecoTxt = `<span class="eco">Move ${u.moveLeft} · Actions ${u.actionsLeft}${u.flags.bonusQuick ? `+${u.flags.bonusQuick}` : ''}${u.flags.fullTechLeft ? ` · tech ${u.flags.fullTechLeft}` : ''} · Reactions ${u.reactionsLeft} · OC ${['1', '1d3', '1d6', '1d6+4'][u.overchargeLevel]}</span>`
      actions = `<div class="actions">${ecoTxt}
        ${this.mode.k !== 'move' && this.mode.k !== 'idle' ? this.btn('cancel', '✕ Cancel (Esc)', true, '', 'warn') : ''}
        ${b.has(u, 'prone') ? this.btn('standup', 'Stand Up', b.has(u, 'immobilized') ? 'Immobilized' : true) : ''}
        ${this.btn('boost', 'Boost [Q]', and(q, b.has(u, 'slowed') || b.has(u, 'immobilized') ? 'Slowed/immobilized' : true))}
        ${this.btn('overcharge', 'Overcharge', u.overchargedThisTurn ? 'Once per turn' : u.kind === 'mech' ? true : 'Mechs only')}
        ${this.btn('tech', 'Invade [QT]', and(qt, jam), 'invade')}${this.btn('tech', 'Lock On [QT]', and(qt, jam), 'lockon')}${this.btn('tech', 'Bolster [QT]', and(qt, jam), 'bolster')}${this.btn('tech', 'Scan [QT]', and(qt, jam), 'scan')}${this.btn('fulltech', 'Full Tech [F]', and(fu, jam))}
        ${this.btn('stab-cool', 'Stabilize: Cool [F]', fu)}${this.btn('stab-repair', 'Stabilize: Repair [F]', and(fu, u.repairs > 0 ? true : 'No repairs'))}
        ${this.btn('disengage', 'Disengage [F]', fu)}${this.btn('hide', 'Hide [Q]', and(q, b.canHide(u) ? true : 'Need cover / out of sight'))}${this.btn('search', 'Search [Q]', q)}
        ${this.btn('melee', 'Ram [Q]', q, 'ram')}${this.btn('melee', 'Grapple [Q]', q, 'grapple')}${this.btn('melee', 'Improvised [F]', fu, 'improvised')}
        ${b.has(u, 'grappled') ? this.btn('breakgrapple', 'Break Grapple [Q]', q) : ''}
        ${b.has(u, 'shutdown') ? this.btn('bootup', 'Boot Up [F]', u.actionsLeft >= 2 ? true : 'Needs full action') : this.btn('shutdown', 'Shut Down [Q]', q)}
        ${fr ? this.btn('core', `CORE: ${esc(fr.core_system.active_name ?? fr.core_system.name)} [${actLabel((fr.core_system.activation ?? 'quick').toLowerCase())}]`, u.coreAvailable ? (fr.core_system.activation === 'Protocol' ? pr : fr.core_system.activation === 'Full' ? fu : q) : 'Core power spent', '', 'core') : ''}
        ${this.btn('selfdestruct', 'Self-Destruct', q, '', 'warn')}
        ${this.btn('auto', 'Auto (AI)', true)}${this.btn('end', 'End Turn ⏎', true, '', 'primary')}
      </div>
      ${custom.length ? `<div class="actions systems"><span class="eco">Systems & traits</span>${custom.map(c => `<button class="${c.usable(b, u) === true ? '' : 'disabled'}" data-act="custom" data-arg="${esc(c.key)}" title="${esc(c.text)}${c.usable(b, u) !== true ? ' — ' + esc(c.usable(b, u) as string) : ''}">${esc(c.name)} [${actLabel(c.activation)}]${c.text.startsWith('[manual]') ? '*' : ''}</button>`).join('')}</div>` : ''}`
      if (this.mode.k === 'barrage-pick') actions = `<div class="hint">Barrage: choose the second weapon below.</div>` + actions
      if (this.mode.k === 'attack') actions = `<div class="hint">${this.mode.action === 'aux' ? 'Optional aux attack — ' : ''}Choose a target for <b>${esc(this.mode.weapon.name)}</b>. ${this.b.isAoE(this.b.profile(this.mode.weapon)) ? 'Click a tile to aim the area.' : ''}</div>` + actions
      if (this.mode.k === 'tech') actions = `<div class="hint">Choose a target for ${this.mode.tech.toUpperCase()}.</div>` + actions
      if (this.mode.k === 'custom') actions = `<div class="hint">${esc(this.mode.action.name)}: ${esc(this.mode.action.text)}</div>` + actions
      if (this.mode.k === 'melee') actions = `<div class="hint">Choose an adjacent target to ${this.mode.what}.</div>` + actions
    }
    const sysList = u.systems.length ? `<div class="syslist">${u.systems.map(s => `<span class="sys ${s.destroyed ? 'destroyed' : ''}" title="${esc(sysText(s))}">${esc(s.name)}${s.usesLeft != null ? ` (${s.usesLeft})` : ''}${!s.charged ? ' ⌛' : ''}</span>`).join('')}</div>` : ''
    return head + actions + `<div class="weapons">${wcards}</div>` + sysList
  }

  private weaponCard(u: Unit, w: Weapon, active: boolean): string {
    const b = this.b
    const pr = b.profile(w)
    const ranges = b.ranges(u, w).map(r => `${r.type} ${r.val}`).join(', ')
    const dmg = pr.damage.map(d => `${d.val} ${d.type}`).join(' + ')
    const tags = pr.tags.map(t => `${TAG_NAMES[t.id] ?? t.id.replace('tg_', '')}${t.val != null && t.val !== '' ? ' ' + t.val : ''}`).join(', ')
    const usable = b.weaponUsable(u, w)
    const fired = b.firedThisTurn(u, w) ? 'Already attacked this turn' : true
    const q = b.canSpend(u, 'quick'), fu = b.canSpend(u, 'full')
    const all = (...xs: (true | string)[]) => xs.find(x => x !== true) ?? true
    let btns = ''
    if (active && u.side === 'player') {
      if (this.mode.k === 'barrage-pick') btns = this.btn('barrage', 'Barrage #2', all(usable, fired), w.uid, 'primary')
      else {
        btns = (w.size !== 'Superheavy' ? this.btn('skirmish', 'Skirmish [Q]', all(q, usable, fired), w.uid) : '') + this.btn('barrage', 'Barrage [F]', all(fu, usable, fired), w.uid)
        if (!w.loaded && !w.destroyed) btns += this.btn('reload', 'Reload [Q]', q, w.uid)
        if (w.profiles.length > 1) btns += w.profiles.map((p, i) => (i === w.profileIndex ? '' : `<button data-act="profile" data-arg="${w.uid}" data-i="${i}" title="Switch profile">${esc(p.name)}</button>`)).join('')
      }
    }
    const fx = [pr.onHit, pr.onCrit].flat().map(e => (e.do === 'text' ? stripHtml(e.text) : e.do === 'status' ? `${e.status}${e.save ? ` (${e.save} save)` : ''}` : e.do)).join('; ')
    return `<div class="wcard ${w.destroyed ? 'destroyed' : ''} ${usable !== true ? 'unusable' : ''}" title="${esc((pr.text ? stripHtml(pr.text) + ' ' : '') + fx)}">
      <div class="nm">${esc(w.name)}${w.profiles.length > 1 ? ` <span class="muted">[${esc(pr.name)}]</span>` : ''} <span class="muted">${esc(w.size)} ${esc(w.type)}</span>${w.usesLeft != null ? ` <span class="uses">${w.usesLeft} uses</span>` : ''}${!w.loaded ? ' <span class="bad">UNLOADED</span>' : ''}${!w.charged ? ' <span class="bad">recharging</span>' : ''}${w.destroyed ? ' <span class="bad">DESTROYED</span>' : ''}</div>
      <div class="row">${esc(ranges)} · <b>${esc(dmg || '—')}</b>${tags ? ` · <span class="muted">${esc(tags)}</span>` : ''}</div>
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
