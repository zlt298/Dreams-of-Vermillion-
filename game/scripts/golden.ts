// Re-pin the golden battles after an intended change:  npm run golden
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CASES, runCase } from '../tests/golden/cases'

const out = CASES.map(c => { const r = runCase(c); console.log(`${r.id.padEnd(12)} round ${r.round}  winner ${r.winner ?? '—'}  ${r.commands} commands  ${r.hash}`); return r })
writeFileSync(join(import.meta.dirname, '../tests/golden/battles.json'), JSON.stringify(out, null, 2) + '\n')
console.log('pinned tests/golden/battles.json')
