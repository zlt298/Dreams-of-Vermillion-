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

let tot = 0, done = 0
console.log('LANCER rules coverage (lancer-data 4.0.12)\n')
console.log('section            scripted   auto  manual   done%')
for (const [name, rows] of Object.entries(sections)) {
  const s = rows.filter(r => r.c === 'scripted').length, a = rows.filter(r => r.c === 'auto').length, m = rows.filter(r => r.c === 'manual').length
  tot += rows.length; done += s + a
  console.log(`${name.padEnd(18)} ${String(s).padStart(8)} ${String(a).padStart(6)} ${String(m).padStart(7)} ${String(Math.round(((s + a) / rows.length) * 100)).padStart(6)}%`)
}
console.log(`\nTOTAL ${done}/${tot} (${Math.round((done / tot) * 100)}%) executed by the engine; the rest log their rules text for manual resolution.`)
if (list) for (const [name, rows] of Object.entries(sections)) {
  const m = rows.filter(r => r.c === 'manual')
  if (m.length) console.log(`\n## ${name} — manual\n` + m.map(r => `  ${r.id}  ${r.name}`).join('\n'))
}
