import { ARENA, RENDER } from '../config/constants.js';
import { Vector2D } from '../physics/Vector2D.js';

/**
 * Owns the battle canvas. The world is drawn into a low-resolution buffer
 * (PIXEL_SCALE) and blown up with nearest-neighbour filtering for a crisp
 * pixel-art look; HUD text is drawn afterwards at native resolution.
 */
export class CanvasRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.buffer = document.createElement('canvas');
    this.bctx = this.buffer.getContext('2d');
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
    this.worldScale = 1; // buffer px per world px
    this.shake = 0;
    this.shakeOffset = new Vector2D();
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, Math.round(rect.width));
    this.cssH = Math.max(1, Math.round(rect.height));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);

    this.buffer.width = Math.ceil(this.cssW / RENDER.PIXEL_SCALE);
    this.buffer.height = Math.ceil(this.cssH / RENDER.PIXEL_SCALE);

    const usableH = this.cssH - RENDER.HUD_TOP - RENDER.HUD_BOTTOM;
    const fitCss = Math.min(this.cssW, usableH) / (2 * (ARENA.R0 + ARENA.VIEW_MARGIN));
    this.worldScale = fitCss / RENDER.PIXEL_SCALE;
    this.originCss = new Vector2D(this.cssW / 2, RENDER.HUD_TOP + usableH / 2);
  }

  addShake(amount) {
    this.shake = Math.min(12, this.shake + amount);
  }

  /** Begin a world-space frame on the pixel buffer. Returns the buffer context. */
  beginWorld(dt) {
    const b = this.bctx;
    this.shake = Math.max(0, this.shake - dt * 30);
    this.shakeOffset.set((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, this.buffer.width, this.buffer.height);
    const ox = this.originCss.x / RENDER.PIXEL_SCALE + this.shakeOffset.x / RENDER.PIXEL_SCALE;
    const oy = this.originCss.y / RENDER.PIXEL_SCALE + this.shakeOffset.y / RENDER.PIXEL_SCALE;
    b.setTransform(this.worldScale, 0, 0, this.worldScale, ox, oy);
    return b;
  }

  /** Blit the pixel buffer to the screen and switch to CSS-pixel HUD space. */
  present() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#07060d';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(
      this.buffer, 0, 0, this.buffer.width, this.buffer.height,
      0, 0, this.buffer.width * RENDER.PIXEL_SCALE * this.dpr, this.buffer.height * RENDER.PIXEL_SCALE * this.dpr,
    );
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    return ctx;
  }

  /** CSS pixels per world pixel. */
  get cssScale() {
    return this.worldScale * RENDER.PIXEL_SCALE;
  }

  worldToScreen(p) {
    return new Vector2D(this.originCss.x + p.x * this.cssScale, this.originCss.y + p.y * this.cssScale);
  }

  /** Client (event) coordinates → world coordinates. */
  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return new Vector2D((sx - this.originCss.x) / this.cssScale, (sy - this.originCss.y) / this.cssScale);
  }

  clientToCss(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return new Vector2D(clientX - rect.left, clientY - rect.top);
  }

  // ───────────── HUD ─────────────
  /**
   * @param {import('../systems/CombatEngine.js').CombatEngine} engine
   * @param {{menu?:object, floats?:Array}} ui
   */
  drawHUD(engine, ui = {}) {
    const ctx = this.ctx;
    const W = this.cssW;
    ctx.save();
    ctx.textBaseline = 'middle';

    // Clock
    const t = Math.min(engine.time, 120);
    const mm = Math.floor(t / 60);
    const ss = Math.floor(t % 60).toString().padStart(2, '0');
    const warn = engine.shrinking;
    ctx.textAlign = 'center';
    ctx.font = 'bold 22px "Press Start 2P", ui-monospace, monospace';
    ctx.fillStyle = warn && Math.floor(engine.time * 3) % 2 ? '#ff4a4a' : '#f4e9c9';
    ctx.fillText(`${mm}:${ss}`, W / 2, 24);
    ctx.font = '9px "Press Start 2P", ui-monospace, monospace';
    ctx.fillStyle = warn ? '#ff7a7a' : '#8f86a8';
    const phaseText = engine.time < ARENA.STATIC_UNTIL
      ? `RING SHRINKS IN ${Math.ceil(ARENA.STATIC_UNTIL - engine.time)}s`
      : engine.time < ARENA.COLLAPSE_AT ? `DOHYO COLLAPSING · R ${Math.round(engine.arenaRadius)}` : 'COLLAPSED';
    ctx.fillText(phaseText, W / 2, 48);

    const panelW = Math.min(260, (W - 150) / 2);
    this.drawBugPanel(ctx, engine.player, 10, 8, panelW, 'left');
    this.drawBugPanel(ctx, engine.opponent, W - 10 - panelW, 8, panelW, 'right');

    for (const f of ui.floats || []) this.drawFloat(ctx, f);
    if (ui.menu) this.drawRadialMenu(ctx, ui.menu, engine.player);
    if (ui.target && !engine.player.out) this.drawTargetMarker(ctx, ui.target);

    if (engine.phase === 'countdown') {
      const n = Math.ceil(engine.countdown);
      this.drawBanner(ctx, n > 0 ? String(n) : 'FIGHT!', '#ffd24a', 1 - (engine.countdown % 1));
    } else if (engine.time < 0.8) {
      this.drawBanner(ctx, 'FIGHT!', '#ffd24a', 1);
    }
    if (ui.banner) this.drawBanner(ctx, ui.banner.text, ui.banner.color, 1);
    ctx.restore();
  }

  drawBugPanel(ctx, bug, x, y, w, align) {
    const s = bug.stats;
    const right = align === 'right';
    ctx.textAlign = right ? 'right' : 'left';
    ctx.font = '10px "Press Start 2P", ui-monospace, monospace';
    ctx.fillStyle = `hsl(${bug.hue} 80% 70%)`;
    const label = bug.name.length > 18 ? `${bug.name.slice(0, 17)}…` : bug.name;
    ctx.fillText(label, right ? x + w : x, y + 8);

    const bar = (by, ratio, color, text) => {
      ctx.fillStyle = '#1b1726';
      ctx.fillRect(x, by, w, 10);
      ctx.fillStyle = color;
      const fw = Math.max(0, Math.min(1, ratio)) * (w - 2);
      ctx.fillRect(right ? x + w - 1 - fw : x + 1, by + 1, fw, 8);
      ctx.font = '7px "Press Start 2P", ui-monospace, monospace';
      ctx.fillStyle = '#f4e9c9';
      ctx.fillText(text, right ? x + w - 3 : x + 3, by + 5.5);
    };
    const hull = bug.chassis.hpRatio;
    bar(y + 18, hull, hull > 0.5 ? '#5bd66b' : hull > 0.25 ? '#ffc93c' : '#ff4a4a', `HULL ${Math.ceil(bug.chassis.hp)}`);
    const sr = bug.stamina / s.staminaMax;
    bar(y + 31, sr, bug.stalled ? '#4a6cff' : sr < 0.25 ? '#ff9a3c' : '#5ad8ff', bug.stalled ? 'THERMAL STALL' : `STAMINA ${Math.round(bug.stamina)}`);

    // Stall strike pips
    ctx.font = '7px "Press Start 2P", ui-monospace, monospace';
    ctx.fillStyle = '#8f86a8';
    const pipsX = right ? x + w : x;
    ctx.fillText('STALLS', pipsX, y + 50);
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i < bug.stallStrikes ? '#ff4a4a' : '#2d2640';
      const px = right ? x + w - 52 - i * 10 - 8 : x + 52 + i * 10;
      ctx.fillRect(px, y + 46, 8, 8);
    }
    if (bug.effects.lifted > 0 || bug.stats.gripMod < 1) {
      ctx.fillStyle = '#b6ff5a';
      ctx.fillText('NO GRIP', right ? x + w - 90 : x + 90, y + 50);
    }
  }

  drawFloat(ctx, f) {
    const p = this.worldToScreen(f.pos);
    ctx.globalAlpha = Math.max(0, Math.min(1, f.life / 0.4));
    ctx.textAlign = 'center';
    ctx.font = `${Math.round((f.size || 10) * 1.25)}px "Press Start 2P", ui-monospace, monospace`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#07060d';
    ctx.strokeText(f.text, p.x, p.y - f.rise);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, p.x, p.y - f.rise);
    ctx.globalAlpha = 1;
  }

  drawTargetMarker(ctx, target) {
    const p = this.worldToScreen(target);
    const t = performance.now() / 200;
    const r = 7 + Math.sin(t) * 2;
    ctx.strokeStyle = '#5bd66b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x - r, p.y); ctx.lineTo(p.x - r / 3, p.y);
    ctx.moveTo(p.x + r / 3, p.y); ctx.lineTo(p.x + r, p.y);
    ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x, p.y - r / 3);
    ctx.moveTo(p.x, p.y + r / 3); ctx.lineTo(p.x, p.y + r);
    ctx.stroke();
  }

  /** Radial weapon menu around the player's bug. */
  drawRadialMenu(ctx, menu, bug) {
    const c = this.worldToScreen(bug.pos);
    ctx.fillStyle = 'rgba(7,6,13,0.55)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, menu.radius + 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#3a3152';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.textAlign = 'center';
    menu.items.forEach((item, i) => {
      const pos = new Vector2D(c.x + Math.cos(item.angle) * menu.radius, c.y + Math.sin(item.angle) * menu.radius);
      const hot = menu.hover === i;
      ctx.fillStyle = item.disabled ? '#2d2640' : hot ? item.color : '#1b1726';
      ctx.strokeStyle = item.color;
      ctx.lineWidth = hot ? 3 : 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = '7px "Press Start 2P", ui-monospace, monospace';
      ctx.fillStyle = hot ? '#07060d' : '#f4e9c9';
      item.lines.forEach((ln, j) => ctx.fillText(ln, pos.x, pos.y - 5 + j * 10));
    });
    ctx.font = '7px "Press Start 2P", ui-monospace, monospace';
    ctx.fillStyle = '#8f86a8';
    ctx.fillText('RELEASE TO FIRE', c.x, c.y + menu.radius + 44);
  }

  drawBanner(ctx, text, color, pulse = 1) {
    const size = Math.min(56, this.cssW / 9) * (0.85 + 0.15 * pulse);
    ctx.textAlign = 'center';
    ctx.font = `${Math.round(size)}px "Press Start 2P", ui-monospace, monospace`;
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#07060d';
    ctx.strokeText(text, this.originCss.x, this.originCss.y);
    ctx.fillStyle = color;
    ctx.fillText(text, this.originCss.x, this.originCss.y);
  }
}
