// The in-game pilot builder: pilot level, mech skills, licenses, talents, core bonuses, frame, weapons
// and systems. Everything is checked live against the LANCER build rules (rules/legality.ts).
import { Lancer, type WeaponData } from '../data/lancer'
import { resolveUnknown, type PilotBuild } from '../import/compcon'
import { validateBuild, MAX_SKILL, MAX_LICENSE_RANK, MAX_LL, slotSizes } from '../rules/legality'
import { buildMechUnit, talentIntegrated } from '../rules/stats'
import {
  newDraft, editable, setFrame, setMountBonus, toggleCoreBonus, setTalentRank, licenseRank, setLicenseRank, pruneCoreBonuses,
  frameOptions, weaponOptions, modOptions, systemOptions, coreBonusOptions, setWeapon, MOUNT_CBS,
} from './builder'
import { rangeChip, tagChip } from './tags'
import { esc } from './dom'
import { confirmDialog } from './modal'

export interface BuilderOptions {
  build?: PilotBuild
  /** the level is set by the campaign and can't be changed here */
  lockLevel?: boolean
  title: string
  onSave: (p: PilotBuild) => void
  onCancel: () => void
}

const strip = (s?: string) => (s ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
const tip = (s?: string) => (s ? ` data-tip="${esc(strip(s))}"` : '')
const HASE = ['Hull', 'Agility', 'Systems', 'Engineering']
const SOURCES = ['GMS', 'IPS-N', 'SSC', 'HORUS', 'HA']
const srcOrder = (s?: string) => { const i = SOURCES.indexOf(s ?? ''); return i < 0 ? 99 : i }

function licenseLabel(x: { source?: string; license?: string; license_level?: number }): string {
  return x.source && x.source !== 'GMS' && x.license_level ? `${x.license} ${'I'.repeat(x.license_level)}` : 'GMS'
}

function weaponDetail(w: WeaponData): string {
  const pr = w.profiles?.[0] ?? {}
  const dmg = (pr.damage ?? w.damage ?? []).map(d => `${d.val} ${d.type}`).join(' + ')
  const bits = [
    `${esc(w.mount)} ${esc(w.type)}`,
    w.profiles && w.profiles.length > 1 ? `${w.profiles.length} profiles` : '',
    ...(pr.range ?? w.range ?? []).map(r => rangeChip(r.type, r.val)),
    dmg ? esc(dmg) : '',
    ...(pr.tags ?? w.tags ?? []).filter(t => t.id !== 'tg_unique').map(t => tagChip(t.id, t.val)),
    w.sp ? `${w.sp} SP` : '',
  ].filter(Boolean)
  const hit = pr.on_hit ?? w.on_hit
  const fx = [pr.effect ?? w.effect, hit && typeof hit === 'object' ? hit.detail : hit].filter(Boolean).map(x => strip(String(x))).join(' ')
  return `<span class="muted small">${bits.join(' · ')}${fx ? ` · <span class="tagtip"${tip(fx)}>effect</span>` : ''}</span>`
}

/** Options for a <select>, grouped by manufacturer. */
function grouped<T extends { id: string; name: string; source?: string; license?: string; license_level?: number; sp?: number }>(items: T[], selected: string | null | undefined, empty: string): string {
  const groups = new Map<string, T[]>()
  for (const x of [...items].sort((a, b) => srcOrder(a.source) - srcOrder(b.source))) {
    const g = x.source ?? 'Other'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(x)
  }
  const opt = (x: T) => `<option value="${esc(x.id)}" ${x.id === selected ? 'selected' : ''}>${esc(x.name)} — ${esc(licenseLabel(x))}${x.sp ? ` · ${x.sp} SP` : ''}</option>`
  return `<option value="">${esc(empty)}</option>` + [...groups].map(([g, xs]) => `<optgroup label="${esc(g)}">${xs.map(opt).join('')}</optgroup>`).join('')
}

export function builderScreen(root: HTMLElement, opts: BuilderOptions) {
  const p: PilotBuild = opts.build ? editable(opts.build) : newDraft()
  let talentFilter = ''
  const host = document.createElement('div')
  host.className = 'screen builder'
  root.appendChild(host)

  const render = () => {
    const scroll = host.scrollTop
    const v = validateBuild(p)
    const b = v.budgets
    const meter = (label: string, x: { used: number; max: number }) =>
      `<span class="meter ${x.used > x.max ? 'over' : x.used < x.max ? 'left' : 'full'}">${label} <b>${x.used}/${x.max}</b></span>`
    const f = Lancer.frames.get(p.mech.frameId)
    let u = null
    try { u = buildMechUnit(p) } catch { /* incomplete build */ }

    // licenses, grouped by manufacturer
    const frames = [...Lancer.frames.values()].filter(x => x.source !== 'GMS')
    const licenses = SOURCES.slice(1).map(src => `<div class="lic-group"><h4>${esc(src)}</h4>${frames.filter(x => x.source === src).map(x => {
      const { rank, min } = licenseRank(p, x.id)
      const pips = Array.from({ length: MAX_LICENSE_RANK }, (_, i) => `<button class="pip ${i < rank ? 'on' : ''}" data-lic="${x.id}" data-rank="${i + 1 === rank ? i : i + 1}" ${i + 1 <= min && i + 1 === rank ? 'disabled' : ''} title="${esc(`${x.name} rank ${i + 1}`)}"></button>`).join('')
      return `<div class="lic ${rank ? 'held' : ''}"><span${tip(min ? `Equipment needs rank ${min}` : '')}>${esc(x.name)}</span><span class="pips">${pips}</span></div>`
    }).join('')}</div>`).join('')

    // talents
    const talents = [...Lancer.talents.values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => {
      const cur = p.talents.find(x => x.id === t.id)?.rank ?? 0
      const ranks = t.ranks.map((r, i) => `<button class="rk ${i < cur ? 'on' : ''}" data-talent="${t.id}" data-rank="${i + 1 === cur ? i : i + 1}"${tip(`${r.name} (rank ${i + 1}): ${r.description}`)}>${'I'.repeat(i + 1)}</button>`).join('')
      return `<div class="talent ${cur ? 'held' : ''}" data-name="${esc(t.name.toLowerCase())}"><span${tip((t as any).terse ?? (t as any).description)}>${esc(t.name)}</span><span>${ranks}</span></div>`
    }).join('')

    // core bonuses
    const cbs = coreBonusOptions(p).sort((a, b) => srcOrder(a.cb.source) - srcOrder(b.cb.source) || a.cb.name.localeCompare(b.cb.name)).map(({ cb, allowed }) => {
      const on = p.coreBonuses.includes(cb.id)
      const why = !allowed ? ` (needs ${3 * (p.coreBonuses.filter(c => Lancer.coreBonuses.get(c)?.source === cb.source).length + 1)} ${cb.source} license ranks)` : ''
      return `<button class="cb ${on ? 'on' : ''}" data-cb="${cb.id}" ${!on && (!allowed || b.coreBonuses.used >= b.coreBonuses.max) ? 'disabled' : ''}${tip(cb.effect + why)}><span class="muted">${esc(cb.source)}</span> ${esc(cb.name)}</button>`
    }).join('')

    // mounts
    const mounts = p.mech.mounts.map((m, mi) => {
      const slots = m.slots.map((s, si) => {
        if (!slotSizes(m, si).length && !s.weaponId) return `<div class="slot muted small">— used by the Main weapon —</div>`
        const w = s.weaponId ? Lancer.weapons.get(s.weaponId) : undefined
        const mods = modOptions(p, s.weaponId, mi, si)
        return `<div class="slot"><select data-weapon="${mi}:${si}">${grouped(weaponOptions(p, mi, si), s.weaponId, '— empty —')}</select>
          ${w && mods.length ? `<select data-mod="${mi}:${si}">${grouped(mods, s.modId, '— no mod —')}</select>` : ''}
          ${w ? `<div>${weaponDetail(w)}</div>` : ''}</div>`
      }).join('')
      const cbTags = m.bonusEffects.map(c => `<span class="chip"${tip(Lancer.coreBonuses.get(c)?.effect)}>${esc(Lancer.coreBonuses.get(c)?.name ?? c)}</span>`).join('')
      return `<div class="mount"><div class="mh"><b>${esc(m.type === 'CB-Integrated' ? 'Integrated (core bonus)' : m.type)}</b> mount ${cbTags}</div>${slots}</div>`
    }).join('')
    const mountCbs = p.coreBonuses.filter(c => MOUNT_CBS.includes(c)).map(c => {
      const at = p.mech.mounts.findIndex(m => m.bonusEffects.includes(c))
      const choices = p.mech.mounts.map((m, i) => ({ m, i })).filter(({ m }) => m.type !== 'CB-Integrated')
      return `<label class="small">${esc(Lancer.coreBonuses.get(c)!.name)} on <select data-mountcb="${c}"><option value="-1">— choose a mount —</option>${choices.map(({ m, i }) => `<option value="${i}" ${i === at ? 'selected' : ''}>#${i + 1} ${esc(m.type)}</option>`).join('')}</select></label>`
    }).join(' ')
    const integrated = [...(f?.core_system.integrated ?? []), ...p.talents.flatMap(t => talentIntegrated(t.id, t.rank))]
      .map(id => Lancer.weapons.get(id)?.name ?? Lancer.systems.get(id)?.name ?? id)

    const systems = p.mech.systems.map((id, i) => {
      const s = Lancer.systems.get(id)
      return `<span class="chip"${tip(s?.effect ?? s?.actions?.map(a => `${a.name}: ${(a as any).detail ?? ''}`).join(' '))}>${esc(s?.name ?? id)}${s?.sp ? ` <span class="muted">${s.sp} SP</span>` : ''} <button class="x" data-rmsys="${i}">✕</button></span>`
    }).join('') || '<span class="muted small">No systems.</span>'

    host.innerHTML = `
      <div class="hhead"><h2>${esc(opts.title)}</h2><div>
        <button data-go="save" class="primary" ${v.errors.length ? 'disabled' : ''} title="${v.errors.length ? 'Fix the errors first' : 'Save this pilot'}">Save pilot</button>
        <button data-go="cancel">Cancel</button></div></div>
      <div class="budget">
        ${opts.lockLevel ? `<span class="meter">LL <b>${p.level}</b></span>` : `<label class="meter">LL <select data-ll>${Array.from({ length: MAX_LL + 1 }, (_, i) => `<option ${i === p.level ? 'selected' : ''}>${i}</option>`).join('')}</select></label>`}
        ${meter('HASE', b.hase)}${meter('Talents', b.talents)}${meter('Licenses', b.licenses)}${meter('Core bonuses', b.coreBonuses)}${meter('SP', b.sp)}
        ${v.errors.map(e => `<div class="bad small">✕ ${esc(e)}</div>`).join('')}
        ${v.warnings.map(e => `<div class="warn small">• ${esc(e)}</div>`).join('')}
      </div>
      <div class="bgrid">
        <section><h3>Pilot</h3>
          <label>Callsign <input data-text="callsign" value="${esc(p.callsign)}" maxlength="40"></label>
          <label>Name <input data-text="name" value="${esc(p.name)}" maxlength="60"></label>
          <div class="hase">${HASE.map((h, i) => `<div><span>${h}</span><button data-hase="${i}" data-d="-1" ${p.mechSkills[i] <= 0 ? 'disabled' : ''}>−</button><b>${p.mechSkills[i]}</b><button data-hase="${i}" data-d="1" ${p.mechSkills[i] >= MAX_SKILL || b.hase.used >= b.hase.max ? 'disabled' : ''}>+</button></div>`).join('')}</div>
          <h3>Licenses</h3><p class="muted small">Frames need rank II. Weapons and systems need the rank shown next to them.</p>
          <div class="licenses">${licenses}</div>
          <h3>Core bonuses</h3><p class="muted small">One every 3 License Levels. Non-GMS bonuses need 3 license ranks with that manufacturer for each bonus.</p>
          <div class="cbs">${cbs}</div>
        </section>
        <section><h3>Talents</h3><input class="tfilter" placeholder="Filter talents…" value="${esc(talentFilter)}">
          <div class="talents">${talents}</div>
        </section>
        <section><h3>Mech</h3>
          <label>Name <input data-text="mech" value="${esc(p.mech.name)}" maxlength="40"></label>
          <label>Frame <select data-frame>${frameOptions(p).map(x => `<option value="${x.id}" ${x.id === p.mech.frameId ? 'selected' : ''}>${esc(`${x.source} ${x.name}`)}</option>`).join('')}</select></label>
          ${f ? `<div class="small">${f.traits.map(t => `<span class="chip"${tip(t.description)}>${esc(t.name)}</span>`).join('')}<span class="chip core"${tip(`${f.core_system.active_name ?? ''}: ${f.core_system.active_effect ?? ''} ${f.core_system.passive_effect ?? ''}`)}>CORE: ${esc(f.core_system.name)}</span></div>` : ''}
          ${u ? `<div class="muted small">HP ${u.stats.hp} · ARM ${u.stats.armor} · EVA ${u.stats.evasion} · E-DEF ${u.stats.edef} · HEAT ${u.stats.heatcap} · SPD ${u.stats.speed} · SENS ${u.stats.sensors} · Structure ${u.stats.structure} · Stress ${u.stats.stress}</div>` : ''}
          ${integrated.length ? `<div class="small muted">Integrated: ${integrated.map(esc).join(', ')}</div>` : ''}
          <h4>Mounts</h4>${mountCbs ? `<div>${mountCbs}</div>` : ''}${mounts}
          <h4>Systems</h4><div class="systems">${systems}</div>
          <select data-addsys>${grouped(systemOptions(p), null, '+ add a system…')}</select>
        </section>
      </div>`
    applyFilter()
    host.scrollTop = scroll
  }

  const applyFilter = () => {
    host.querySelectorAll<HTMLElement>('.talent').forEach(el => { el.style.display = !talentFilter || el.dataset.name!.includes(talentFilter) ? '' : 'none' })
  }
  const change = (fn: () => void) => { fn(); p.unknown = resolveUnknown(p); render() }

  host.addEventListener('click', e => {
    const el = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
    if (!el || el.disabled) return
    const d = el.dataset
    if (d.go === 'cancel') return opts.onCancel()
    if (d.go === 'save') {
      const v = validateBuild(p)
      if (v.errors.length) return
      if (v.warnings.some(w => /unspent|unchosen/.test(w))) {
        void confirmDialog('Unspent points', `${v.warnings.join('\n')}\n\nSave anyway?`, { ok: 'Save anyway', cancel: 'Keep editing' }).then(ok => { if (ok) opts.onSave(structuredClone(p)) })
        return
      }
      return opts.onSave(structuredClone(p))
    }
    if (d.hase) change(() => { const i = +d.hase!; p.mechSkills[i] = Math.max(0, Math.min(MAX_SKILL, p.mechSkills[i] + +d.d!)) })
    if (d.lic) change(() => { setLicenseRank(p, d.lic!, +d.rank!); pruneCoreBonuses(p) })
    if (d.talent) change(() => setTalentRank(p, d.talent!, +d.rank!))
    if (d.cb) change(() => toggleCoreBonus(p, d.cb!))
    if (d.rmsys) change(() => { p.mech.systems.splice(+d.rmsys!, 1) })
  })
  host.addEventListener('change', e => {
    const el = e.target as HTMLInputElement | HTMLSelectElement
    const d = el.dataset
    if (d.text) change(() => {
      const val = el.value.trim()
      if (d.text === 'callsign') p.callsign = val || 'Lancer'
      if (d.text === 'name') p.name = val || p.callsign
      if (d.text === 'mech') p.mech.name = val || (Lancer.frames.get(p.mech.frameId)?.name ?? 'Mech')
    })
    if (d.ll !== undefined) change(() => { p.level = +el.value })
    if (d.frame !== undefined) change(() => setFrame(p, el.value))
    if (d.weapon) change(() => { const [mi, si] = d.weapon!.split(':').map(Number); setWeapon(p, mi, si, el.value || null) })
    if (d.mod) change(() => { const [mi, si] = d.mod!.split(':').map(Number); p.mech.mounts[mi].slots[si].modId = el.value || null })
    if (d.mountcb) change(() => setMountBonus(p, d.mountcb!, +el.value))
    if (d.addsys !== undefined && el.value) change(() => { p.mech.systems.push(el.value) })
  })
  host.addEventListener('input', e => {
    const el = e.target as HTMLInputElement
    if (el.classList.contains('tfilter')) { talentFilter = el.value.trim().toLowerCase(); applyFilter() }
  })
  p.unknown = resolveUnknown(p)
  render()
}
