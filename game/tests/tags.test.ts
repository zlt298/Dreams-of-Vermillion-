// Tag tooltips: names and rules text from lancer-data, chips and free-text annotation.
import { describe, expect, it } from 'vitest'
import { annotateTags, rangeChip, tagChip, tagInfo } from '../src/ui/tags'

describe('tag tooltips', () => {
  it('fills in tag values', () => {
    const r = tagInfo('tg_reliable', 2)
    expect(r.name).toBe('Reliable 2')
    expect(r.desc).toMatch(/2/)
    expect(tagInfo('tg_ap').name).toBe('AP')
    expect(tagInfo('tg_loading').desc.length).toBeGreaterThan(20)
  })
  it('renders chips with the rules text in data-tip', () => {
    expect(tagChip('tg_smart')).toMatch(/class="tagtip" data-tip="Smart: /)
    expect(rangeChip('Blast', 2)).toMatch(/data-tip="Blast 2: .*>Blast 2</)
    expect(rangeChip('Weird', 1)).toBe('Weird 1')
  })
  it('annotates tag phrases in text but not markup', () => {
    const out = annotateTags('Reliable 2: 2 damage. <b class="AP">AP</b> Blast 2 and Seeking.')
    expect(out).toMatch(/<span class="tagtip" data-tip="Reliable 2: [^"]*">Reliable 2<\/span>/)
    expect(out).toContain('<b class="AP">')
    expect((out.match(/class="tagtip"/g) ?? []).length).toBe(4)
  })
})
