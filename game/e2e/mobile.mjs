// Mobile end-to-end check: plays the start of a campaign on an emulated phone using touch only, and
// checks the phone layout (no sideways overflow, touch-sized battle buttons, no page errors).
// - iPhone 13 landscape: New run → interlude (tap and hold) → node card → Enter → battle: activate,
//   open Attack, tap a target twice (preview, then confirm), then let Auto finish the fight.
// - iPhone 13 portrait: a quick skirmish shows the phone HUD and the one-time rotate tip.
// Usage: npm run e2e:mobile   (needs Playwright + Chromium; skips otherwise)
import { createServer } from 'vite'
import { createRequire } from 'node:module'

let pw
try { pw = await import('playwright') } catch {
  try { pw = createRequire(import.meta.url)('playwright') } catch { console.log('e2e:mobile: playwright not installed — skipping'); process.exit(0) }
}
const { chromium, devices } = pw

const server = await createServer({ server: { port: 5198, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
const failures = []
const fail = msg => { console.error(`e2e:mobile: FAILED — ${msg}`); failures.push(msg) }

async function phone(name) {
  const d = { ...devices[name] }
  delete d.defaultBrowserType
  const ctx = await browser.newContext({ ...d, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error' && !/GL Driver/.test(m.text())) errors.push(m.text()) })
  await page.goto('http://localhost:5198/')
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('dov.animSpeed', '0') })
  await page.reload()
  return { ctx, page, errors }
}

/** No screen may scroll sideways on a phone. */
async function noOverflow(page, where) {
  const o = await page.evaluate(() => {
    const s = document.querySelector('.screen')
    return { doc: document.scrollingElement.scrollWidth - innerWidth, screen: s ? s.scrollWidth - s.clientWidth : 0 }
  })
  if (o.doc > 1 || o.screen > 1) fail(`${where}: wider than the screen (${JSON.stringify(o)})`)
}

/** Tap the first visible element matching `sel` (real touch events). */
const tap = (page, sel) => page.locator(sel).first().tap()

/** Answer any open decision prompt with its first option. */
async function answerPrompts(page) {
  for (let i = 0; i < 6; i++) {
    if (!(await page.locator('.picker button[data-i]').count())) return
    await tap(page, '.picker button[data-i]')
    await page.waitForTimeout(300)
  }
}

try {
  // ---------------------------------------------------------------- landscape campaign start
  {
    const { ctx, page, errors } = await phone('iPhone 13 landscape')
    if (!(await page.evaluate(() => document.documentElement.hasAttribute('data-phone')))) fail('phone layout flag not set')
    await noOverflow(page, 'title')
    await tap(page, 'button:has-text("New run")')
    await page.waitForSelector('.screen.hangar')
    await noOverflow(page, 'hangar')
    await tap(page, 'button:has-text("Begin run")')
    // interlude: tap and hold to skip
    await page.waitForSelector('.interlude .tx')
    const hint = await page.textContent('.ix-hint')
    if (!/TAP AND HOLD/.test(hint ?? '')) fail(`interlude hint is not touch copy: "${hint}"`)
    await page.evaluate(() => document.querySelector('.interlude').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' })))
    await page.waitForTimeout(1500)
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' })))
    await page.waitForSelector('.runmap')
    await noOverflow(page, 'campaign map')
    // a tap opens the node card; Enter starts the fight
    await tap(page, '.node.avail')
    await page.waitForSelector('.nodecard.docked [data-enter]')
    await tap(page, '.nodecard.docked [data-enter]')
    await page.waitForFunction(() => !!window.__dov.battle, null, { timeout: 30000 })
    await page.waitForSelector('.sheet')
    // activate the first ready lancer from the sheet
    await page.waitForFunction(() => document.querySelector('.sheet [data-act="activate"]') || window.__dov.battle.b.active, null, { timeout: 30000 })
    if (await page.locator('.sheet [data-act="activate"]').count()) await tap(page, '.sheet [data-act="activate"]')
    await answerPrompts(page)
    await page.waitForSelector('.sheet [data-act="sheet-tab"]')
    // touch-sized buttons in the sheet
    const small = await page.evaluate(() => [...document.querySelectorAll('.sheet .sh-row button')].filter(b => b.getBoundingClientRect().height < 40).map(b => b.textContent.trim()))
    if (small.length) fail(`sheet buttons under 40 px tall: ${small.join(', ')}`)
    // Attack tab → first usable Skirmish → tap a valid target twice (preview, confirm)
    await tap(page, '.sheet [data-act="sheet-tab"][data-arg="attack"]')
    // test setup: bring one hostile into range (turn 1 usually starts out of reach on these long maps)
    await page.evaluate(() => {
      const s = window.__dov.battle, b = s.b, a = b.active
      const w = a.weapons.find(w => !w.destroyed && b.weaponUsable(a, w) === true)
      if (!w || b.alive().some(t => b.hostile(a, t) && b.validTarget(a, w, t) === true)) return
      const e = b.alive().find(t => b.hostile(a, t) && t.stats.size <= 1)
      if (!e) return
      const home = e.pos
      for (let r = 2; r <= 4; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        const p = { x: a.pos.x + dx, y: a.pos.y + dy }
        if (p.x < 0 || p.y < 0 || p.x >= b.map.w || p.y >= b.map.h || b.alive().some(u => u.pos.x === p.x && u.pos.y === p.y)) continue
        e.pos = p
        if (b.validTarget(a, w, e) === true) { s.view.syncUnits(); s.render(); return }
      }
      e.pos = home
    })
    const fired = await page.evaluate(() => {
      const s = window.__dov.battle, a = s.b.active
      const btn = [...document.querySelectorAll('.sheet [data-act="skirmish"]:not(.disabled)')].find(x => {
        const w = a.weapons.find(w => w.uid === x.dataset.arg)
        return w && s.b.alive().some(t => s.b.hostile(a, t) && s.b.validTarget(a, w, t) === true)
      })
      return btn ? btn.dataset.arg : null
    })
    if (fired) {
      await tap(page, `.sheet [data-act="skirmish"][data-arg="${fired}"]`)
      if (!(await page.locator('.sheet.peek').count())) fail('choosing a weapon did not collapse the sheet to peek')
      const pt = await page.evaluate(uid => {
        const s = window.__dov.battle, a = s.b.active
        const w = a.weapons.find(x => x.uid === uid)
        const t = s.b.alive().find(t => s.b.hostile(a, t) && s.b.validTarget(a, w, t) === true)
        s.view.focus(t.pos)
        return t.id
      }, fired)
      await page.waitForTimeout(300)
      const xy = await page.evaluate(id => {
        const v = window.__dov.battle.view, g = v.units.get(id).group.position.clone()
        g.y += 0.4
        g.project(v.camera)
        const r = v.renderer.domElement.getBoundingClientRect()
        return { x: r.left + ((g.x + 1) / 2) * r.width, y: r.top + ((1 - g.y) / 2) * r.height }
      }, pt)
      const before = await page.evaluate(() => window.__dov.battle.b.log.length)
      await page.touchscreen.tap(xy.x, xy.y)
      await page.waitForTimeout(300)
      const preview = await page.evaluate(() => document.querySelector('.tooltip')?.style.display === 'block')
      if (!preview) fail('first tap on a target did not show the attack preview')
      await page.touchscreen.tap(xy.x, xy.y)
      await answerPrompts(page)
      await page.waitForTimeout(500)
      const after = await page.evaluate(() => window.__dov.battle?.b.log.length ?? 0)
      if (after <= before) fail('second tap on the target did not attack')
    } else console.log('e2e:mobile: no target in range on turn 1; skipping the attack step')
    // let the AI finish the fight from the sheet's Auto button
    const t0 = Date.now()
    while (Date.now() - t0 < 300000) {
      if (await page.evaluate(() => !window.__dov.battle)) break
      await page.evaluate(() => {
        const click = el => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const s = window.__dov.battle
        if (!s) return
        if (s.b.winner) return click(document.querySelector('[data-act="finish"]'))
        const opt = document.querySelector('.picker button[data-i]')
        if (opt) return click(opt)
        if (s.b.active?.side === 'player') { s.sheetState = 'half'; s.sheetTab = 'move'; s.render(); return click(document.querySelector('.sheet [data-act="auto"]')) }
        click(document.querySelector('.sheet [data-act="auto"]'))
      })
      await page.waitForTimeout(200)
    }
    if (await page.evaluate(() => !!window.__dov.battle)) fail('battle never ended on the phone')
    else await noOverflow(page, 'after the battle')
    if (errors.length) fail('page errors (landscape):\n' + errors.join('\n'))
    await ctx.close()
  }
  // ---------------------------------------------------------------- portrait skirmish
  {
    const { ctx, page, errors } = await phone('iPhone 13')
    await tap(page, 'button:has-text("Quick skirmish")')
    await tap(page, 'button:has-text("Choose enemies")')
    await noOverflow(page, 'skirmish teams (portrait)')
    await tap(page, '[data-team]')
    await page.waitForFunction(() => !!window.__dov.battle, null, { timeout: 30000 })
    await page.waitForSelector('.sheet')
    await page.waitForSelector('.app-toast', { timeout: 5000 }).catch(() => fail('portrait battle did not show the rotate tip'))
    if (!(await page.locator('.topbar.phone').count())) fail('portrait battle is not using the phone header')
    if (errors.length) fail('page errors (portrait):\n' + errors.join('\n'))
    await ctx.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log(failures.length ? `e2e:mobile: ${failures.length} failure(s)` : 'e2e:mobile: ok')
process.exit(failures.length ? 1 : 0)
