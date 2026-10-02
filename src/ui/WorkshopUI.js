import { HOIST_REGIONS, WEAPON_CLASSES } from '../config/constants.js';
import { PARTS, DRIVE_KINDS, JACKET_NAMES, RARITY } from '../config/partsData.js';
import { PART_SCORES, VEHICLE_SCORES, REF, shown, partSummary } from '../config/scores.js';
import { BattleBug } from '../entities/BattleBug.js';
import { Part } from '../entities/Part.js';
import { SpriteRenderer } from '../render/SpriteRenderer.js';
import { formatMoney } from '../systems/EconomyManager.js';

// ───────────── Shared DOM helpers ─────────────
/** Hyperscript-style element builder. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let modalOnClose = null;

/**
 * @param {{onClose?:Function, header?:Node, className?:string, modal?:boolean}} opts
 *   header replaces the title; modal:true means only the ✕ closes it (no backdrop click).
 */
export function openModal(title, body, { onClose, header, className = '', modal = false } = {}) {
  const root = document.getElementById('modal-root');
  root.replaceChildren(
    el('div', { class: 'modal-backdrop', onclick: modal ? null : closeModal }),
    el('div', { class: `modal ${className}`, role: 'dialog', 'aria-label': title },
      el('div', { class: 'modal-head' },
        header || el('h2', {}, title),
        el('button', { class: 'btn btn-icon', 'aria-label': 'Close', onclick: closeModal }, '✕')),
      el('div', { class: 'modal-body' }, body)),
  );
  root.classList.add('open');
  modalOnClose = onClose || null;
}

export function closeModal() {
  const root = document.getElementById('modal-root');
  root.classList.remove('open');
  root.replaceChildren();
  const cb = modalOnClose;
  modalOnClose = null;
  cb?.();
}

export function toast(msg, kind = 'info') {
  const root = document.getElementById('toast-root');
  const t = el('div', { class: `toast toast-${kind}` }, msg);
  root.append(t);
  setTimeout(() => t.classList.add('leaving'), 2600);
  setTimeout(() => t.remove(), 3100);
}

export function hpBar(ratio, { label } = {}) {
  const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  const cls = ratio > 0.6 ? 'good' : ratio > 0.3 ? 'warn' : 'bad';
  return el('div', { class: `hpbar ${cls}`, title: `${pct}%` },
    el('div', { class: 'hpbar-fill', style: { width: `${pct}%` } }),
    el('span', { class: 'hpbar-label' }, label ?? `${pct}%`));
}

/** One-line summary under a part's name, in scores out of 100. */
export function partStatLine(part) {
  const line = partSummary(part);
  if (part.type === 'weapon') return `${WEAPON_CLASSES[part.stats.class].label} · ${line}`;
  if (part.type === 'cooling' || part.type === 'enhancement' || part.type === 'drivetrain') {
    const works = part.stats.jacket
      ? `Combustion & torque; other drives need ${/^[AEIOU]/.test(JACKET_NAMES[part.stats.jacket]) ? 'an' : 'a'} ${JACKET_NAMES[part.stats.jacket]}`
      : part.stats.works ? `Drives: ${part.stats.works.map((k) => DRIVE_KINDS[k]).join(', ')}` : 'Any drive';
    const uses = part.usesLeft != null ? ` · ${part.usesLeft ? `${part.usesLeft} battle${part.usesLeft > 1 ? 's' : ''} left` : 'used up'}` : '';
    return `${line} · ${works}${uses}`;
  }
  return line;
}

// ───────────── Comparison bars ─────────────
// Every stat is a score out of 100 (see config/scores.js); the bar stops at 100.
const int = (v) => `${shown(v)}`;
const capped = (v) => Math.min(100, Math.max(0, v));

/**
 * One stat bar: the fill is the current value, a red segment runs on to the
 * value once fully repaired, and the white marker is the reference (fully repaired).
 * The fill is green/amber when the repaired value beats / trails the reference.
 */
export function statBar({ value, potential = value, ref = null, max, better, neutral = false, cls = '' }) {
  const scale = Math.max(max, value, potential, ref ?? 0) || 1;
  const pct = (v) => `${Math.max(0, Math.min(1, v / scale)) * 100}%`;
  let tone = neutral || better === 'neutral' ? 'neutral weight' : 'neutral';
  if (ref != null && !neutral && better !== 'neutral') {
    const diff = better === 'lower' ? ref - potential : potential - ref;
    const eps = Math.abs(ref) * 0.01 + 1e-9;
    tone = diff > eps ? 'better' : diff < -eps ? 'worse' : 'same';
  }
  // For "lower is better" stats damage doesn't apply, so potential ≈ value.
  const lo = Math.min(value, potential);
  const hi = Math.max(value, potential);
  return el('div', { class: `cmp-bar ${cls}` },
    el('div', { class: `cmp-fill ${tone}`, style: { width: pct(lo) } }),
    hi - lo > scale * 0.002 ? el('div', { class: 'cmp-dmg', style: { left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})` } }) : null,
    ref != null ? el('div', { class: 'cmp-mark', style: { left: pct(ref) } }) : null);
}

/**
 * Stat bars for a candidate against what's on the hoist.
 * @param {Array<{label, value, potential?, current, max, fmt, better}>} rows
 *   value = as it is now, potential = fully repaired, current = the reference (fully repaired)
 */
export function compareBars(rows, { neutral = false, legend = null } = {}) {
  return el('div', { class: 'cmp' },
    rows.map((r) => {
      const hasCur = r.current != null;
      const pot = r.potential ?? r.value;
      const repairedNote = pot !== r.value ? ` → ${r.fmt(pot)} repaired` : '';
      return el('div', { class: 'cmp-row', title: `${r.label}: ${r.fmt(r.value)}${repairedNote}${hasCur ? ` (on hoist, repaired: ${r.fmt(r.current)})` : ''}` },
        el('span', { class: 'cmp-label' }, r.label),
        statBar({ value: r.value, potential: pot, ref: r.current, max: r.max, better: r.better, neutral }),
        el('span', { class: 'cmp-val' }, r.fmt(r.value)));
    }),
    legend ? el('div', { class: 'cmp-legend' }, el('span', { class: 'cmp-legend-mark' }), legend) : null);
}

export function partCompare(part, current, { legend } = {}) {
  const full = (p) => new Part(p.key, { uid: p.uid, hp: p.repairedHp });
  // Add-ons only show the effects either side actually has.
  const rows = (PART_SCORES[part.type] || []).filter((r) => r.neutral || r.get(full(part)) >= 1 || (current && r.get(full(current)) >= 1));
  if (!rows.length) return null;
  return compareBars(rows.map((r) => ({
    label: r.label, fmt: int, better: r.neutral ? 'neutral' : 'higher', max: 100,
    value: capped(r.get(part)), potential: capped(r.get(full(part))), current: current ? capped(r.get(full(current))) : null,
  })), { legend: legend ?? (current ? `on hoist: ${current.name}` : 'nothing fitted in this slot') });
}

/** Stats you can judge from the outside, without seeing under the hood. */
const EXTERIOR = new Set(['Hull']);

export function vehicleCompare(bug, current, { neutral = false, exterior = false } = {}) {
  const s = bug.getStats();
  const ps = pristineStats(bug);
  const cs = current && current !== bug ? pristineStats(current) : null;
  const rows = exterior ? VEHICLE_SCORES.filter((r) => EXTERIOR.has(r.label)) : VEHICLE_SCORES;
  return compareBars(rows.map((r) => ({
    label: r.label, fmt: int, better: r.neutral ? 'neutral' : 'higher', max: 100,
    value: capped(r.get(s, bug)), potential: capped(r.get(ps, bug, true)), current: cs ? capped(r.get(cs, current, true)) : null,
  })), { neutral, legend: cs ? `on hoist: ${current.name}` : null });
}

/** The fitted part a candidate would be compared against. */
export function counterpart(bug, part) {
  if (!bug) return null;
  if (part.type === 'cooling' || part.type === 'enhancement') {
    const list = bug.slotList(part.type);
    return list.find((x) => x.key === part.key) || list[0] || null;
  }
  if (part.type === 'weapon') {
    return bug.weapons.find((w) => w.key === part.key)
      || bug.weapons.find((w) => w.stats.class === part.stats.class)
      || bug.weapons[0] || null;
  }
  // Castors and tyres share the slot but only compare like with like.
  if (part.type === 'tires' || part.type === 'castor') return bug.tires?.type === part.type ? bug.tires : null;
  return ['chassis', 'engine', 'armor'].includes(part.type) ? bug.slotPart(part.type) : null;
}

/** The tag on a part card: the drive type for motors, Driven or Gliding for running gear. */
function partTypeLabel(part) {
  if (part.type === 'engine') return DRIVE_KINDS[part.stats.kind] || 'drive';
  if (part.type === 'tires') return 'driven';
  if (part.type === 'castor') return 'gliding';
  if (part.type === 'drivetrain') return 'drive train';
  return part.type;
}

/** @param {{group?: {parts: Part[]}}} opts group: a stack of like spares — shown as one card, × n */
export function partCard(part, economy, { actions = [], extra = null, compareTo, compareLegend, group = null } = {}) {
  const n = group?.parts.length || 1;
  const pct = (p) => Math.round(p.hpRatio * 100);
  const worst = n > 1 ? group.parts.reduce((w, p) => (p.hpRatio < w.hpRatio ? p : w), part) : part;
  const cond = pct(worst) === pct(part) ? `${pct(part)}%` : `${pct(worst)}–${pct(part)}%`;
  return el('div', { class: `part-card rarity-${part.rarity}${part.isScrap ? ' broken' : ''}` },
    el('div', { class: 'part-head' },
      el('span', { class: `part-type type-${part.type}` }, partTypeLabel(part)),
      el('strong', {}, part.name),
      part.rarity !== 'common' ? el('span', { class: `rarity-tag rarity-${part.rarity}` }, part.rarity) : null,
      n > 1 ? el('span', { class: 'stack-count', title: `${n} in your spares` }, `× ${n}`) : null),
    el('div', { class: 'part-stats' }, partStatLine(part)),
    hpBar(part.hpRatio, { label: part.isScrap ? `SCRAP — ${cond}` : `Condition ${cond}` }),
    compareTo !== undefined && compareTo !== part ? partCompare(part, compareTo, { legend: compareLegend }) : null,
    extra,
    actions.length ? el('div', { class: 'part-actions' }, actions) : null);
}

/**
 * The Sell button for a stack of spares. One item sells straight away; a stack
 * opens a slider (starting at 1, up to all of them) to pick how many.
 * @param {(fn: Function, msg: string|Function) => void} act
 */
export function sellStackButton(group, economy, act, { disabled = false, title = null } = {}) {
  const n = group.parts.length;
  const name = group.best.name;
  const verb = group.scrap ? 'Scrap' : 'Sell';
  const sold = (count) => (v) => `Sold ${count > 1 ? `${count} × ` : ''}${name} for ${formatMoney(v)}`;
  return el('button', {
    class: 'btn btn-small', disabled, title,
    onclick: () => {
      if (n === 1) { act(() => economy.sellFromGroup(group, 1), sold(1)); return; }
      const label = el('strong', {});
      const show = (k) => { label.textContent = `${k} × ${name} for ${formatMoney(economy.groupSellTotal(group, k))}`; };
      const slider = el('input', { type: 'range', min: 1, max: n, step: 1, value: 1, 'aria-label': 'How many to sell', oninput: (e) => show(Number(e.target.value)) });
      show(1);
      openModal(`${verb} ${name}`, el('div', { class: 'sell-slider' },
        el('p', { class: 'small muted' }, `You have ${n}.${group.scrap ? '' : ' The worst-condition ones go first.'}`),
        slider, label,
        el('div', { class: 'part-actions' },
          el('button', { class: 'btn btn-primary', onclick: () => { const k = Number(slider.value); closeModal(); act(() => economy.sellFromGroup(group, k), sold(k)); } }, verb),
          el('button', { class: 'btn', onclick: closeModal }, 'Cancel'))));
    },
  }, n === 1 ? `${verb} ${formatMoney(economy.partSellPrice(group.best))}` : `${verb}…`);
}

/** Derived stats each drive of a twin contributes to (shown Drive 1/Drive 2). */
const PER_DRIVE = ['fDrive', 'fUsable', 'accel', 'vMax', 'cooling'];

/** Stats with every part at full HP — used to show damage penalties. */
function pristineStats(bug) {
  const j = bug.toJSON();
  // "Repaired" means as far as you can repair it right now (90%, or 100% with a mechanic).
  const strip = (p) => (p ? { key: p.key, uid: p.uid, hp: Part.fromJSON(p).repairedHp } : null);
  return BattleBug.fromJSON({
    ...j, chassis: strip(j.chassis), engine: strip(j.engine), tires: strip(j.tires), armor: strip(j.armor), weapons: j.weapons.map(strip),
  }).getStats();
}

/**
 * The Workshop: an interactive hoist view of the active vehicle. Clicking
 * Front / Center / Sides / Hull opens repair & replace modals.
 */
export class WorkshopUI {
  constructor(root, { state, economy, sprite, onShop = null }) {
    this.root = root;
    this.onShop = onShop; // (partType) => open that Marketplace category
    this.state = state;
    this.economy = economy;
    this.sprite = sprite;
    this.hover = null;
    this.openRegionKey = null;
    this.raf = 0;
    this.canvas = null;
  }

  get bug() {
    return this.state.activeBug;
  }

  /** The vehicle that won the one on the hoist, if we're inspecting a fresh capture. */
  get refBug() {
    const r = this.state.compareRef;
    const bug = this.bug;
    if (!r || !bug || r.id !== bug.id) return null;
    return this.state.getVehicle(r.refId);
  }

  act(fn, success) {
    try {
      const r = fn();
      if (success) toast(typeof success === 'function' ? success(r) : success, 'good');
      this.state.commit();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  render() {
    const bug = this.bug;
    if (!bug) {
      this.root.replaceChildren(el('div', { class: 'panel-title' }, el('h2', {}, 'The Hoist')),
        el('div', { class: 'notice notice-warn' }, 'The hoist is empty — you have no vehicles. Buy a replacement from Marketplace › Chassis.'));
      return;
    }
    const locked = this.state.isLocked(bug);
    this.canvas = el('canvas', { class: 'hoist-canvas', width: 220, height: 190, 'aria-label': 'Vehicle hoist — click a region' });
    this.canvas.addEventListener('pointermove', (e) => this.onHover(e));
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; });
    // Horizontal swipe on the hoist flips between vehicles; a plain tap inspects a region.
    let swipe = null;
    this.canvas.addEventListener('pointerdown', (e) => { swipe = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!swipe) return;
      const dx = e.clientX - swipe.x;
      const dy = e.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        this.suppressClick = true;
        this.cycle(dx < 0 ? 1 : -1);
      }
    });
    this.canvas.addEventListener('click', (e) => {
      if (this.suppressClick) { this.suppressClick = false; return; }
      const region = this.regionFromEvent(e);
      if (region) this.openRegion(region);
    });

    const repairAll = this.economy.repairAllCost(bug);
    const issues = bug.battleIssues();

    const canDispose = !locked && !this.economy.inField;
    this.root.replaceChildren(el('div', { class: 'hoist-layout' },
      el('div', { class: 'hoist-main' }, ...[
        this.renderCarousel(bug, locked),
        el('div', { class: 'hoist-stage' }, this.canvas,
          el('div', { class: 'hoist-hint' }, this.state.vehicles.length > 1 ? 'Tap a region · swipe for next vehicle' : 'Tap a region to inspect it')),
        el('div', { class: 'region-buttons' },
          Object.entries(HOIST_REGIONS).map(([key, r]) => el('button', {
            class: 'btn btn-region',
            onclick: () => this.openRegion(key),
            onmouseenter: () => { this.hover = key; },
            onmouseleave: () => { this.hover = null; },
          }, el('span', {}, r.label), el('small', {}, this.regionSummary(key))))),
        issues.length ? el('ul', { class: 'issues' }, issues.map((i) => el('li', {}, `⚠ ${i}`))) : null,
        el('div', { class: 'hoist-actions' },
          el('button', {
            class: 'btn btn-primary btn-small repair-btn',
            disabled: repairAll === 0 || this.state.money < 1,
            onclick: () => this.act(() => this.economy.repairAll(bug), (hp) => (hp ? `Repaired ${bug.name} — condition ${Math.round(bug.condition * 100)}%` : 'Nothing repaired')),
          }, repairAll ? `Repair all ${formatMoney(repairAll)}` : 'Fully repaired'),
          el('button', { class: 'btn btn-small', onclick: () => { this.renaming = true; this.render(); } }, 'Rename'),
          el('button', {
            class: 'btn btn-small', disabled: bug.parts.length <= 1,
            onclick: () => this.confirm(`Strip ${bug.name}?`, 'Every fitted part comes off and goes to your spares. The bare chassis stays on the hoist.',
              () => this.act(() => this.economy.stripVehicle(bug.id), (r) => `Stripped ${r.parts.length} part${r.parts.length === 1 ? '' : 's'} — the bare chassis is on the hoist`)),
          }, 'Strip'),
          el('button', {
            class: 'btn btn-small btn-danger', disabled: !canDispose,
            onclick: () => this.confirm(`Sell ${bug.name}?`, this.economy.sellWarning(bug),
              () => this.act(() => this.economy.sellVehicle(bug.id), (v) => `Sold for ${formatMoney(v)}`)),
          }, `Sell ${formatMoney(this.economy.vehicleSellPrice(bug))}`)),
      ].filter(Boolean)),
      el('div', { class: 'hoist-side' }, ...[
        this.state.staff.mechanic ? this.renderAdvice(bug, locked) : null,
        this.refBug ? el('div', { class: 'notice notice-gold ref-note' },
          el('strong', {}, 'Captured! '), 'White ticks show ', el('span', { class: 'cmp-legend-mark' }), ` ${this.refBug.name}, the bug that won it.`) : null,
        this.renderStats(bug),
      ].filter(Boolean))));

    this.startLoop();
    if (this.openRegionKey) this.openRegion(this.openRegionKey, true);
  }

  renderCarousel(bug, locked) {
    const vs = this.state.vehicles;
    const i = vs.indexOf(bug);
    const many = vs.length > 1;
    const lockedIn = this.state.tournament.entered;
    const name = this.renaming
      ? el('form', {
        class: 'rename',
        onsubmit: (e) => {
          e.preventDefault();
          const v = e.target.elements.name.value.trim().slice(0, 24);
          this.renaming = false;
          if (v) this.act(() => { bug.name = v; }, 'Renamed');
          else this.render();
        },
      }, el('input', { name: 'name', value: bug.name, maxlength: 24, 'aria-label': 'Vehicle name' }), el('button', { class: 'btn btn-small', type: 'submit' }, 'Save'))
      : el('strong', {}, bug.name);
    return el('div', { class: 'hoist-name' },
      many ? el('button', { class: 'btn btn-icon carousel-btn', 'aria-label': 'Previous vehicle', disabled: lockedIn, onclick: () => this.cycle(-1) }, '◀') : null,
      el('span', { class: 'bug-swatch', style: { background: `hsl(${bug.hue} 60% 55%)` } }),
      el('div', { class: 'hoist-name-text' },
        name,
        this.state.newVehicleIds.has(bug.id) ? el('span', { class: 'badge badge-gold' }, 'NEW') : null,
        locked ? el('span', { class: 'badge badge-lock', title: 'Tournament entrant: spares only, no switching vehicles' }, '🔒 ENTERED') : null,
        el('div', { class: 'muted small' }, bug.chassis.name, many ? ` · ${i + 1} of ${vs.length}` : '')),
      many ? el('button', { class: 'btn btn-icon carousel-btn', 'aria-label': 'Next vehicle', disabled: lockedIn, onclick: () => this.cycle(1) }, '▶') : null);
  }

  confirm(title, text, onYes) {
    openModal(title, el('div', {},
      el('p', {}, text),
      el('div', { class: 'part-actions' },
        el('button', { class: 'btn btn-primary', onclick: () => { closeModal(); onYes(); } }, 'Confirm'),
        el('button', { class: 'btn', onclick: closeModal }, 'Cancel'))));
  }

  /** The mechanic's verdict: what's holding the bug back and the one part that fixes it. */
  renderAdvice(bug, locked) {
    const eco = this.economy;
    const advice = eco.mechanicAdvice(bug);
    const lines = advice.lines.map((l) => el('div', {}, l));
    for (const c of advice.combos) lines.push(el('div', { class: `interaction ${c.good ? 'good' : 'bad'}` }, `${c.good ? '✓' : '⚠'} ${c.text}`));
    if (advice.pick) {
      const def = PARTS[advice.pick.key];
      const where = eco.pickAvailability(advice.pick.key);
      const reason = advice.pick.reason[0].toUpperCase() + advice.pick.reason.slice(1);
      lines.push(el('div', {}, `${reason}. Get the `, el('strong', {}, def.name), '.'));
      if (where.where === 'spares') {
        lines.push(el('div', { class: 'advice-row' }, 'You\'ve got one in your spares.',
          el('button', {
            class: 'btn btn-small btn-primary', disabled: locked,
            onclick: () => this.act(() => eco.equipFromInventory(bug, where.part.uid), `Fitted ${def.name}`),
          }, 'Fit it')));
      } else if (where.where === 'market') {
        lines.push(el('div', { class: 'advice-row' }, `On the Marketplace for ${formatMoney(where.price)}.`,
          el('button', {
            class: 'btn btn-small btn-primary', disabled: this.state.money < where.price,
            onclick: () => this.act(() => eco.buyPartListing(where.listing.id), `Bought ${def.name} — it's in your spares`),
          }, 'Buy')));
      } else {
        lines.push(el('div', { class: 'muted' }, 'Not on the Marketplace right now — tough.',
          this.state.staff.manager ? ' Your manager will go looking for one.' : ''));
      }
    }
    if (!lines.length) return null;
    return el('div', { class: 'advice' }, el('div', { class: 'advice-head' }, `🔧 ${this.economy.person('mechanic')?.name || 'Mechanic'}`), lines);
  }

  /** Put the next/previous garage vehicle on the hoist. */
  cycle(dir) {
    const vs = this.state.vehicles;
    if (vs.length < 2) return;
    if (this.state.tournament.entered) {
      toast('Your tournament entrant is locked on the hoist', 'bad');
      return;
    }
    const i = vs.indexOf(this.bug);
    const next = vs[(i + dir + vs.length) % vs.length];
    this.renaming = false;
    this.act(() => this.state.setActive(next.id));
  }

  regionSummary(key) {
    const bug = this.bug;
    const parts = {
      front: bug.weapons,
      center: bug.drives,
      sides: [bug.tires],
      hull: [bug.chassis, bug.armor],
    }[key].filter(Boolean);
    if (key === 'front') return `${bug.weapons.length}/${bug.weaponSlots} weapons`;
    if (!parts.length) return 'empty';
    const r = parts.reduce((s, p) => s + p.hpRatio, 0) / parts.length;
    if (key === 'center' && bug.driveSlots > 1) return `${bug.drives.length}/2 drives · ${Math.round(r * 100)}%`;
    return `${Math.round(r * 100)}%`;
  }

  renderStats(bug) {
    const s = bug.getStats();
    const p = pristineStats(bug);
    const ref = this.refBug;
    // The reference vehicle is compared fully repaired.
    const rs = ref ? pristineStats(ref) : null;
    // Scores out of 100 — the bar (and the number) stop at 100.
    const refFor = { fDrive: REF.fDrive, fGrip: REF.fGrip, fUsable: REF.fUsable, accel: REF.accel, vMax: REF.vMax, staminaMax: REF.stamina, cooling: REF.cooling, mass: REF.mass };
    const sc = (key, v) => capped((v / refFor[key]) * 100);
    const row = (label, key, hint, neutral = false) => {
      // Bar = current value, red = what repairs would restore, white tick = reference.
      const cur = sc(key, s[key]);
      const full = sc(key, p[key]);
      const refVal = rs ? sc(key, rs[key]) : null;
      // Twin drives: each drive's own figure, Drive 1/Drive 2 (the bar shows the whole vehicle).
      const split = s.perDrive && PER_DRIVE.includes(key) ? s.perDrive.map((d) => shown(sc(key, d[key]))).join('/') : null;
      const tip = `${hint}${split ? ' — Drive 1/Drive 2' : ''}`;
      return el('tr', { title: refVal != null ? `${tip} — ${ref.name} (repaired): ${shown(refVal)}` : tip || '' },
        el('th', {}, label),
        el('td', { class: split ? 'split' : null }, split ?? `${shown(cur)}`),
        el('td', { class: 'stat-bar-cell' }, statBar({ value: cur, potential: full, ref: refVal, max: 100, neutral, cls: 'stat-bar' })));
    };
    return el('div', { class: 'stats-block' },
      el('h3', {}, 'Derived stats'),
      el('table', { class: 'stats' },
        el('tbody', {},
          row('Drive', 'fDrive', "What the motor puts out (less damage)"),
          row('Grip', 'fGrip', 'The most force your tires can put down before they spin'),
          row('Push', 'fUsable', 'What actually moves you: the lower of Drive and Grip'),
          row('Acceleration', 'accel', 'Push for your weight'),
          row('Top speed', 'vMax', 'Motor revs × tire size'),
          row('Stamina', 'staminaMax', 'How long you can push before a thermal stall'),
          row('Cooling', 'cooling', 'How fast stamina comes back'),
          row('Weight', 'mass', 'Heavier is harder to push around — and harder to move', true),
        )),
      el('p', { class: 'muted small stats-note' },
        s.castor
          ? 'Gliding on castors: thrust is what moves you — less rolling resistance or more thrust = more push.'
          : s.fDrive > s.fGrip
            ? 'Traction-limited: better grip = more push.'
            : 'Power-limited: a stronger motor = more push.'),
      this.renderComponents(bug),
    );
  }

  /** Everything fitted to the vehicle, rarest first: "Category: Name — ★★ Rarity". */
  renderComponents(bug) {
    const CATEGORY = { chassis: 'Chassis', engine: 'Power Plant', tires: 'Running Gear', castor: 'Running Gear', armor: 'Armour', weapon: 'Weapon', cooling: 'Cooling', enhancement: 'Enhancement', drivetrain: 'Drive Train' };
    const parts = [...bug.parts].sort((a, b) => RARITY[b.rarity].rank - RARITY[a.rarity].rank || b.tier - a.tier || a.name.localeCompare(b.name));
    return el('div', { class: 'components' },
      el('h3', {}, 'Components'),
      el('ul', { class: 'component-list' }, parts.map((p) => el('li', {},
        el('span', { class: 'muted' }, `${CATEGORY[p.type] || p.type}: `),
        p.name, ' — ',
        el('span', { class: 'stars' }, `${'★'.repeat(p.tier)}`), ' ',
        el('span', { class: `rarity-${p.rarity}` }, RARITY[p.rarity].label)))));
  }

  // ───────────── Hoist canvas ─────────────
  get hoistGeom() {
    const c = this.canvas;
    const bug = this.bug;
    return { cx: c.width / 2, cy: c.height / 2 + 4, k: 58 / bug.designRadius };
  }

  regionFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
    const py = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
    const { cx, cy, k } = this.hoistGeom;
    const dx = (px - cx) / k;
    const dy = (py - cy) / k;
    // Bug faces up (angle −π/2): local x = −dy, local y = dx
    return SpriteRenderer.regionAt(-dy, dx, this.bug.designRadius);
  }

  onHover(e) {
    const region = this.regionFromEvent(e);
    this.hover = region;
    this.canvas.style.cursor = region ? 'pointer' : 'default';
  }

  startLoop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.canvas?.isConnected) return;
      if (this.canvas.offsetParent !== null) this.drawHoist(); // skip while the Garage is hidden
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  drawHoist() {
    const c = this.canvas;
    const ctx = c.getContext('2d');
    const bug = this.bug;
    if (!bug) return;
    const time = performance.now() / 1000;
    const { cx, cy, k } = this.hoistGeom;
    const W = c.width;
    const H = c.height;

    // Garage wall
    ctx.fillStyle = '#16121f';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#1c1728';
    for (let y = 0; y < H; y += 10) {
      for (let x = (y / 10) % 2 ? 0 : -10; x < W; x += 20) ctx.fillRect(x + 1, y + 1, 18, 8);
    }
    // Hazard floor stripe
    for (let x = -20; x < W; x += 16) {
      ctx.fillStyle = '#e0b43a';
      ctx.beginPath();
      ctx.moveTo(x, H); ctx.lineTo(x + 8, H - 10); ctx.lineTo(x + 16, H - 10); ctx.lineTo(x + 8, H);
      ctx.fill();
    }
    ctx.fillStyle = '#0b0910';
    ctx.fillRect(0, H - 12, W, 2);

    // Lift posts & platform
    const bob = Math.sin(time * 1.5) * 1.5;
    ctx.fillStyle = '#3a3448';
    ctx.fillRect(cx - 82, 20, 10, H - 32);
    ctx.fillRect(cx + 72, 20, 10, H - 32);
    ctx.fillStyle = '#e0b43a';
    ctx.fillRect(cx - 82, 20, 10, 4);
    ctx.fillRect(cx + 72, 20, 10, 4);
    ctx.fillStyle = '#4a4458';
    ctx.fillRect(cx - 74, cy - 50 + bob, 148, 100);
    ctx.fillStyle = '#3a3448';
    for (let y = cy - 44; y < cy + 46; y += 12) ctx.fillRect(cx - 70, y + bob, 140, 2);
    ctx.fillStyle = '#0b0910';
    ctx.fillRect(cx - 74, cy + 50 + bob, 148, 3);

    this.sprite.drawBug(ctx, bug, {
      x: cx, y: cy + bob, angle: -Math.PI / 2, scale: k, time, shadow: false, highlight: this.hover,
    });

    if (this.hover) {
      ctx.font = '8px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd24a';
      ctx.fillText(HOIST_REGIONS[this.hover].label.toUpperCase(), cx, 12);
    }
  }

  /** Reopen an area of the hoist on the tab you left it on (coming back from the Marketplace). */
  reopen({ region, tab, bay }) {
    if (!region || !this.bug) return;
    this.openRegionKey = region;
    this.regionTab = tab;
    this.regionBay = bay || 0;
    this.openRegion(region);
  }

  // ───────────── Region modal ─────────────
  openRegion(key, refresh = false) {
    const region = HOIST_REGIONS[key];
    const bug = this.bug;
    if (!region || !bug) return;
    if (refresh && !document.querySelector('#modal-root.open')) {
      this.openRegionKey = null;
      return;
    }
    // Open on what's fitted (castors, if the running gear is castors).
    if (this.openRegionKey !== key) { this.regionTab = region.types[0]; this.regionBay = 0; }
    this.openRegionKey = key;
    const locked = this.state.isLocked(bug);
    // Twin-bay shells: Inside splits into Drive 1 and Drive 2, each with its own parts.
    const twinBays = key === 'center' && bug.driveSlots > 1;
    const bay = twinBays ? Math.min(this.regionBay || 0, 1) : null;
    const driveTabs = twinBays
      ? el('div', { class: 'subtabs drive-tabs', role: 'tablist' }, [0, 1].map((b) => el('button', {
        class: `subtab${b === bay ? ' active' : ''}`,
        role: 'tab',
        'aria-selected': b === bay ? 'true' : 'false',
        onclick: () => { this.regionBay = b; this.openRegion(key); },
      }, `Drive ${b + 1}`, el('span', { class: 'subtab-count' }, bug.drives[b] ? bug.drives[b].name : 'empty'))))
      : null;
    // Areas with several part types get a tab each (Inside: Power Plant · Cooling · Enhancement · Drive Train; Shell: Chassis · Armour).
    const type = region.types.includes(this.regionTab) ? this.regionTab : region.types[0];
    const TAB_LABELS = { engine: 'Power Plant', cooling: 'Cooling', enhancement: 'Enhancement', drivetrain: 'Drive Train', chassis: 'Chassis', armor: 'Armour', tires: 'Tyres', castor: 'Castors' };
    const tabs = region.types.length > 1
      ? el('div', { class: 'subtabs region-tabs', role: 'tablist' }, region.types.map((t) => {
        const list = bug.slotList(t);
        const fitted = t === 'tires' || t === 'castor' ? bug.tires?.type === t : bug.slotPart(t);
        const count = twinBays
          ? (t === 'engine' ? (bug.drives[bay] ? '✓' : '—') : `${bug.addOnsOn(t, bay).length}/${BattleBug.perDrive(t)}`)
          : list ? `${list.length}/${bug.slotCapacity(t) || BattleBug.perDrive(t) || list.length}` : (t === 'chassis' || fitted ? '✓' : '—');
        return el('button', {
          class: `subtab${t === type ? ' active' : ''}`,
          role: 'tab',
          'aria-selected': t === type ? 'true' : 'false',
          onclick: () => { this.regionTab = t; this.openRegion(key); },
        }, TAB_LABELS[t], el('span', { class: 'subtab-count' }, count));
      }))
      : null;
    const body = el('div', { class: 'region-modal' },
      el('p', { class: 'muted' }, region.blurb, this.economy.inField ? " — you're in the field: spares from your inventory only." : ''),
      driveTabs,
      tabs,
      twinBays ? this.renderBaySlot(bug, type, bay, locked) : this.renderSlot(bug, type, false));
    openModal(`${region.label} · ${bug.name}`, body, { onClose: () => { this.openRegionKey = null; } });
  }

  /** Twin drives out of balance: each odd part, and where its match can come from. */
  renderMatching(bug, odd, locked, optional = false) {
    const eco = this.economy;
    const box = optional
      ? el('div', { class: 'notice match-box' },
        el('strong', {}, 'Cooling differs'), el('div', { class: 'small' }, 'Each power plant cools itself, so it works as it is — but run the same cooling on both and they work together for +10%.'))
      : el('div', { class: 'notice notice-warn match-box' },
        el('strong', {}, "Drives don't match"), el('div', { class: 'small' }, "Each drive needs the same kit, or she'll pull to one side."));
    for (const u of odd) {
      const src = eco.matchSource(u.part.key);
      const side = `Drive ${u.missingOn + 1}`;
      let action;
      if (src?.where === 'spares') {
        action = el('button', { class: 'btn btn-small btn-primary', disabled: locked, onclick: () => this.act(() => eco.fitMatching(bug, u.part.uid), `Fitted the matching ${u.part.name} from your spares`) }, 'Fit spare');
      } else if (src && !eco.inField) {
        action = el('button', { class: 'btn btn-small btn-primary', disabled: locked || this.state.money < src.price, onclick: () => this.act(() => eco.fitMatching(bug, u.part.uid), `Bought and fitted the matching ${u.part.name}`) }, `Buy & fit ${formatMoney(src.price)}`);
      } else if (this.state.staff.manager && !eco.inField && eco.huntOdds(u.part.key) !== null) {
        action = el('span', { class: 'muted small' }, `Manager's looking — ${Math.round(eco.huntOdds(u.part.key) * 100)}% after your next bout`);
      } else if (this.state.staff.manager && !eco.inField) {
        action = el('button', {
          class: 'btn btn-small',
          onclick: () => this.act(() => eco.managerFind(u.part.key),
            (r) => (r.found ? `Manager: found a ${r.name} — it's on the Marketplace` : `Manager: no ${r.name} to be had yet — I'll keep looking (${Math.round(r.next * 100)}% after your next bout)`)),
        }, 'Ask manager to find one');
      } else {
        action = el('span', { class: 'muted small' }, eco.inField ? 'None in your spares.' : 'None about — a manager could find you one.');
      }
      box.append(el('div', { class: 'advice-row' }, `${u.part.name} → ${side}`, action));
    }
    return box;
  }

  /** Compare a component of a fresh capture against the winning vehicle's equivalent. */
  refCompare(part) {
    const ref = this.refBug;
    if (!ref) return {};
    const cp = counterpart(ref, part);
    return { compareTo: cp, compareLegend: cp ? `${ref.name}'s ${cp.name} (your winner)` : `${ref.name} (your winner) has none fitted` };
  }

  repairButton(part) {
    const cost = this.economy.repairCost(part);
    if (!cost) return null;
    const affordable = this.state.money >= cost;
    return el('button', {
      class: 'btn btn-small btn-primary',
      disabled: this.state.money < 1,
      onclick: () => this.act(() => this.economy.repairPart(part), () => `Repaired ${part.name} — condition ${Math.round(part.hpRatio * 100)}%`),
    }, affordable ? `Repair ${formatMoney(cost)}` : `Patch (${formatMoney(this.state.money)})`);
  }

  /** A fitted part's card: repair, and remove (a power plant takes its add-ons with it). */
  fittedCard(bug, part, locked) {
    return partCard(part, this.economy, {
      ...this.refCompare(part),
      actions: [
        this.repairButton(part),
        el('button', {
          class: 'btn btn-small',
          disabled: locked,
          onclick: () => this.act(() => this.economy.unequipToInventory(bug, part.uid),
            (off) => (off.length > 1 ? `${part.name} moved to inventory — its cooling, enhancements and drive train came off too` : `${part.name} moved to inventory`)),
        }, 'Remove'),
      ].filter(Boolean),
    });
  }

  /** The Marketplace aisle link for a part type (remembers where to come back to). */
  shopLink(type) {
    if (!this.onShop || this.economy.inField) return null;
    const label = { engine: 'Power Plant', cooling: 'Cooling', enhancement: 'Enhancements', drivetrain: 'Drive Train', tires: 'Running Gear', castor: 'Running Gear', armor: 'Armour', weapon: 'Weapons' }[type];
    return el('button', {
      class: 'btn btn-small shop-link',
      onclick: () => {
        const back = { region: this.openRegionKey, tab: this.regionTab, bay: this.regionBay };
        closeModal();
        this.onShop(type, back);
      },
    }, `Shop ${label} on the Marketplace →`);
  }

  /**
   * One drive of a twin-bay shell: its power plant, or the cooling,
   * enhancements or drive train fitted to it. Spares fit straight onto this drive.
   */
  renderBaySlot(bug, type, bay, locked) {
    const eco = this.economy;
    const title = { engine: 'Power Plant', cooling: 'Cooling', enhancement: 'Enhancement', drivetrain: 'Drive Train' }[type];
    const name = `Drive ${bay + 1}`;
    const section = el('section', { class: 'slot-section' }, el('h3', {}, `${name} · ${title}`));
    const drive = bug.drives[bay];
    const inv = this.state.inventory.filter((p) => p.type === type);
    const spares = (actionsFor) => {
      if (!inv.length) return el('p', { class: 'muted small' }, 'No spare parts of this type — visit the Marketplace or strip a captured vehicle.');
      const list = el('div', { class: 'replace-list' }, el('h4', {}, `Spares — fit to ${name} or sell`));
      for (const group of eco.spareGroups(inv)) {
        const part = group.best;
        const actions = [...actionsFor(part), sellStackButton(group, eco, (fn, msg) => this.act(fn, msg), {
          disabled: eco.inField, title: eco.inField ? "No selling while you're in the tournament" : null,
        })];
        list.append(partCard(part, eco, { actions, compareTo: counterpart(bug, part), group }));
      }
      return list;
    };

    if (type === 'engine') {
      section.append(drive ? this.fittedCard(bug, drive, locked) : el('div', { class: 'empty-slot' }, 'Empty drive bay'));
      const other = bug.drives[1 - bay];
      section.append(el('p', { class: 'muted small' }, `The two drives can be any mix of motor types${other ? ` (the other is ${other.stats.kind})` : ''}. With both working, a swipe spins you 360° on the spot — but the stronger side pulls her off line, so keep them even (Derived stats shows each drive's figures as Drive 1/Drive 2).`));
      if (bay > bug.drives.length) {
        section.append(el('p', { class: 'muted small' }, 'Fit Drive 1 first.'));
      } else {
        section.append(spares((part) => [el('button', {
          class: `btn btn-small${drive ? '' : ' btn-primary'}`, disabled: locked || part.isScrap,
          onclick: () => this.act(() => eco.equipFromInventory(bug, part.uid, bay), `${drive ? 'Swapped' : 'Fitted'} ${part.name} in ${name}`),
        }, drive ? 'Swap' : 'Fit')]));
      }
    } else if (!drive) {
      section.append(el('div', { class: 'empty-slot' }, `No power plant in ${name}`));
      section.append(el('p', { class: 'muted small' }, `${title} mounts on the power plant. Fit a drive first dummy!`));
      section.append(spares(() => []));
    } else {
      const per = BattleBug.perDrive(type);
      const mine = bug.addOnsOn(type, bay);
      if (!mine.length) section.append(el('div', { class: 'empty-slot' }, 'Empty'));
      for (const part of mine) section.append(this.fittedCard(bug, part, locked));
      section.append(el('p', { class: 'muted small' }, `${mine.length}/${per} ${title.toLowerCase()} slot${per > 1 ? 's' : ''} on ${name}. ${type === 'cooling'
        ? 'Each power plant cools itself; liquid cooling needs a jacket on this drive (unless it\'s combustion or torque). The same cooling on both drives works together: +10%.'
        : type === 'drivetrain'
          ? `One shaft and one prop count per drive, and ${bug.drives.length > 1 ? 'one gearbox' : 'up to two gearboxes while only one drive is fitted'} — a turbine runs High-Speed Shaft → gearbox → drive shaft. Fit the same to both drives or she pulls.`
          : 'Fit the same to both drives or she pulls to one side.'}`));
      const odd = bug.unmatched({ cooling: true }).filter((u) => u.part.type === type);
      if (odd.length) section.append(this.renderMatching(bug, odd, locked, type === 'cooling'));
      section.append(spares((part) => (mine.length < per
        ? [el('button', { class: 'btn btn-small btn-primary', disabled: locked || part.isScrap, onclick: () => this.act(() => eco.equipFromInventory(bug, part.uid, undefined, bay), `Fitted ${part.name} to ${name}`) }, 'Fit')]
        : mine.map((w, i) => el('button', {
          class: 'btn btn-small', disabled: locked || part.isScrap,
          onclick: () => this.act(() => eco.equipFromInventory(bug, part.uid, i, bay), `Swapped ${part.name} in on ${name}`),
        }, `Swap ${i + 1}`)))));
    }
    const link = this.shopLink(type);
    if (link) section.append(link);
    return section;
  }

  renderSlot(bug, type, locked) {
    const inv = this.state.inventory.filter((p) => p.type === type || (type === 'tires' && p.type === 'castor'));
    const title = { engine: 'Power Plant', cooling: 'Cooling', enhancement: 'Enhancement', drivetrain: 'Drive Train', tires: 'Running Gear', castor: 'Castors', armor: 'Armour', weapon: 'Weapons', chassis: 'Chassis' }[type];
    const section = el('section', { class: 'slot-section' }, el('h3', {}, title));
    const multi = bug.slotList(type); // weapons, cooling and enhancements have several slots
    const cap = bug.slotCapacity(type);

    if (type === 'chassis') {
      section.append(partCard(bug.chassis, this.economy, {
        ...this.refCompare(bug.chassis),
        actions: [this.repairButton(bug.chassis)].filter(Boolean),
        extra: el('p', { class: 'muted small' }, 'The frame IS the vehicle. Hull at 0% = catastrophic damage.'),
      }));
      return section;
    }

    // Running gear: driven tyres and tracks, or gliding castors — one slot for either.
    const equipped = multi || [bug.slotPart(type)].filter(Boolean);
    if (type === 'tires') {
      section.append(el('p', { class: 'muted small' }, "Driven tyres and tracks need a drive shaft. Gliding castors sit under the chassis, out of sight, and need thrust — a turbine or plasma drive, or a propeller or ducted fan. On castors you accelerate hard but slide: to slow down, thrust the other way."));
    }
    if (!equipped.length) {
      section.append(el('div', { class: 'empty-slot' }, type === 'weapon' && bug.weaponSlots === 0 ? 'No hardpoints on this frame' : 'Empty slot'));
    }
    for (const part of equipped) section.append(this.fittedCard(bug, part, locked));

    if (type === 'weapon') {
      section.append(el('p', { class: 'muted small' }, `${bug.weapons.length}/${bug.weaponSlots} hardpoints used. Weapons add mass and cost stamina per activation.`));
    } else if (type === 'engine' && multi) {
      section.append(el('p', { class: 'muted small' }, `${multi.length}/${cap} drive bays used. Twin drives can be any mix of motor types — with both working, a swipe spins you 360° on the spot. Keep them even or she'll pull to one side.`));
    } else if (multi && !bug.drives.length) {
      section.append(el('p', { class: 'muted small' }, `No drive fitted — ${title.toLowerCase()} mounts on the drive. Fit a drive first dummy!`));
    } else if (type === 'drivetrain') {
      const gearboxes = bug.driveSlots > 1 ? 'two gearboxes (a twin-bay shell with one drive has room for both)' : 'one gearbox';
      section.append(el('p', { class: 'muted small' }, `${multi.length}/${cap} drive-train slots used. Only ${gearboxes}, one shaft and one prop count — a turbine runs High-Speed Shaft → gearbox → drive shaft. Your mechanic knows which combinations pay off.`));
    } else if (multi) {
      section.append(el('p', { class: 'muted small' }, `${multi.length}/${cap} ${type === 'cooling' ? 'cooling' : 'enhancement'} slot${cap > 1 ? 's' : ''} used. Not every add-on suits every drive.`));
    }

    if (inv.length) {
      const list = el('div', { class: 'replace-list' }, el('h4', {}, type === 'weapon' ? 'Spares — mount or sell' : 'Spares — fit or sell'));
      // Like spares stack (× n); fitting takes the best of the stack.
      for (const group of this.economy.spareGroups(inv)) {
        const part = group.best;
        const actions = [];
        if (multi) {
          if (multi.length < cap) {
            actions.push(el('button', { class: 'btn btn-small btn-primary', disabled: locked || part.isScrap, onclick: () => this.act(() => this.economy.equipFromInventory(bug, part.uid), `Fitted ${part.name}`) }, type === 'weapon' ? 'Mount' : 'Fit'));
          }
          multi.forEach((w, i) => actions.push(el('button', {
            class: 'btn btn-small', disabled: locked || part.isScrap,
            onclick: () => this.act(() => this.economy.equipFromInventory(bug, part.uid, i), `Swapped in ${part.name}`),
          }, `Swap slot ${i + 1}`)));
        } else {
          actions.push(el('button', { class: 'btn btn-small btn-primary', disabled: locked || part.isScrap, onclick: () => this.act(() => this.economy.equipFromInventory(bug, part.uid), `Fitted ${part.name}`) }, 'Fit'));
        }
        actions.push(sellStackButton(group, this.economy, (fn, msg) => this.act(fn, msg), {
          disabled: this.economy.inField,
          title: this.economy.inField ? "No selling while you're in the tournament" : null,
        }));
        list.append(partCard(part, this.economy, { actions, compareTo: counterpart(bug, part), group }));
      }
      section.append(list);
    } else {
      section.append(el('p', { class: 'muted small' }, 'No spare parts of this type — visit the Marketplace or strip a captured vehicle.'));
    }
    // Straight to the right aisle of the Marketplace (closed while you're in the tournament).
    const link = this.shopLink(type);
    if (link) section.append(link);
    return section;
  }
}
