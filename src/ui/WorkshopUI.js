import { HOIST_REGIONS, WEAPON_CLASSES } from '../config/constants.js';
import { PART_KEYS_BY_TYPE } from '../config/partsData.js';
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

export function openModal(title, body, { onClose } = {}) {
  const root = document.getElementById('modal-root');
  root.replaceChildren(
    el('div', { class: 'modal-backdrop', onclick: closeModal }),
    el('div', { class: 'modal', role: 'dialog', 'aria-label': title },
      el('div', { class: 'modal-head' },
        el('h2', {}, title),
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

export function partStatLine(part) {
  const s = part.stats;
  switch (part.type) {
    case 'chassis': return `Stamina ${s.staminaMax} · ${s.weaponSlots} hardpoint${s.weaponSlots === 1 ? '' : 's'} · turn ${s.turn}`;
    case 'engine': return `F ${(s.force / 1000).toFixed(0)} kN · ${s.rpm} rpm · cool ${s.cooling}/s`;
    case 'tires': return `μ ${s.mu} · tire r ${s.radius}`;
    case 'armor': return `Absorbs ${Math.round(s.absorb * 100)}% of impacts`;
    case 'weapon': return `${WEAPON_CLASSES[s.class].label} · ${s.cost} stamina · range ${s.range}`;
    default: return '';
  }
}

// ───────────── Comparison bars ─────────────
const kN = (v) => `${(v / 1000).toFixed(1)} kN`;
const int = (v) => `${Math.round(v)}`;

/**
 * Comparable stats per part type. `get` reads the part's *effective* value
 * (damage-scaled where the physics formulae scale it).
 */
export const PART_COMPARE = {
  engine: [
    { label: 'Drive force', get: (p) => p.stats.force * p.hpRatio, fmt: kN },
    { label: 'Motor RPM', get: (p) => p.stats.rpm, fmt: int },
    { label: 'Cooling', get: (p) => p.stats.cooling, fmt: (v) => `${v}/s` },
    { label: 'Mass', get: (p) => p.mass, fmt: (v) => `${v} kg`, better: 'neutral' },
  ],
  tires: [
    { label: 'Grip μ', get: (p) => p.stats.mu * p.hpRatio, fmt: (v) => v.toFixed(2) },
    { label: 'Tire radius', get: (p) => p.stats.radius, fmt: int },
    { label: 'Mass', get: (p) => p.mass, fmt: (v) => `${v} kg`, better: 'neutral' },
  ],
  armor: [
    { label: 'Absorb', get: (p) => p.stats.absorb * p.hpRatio, fmt: (v) => `${Math.round(v * 100)}%` },
    { label: 'Plating HP', get: (p) => p.hp, fmt: int },
    { label: 'Mass', get: (p) => p.mass, fmt: (v) => `${v} kg`, better: 'neutral' },
  ],
  chassis: [
    { label: 'Hull HP', get: (p) => p.hp, fmt: int },
    { label: 'Stamina', get: (p) => p.stats.staminaMax, fmt: int },
    { label: 'Hardpoints', get: (p) => p.stats.weaponSlots, fmt: int },
    { label: 'Turn rate', get: (p) => p.stats.turn, fmt: (v) => v.toFixed(1) },
    { label: 'Mass', get: (p) => p.mass, fmt: (v) => `${v} kg`, better: 'neutral' },
  ],
  weapon: [
    { label: 'Range', get: (p) => p.stats.range, fmt: int },
    { label: 'Stamina cost', get: (p) => p.stats.cost, fmt: int, better: 'lower' },
    { label: 'Cooldown', get: (p) => p.stats.cooldown, fmt: (v) => `${v}s`, better: 'lower' },
    { label: 'Mass', get: (p) => p.mass, fmt: (v) => `${v} kg`, better: 'neutral' },
  ],
};

/** Whole-vehicle stats; `get(stats, bug)`. Scales are the bar's full width. */
export const VEHICLE_COMPARE = [
  { label: 'Push', get: (s) => s.fUsable, fmt: kN, max: 65000 },
  { label: 'Grip', get: (s) => s.fGrip, fmt: kN, max: 130000 },
  { label: 'Top speed', get: (s) => s.vMax, fmt: (v) => `${Math.round(v)} px/s`, max: 380 },
  { label: 'Accel', get: (s) => s.accel, fmt: (v) => `${Math.round(v)}`, max: 500 },
  { label: 'Stamina', get: (s) => s.staminaMax, fmt: int, max: 150 },
  { label: 'Hull', get: (s, bug) => bug.chassis.hp, fmt: int, max: 260 },
  { label: 'Mass', get: (s) => s.mass, fmt: (v) => `${v} kg`, max: 330, better: 'neutral' },
];

const partScaleCache = {};
function partScale(type, row) {
  const key = `${type}:${row.label}`;
  if (!(key in partScaleCache)) {
    partScaleCache[key] = Math.max(...PART_KEYS_BY_TYPE[type].map((k) => row.get(new Part(k))));
  }
  return partScaleCache[key];
}

/**
 * Stat bars for a candidate, with a vertical marker showing the value of
 * what's currently on the hoist. Fill turns green/red when better/worse.
 * @param {Array<{label, value, current, max, fmt, better}>} rows
 */
export function compareBars(rows, { neutral = false, legend = null } = {}) {
  return el('div', { class: 'cmp' },
    rows.map((r) => {
      const max = Math.max(r.max, r.value, r.current ?? 0) || 1;
      const hasCur = r.current != null;
      let cls = 'neutral';
      if (hasCur && !neutral && r.better !== 'neutral') {
        const diff = r.better === 'lower' ? r.current - r.value : r.value - r.current;
        const eps = Math.abs(r.current) * 0.01 + 1e-9;
        cls = diff > eps ? 'better' : diff < -eps ? 'worse' : 'same';
      }
      return el('div', { class: 'cmp-row', title: hasCur ? `${r.label}: ${r.fmt(r.value)} (on hoist: ${r.fmt(r.current)})` : r.label },
        el('span', { class: 'cmp-label' }, r.label),
        el('div', { class: 'cmp-bar' },
          el('div', { class: `cmp-fill ${cls}`, style: { width: `${(r.value / max) * 100}%` } }),
          hasCur ? el('div', { class: 'cmp-mark', style: { left: `${(r.current / max) * 100}%` } }) : null),
        el('span', { class: 'cmp-val' }, r.fmt(r.value)));
    }),
    legend ? el('div', { class: 'cmp-legend' }, el('span', { class: 'cmp-legend-mark' }), legend) : null);
}

export function partCompare(part, current, { legend } = {}) {
  const rows = PART_COMPARE[part.type];
  if (!rows) return null;
  return compareBars(rows.map((r) => ({
    label: r.label, fmt: r.fmt, better: r.better,
    value: r.get(part), current: current ? r.get(current) : null, max: partScale(part.type, r),
  })), { legend: legend ?? (current ? `on hoist: ${current.name}` : 'nothing fitted in this slot') });
}

export function vehicleCompare(bug, current, { neutral = false } = {}) {
  const s = bug.getStats();
  const cs = current && current !== bug ? current.getStats() : null;
  return compareBars(VEHICLE_COMPARE.map((r) => ({
    label: r.label, fmt: r.fmt, better: r.better, max: r.max,
    value: r.get(s, bug), current: cs ? r.get(cs, current) : null,
  })), { neutral, legend: cs ? `on hoist: ${current.name}` : null });
}

/** The fitted part a candidate would be compared against. */
export function counterpart(bug, part) {
  if (!bug) return null;
  if (part.type === 'weapon') {
    return bug.weapons.find((w) => w.key === part.key)
      || bug.weapons.find((w) => w.stats.class === part.stats.class)
      || bug.weapons[0] || null;
  }
  return ['chassis', 'engine', 'tires', 'armor'].includes(part.type) ? bug[part.type] : null;
}

export function partCard(part, economy, { actions = [], extra = null, compareTo, compareLegend } = {}) {
  return el('div', { class: `part-card rarity-${part.rarity}${part.isBroken ? ' broken' : ''}` },
    el('div', { class: 'part-head' },
      el('span', { class: `part-type type-${part.type}` }, part.type),
      el('strong', {}, part.name),
      el('span', { class: 'part-mass' }, `${part.mass} kg`)),
    el('div', { class: 'part-stats' }, partStatLine(part)),
    hpBar(part.hpRatio, { label: part.isBroken ? 'BROKEN' : `${Math.ceil(part.hp)}/${part.maxHp} HP` }),
    compareTo !== undefined && compareTo !== part ? partCompare(part, compareTo, { legend: compareLegend }) : null,
    extra,
    actions.length ? el('div', { class: 'part-actions' }, actions) : null);
}

/** Stats with every part at full HP — used to show damage penalties. */
function pristineStats(bug) {
  const j = bug.toJSON();
  const strip = (p) => (p ? { key: p.key, uid: p.uid } : null);
  return BattleBug.fromJSON({
    ...j, chassis: strip(j.chassis), engine: strip(j.engine), tires: strip(j.tires), armor: strip(j.armor), weapons: j.weapons.map(strip),
  }).getStats();
}

/**
 * The Workshop: an interactive hoist view of the active vehicle. Clicking
 * Front / Center / Sides / Hull opens repair & replace modals.
 */
export class WorkshopUI {
  constructor(root, { state, economy, sprite }) {
    this.root = root;
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

    const canDispose = !locked && this.state.vehicles.length > 1;
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
            onclick: () => this.act(() => this.economy.repairAll(bug), (hp) => (hp ? `Repaired ${Math.round(hp)} HP` : 'Nothing repaired')),
          }, repairAll ? `Repair all ${formatMoney(repairAll)}` : 'Fully repaired'),
          el('button', { class: 'btn btn-small', onclick: () => { this.renaming = true; this.render(); } }, 'Rename'),
          el('button', {
            class: 'btn btn-small', disabled: !canDispose,
            onclick: () => this.confirm(`Strip ${bug.name}?`, 'Engine, tires, armour and weapons go to your spares; the bare frame is sold as scrap.',
              () => this.act(() => this.economy.stripVehicle(bug.id), (r) => `Stripped ${r.parts.length} parts, frame scrapped for ${formatMoney(r.scrap)}`)),
          }, 'Strip'),
          el('button', {
            class: 'btn btn-small btn-danger', disabled: !canDispose,
            onclick: () => this.confirm(`Sell ${bug.name}?`, `You'll receive ${formatMoney(this.economy.vehicleSellPrice(bug))}.`,
              () => this.act(() => this.economy.sellVehicle(bug.id), (v) => `Sold for ${formatMoney(v)}`)),
          }, `Sell ${formatMoney(this.economy.vehicleSellPrice(bug))}`)),
      ].filter(Boolean)),
      el('div', { class: 'hoist-side' }, ...[
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
        locked ? el('span', { class: 'badge badge-lock', title: 'Tournament rules' }, '🔒 LOCKED') : null,
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

  /** Put the next/previous hangar vehicle on the hoist. */
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
      center: [bug.engine],
      sides: [bug.tires],
      hull: [bug.chassis, bug.armor],
    }[key].filter(Boolean);
    if (key === 'front') return `${bug.weapons.length}/${bug.weaponSlots} weapons`;
    if (!parts.length) return 'empty';
    const r = parts.reduce((s, p) => s + p.hpRatio, 0) / parts.length;
    return `${Math.round(r * 100)}%`;
  }

  renderStats(bug) {
    const s = bug.getStats();
    const p = pristineStats(bug);
    const ref = this.refBug;
    const rs = ref ? ref.getStats() : null;
    const row = (label, cur, max, fmt, hint, key) => {
      // Without a reference: bar = current vs pristine (damage penalty).
      // With the winning vehicle as reference: its value is the white tick.
      const refVal = rs ? rs[key] : null;
      const scale = Math.max(max, refVal ?? 0) || 1;
      const ratio = cur / scale;
      let cls = ratio < 0.99 * (max / scale) ? 'penalty' : '';
      if (refVal != null) cls = cur > refVal * 1.01 ? 'better' : cur < refVal * 0.99 ? 'worse' : '';
      return el('tr', { title: refVal != null ? `${hint} — ${ref.name}: ${fmt(refVal)}` : hint || '' },
        el('th', {}, label),
        el('td', {}, fmt(cur)),
        el('td', { class: 'stat-bar-cell' }, el('div', { class: `stat-bar ${cls}` },
          el('div', { style: { width: `${Math.round(Math.min(1, ratio) * 100)}%` } }),
          refVal != null ? el('span', { class: 'cmp-mark', style: { left: `${Math.min(100, (refVal / scale) * 100)}%` } }) : null)));
    };
    const kn = (v) => `${(v / 1000).toFixed(1)} kN`;
    return el('div', { class: 'stats-block' },
      el('h3', {}, 'Derived stats'),
      el('table', { class: 'stats' },
        el('tbody', {},
          el('tr', { title: 'm = m_chassis + Σ m_part' }, el('th', {}, 'Mass'), el('td', {}, `${s.mass} kg`),
            el('td', { class: 'muted small' }, rs ? `vs ${rs.mass} kg` : '')),
          row('Drive force', s.fDrive, p.fDrive, kn, 'F_drive = F_base × HP_engine / MaxHP', 'fDrive'),
          row('Grip limit', s.fGrip, p.fGrip, kn, 'F_grip = μ × m × g × HP_tires / MaxHP', 'fGrip'),
          row('Usable force', s.fUsable, p.fUsable, kn, 'F_usable = min(F_drive, F_grip)', 'fUsable'),
          row('Acceleration', s.accel, p.accel, (v) => `${Math.round(v)} px/s²`, 'a = F_usable / m', 'accel'),
          row('Top speed', s.vMax, p.vMax, (v) => `${Math.round(v)} px/s`, 'rpm × tire radius × wear', 'vMax'),
          row('Stamina', s.staminaMax, p.staminaMax, (v) => `${v}`, 'Battery / thermal headroom', 'staminaMax'),
          row('Cooling', s.cooling, p.cooling, (v) => `${v}/s`, 'Idle recovery R_cool', 'cooling'),
        )),
      el('p', { class: 'muted small stats-note' },
        s.fDrive > s.fGrip
          ? 'Traction-limited: better grip = more push.'
          : 'Power-limited: a stronger motor = more push.'),
    );
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
      if (this.canvas.offsetParent !== null) this.drawHoist(); // skip while the Hangar is hidden
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

  // ───────────── Region modal ─────────────
  openRegion(key, refresh = false) {
    const region = HOIST_REGIONS[key];
    const bug = this.bug;
    if (!region || !bug) return;
    if (refresh && !document.querySelector('#modal-root.open')) {
      this.openRegionKey = null;
      return;
    }
    this.openRegionKey = key;
    const locked = this.state.isLocked(bug);
    const body = el('div', { class: 'region-modal' },
      el('p', { class: 'muted' }, region.blurb, locked ? ' — tournament lock: repairs only.' : ''),
      region.types.map((type) => this.renderSlot(bug, type, locked)));
    openModal(`${region.label} · ${bug.name}`, body, { onClose: () => { this.openRegionKey = null; } });
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
      onclick: () => this.act(() => this.economy.repairPart(part), (hp) => `Repaired ${Math.round(hp)} HP on ${part.name}`),
    }, affordable ? `Repair ${formatMoney(cost)}` : `Patch (${formatMoney(this.state.money)})`);
  }

  renderSlot(bug, type, locked) {
    const inv = this.state.inventory.filter((p) => p.type === type);
    const section = el('section', { class: 'slot-section' }, el('h3', {}, type === 'armor' ? 'Armour' : type[0].toUpperCase() + type.slice(1)));

    if (type === 'chassis') {
      section.append(partCard(bug.chassis, this.economy, {
        ...this.refCompare(bug.chassis),
        actions: [this.repairButton(bug.chassis)].filter(Boolean),
        extra: el('p', { class: 'muted small' }, 'The frame IS the vehicle. Hull at 0 HP = catastrophic damage.'),
      }));
      return section;
    }

    const equipped = type === 'weapon' ? bug.weapons : [bug[type]].filter(Boolean);
    if (!equipped.length) section.append(el('div', { class: 'empty-slot' }, type === 'weapon' && bug.weaponSlots === 0 ? 'No hardpoints on this frame' : 'Empty slot'));
    for (const part of equipped) {
      section.append(partCard(part, this.economy, {
        ...this.refCompare(part),
        actions: [
          this.repairButton(part),
          el('button', {
            class: 'btn btn-small',
            disabled: locked,
            onclick: () => this.act(() => this.economy.unequipToInventory(bug, part.uid), `${part.name} moved to inventory`),
          }, 'Remove'),
        ].filter(Boolean),
      }));
    }

    if (type === 'weapon') {
      section.append(el('p', { class: 'muted small' }, `${bug.weapons.length}/${bug.weaponSlots} hardpoints used. Weapons add mass and cost stamina per activation.`));
    }

    if (inv.length) {
      const list = el('div', { class: 'replace-list' }, el('h4', {}, type === 'weapon' ? 'Mount from inventory' : 'Replace from inventory'));
      for (const part of inv) {
        const actions = [];
        if (type === 'weapon') {
          if (bug.weapons.length < bug.weaponSlots) {
            actions.push(el('button', { class: 'btn btn-small btn-primary', disabled: locked, onclick: () => this.act(() => this.economy.equipFromInventory(bug, part.uid), `Mounted ${part.name}`) }, 'Mount'));
          }
          bug.weapons.forEach((w, i) => actions.push(el('button', {
            class: 'btn btn-small', disabled: locked,
            onclick: () => this.act(() => this.economy.equipFromInventory(bug, part.uid, i), `Swapped in ${part.name}`),
          }, `Swap slot ${i + 1}`)));
        } else {
          actions.push(el('button', { class: 'btn btn-small btn-primary', disabled: locked, onclick: () => this.act(() => this.economy.equipFromInventory(bug, part.uid), `Fitted ${part.name}`) }, 'Fit'));
        }
        list.append(partCard(part, this.economy, { actions, compareTo: counterpart(bug, part) }));
      }
      section.append(list);
    } else {
      section.append(el('p', { class: 'muted small' }, 'No spare parts of this type — visit the Marketplace or strip a captured vehicle.'));
    }
    return section;
  }
}
