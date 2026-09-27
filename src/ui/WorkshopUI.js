import { HOIST_REGIONS, WEAPON_CLASSES } from '../config/constants.js';
import { BattleBug } from '../entities/BattleBug.js';
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

export function partCard(part, economy, { actions = [], extra = null } = {}) {
  return el('div', { class: `part-card rarity-${part.rarity}${part.isBroken ? ' broken' : ''}` },
    el('div', { class: 'part-head' },
      el('span', { class: `part-type type-${part.type}` }, part.type),
      el('strong', {}, part.name),
      el('span', { class: 'part-mass' }, `${part.mass} kg`)),
    el('div', { class: 'part-stats' }, partStatLine(part)),
    hpBar(part.hpRatio, { label: part.isBroken ? 'BROKEN' : `${Math.ceil(part.hp)}/${part.maxHp} HP` }),
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
      this.root.replaceChildren(el('div', { class: 'empty' }, 'No vehicle in the hangar.'));
      return;
    }
    const locked = this.state.isLocked(bug);
    this.canvas = el('canvas', { class: 'hoist-canvas', width: 220, height: 190, 'aria-label': 'Vehicle hoist — click a region' });
    this.canvas.addEventListener('pointermove', (e) => this.onHover(e));
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; });
    this.canvas.addEventListener('click', (e) => {
      const region = this.regionFromEvent(e);
      if (region) this.openRegion(region);
    });

    const repairAll = this.economy.repairAllCost(bug);
    const issues = bug.battleIssues();

    this.root.replaceChildren(...[
      el('div', { class: 'panel-title' },
        el('h2', {}, 'The Hoist'),
        locked ? el('span', { class: 'badge badge-lock', title: 'Tournament rules' }, '🔒 TOURNAMENT LOCK') : null),
      el('div', { class: 'hoist-name' },
        el('span', { class: 'bug-swatch', style: { background: `hsl(${bug.hue} 60% 55%)` } }),
        el('div', {}, el('strong', {}, bug.name), el('div', { class: 'muted small' }, bug.chassis.name))),
      el('div', { class: 'hoist-stage' }, this.canvas,
        el('div', { class: 'hoist-hint' }, 'Tap a region of the bug to inspect it')),
      el('div', { class: 'region-buttons' },
        Object.entries(HOIST_REGIONS).map(([key, r]) => el('button', {
          class: 'btn btn-region',
          onclick: () => this.openRegion(key),
          onmouseenter: () => { this.hover = key; },
          onmouseleave: () => { this.hover = null; },
        }, el('span', {}, r.label), el('small', {}, this.regionSummary(key))))),
      issues.length ? el('ul', { class: 'issues' }, issues.map((i) => el('li', {}, `⚠ ${i}`))) : null,
      el('div', { class: 'repair-all' },
        el('button', {
          class: 'btn btn-primary',
          disabled: repairAll === 0 || this.state.money < 1,
          onclick: () => this.act(() => this.economy.repairAll(bug), (hp) => (hp ? `Repaired ${Math.round(hp)} HP` : 'Nothing repaired')),
        }, repairAll ? `Repair all — ${formatMoney(repairAll)}` : 'Fully repaired'),
      ),
      this.renderStats(bug),
    ].filter(Boolean));

    this.startLoop();
    if (this.openRegionKey) this.openRegion(this.openRegionKey, true);
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
    const row = (label, cur, max, fmt, hint) => {
      const ratio = max > 0 ? cur / max : 0;
      return el('tr', { title: hint || '' },
        el('th', {}, label),
        el('td', {}, fmt(cur)),
        el('td', { class: 'stat-bar-cell' }, el('div', { class: `stat-bar ${ratio < 0.99 ? 'penalty' : ''}` },
          el('div', { style: { width: `${Math.round(Math.min(1, ratio) * 100)}%` } }))));
    };
    const kn = (v) => `${(v / 1000).toFixed(1)} kN`;
    return el('div', { class: 'stats-block' },
      el('h3', {}, 'Derived stats'),
      el('table', { class: 'stats' },
        el('tbody', {},
          el('tr', { title: 'm = m_chassis + Σ m_part' }, el('th', {}, 'Mass'), el('td', {}, `${s.mass} kg`), el('td', {})),
          row('Drive force', s.fDrive, p.fDrive, kn, 'F_drive = F_base × HP_engine / MaxHP'),
          row('Grip limit', s.fGrip, p.fGrip, kn, 'F_grip = μ × m × g × HP_tires / MaxHP'),
          row('Usable force', s.fUsable, p.fUsable, kn, 'F_usable = min(F_drive, F_grip)'),
          row('Acceleration', s.accel, p.accel, (v) => `${Math.round(v)} px/s²`, 'a = F_usable / m'),
          row('Top speed', s.vMax, p.vMax, (v) => `${Math.round(v)} px/s`, 'rpm × tire radius × wear'),
          row('Stamina', s.staminaMax, p.staminaMax, (v) => `${v}`, 'Battery / thermal headroom'),
          row('Cooling', s.cooling, p.cooling, (v) => `${v}/s`, 'Idle recovery R_cool'),
        )),
      el('p', { class: 'muted small' },
        s.fDrive > s.fGrip
          ? 'Traction-limited: your motor out-muscles your tires. Better grip = more push.'
          : 'Power-limited: your tires can take more torque than the motor delivers.'),
    );
  }

  // ───────────── Hoist canvas ─────────────
  get hoistGeom() {
    const c = this.canvas;
    const bug = this.bug;
    return { cx: c.width / 2, cy: c.height / 2 + 4, k: 58 / bug.radius };
  }

  regionFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * this.canvas.width;
    const py = ((e.clientY - rect.top) / rect.height) * this.canvas.height;
    const { cx, cy, k } = this.hoistGeom;
    const dx = (px - cx) / k;
    const dy = (py - cy) / k;
    // Bug faces up (angle −π/2): local x = −dy, local y = dx
    return SpriteRenderer.regionAt(-dy, dx, this.bug.radius);
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
      this.drawHoist();
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
        actions: [this.repairButton(bug.chassis)].filter(Boolean),
        extra: el('p', { class: 'muted small' }, 'The frame IS the vehicle. Hull at 0 HP = catastrophic damage.'),
      }));
      return section;
    }

    const equipped = type === 'weapon' ? bug.weapons : [bug[type]].filter(Boolean);
    if (!equipped.length) section.append(el('div', { class: 'empty-slot' }, type === 'weapon' && bug.weaponSlots === 0 ? 'No hardpoints on this frame' : 'Empty slot'));
    for (const part of equipped) {
      section.append(partCard(part, this.economy, {
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
        list.append(partCard(part, this.economy, { actions }));
      }
      section.append(list);
    } else {
      section.append(el('p', { class: 'muted small' }, 'No spare parts of this type — visit the Marketplace or strip a captured vehicle.'));
    }
    return section;
  }
}
