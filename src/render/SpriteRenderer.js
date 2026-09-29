import { PHYSICS } from '../config/constants.js';
import { Vector2D } from '../physics/Vector2D.js';

const OUTLINE = '#0b0910';

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Tiny deterministic PRNG so each bug's scratches/patches stay put. */
function seeded(seed) {
  let s = seed || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

const ENGINE_GLOW = {
  rust_motor: '#ff8a3d',
  torque_block: '#ffb03d',
  spinner_x: '#ffe14a',
  fusion_core: '#7dfcff',
  plasma_twin: '#c77dff',
};

const TIRE_STYLE = {
  bald_rollers: { kind: 'wheels', body: '#4a4552', stripe: '#5d5866', gap: 0 },
  knobby_treads: { kind: 'wheels', body: '#1d1a22', stripe: '#3a3542', gap: 5 },
  racing_slicks: { kind: 'wheels', body: '#141218', stripe: '#c83a3a', gap: 0, big: true },
  crawler_tracks: { kind: 'track', body: '#23202a', stripe: '#55505e', gap: 5 },
  gecko_pads: { kind: 'track', body: '#1f3a22', stripe: '#6bff7a', gap: 7 },
};

/**
 * Procedural sprite renderer for bugs, weapons and particle effects.
 * Every bug faces +x in local space.
 */
export class SpriteRenderer {
  constructor() {
    this.particles = [];
    this.floats = [];
  }

  // ───────────── Bugs ─────────────
  palette(bug) {
    const h = bug.hue;
    return {
      base: `hsl(${h} 48% 42%)`,
      light: `hsl(${h} 60% 60%)`,
      dark: `hsl(${h} 45% 24%)`,
      accent: `hsl(${(h + 180) % 360} 70% 60%)`,
    };
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('../entities/BattleBug.js').BattleBug} bug
   * @param {{x?:number,y?:number,angle?:number,scale?:number,time?:number,shadow?:boolean,highlight?:string|null}} o
   */
  drawBug(ctx, bug, o = {}) {
    const x = o.x ?? bug.pos.x;
    const y = o.y ?? bug.pos.y;
    const angle = o.angle ?? bug.angle;
    // Drawn at design radius; world bugs are scaled up by BUG_SCALE.
    let scale = o.scale ?? PHYSICS.BUG_SCALE;
    const time = o.time ?? performance.now() / 1000;
    const r = bug.designRadius;
    const pal = this.palette(bug);
    const fx = bug.effects || {};

    // Falling into the void / wreck state
    let alpha = 1;
    if (bug.out && bug.outReason === 'ringout') {
      const f = Math.min(1, bug.fall / 0.9);
      scale *= 1 - f * 0.85;
      alpha = 1 - f * 0.9;
      if (f >= 1) return;
    }
    const lifted = fx.lifted > 0;
    if (lifted) scale *= 1.1;

    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = alpha;

    if (o.shadow !== false) {
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      const off = lifted ? 12 : 4;
      ctx.ellipse(off * 0.6, off, r * scale * 1.05, r * scale * 0.95, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.rotate(angle + (lifted ? Math.sin(time * 20) * 0.05 : 0));
    ctx.scale(scale, scale);

    this.drawTires(ctx, bug, r, time);
    this.drawEngine(ctx, bug, r, time);
    this.drawHull(ctx, bug, r, pal, time);
    this.drawArmor(ctx, bug, r);
    this.drawDamage(ctx, bug, r);
    if (bug.control?.reverse && bug.throttle > 0) this.drawReverseLights(ctx, r, time);
    this.drawWeapons(ctx, bug, r, time);
    this.drawEyes(ctx, bug, r, time);

    if (fx.flash > 0) {
      ctx.globalAlpha = alpha * Math.min(1, fx.flash / 0.12) * 0.7;
      ctx.fillStyle = '#ffffff';
      this.hullPath(ctx, bug.chassis.stats.shape, r);
      ctx.fill();
      ctx.globalAlpha = alpha;
    }
    if (bug.stalled) {
      ctx.globalAlpha = alpha * (0.35 + 0.15 * Math.sin(time * 8));
      ctx.fillStyle = '#4a6cff';
      this.hullPath(ctx, bug.chassis.stats.shape, r);
      ctx.fill();
      ctx.globalAlpha = alpha;
    }
    if (fx.exposed > 0) {
      ctx.strokeStyle = `rgba(255,80,80,${0.5 + 0.5 * Math.sin(time * 25)})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(-r * 0.7, -r * 1.02, r * 1.4, 4);
      ctx.strokeRect(-r * 0.7, r * 0.98, r * 1.4, 4);
    }
    if (bug.out && bug.outReason !== 'ringout') {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = '#111';
      this.hullPath(ctx, bug.chassis.stats.shape, r);
      ctx.fill();
    }
    if (o.highlight) this.drawHighlight(ctx, bug, r, o.highlight, time);
    ctx.restore();
  }

  drawTires(ctx, bug, r, time) {
    const tires = bug.tires;
    ctx.fillStyle = OUTLINE;
    if (!tires) {
      // Bare axles
      ctx.fillRect(-r * 0.5, -r * 0.9, 4, r * 1.8);
      ctx.fillRect(r * 0.3, -r * 0.9, 4, r * 1.8);
      return;
    }
    const style = (typeof tires.def.look === 'object' ? tires.def.look : null) || TIRE_STYLE[tires.key] || TIRE_STYLE.bald_rollers;
    const broken = tires.isBroken;
    const phase = (bug.odometer || 0) % 8;
    const w = r * 0.34;
    const drawStrip = (x0, len, yTop) => {
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(x0 - 2, yTop - 2, len + 4, w + 4);
      ctx.fillStyle = broken ? '#6a6070' : style.body;
      ctx.fillRect(x0, yTop, len, w);
      if (style.gap && !broken) {
        ctx.fillStyle = style.stripe;
        for (let sx = x0 - 8 + phase; sx < x0 + len; sx += 8) {
          if (sx >= x0) ctx.fillRect(sx, yTop, 3, w);
        }
      } else if (!broken) {
        ctx.fillStyle = style.stripe;
        ctx.fillRect(x0 + 2, yTop + w / 2 - 1, len - 4, 2);
      } else {
        ctx.fillStyle = '#2a2530';
        ctx.fillRect(x0 + len * 0.3, yTop, 4, w);
        ctx.fillRect(x0 + len * 0.7, yTop, 3, w);
      }
    };
    for (const sgn of [-1, 1]) {
      const yTop = sgn < 0 ? -r * 0.98 : r * 0.64;
      if (style.kind === 'track') {
        drawStrip(-r * 0.85, r * 1.7, yTop);
      } else {
        const len = style.big ? r * 0.72 : r * 0.55;
        drawStrip(-r * 0.78, len, yTop);
        drawStrip(r * 0.78 - len, len, yTop);
      }
    }
  }

  /** White reversing lamps on the tail while driving backwards. */
  drawReverseLights(ctx, r, time) {
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(-r * 0.92 - 1, -r * 0.52 - 1, 6, 6);
    ctx.fillRect(-r * 0.92 - 1, r * 0.52 - 5, 6, 6);
    ctx.fillStyle = Math.sin(time * 12) > -0.6 ? '#ffffff' : '#c8c8c8';
    ctx.fillRect(-r * 0.92, -r * 0.52, 4, 4);
    ctx.fillRect(-r * 0.92, r * 0.52 - 4, 4, 4);
  }

  drawEngine(ctx, bug, r, time) {
    const e = bug.engine;
    const x = -r * 0.98;
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(x - 2, -r * 0.32, r * 0.34, r * 0.64);
    if (!e) return;
    ctx.fillStyle = '#3a3542';
    ctx.fillRect(x, -r * 0.28, r * 0.3, r * 0.56);
    if (e.isBroken) return;
    const glow = e.def.glow || ENGINE_GLOW[e.key] || '#ff8a3d';
    const flick = 0.55 + 0.45 * (bug.throttle || 0) * (0.7 + 0.3 * Math.sin(time * 40));
    ctx.globalAlpha *= flick;
    ctx.fillStyle = glow;
    ctx.fillRect(x + 1, -r * 0.2, r * 0.16, r * 0.14);
    ctx.fillRect(x + 1, r * 0.06, r * 0.16, r * 0.14);
    ctx.globalAlpha /= flick;
  }

  hullPath(ctx, shape, r) {
    ctx.beginPath();
    switch (shape) {
      case 'beetle':
        ctx.ellipse(-r * 0.05, 0, r * 0.88, r * 0.7, 0, 0, Math.PI * 2);
        break;
      case 'roach':
        ctx.ellipse(0, 0, r * 0.98, r * 0.56, 0, 0, Math.PI * 2);
        break;
      case 'mantis':
        ctx.ellipse(-r * 0.35, 0, r * 0.55, r * 0.5, 0, 0, Math.PI * 2);
        ctx.moveTo(r * 0.55, 0);
        ctx.ellipse(r * 0.25, 0, r * 0.32, r * 0.36, 0, 0, Math.PI * 2);
        break;
      case 'scarab': {
        const pts = [[0.9, -0.35], [0.9, 0.35], [0.45, 0.72], [-0.7, 0.72], [-0.95, 0.3], [-0.95, -0.3], [-0.7, -0.72], [0.45, -0.72]];
        pts.forEach(([px, py], i) => (i ? ctx.lineTo(px * r, py * r) : ctx.moveTo(px * r, py * r)));
        ctx.closePath();
        break;
      }
      case 'hornet':
        ctx.ellipse(-r * 0.3, 0, r * 0.62, r * 0.5, 0, 0, Math.PI * 2);
        ctx.moveTo(r * 0.72, 0);
        ctx.ellipse(r * 0.42, 0, r * 0.32, r * 0.42, 0, 0, Math.PI * 2);
        break;
      case 'aphid':
        // Plump pear-shaped body with a small head.
        ctx.ellipse(-r * 0.15, 0, r * 0.78, r * 0.64, 0, 0, Math.PI * 2);
        ctx.moveTo(r * 0.9, 0);
        ctx.ellipse(r * 0.62, 0, r * 0.28, r * 0.3, 0, 0, Math.PI * 2);
        break;
      case 'ant':
        // Big gaster, thorax, head.
        ctx.ellipse(-r * 0.42, 0, r * 0.52, r * 0.6, 0, 0, Math.PI * 2);
        ctx.moveTo(r * 0.5, 0);
        ctx.ellipse(r * 0.24, 0, r * 0.26, r * 0.3, 0, 0, Math.PI * 2);
        ctx.moveTo(r * 0.98, 0);
        ctx.ellipse(r * 0.72, 0, r * 0.26, r * 0.28, 0, 0, Math.PI * 2);
        break;
      case 'daddy':
        // A round little body — no legs.
        ctx.arc(0, 0, r * 0.72, 0, Math.PI * 2);
        break;
      case 'scrapper':
      default: {
        const pts = [[0.82, -0.45], [0.82, 0.45], [0.5, 0.62], [-0.78, 0.62], [-0.9, 0.4], [-0.9, -0.4], [-0.78, -0.62], [0.5, -0.62]];
        pts.forEach(([px, py], i) => (i ? ctx.lineTo(px * r, py * r) : ctx.moveTo(px * r, py * r)));
        ctx.closePath();
      }
    }
  }

  drawHull(ctx, bug, r, pal) {
    const shape = bug.chassis.stats.shape;
    const broken = bug.chassis.isBroken;
    this.hullPath(ctx, shape, r);
    ctx.fillStyle = broken ? '#2c2830' : pal.base;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();

    ctx.save();
    this.hullPath(ctx, shape, r);
    ctx.clip();
    // Top-light band
    ctx.fillStyle = broken ? '#3a3540' : pal.light;
    ctx.globalAlpha *= 0.55;
    ctx.fillRect(-r, -r, r * 2, r * 0.35);
    ctx.globalAlpha /= 0.55;
    ctx.fillStyle = pal.dark;

    switch (shape) {
      case 'beetle':
        ctx.fillRect(-r, -1.5, r * 1.6, 3); // elytra split
        ctx.fillStyle = pal.accent;
        ctx.fillRect(-r * 0.45, -r * 0.42, 6, 6);
        ctx.fillRect(-r * 0.45, r * 0.3, 6, 6);
        ctx.fillRect(r * 0.05, -r * 0.3, 5, 5);
        ctx.fillRect(r * 0.05, r * 0.22, 5, 5);
        break;
      case 'roach':
        for (let i = -2; i <= 1; i++) ctx.fillRect(i * r * 0.3, -r * 0.5, 2, r);
        break;
      case 'mantis':
        ctx.fillRect(-r * 0.7, -r * 0.4, 2, r * 0.8);
        ctx.fillRect(-r * 0.4, -r * 0.45, 2, r * 0.9);
        ctx.fillRect(-r * 0.1, -r * 0.4, 2, r * 0.8);
        break;
      case 'scarab':
        ctx.fillRect(-r * 0.6, -r * 0.72, 3, r * 1.44);
        ctx.fillRect(r * 0.1, -r * 0.72, 3, r * 1.44);
        ctx.fillStyle = pal.accent;
        ctx.fillRect(-r * 0.3, -4, r * 0.3, 8);
        break;
      case 'hornet':
        ctx.fillStyle = '#16131b';
        for (let i = 0; i < 3; i++) ctx.fillRect(-r * 0.8 + i * r * 0.28, -r * 0.5, r * 0.12, r);
        break;
      case 'aphid':
        // Soft body segments, scrap rivets and a patch.
        for (let i = 0; i < 3; i++) ctx.fillRect(-r * 0.7 + i * r * 0.32, -r * 0.55, 2, r * 1.1);
        for (const [px, py] of [[-0.55, -0.4], [-0.55, 0.4], [0.2, -0.38], [0.2, 0.38]]) ctx.fillRect(px * r - 2, py * r - 2, 4, 4);
        ctx.fillStyle = '#7a6a5a';
        ctx.fillRect(-r * 0.4, -r * 0.18, r * 0.36, r * 0.28);
        break;
      case 'ant':
        // Gaster stripes and a pinched waist.
        for (let i = 0; i < 3; i++) ctx.fillRect(-r * 0.75 + i * r * 0.24, -r * 0.5, 3, r);
        ctx.fillRect(r * 0.06, -r * 0.3, 3, r * 0.6);
        ctx.fillStyle = pal.accent;
        ctx.fillRect(r * 0.62, -r * 0.1, 5, 5);
        break;
      case 'daddy':
        // Dark saddle and a row of stitches.
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.38, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = pal.light;
        for (let i = -2; i <= 2; i++) ctx.fillRect(i * r * 0.14 - 1, -r * 0.62, 2, 6);
        break;
      default: {
        // Scrapper rivets & a patch
        ctx.fillStyle = pal.dark;
        for (const [px, py] of [[-0.6, -0.45], [-0.6, 0.45], [0.35, -0.45], [0.35, 0.45]]) ctx.fillRect(px * r - 2, py * r - 2, 4, 4);
        ctx.fillStyle = '#7a6a5a';
        ctx.fillRect(-r * 0.35, -r * 0.2, r * 0.4, r * 0.3);
      }
    }
    ctx.restore();

    // Appendages
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2;
    if (shape === 'roach' || shape === 'hornet') {
      ctx.beginPath();
      ctx.moveTo(r * 0.8, -r * 0.15); ctx.lineTo(r * 1.25, -r * 0.55);
      ctx.moveTo(r * 0.8, r * 0.15); ctx.lineTo(r * 1.25, r * 0.55);
      ctx.stroke();
    }
    if (shape === 'hornet') {
      ctx.fillStyle = OUTLINE;
      ctx.beginPath();
      ctx.moveTo(-r * 0.9, -3); ctx.lineTo(-r * 1.15, 0); ctx.lineTo(-r * 0.9, 3);
      ctx.fill();
    }
    if (shape === 'ant') {
      // Elbowed antennae
      ctx.beginPath();
      ctx.moveTo(r * 0.9, -r * 0.12); ctx.lineTo(r * 1.12, -r * 0.35); ctx.lineTo(r * 1.3, -r * 0.2);
      ctx.moveTo(r * 0.9, r * 0.12); ctx.lineTo(r * 1.12, r * 0.35); ctx.lineTo(r * 1.3, r * 0.2);
      ctx.stroke();
    }
    if (shape === 'aphid') {
      // Cornicles — the two little tail-pipes aphids have — and short antennae
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(-r * 1.0, -r * 0.38, r * 0.2, 5);
      ctx.fillRect(-r * 1.0, r * 0.38 - 5, r * 0.2, 5);
      ctx.beginPath();
      ctx.moveTo(r * 0.8, -r * 0.1); ctx.lineTo(r * 1.1, -r * 0.3);
      ctx.moveTo(r * 0.8, r * 0.1); ctx.lineTo(r * 1.1, r * 0.3);
      ctx.stroke();
    }
    if (shape === 'daddy') {
      // Eight sad little leg stumps
      ctx.fillStyle = OUTLINE;
      for (let i = 0; i < 8; i++) {
        ctx.save();
        ctx.rotate((i / 8) * Math.PI * 2 + Math.PI / 8);
        ctx.fillRect(r * 0.7, -2, r * 0.14, 4);
        ctx.restore();
      }
    }
    if (shape === 'mantis') {
      ctx.lineWidth = 3;
      ctx.strokeStyle = pal.dark;
      ctx.beginPath();
      ctx.moveTo(r * 0.2, -r * 0.3); ctx.lineTo(r * 0.75, -r * 0.62); ctx.lineTo(r * 1.0, -r * 0.4);
      ctx.moveTo(r * 0.2, r * 0.3); ctx.lineTo(r * 0.75, r * 0.62); ctx.lineTo(r * 1.0, r * 0.4);
      ctx.stroke();
    }
  }

  drawArmor(ctx, bug, r) {
    const a = bug.armor;
    if (!a || a.isBroken) return;
    const shape = bug.chassis.stats.shape;
    const rng = seeded(hashString(a.uid));
    ctx.save();
    this.hullPath(ctx, shape, r);
    ctx.clip();
    ctx.globalAlpha *= 0.35 + 0.65 * a.hpRatio;
    switch (a.def.look || a.key) {
      case 'scrap_plating':
        for (let i = 0; i < 4; i++) {
          ctx.fillStyle = ['#8a7a66', '#6d7580', '#90705a'][i % 3];
          const px = (rng() - 0.6) * r * 1.4;
          const py = (rng() - 0.5) * r;
          ctx.fillRect(px, py, r * 0.3, r * 0.22);
          ctx.fillStyle = OUTLINE;
          ctx.fillRect(px + 1, py + 1, 2, 2);
        }
        break;
      case 'steel_plate':
        ctx.fillStyle = '#9aa3ad';
        ctx.fillRect(-r, -r * 0.62, r * 1.7, r * 0.18);
        ctx.fillRect(-r, r * 0.44, r * 1.7, r * 0.18);
        ctx.fillStyle = '#5d6570';
        ctx.fillRect(-r, -r * 0.46, r * 1.7, 2);
        ctx.fillRect(-r, r * 0.44, r * 1.7, 2);
        break;
      case 'titan_weave':
        ctx.strokeStyle = '#c8d3e0';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = -r * 2; i < r * 2; i += 7) {
          ctx.moveTo(i, -r); ctx.lineTo(i + r * 2, r);
          ctx.moveTo(i, r); ctx.lineTo(i + r * 2, -r);
        }
        ctx.globalAlpha *= 0.45;
        ctx.stroke();
        break;
      case 'ablative_shell':
        ctx.strokeStyle = '#e0b070';
        ctx.lineWidth = 3;
        for (let i = 1; i <= 3; i++) {
          ctx.beginPath();
          ctx.arc(-r * 0.2, 0, r * 0.25 * i, -Math.PI / 2, Math.PI / 2);
          ctx.stroke();
        }
        break;
      default:
        break;
    }
    ctx.restore();
  }

  drawDamage(ctx, bug, r) {
    const hull = bug.chassis.hpRatio;
    if (hull > 0.6) return;
    const rng = seeded(hashString(bug.id));
    const cracks = hull > 0.3 ? 2 : 4;
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < cracks; i++) {
      let px = (rng() - 0.5) * r;
      let py = (rng() - 0.5) * r * 0.8;
      ctx.moveTo(px, py);
      for (let k = 0; k < 3; k++) {
        px += (rng() - 0.5) * r * 0.5;
        py += (rng() - 0.5) * r * 0.4;
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  weaponMount(bug, index, r) {
    const n = bug.weapons.length;
    const y = n > 1 ? (index === 0 ? -r * 0.32 : r * 0.32) : 0;
    const shape = bug.chassis.stats.shape;
    const x = shape === 'roach' ? r * 0.92 : shape === 'mantis' || shape === 'hornet' ? r * 0.62 : r * 0.8;
    return { x, y };
  }

  drawWeapons(ctx, bug, r, time) {
    bug.weapons.forEach((w, i) => {
      const { x, y } = this.weaponMount(bug, i, r);
      const cd = bug.cooldowns?.[w.uid] || 0;
      const since = cd > 0 ? w.stats.cooldown - cd : 99;
      const s = r / 26;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(s, s);
      if (w.isBroken) ctx.rotate(0.35);
      this.drawWeapon(ctx, w, bug, since, time);
      ctx.restore();
    });
  }

  drawWeapon(ctx, w, bug, since, time) {
    const broken = w.isBroken;
    const metal = broken ? '#4a4550' : '#8d93a0';
    const dark = broken ? '#2a2530' : '#4a5060';
    ctx.lineWidth = 2;
    ctx.strokeStyle = OUTLINE;
    switch (w.def.look || w.key) {
      case 'emp_pulse': {
        ctx.fillStyle = dark;
        ctx.fillRect(-4, -3, 8, 6);
        ctx.fillStyle = metal;
        ctx.beginPath();
        ctx.arc(6, 0, 8, -Math.PI / 2, Math.PI / 2);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = broken ? '#333' : `hsl(190 100% ${60 + 20 * Math.sin(time * 6)}%)`;
        ctx.fillRect(6, -2, 4, 4);
        break;
      }
      case 'tesla_coil': {
        ctx.fillStyle = dark;
        ctx.fillRect(-6, -5, 10, 10);
        ctx.fillStyle = '#c87a3a';
        for (let i = 0; i < 3; i++) ctx.fillRect(-5 + i * 3, -5, 2, 10);
        ctx.fillStyle = metal;
        ctx.fillRect(4, -6, 12, 3);
        ctx.fillRect(4, 3, 12, 3);
        if (!broken && Math.sin(time * 30) > 0.4) {
          ctx.strokeStyle = '#9ff4ff';
          ctx.beginPath();
          ctx.moveTo(16, -4); ctx.lineTo(13, 0); ctx.lineTo(16, 4);
          ctx.stroke();
        }
        break;
      }
      case 'pneumatic_ram': {
        const ext = since < 0.25 ? 14 * Math.sin((since / 0.25) * Math.PI) : 0;
        ctx.fillStyle = dark;
        ctx.fillRect(-8, -5, 14, 10);
        ctx.strokeRect(-8, -5, 14, 10);
        ctx.fillStyle = metal;
        ctx.fillRect(6, -2, 4 + ext, 4);
        ctx.fillStyle = broken ? '#555' : '#d04a3a';
        ctx.fillRect(10 + ext, -8, 5, 16);
        ctx.strokeRect(10 + ext, -8, 5, 16);
        break;
      }
      case 'spike_array': {
        const active = bug.effects?.spikes > 0;
        const len = active ? 14 : 7;
        ctx.fillStyle = active ? `hsl(${10 + 20 * Math.sin(time * 20)} 100% 60%)` : metal;
        for (let i = -2; i <= 2; i++) {
          const yy = i * 5;
          ctx.beginPath();
          ctx.moveTo(0, yy - 3); ctx.lineTo(len, yy); ctx.lineTo(0, yy + 3);
          ctx.closePath();
          ctx.fill(); ctx.stroke();
        }
        break;
      }
      case 'wedge_lifter': {
        const up = since < 0.5 ? 1 : 0;
        ctx.fillStyle = up ? '#f0d060' : broken ? '#555' : '#c8a83a';
        ctx.beginPath();
        ctx.moveTo(-2, -14); ctx.lineTo(10 + up * 4, -12); ctx.lineTo(10 + up * 4, 12); ctx.lineTo(-2, 14);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = OUTLINE;
        for (let i = -10; i <= 8; i += 6) ctx.fillRect(2, i, 6, 2);
        break;
      }
      case 'slick_sprayer': {
        ctx.fillStyle = broken ? '#444' : '#2b6b3a';
        ctx.beginPath();
        ctx.arc(-3, 0, 6, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = metal;
        ctx.fillRect(2, -2, 12, 4);
        ctx.strokeRect(2, -2, 12, 4);
        if (since < 0.4) {
          ctx.fillStyle = '#1a1520';
          ctx.fillRect(14, -4, 6, 8);
        }
        break;
      }
      default:
        ctx.fillStyle = metal;
        ctx.fillRect(-4, -4, 8, 8);
    }
  }

  drawEyes(ctx, bug, r, time) {
    const shape = bug.chassis.stats.shape;
    const ex = shape === 'mantis' || shape === 'hornet' ? r * 0.42 : shape === 'roach' ? r * 0.7 : r * 0.55;
    const ys = bug.alien ? [-r * 0.24, 0, r * 0.24] : [-r * 0.2, r * 0.2];
    const blink = Math.sin(time * 1.3 + bug.hue) > 0.97;
    for (const ey of ys) {
      ctx.fillStyle = OUTLINE;
      ctx.fillRect(ex - 4, ey - 4, 8, 8);
      if (bug.stalled || bug.chassis.isBroken) {
        ctx.fillStyle = '#8f86a8';
        ctx.fillRect(ex - 3, ey - 0.5, 6, 1.5);
        continue;
      }
      ctx.fillStyle = bug.alien ? '#b6ff5a' : '#f4e9c9';
      ctx.fillRect(ex - 3, ey - (blink ? 0.5 : 3), 6, blink ? 1.5 : 6);
      if (!blink) {
        ctx.fillStyle = OUTLINE;
        ctx.fillRect(ex, ey - 1, 2.5, 2.5);
      }
    }
  }

  drawHighlight(ctx, bug, r, region, time) {
    const pulse = 0.6 + 0.4 * Math.sin(time * 6);
    ctx.strokeStyle = `rgba(255, 210, 74, ${pulse})`;
    ctx.fillStyle = `rgba(255, 210, 74, ${0.18 * pulse})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    switch (region) {
      case 'front': ctx.rect(r * 0.45, -r * 0.62, r * 0.85, r * 1.24); break;
      case 'center': ctx.rect(-r * 1.02, -r * 0.28, r * 1.22, r * 0.56); break;
      case 'sides':
        ctx.rect(-r * 0.9, -r * 1.05, r * 1.8, r * 0.48);
        ctx.rect(-r * 0.9, r * 0.57, r * 1.8, r * 0.48);
        break;
      case 'hull': this.hullPath(ctx, bug.chassis.stats.shape, r * 1.08); break;
      default: return;
    }
    ctx.fill();
    ctx.stroke();
  }

  /**
   * Hoist hit-test: local bug coordinates (facing +x) → region key.
   */
  static regionAt(localX, localY, r) {
    if (Math.abs(localX) > r * 1.35 || Math.abs(localY) > r * 1.15) return null;
    if (localX > r * 0.45 && Math.abs(localY) < r * 0.62) return 'front';
    if (Math.abs(localY) > r * 0.57) return 'sides';
    if (localX < r * 0.2 && Math.abs(localY) < r * 0.28 && localX > -r * 1.05) return 'center';
    return 'hull';
  }

  /**
   * Procedural alien pilot portrait, deterministic per pilot: head shape,
   * skin, eye count, antennae, mouth and a style-coloured backdrop.
   */
  renderPortrait(pilot, size = 88) {
    const px = 32;
    const c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    c.className = 'pilot-portrait';
    c.style.width = `${size}px`;
    c.style.height = `${size}px`;
    const g = c.getContext('2d');
    const rng = seeded(hashString(pilot.id || pilot.name || 'x'));
    const r = () => rng();
    const hue = Math.floor(r() * 360);
    const skin = `hsl(${hue} 55% 50%)`;
    const skinDark = `hsl(${hue} 50% 32%)`;
    const skinLight = `hsl(${hue} 65% 66%)`;
    const BACKDROPS = { bully: '#4a1f25', zapper: '#1f3a4a', turtle: '#2b3a22', dodger: '#3a2b4a', sumo: '#4a3a1f', hothead: '#5a2410', hapless: '#2a2a33' };
    g.fillStyle = BACKDROPS[pilot.style] || '#221c30';
    g.fillRect(0, 0, px, px);
    g.fillStyle = 'rgba(255,255,255,0.06)';
    for (let y = 0; y < px; y += 4) g.fillRect(0, y, px, 2);

    // Shoulders / suit
    g.fillStyle = `hsl(${(hue + 180) % 360} 30% 30%)`;
    g.fillRect(6, 25, 20, 7);
    g.fillStyle = skinDark;
    g.fillRect(13, 21, 6, 5);

    // Head
    const shape = Math.floor(r() * 4);
    g.fillStyle = skin;
    g.beginPath();
    if (shape === 0) g.ellipse(16, 13, 9, 10, 0, 0, Math.PI * 2); // egg
    else if (shape === 1) g.ellipse(16, 12, 11, 8, 0, 0, Math.PI * 2); // wide blob
    else if (shape === 2) { g.moveTo(16, 1); g.lineTo(27, 20); g.lineTo(5, 20); g.closePath(); } // triangle
    else g.ellipse(16, 11, 7, 11, 0, 0, Math.PI * 2); // tall dome
    g.fill();
    g.fillStyle = skinLight;
    g.fillRect(10, 5, 4, 2);
    g.fillStyle = skinDark;
    g.fillRect(8, 17, 16, 2);

    // Antennae or horns
    const ant = Math.floor(r() * 3);
    g.fillStyle = skinDark;
    if (ant === 1) {
      g.fillRect(10, 0, 1, 5); g.fillRect(21, 0, 1, 5);
      g.fillStyle = `hsl(${(hue + 90) % 360} 90% 60%)`;
      g.fillRect(9, 0, 3, 2); g.fillRect(20, 0, 3, 2);
    } else if (ant === 2) {
      g.fillRect(6, 3, 2, 4); g.fillRect(24, 3, 2, 4);
    }

    // Eyes
    const eyes = 1 + Math.floor(r() * 4);
    const eyeColor = `hsl(${(hue + 120 + Math.floor(r() * 120)) % 360} 90% 65%)`;
    const eyeW = eyes === 1 ? 6 : 3;
    const span = eyes === 1 ? 0 : 14;
    for (let i = 0; i < eyes; i++) {
      const ex = eyes === 1 ? 13 : Math.round(9 + (span / (eyes - 1)) * i);
      const ey = 10 + (eyes === 3 && i === 1 ? -3 : 0);
      g.fillStyle = '#0b0910';
      g.fillRect(ex - 1, ey - 1, eyeW + 2, 5);
      g.fillStyle = eyeColor;
      g.fillRect(ex, ey, eyeW, 3);
      g.fillStyle = '#0b0910';
      g.fillRect(ex + Math.floor(eyeW / 2), ey + 1, 1, 1);
    }

    // Mouth
    const mouth = Math.floor(r() * 4);
    g.fillStyle = '#0b0910';
    if (mouth === 0) g.fillRect(12, 16, 8, 1); // flat
    else if (mouth === 1) { g.fillRect(11, 15, 10, 2); g.fillStyle = '#f4e9c9'; g.fillRect(12, 15, 1, 1); g.fillRect(19, 15, 1, 1); } // fangs
    else if (mouth === 2) { g.fillRect(12, 15, 1, 1); g.fillRect(13, 16, 6, 1); g.fillRect(19, 15, 1, 1); } // grin
    else { g.fillStyle = skinDark; g.fillRect(12, 17, 2, 4); g.fillRect(15, 17, 2, 5); g.fillRect(18, 17, 2, 4); } // tentacles

    // Style accessory
    if (pilot.style === 'zapper') { g.fillStyle = '#9ff4ff'; g.fillRect(4, 8, 1, 1); g.fillRect(27, 12, 1, 1); g.fillRect(3, 14, 1, 1); }
    if (pilot.style === 'hothead') { g.fillStyle = '#ff7a3d'; g.fillRect(25, 4, 2, 2); g.fillRect(27, 2, 1, 1); }
    if (pilot.style === 'sumo') { g.fillStyle = '#1b1726'; g.fillRect(14, 0, 4, 3); }
    if (pilot.style === 'turtle') { g.fillStyle = '#5d7a4a'; g.fillRect(6, 24, 20, 2); }
    if (pilot.style === 'bully') { g.fillStyle = '#8a2a2a'; g.fillRect(19, 7, 5, 1); }
    if (pilot.style === 'dodger') { g.fillStyle = '#c8b6ff'; g.fillRect(7, 9, 18, 1); }
    return c;
  }

  /** Static pixelated portrait for cards (facing up). */
  renderThumbnail(bug, size = 96) {
    const c = document.createElement('canvas');
    const px = Math.round(size / 2);
    c.width = px;
    c.height = px;
    c.className = 'bug-thumb';
    c.style.width = `${size}px`;
    c.style.height = `${size}px`;
    const ctx = c.getContext('2d');
    const scale = (px * 0.36) / bug.designRadius;
    this.drawBug(ctx, bug, { x: px / 2, y: px / 2 + 1, angle: -Math.PI / 2, scale, time: 0, shadow: true });
    return c;
  }

  // ───────────── Particles & floating text ─────────────
  spawn(p) {
    if (this.particles.length > 600) this.particles.shift();
    this.particles.push({ drag: 3, size: 3, gravity: 0, ...p, max: p.life });
  }

  sparks(pos, n = 8, color = '#ffd24a', speed = 220) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random() * 0.7);
      this.spawn({ type: 'spark', x: pos.x, y: pos.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.25 + Math.random() * 0.3, color, size: 3 });
    }
  }

  smoke(pos, color = 'rgba(60,55,70,0.8)', n = 1) {
    for (let i = 0; i < n; i++) {
      this.spawn({ type: 'smoke', x: pos.x + (Math.random() - 0.5) * 8, y: pos.y + (Math.random() - 0.5) * 8, vx: (Math.random() - 0.5) * 20, vy: -20 - Math.random() * 20, life: 0.8 + Math.random() * 0.6, color, size: 6, drag: 1 });
    }
  }

  ring(pos, radius, color, life = 0.45) {
    this.spawn({ type: 'ring', x: pos.x, y: pos.y, vx: 0, vy: 0, life, color, radius });
  }

  bolt(from, to, color = '#9ff4ff', life = 0.25) {
    this.spawn({ type: 'bolt', x: from.x, y: from.y, x2: to.x, y2: to.y, vx: 0, vy: 0, life, color, seed: Math.random() * 100 });
  }

  debris(pos, color, n = 6) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 80 + Math.random() * 160;
      this.spawn({ type: 'debris', x: pos.x, y: pos.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.6 + Math.random() * 0.5, color, size: 4, drag: 2.5 });
    }
  }

  spray(from, dir, n = 14) {
    for (let i = 0; i < n; i++) {
      const a = dir.angle() + (Math.random() - 0.5) * 0.6;
      const v = 200 + Math.random() * 200;
      this.spawn({ type: 'spark', x: from.x, y: from.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.35, color: '#221a28', size: 5, drag: 4 });
    }
  }

  float(pos, text, color = '#f4e9c9', size = 10) {
    this.floats.push({ pos: pos.clone(), text, color, size, life: 1.1, rise: 0 });
  }

  /** Smoke from damaged engines, sparks from stalled drives. */
  ambient(bug, dt) {
    if (bug.out && bug.outReason === 'ringout') return;
    const rear = bug.pos.add(Vector2D.fromAngle(bug.angle, -bug.radius * 0.8));
    if (bug.engine && bug.engine.hpRatio < 0.45 && Math.random() < dt * (bug.engine.isBroken ? 14 : 6)) {
      this.smoke(rear, bug.engine.isBroken ? 'rgba(25,22,30,0.85)' : 'rgba(80,75,90,0.7)');
    }
    if (bug.stalled && Math.random() < dt * 10) {
      this.sparks(bug.pos, 1, '#7a9cff', 60);
    }
    if (bug.chassis.isBroken && Math.random() < dt * 8) this.smoke(bug.pos, 'rgba(30,25,35,0.9)');
  }

  update(dt) {
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = Math.max(0, 1 - p.drag * dt);
      p.vx *= k;
      p.vy *= k;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const f of this.floats) {
      f.life -= dt;
      f.rise += dt * 30;
    }
    this.floats = this.floats.filter((f) => f.life > 0);
  }

  draw(ctx) {
    for (const p of this.particles) {
      const t = p.life / p.max;
      ctx.globalAlpha = Math.min(1, t * 1.5);
      switch (p.type) {
        case 'ring':
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 4 * t + 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.radius * (1 - t * 0.8), 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'bolt': {
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          const segs = 7;
          for (let i = 1; i < segs; i++) {
            const k = i / segs;
            const jitter = (Math.sin(p.seed + i * 12.9 + p.life * 60) * 14);
            const nx = -(p.y2 - p.y);
            const ny = p.x2 - p.x;
            const nl = Math.hypot(nx, ny) || 1;
            ctx.lineTo(p.x + (p.x2 - p.x) * k + (nx / nl) * jitter, p.y + (p.y2 - p.y) * k + (ny / nl) * jitter);
          }
          ctx.lineTo(p.x2, p.y2);
          ctx.stroke();
          break;
        }
        case 'smoke': {
          const s = p.size * (2 - t);
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
          break;
        }
        default:
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    ctx.globalAlpha = 1;
  }

  clear() {
    this.particles = [];
    this.floats = [];
  }
}
