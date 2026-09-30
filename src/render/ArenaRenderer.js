import { ARENA } from '../config/constants.js';

/**
 * Draws the void backdrop, the circular dohyo (with its shrinking, flashing
 * perimeter) and floor hazards such as slick puddles. All procedural.
 */
export class ArenaRenderer {
  constructor() {
    this.stars = Array.from({ length: 160 }, () => ({
      x: (Math.random() - 0.5) * 2600,
      y: (Math.random() - 0.5) * 1800,
      s: Math.random() < 0.15 ? 3 : 2,
      tw: Math.random() * Math.PI * 2,
      hue: [220, 280, 40, 190][Math.floor(Math.random() * 4)],
    }));
    this.floor = this.buildFloorTexture();
  }

  /** Pre-render the full-size dohyo surface once (world units). */
  buildFloorTexture() {
    const R = ARENA.R0;
    const size = R * 2;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');

    g.fillStyle = '#2a2238';
    g.fillRect(0, 0, size, size);

    // Pixel noise
    for (let i = 0; i < 9000; i++) {
      const x = Math.floor(Math.random() * size / 4) * 4;
      const y = Math.floor(Math.random() * size / 4) * 4;
      const v = Math.random();
      g.fillStyle = v < 0.5 ? '#251e32' : v < 0.85 ? '#30283f' : '#3a3050';
      g.fillRect(x, y, 4, 4);
    }

    // Plate seams: concentric rings + radial spokes
    g.strokeStyle = '#1c1628';
    g.lineWidth = 4;
    for (let r = 80; r < R; r += 80) {
      g.beginPath();
      g.arc(R, R, r, 0, Math.PI * 2);
      g.stroke();
    }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.beginPath();
      g.moveTo(R + Math.cos(a) * 80, R + Math.sin(a) * 80);
      g.lineTo(R + Math.cos(a) * R, R + Math.sin(a) * R);
      g.stroke();
    }
    // Rivets
    g.fillStyle = '#4a3f60';
    for (let r = 80; r < R; r += 80) {
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2 + r;
        g.fillRect(Math.round(R + Math.cos(a) * r) - 3, Math.round(R + Math.sin(a) * r) - 3, 6, 6);
      }
    }
    // Shikiri-sen starting lines
    g.fillStyle = '#d9cfb0';
    g.fillRect(R - 60, R - 40, 10, 80);
    g.fillRect(R + 50, R - 40, 10, 80);
    // Centre emblem
    g.strokeStyle = '#3d3354';
    g.lineWidth = 6;
    g.beginPath();
    g.arc(R, R, 34, 0, Math.PI * 2);
    g.stroke();
    return c;
  }

  drawBackground(ctx, time) {
    ctx.fillStyle = '#07060d';
    ctx.fillRect(-2000, -2000, 4000, 4000);
    for (const st of this.stars) {
      const tw = 0.5 + 0.5 * Math.sin(time * 1.5 + st.tw);
      ctx.fillStyle = `hsla(${st.hue} 70% ${70 + tw * 25}% / ${0.35 + tw * 0.6})`;
      ctx.fillRect(st.x, st.y, st.s, st.s);
    }
    // Faint ghost of the original ring (void edge)
    ctx.strokeStyle = 'rgba(90, 70, 130, 0.25)';
    ctx.lineWidth = 3;
    ctx.setLineDash([12, 12]);
    ctx.beginPath();
    ctx.arc(0, 0, ARENA.R0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /**
   * Draw the current dohyo: the classic shrinking circle, the donut with its
   * growing hole, the tilted oval (thinner and steeper over time, with the
   * downhill side marked), or the turntable (its floor turning).
   * @param {import('../systems/Dohyo.js').Dohyo} dohyo
   */
  drawRing(ctx, dohyo, time) {
    const R = dohyo.radius(time);
    if (R <= 0.5) return;
    const R0 = ARENA.R0;
    const changing = dohyo.changing(time);
    const flashOn = changing && Math.floor(time * ARENA.FLASH_HZ * 2) % 2 === 0;
    const sq = dohyo.squash(time);
    const hole = dohyo.hole(time);

    // Shape helpers: the outer edge is an ellipse (a circle unless tilted).
    const outer = (r, dx = 0, dy = 0) => { ctx.ellipse(dx, dy, r, r * sq, 0, 0, Math.PI * 2); };

    // Shadow and side wall. On a tilted ring the wall shows on the low side.
    const low = dohyo.tilted ? (dohyo.kind === 3 ? 1 : -1) : 1;
    const wall = dohyo.tilted ? 8 + dohyo.slope(time) * 40 : 8;
    ctx.fillStyle = '#000000';
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    outer(R + 6, 8, 14 * low);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#16111f';
    ctx.beginPath();
    outer(R + 2, 0, wall * low);
    ctx.fill();

    // Floor (clipped to the ring, minus the donut hole; the turntable's floor turns).
    ctx.save();
    ctx.beginPath();
    outer(R);
    if (hole > 0) ctx.arc(0, 0, hole, 0, Math.PI * 2, true);
    ctx.clip('evenodd');
    ctx.save();
    if (dohyo.kind === 5) ctx.rotate(dohyo.angle);
    if (dohyo.tilted) ctx.scale(1, sq);
    ctx.drawImage(this.floor, -R0, -R0, R0 * 2, R0 * 2);
    ctx.restore();
    if (dohyo.tilted) {
      // Shade uphill lighter, downhill darker, with chevrons pointing down the slope.
      const g = ctx.createLinearGradient(0, -R * sq * low, 0, R * sq * low);
      g.addColorStop(0, 'rgba(255,255,255,0.06)');
      g.addColorStop(1, `rgba(0,0,0,${0.15 + dohyo.slope(time) * 0.5})`);
      ctx.fillStyle = g;
      ctx.fillRect(-R, -R, R * 2, R * 2);
      ctx.strokeStyle = 'rgba(255, 210, 120, 0.25)';
      ctx.lineWidth = 6;
      for (const x of [-R * 0.55, 0, R * 0.55]) {
        for (const y of [-R * sq * 0.45, R * sq * 0.1]) {
          ctx.beginPath();
          ctx.moveTo(x - 18, y - 10 * low);
          ctx.lineTo(x, y + 8 * low);
          ctx.lineTo(x + 18, y - 10 * low);
          ctx.stroke();
        }
      }
    }
    if (dohyo.kind === 5) {
      // Spokes that visibly sweep round.
      ctx.strokeStyle = 'rgba(205, 187, 138, 0.18)';
      ctx.lineWidth = 8;
      for (let i = 0; i < 4; i++) {
        const a = dohyo.angle + (i * Math.PI) / 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 40, Math.sin(a) * 40);
        ctx.lineTo(Math.cos(a) * (R - 20), Math.sin(a) * (R - 20));
        ctx.stroke();
      }
    }
    ctx.restore();

    // Tawara (rope ring) at the edge — and round the donut hole.
    const rope = (draw) => {
      ctx.lineWidth = 10;
      ctx.strokeStyle = flashOn ? '#ff3b3b' : changing ? '#7a2230' : '#cdbb8a';
      ctx.beginPath(); draw(); ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = flashOn ? '#ffd0d0' : '#8a7a58';
      ctx.setLineDash([6, 8]);
      ctx.beginPath(); draw(); ctx.stroke();
      ctx.setLineDash([]);
    };
    rope(() => outer(R - 5));
    if (hole > 0) {
      // The hole drops away into the void.
      ctx.fillStyle = '#07060d';
      ctx.beginPath();
      ctx.arc(0, 0, hole, 0, Math.PI * 2);
      ctx.fill();
      rope(() => ctx.arc(0, 0, hole + 5, 0, Math.PI * 2));
    }

    if (changing) {
      // Red hazard glow just inside whichever edge is closing in.
      ctx.strokeStyle = `rgba(255, 60, 60, ${flashOn ? 0.35 : 0.12})`;
      ctx.lineWidth = 26;
      ctx.beginPath();
      if (dohyo.kind === 2) ctx.arc(0, 0, hole + 22, 0, Math.PI * 2);
      else outer(Math.max(0, R - 22));
      ctx.stroke();
    }
  }

  drawPuddles(ctx, puddles, time) {
    for (const p of puddles) {
      const fade = Math.min(1, p.time / 1.2);
      const grow = Math.min(1, (p.maxTime - p.time) / 0.25);
      const r = p.radius * grow;
      ctx.globalAlpha = 0.85 * fade;
      ctx.fillStyle = '#0d0b10';
      ctx.beginPath();
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const wob = 1 + 0.12 * Math.sin(a * 3 + p.seed) + 0.06 * Math.sin(a * 5 + p.seed * 2);
        const x = Math.cos(a) * r * wob + p.pos.x;
        const y = Math.sin(a) * r * wob + p.pos.y;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.fill();
      // Oil-sheen highlights
      ctx.globalAlpha = 0.5 * fade;
      ctx.fillStyle = `hsl(${(time * 60 + p.seed) % 360} 80% 60%)`;
      ctx.fillRect(p.pos.x - r * 0.3, p.pos.y - r * 0.25, r * 0.35, 3);
      ctx.fillStyle = `hsl(${(time * 60 + p.seed + 120) % 360} 80% 60%)`;
      ctx.fillRect(p.pos.x + r * 0.05, p.pos.y + r * 0.2, r * 0.3, 3);
      ctx.globalAlpha = 1;
    }
  }
}
