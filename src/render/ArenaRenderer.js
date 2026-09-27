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
   * @param {number} radius current R(t)
   * @param {number} time elapsed fight time
   * @param {boolean} shrinking
   */
  drawRing(ctx, radius, time, shrinking) {
    if (radius <= 0.5) return;
    const R0 = ARENA.R0;

    // Shadow drop beneath the platform
    ctx.fillStyle = '#000000';
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(8, 14, radius + 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Platform side wall
    ctx.fillStyle = '#16111f';
    ctx.beginPath();
    ctx.arc(0, 8, radius + 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(this.floor, -R0, -R0, R0 * 2, R0 * 2);
    ctx.restore();

    // Tawara (rope ring) at the edge
    const flashOn = shrinking && Math.floor(time * ARENA.FLASH_HZ * 2) % 2 === 0;
    ctx.lineWidth = 10;
    ctx.strokeStyle = flashOn ? '#ff3b3b' : shrinking ? '#7a2230' : '#cdbb8a';
    ctx.beginPath();
    ctx.arc(0, 0, radius - 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = flashOn ? '#ffd0d0' : '#8a7a58';
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.arc(0, 0, radius - 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    if (shrinking) {
      // Red hazard glow just inside the edge
      ctx.strokeStyle = `rgba(255, 60, 60, ${flashOn ? 0.35 : 0.12})`;
      ctx.lineWidth = 26;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(0, radius - 22), 0, Math.PI * 2);
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
