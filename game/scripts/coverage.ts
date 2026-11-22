// Rules-fidelity report over the whole lancer-data compendium.  npm run coverage [-- --list]
import { Lancer } from '../src/data/lancer'
import { coreBonusCoverage, frameCoverage, modCoverage, systemCoverage, talentRankCoverage, weaponCoverage, type Coverage } from '../src/rules/effects/coverage'
import '../src/rules/effects/scripts'

const list = process.argv.includes('--list')
type Row = { id: string; name: string; c: Coverage }
const sections: Record<string, Row[]> = { 'Frame traits': [], 'Core systems': [], Weapons: [], Systems: [], Mods: [], 'Talent ranks': [], 'Core bonuses': [] }
for (const f of Lancer.frames.values()) {
  const c = frameCoverage(f.id)
  sections['Frame traits'].push({ id: `frame:${f.id}`, name: f.name, c: c.traits })
  sections['Core systems'].push({ id: `core:${f.id}`, name: `${f.name}: ${f.core_system.name}`, c: c.core })
}
for (const w of Lancer.weapons.values()) sections.Weapons.push({ id: w.id, name: w.name, c: weaponCoverage(w.id) })
for (const s of Lancer.systems.values()) sections.Systems.push({ id: s.id, name: s.name, c: systemCoverage(s.id) })
for (const m of Lancer.mods.values()) sections.Mods.push({ id: m.id, name: m.name, c: modCoverage(m.id) })
for (const t of Lancer.talents.values()) t.ranks.forEach((r, i) => sections['Talent ranks'].push({ id: `${t.id}:${i + 1}`, name: `${t.name} ${i + 1} (${r.name})`, c: talentRankCoverage(t.id, i + 1) }))
for (const c of Lancer.coreBonuses.values()) sections['Core bonuses'].push({ id: c.id, name: c.name, c: coreBonusCoverage(c.id) })

let tot = 0, done = 0, part = 0
console.log('LANCER rules coverage (lancer-data 4.0.12)\n')
console.log('section            scripted partial   auto  manual   done%')
for (const [name, rows] of Object.entries(sections)) {
  const s = rows.filter(r => r.c === 'scripted').length, p = rows.filter(r => r.c === 'partial').length, a = rows.filter(r => r.c === 'auto').length, m = rows.filter(r => r.c === 'manual').length
  tot += rows.length; done += s + a; part += p
  console.log(`${name.padEnd(18)} ${String(s).padStart(8)} ${String(p).padStart(7)} ${String(a).padStart(6)} ${String(m).padStart(7)} ${String(Math.round(((s + a) / rows.length) * 100)).padStart(6)}%`)
}
console.log(`\nTOTAL ${done}/${tot} (${Math.round((done / tot) * 100)}%) fully executed by the engine, ${part} partially; the rest log their rules text for manual resolution.`)
if (list) for (const [name, rows] of Object.entries(sections)) {
  const m = rows.filter(r => r.c === 'manual' || r.c === 'partial')
  if (m.length) console.log(`\n## ${name} — manual / partial\n` + m.map(r => `  [${r.c}] ${r.id}  ${r.name}`).join('\n'))
}

// LCP=<path to .lcp>: also report official NPC class features (the pack is read at runtime, never stored)
if (process.env.LCP) {
  const { readFileSync } = await import('node:fs')
  const { readLcp } = await import('../src/import/lcp')
  const { getScript } = await import('../src/rules/effects/registry')
  const pack = readLcp(new Uint8Array(readFileSync(process.env.LCP)))
  const rows: { cls: string; id: string; name: string; base: boolean; c: Coverage }[] = []
  for (const cls of pack.classes) for (const f of cls.features) {
    const sc = getScript(`npc:${f.id}`)
    const c: Coverage = sc ? (sc.partial ? 'partial' : 'scripted') : f.partial ? 'manual' : 'auto'
    rows.push({ cls: cls.name, id: f.id, name: f.name, base: f.base, c })
  }
  console.log(`\nOfficial NPC features (${pack.name} ${pack.version})\n`)
  console.log('features           scripted partial   auto  manual   done%')
  for (const [label, rs] of [['Base', rows.filter(r => r.base)], ['Optional', rows.filter(r => !r.base)]] as const) {
    const n = (c: Coverage) => rs.filter(r => r.c === c).length
    console.log(`${label.padEnd(18)} ${String(n('scripted')).padStart(8)} ${String(n('partial')).padStart(7)} ${String(n('auto')).padStart(6)} ${String(n('manual')).padStart(7)} ${String(Math.round(((n('scripted') + n('auto')) / rs.length) * 100)).padStart(6)}%`)
  }
  if (list) {
    const m = rows.filter(r => r.base && (r.c === 'manual' || r.c === 'partial'))
    console.log('\n## Official base features — manual / partial\n' + m.map(r => `  [${r.c}] ${r.cls}: ${r.name}`).join('\n'))
  }
}
