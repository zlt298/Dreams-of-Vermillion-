// Pinned AI-vs-AI battles. A failure means a change altered how these fights play out: if that was
// intended (a rules fix, AI or balance change), regenerate with `npm run golden` and commit battles.json.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CASES, runCase, type GoldenResult } from './golden/cases'

const pinned: GoldenResult[] = JSON.parse(readFileSync(join(import.meta.dirname, 'golden/battles.json'), 'utf8'))

describe('golden battles (run `npm run golden` to re-pin after an intended change)', () => {
  for (const c of CASES) it(c.id, () => {
    const want = pinned.find(p => p.id === c.id)
    expect(want, `${c.id} is not pinned: run npm run golden`).toBeTruthy()
    expect(runCase(c)).toEqual(want)
  }, 60000)
})
