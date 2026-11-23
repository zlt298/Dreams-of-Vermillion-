// Replay an exported battle (the ⤓ button in the battle header) headlessly.
//   npm run replay -- dov-battle-….json [--upto N] [--log 40]
import { readFileSync } from 'node:fs'
import '../src/rules/effects/scripts'
import { importBattle, replayBattle, stateHash } from '../src/replay/replay'

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--'))
if (!file) { console.error('usage: npm run replay -- <battle.json> [--upto N] [--log N]'); process.exit(1) }
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : undefined }
const x = importBattle(readFileSync(file, 'utf8'))
console.log(`battle: seed ${x.record.seed}, ${x.record.units.length} units, ${x.commands.length} commands, exported ${x.exportedAt}`)
if (x.note) console.log(`note: ${x.note}`)
const errors: string[] = []
const b = replayBattle(x, { upTo: opt('--upto'), onError: (i, c, e) => errors.push(`#${i} ${c.op}: ${e.message}`) })
const n = opt('--log') ?? 30
console.log(`\n--- last ${n} log lines ---`)
for (const l of b.log.slice(-n)) console.log(l.text)
console.log(`\nround ${b.round}, winner ${b.winner ?? '—'}`)
if (errors.length) { console.log(`\n${errors.length} command(s) failed:`); for (const e of errors) console.log('  ' + e) }
const h = stateHash(b)
const full = (opt('--upto') ?? x.commands.length) >= x.commands.length
console.log(`state hash ${h}${full ? (h === x.hash ? ' — matches the export ✓' : ` — DIFFERS from the export (${x.hash})`) : ''}`)
if (full && h !== x.hash) process.exitCode = 2
