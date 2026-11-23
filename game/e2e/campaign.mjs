// End-to-end regression: start a campaign, let the AI play the lancers through one battle, and
// check the game reaches the next screen (debrief/repairs/map or defeat) with no page errors.
// Usage: npm run e2e   (needs Playwright + Chromium available; skips otherwise)
//        E2E_URL=<url> npm run e2e   tests an already-served build (e.g. vite preview or the Pages site)
import { createServer } from 'vite'
import { createRequire } from 'node:module'

let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  try {
    // globally installed Playwright is only visible to CommonJS resolution
    ;({ chromium } = createRequire(import.meta.url)('playwright'))
  } catch {
    console.log('e2e: playwright not installed — skipping')
    process.exit(0)
  }
}

const url = process.env.E2E_URL || 'http://localhost:5199/'
const server = process.env.E2E_URL ? null : await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' })
await server?.listen()
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
let failed = false
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(url)
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('dov.animSpeed', '0') })
  await page.reload()
  await page.click('text=New run')
  await page.click('button:has-text("Begin run")')
  await page.click('.node.avail >> nth=0')
  await page.waitForFunction(() => !!window.__dov.battle, null, { timeout: 15000 })
  const t0 = Date.now()
  while (Date.now() - t0 < 180000) {
    const done = await page.evaluate(() => !window.__dov.battle)
    if (done) break
    await page.evaluate(() => {
      const click = el => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      const s = window.__dov.battle
      if (!s || s.b.winner) return
      const auto = document.querySelector('.panel.bottom button[data-act="auto"]:not(.disabled)')
      if (auto) return click(auto)
      const ready = document.querySelector('.card .ready')
      if (ready) click(ready.closest('.card'))
    })
    await page.waitForTimeout(150)
  }
  const heading = await page.evaluate(() => document.querySelector('.screen h1, .screen h2')?.textContent ?? null)
  const stillInBattle = await page.evaluate(() => !!window.__dov.battle)
  console.log(`e2e: reached "${heading}"`)
  if (stillInBattle) { console.error('e2e: FAILED — battle never ended / screen never advanced'); failed = true }
  if (errors.length) { console.error('e2e: FAILED — page errors:\n' + errors.join('\n')); failed = true }
} finally {
  await browser.close()
  await server?.close()
}
process.exit(failed ? 1 : 0)
