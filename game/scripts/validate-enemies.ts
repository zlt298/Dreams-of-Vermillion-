// Validate enemy team JSON files.  Usage: npm run validate-enemies [-- file.json ...]
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { validateTeam } from '../src/enemies/validate'

const dir = resolve(import.meta.dirname, '../../data/enemies')
const files = process.argv.slice(2).length ? process.argv.slice(2).map(f => resolve(f)) : readdirSync(dir).filter(f => f.endsWith('.json')).map(f => join(dir, f))
let failed = 0
const ids = new Map<string, string>()
for (const f of files) {
  let team: any
  try { team = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { console.log(`✗ ${f}: invalid JSON (${(e as Error).message})`); failed++; continue }
  const r = validateTeam(team)
  if (ids.has(team.id)) r.errors.push(`duplicate id '${team.id}' (also in ${ids.get(team.id)})`)
  ids.set(team.id, f)
  const name = f.split('/').pop()
  if (r.errors.length) { failed++; console.log(`✗ ${name} (budget ${r.budget})`); r.errors.forEach(e => console.log(`    error: ${e}`)) }
  else console.log(`✓ ${name} (T${team.tier} ${team.kind ?? 'standard'}, budget ${r.budget})`)
  r.warnings.forEach(w => console.log(`    warn:  ${w}`))
}
console.log(failed ? `\n${failed} file(s) failed validation` : `\nAll ${files.length} team file(s) valid`)
process.exit(failed ? 1 : 0)
