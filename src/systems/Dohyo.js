import { ARENA, PHYSICS } from '../config/constants.js';
import { Vector2D, clamp } from '../physics/Vector2D.js';

/**
 * The five dohyo (rings). After ARENA.STATIC_UNTIL each one gets harder in its
 * own way until ARENA.COLLAPSE_AT:
 *   1 Classic  — the ring shrinks.
 *   2 Donut    — a hole in the middle grows outwards.
 *   3 Tilt ↓   — an oval tilted down towards the bottom of the screen; the oval
 *                thins and the slope steepens.
 *   4 Tilt ↑   — the same, tilted down towards the top of the screen.
 *   5 Spinner  — a turntable that spins faster and faster.
 * Everything that asks "is this on the ring?" goes through here: eliminations,
 * the AI, the input, the renderer.
 */
export const DOHYO_KINDS = Object.freeze({
  1: { name: 'Classic', blurb: 'The ring shrinks.' },
  2: { name: 'Donut', blurb: 'The hole in the middle grows.' },
  3: { name: 'Downhill', blurb: 'Tilted towards the bottom — and getting steeper.' },
  4: { name: 'Uphill', blurb: 'Tilted towards the top — and getting steeper.' },
  5: { name: 'Spinner', blurb: 'A turntable, spinning faster and faster.' },
});

const HOLE = [70, ARENA.R0 - 40];        // donut hole radius: start → end
const SQUASH = [0.86, 0.45];             // tilted oval: height ÷ width, start → end
const TILT = [0.07, 0.5];                // slope (fraction of gravity pulling downhill), start → end
const SPIN = [0.15, 1.6];                // turntable rad/s, start → end

export class Dohyo {
  constructor(kind = 1) {
    this.kind = DOHYO_KINDS[kind] ? Number(kind) : 1;
    this.angle = 0; // turntable rotation so far
  }

  static random() {
    return new Dohyo(1 + Math.floor(Math.random() * 5));
  }

  get name() { return DOHYO_KINDS[this.kind].name; }
  get blurb() { return DOHYO_KINDS[this.kind].blurb; }
  get tilted() { return this.kind === 3 || this.kind === 4; }
  /** Downhill direction on the tilted rings (screen y is down). */
  get downhill() { return new Vector2D(0, this.kind === 3 ? 1 : -1); }

  /** 0 while static, rising to 1 at the collapse time. */
  progress(t) {
    return clamp((t - ARENA.STATIC_UNTIL) / (ARENA.COLLAPSE_AT - ARENA.STATIC_UNTIL), 0, 1);
  }

  changing(t) { return t > ARENA.STATIC_UNTIL && t < ARENA.COLLAPSE_AT; }

  lerp([a, b], t) { return a + (b - a) * this.progress(t); }

  /** Outer radius (the classic ring shrinks; the others keep their size). */
  radius(t) { return this.kind === 1 ? ARENA.R0 * (1 - this.progress(t)) : ARENA.R0; }
  hole(t) { return this.kind === 2 ? this.lerp(HOLE, t) : 0; }
  squash(t) { return this.tilted ? this.lerp(SQUASH, t) : 1; }
  slope(t) { return this.tilted ? this.lerp(TILT, t) : 0; }
  spinRate(t) { return this.kind === 5 ? this.lerp(SPIN, t) : 0; }

  /** Where `pos` sits on the ring as a 0..1 "how far out" (1 = the outer edge). */
  reach(pos, t) {
    const R = this.radius(t);
    if (R <= 0) return Infinity;
    return Math.hypot(pos.x / R, pos.y / (R * this.squash(t)));
  }

  /** Off the ring: past the outer edge, or down the donut hole. */
  isOut(pos, t) {
    if (this.reach(pos, t) > 1) return true;
    return this.kind === 2 && pos.length() < this.hole(t);
  }

  onRing(pos, t) { return !this.isOut(pos, t); }

  /** Roughly how far `pos` is from the nearest edge (world px; negative when off). */
  edgeDistance(pos, t) {
    const R = this.radius(t);
    const outer = (1 - this.reach(pos, t)) * R * this.squash(t);
    if (this.kind !== 2) return outer;
    return Math.min(outer, pos.length() - this.hole(t));
  }

  /** A safe spot to retreat to from `pos`: the middle, or the middle of the donut. */
  safePoint(pos, t) {
    if (this.kind !== 2) return pos.scale(0.25);
    const d = pos.length();
    const mid = (this.hole(t) + this.radius(t)) / 2;
    return d > 1e-6 ? pos.scale(mid / d) : new Vector2D(mid, 0);
  }

  /** Direction from `pos` towards its nearest edge (to push an opponent off). */
  outward(pos, t) {
    const d = pos.length();
    const radial = d > 1e-6 ? pos.scale(1 / d) : new Vector2D(1, 0);
    if (this.kind === 2 && d - this.hole(t) < this.radius(t) - d) return radial.negate(); // closer to the hole
    if (this.tilted) {
      // Normal of the ellipse at this point.
      const s = this.squash(t);
      const n = new Vector2D(pos.x, pos.y / (s * s));
      return n.length() > 1e-6 ? n.normalize() : radial;
    }
    return radial;
  }

  /**
   * On the donut, a straight line to `to` may cross the hole: return a
   * waypoint that goes round it instead (the target itself otherwise).
   */
  route(from, to, margin, t) {
    if (this.kind !== 2) return to;
    const hole = this.hole(t) + margin;
    const seg = to.sub(from);
    const len2 = seg.x * seg.x + seg.y * seg.y;
    const u = len2 > 0 ? clamp(-(from.x * seg.x + from.y * seg.y) / len2, 0, 1) : 0;
    const closest = from.add(seg.scale(u));
    if (closest.length() >= hole) return to;
    const a1 = Math.atan2(from.y, from.x);
    let delta = Math.atan2(to.y, to.x) - a1;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    const a = a1 + Math.sign(delta || 1) * Math.min(Math.abs(delta), Math.PI / 3);
    const mid = (this.hole(t) + this.radius(t)) / 2;
    return new Vector2D(Math.cos(a) * mid, Math.sin(a) * mid);
  }

  /** Pull a point back onto the ring, leaving `margin` px to the edges. */
  clampInside(point, margin, t) {
    const R = this.radius(t);
    const s = this.squash(t);
    const a = Math.max(0, R - margin);
    const b = Math.max(0, R * s - margin);
    let p = point;
    const k = a > 0 && b > 0 ? Math.hypot(p.x / a, p.y / b) : Infinity;
    if (k > 1) p = k === Infinity ? new Vector2D() : p.scale(1 / k);
    if (this.kind === 2) {
      const minR = this.hole(t) + margin;
      const d = p.length();
      if (d < minR) p = d > 1e-6 ? p.scale(minR / d) : new Vector2D(minR, 0);
    }
    return p;
  }

  /**
   * The ring acting on the bugs each step: gravity on the tilted rings
   * (downhill is easier), and the turntable's rotation. (Its floor motion —
   * and the grip it takes to keep up with it — is in the physics, via
   * floorVelocity.)
   */
  applyForces(bugs, dt, t) {
    if (this.kind === 5) this.angle += this.spinRate(t) * dt;
    for (const bug of bugs) {
      if (bug.out) continue;
      if (this.tilted) {
        bug.vel.addInPlace(this.downhill, PHYSICS.GRAVITY * this.slope(t) * dt);
      }
    }
  }

  /**
   * The turntable's floor velocity at `pos` (ω × r: faster further out), or
   * null on a ring that doesn't spin. The physics works relative to it.
   */
  floorVelocity(t) {
    if (this.kind !== 5) return null;
    const w = this.spinRate(t);
    return (pos) => new Vector2D(-w * pos.y, w * pos.x);
  }

  /** The HUD's line about what the ring is doing. */
  status(t) {
    const left = Math.ceil(ARENA.STATIC_UNTIL - t);
    const soon = { 1: 'RING SHRINKS', 2: 'HOLE GROWS', 3: 'TILT STEEPENS', 4: 'TILT STEEPENS', 5: 'SPIN SPEEDS UP' }[this.kind];
    if (t < ARENA.STATIC_UNTIL) return `DOHYO ${this.kind} · ${this.name.toUpperCase()} · ${soon} IN ${left}s`;
    if (t >= ARENA.COLLAPSE_AT) return this.kind === 1 ? 'COLLAPSED' : `DOHYO ${this.kind} · FULL ${this.name.toUpperCase()}`;
    const now = {
      1: `DOHYO COLLAPSING · R ${Math.round(this.radius(t))}`,
      2: `HOLE GROWING · ${Math.round(this.hole(t))}`,
      3: `TILTING · ${Math.round(this.slope(t) * 100)}% SLOPE`,
      4: `TILTING · ${Math.round(this.slope(t) * 100)}% SLOPE`,
      5: `SPINNING · ${this.spinRate(t).toFixed(1)} RAD/S`,
    }[this.kind];
    return now;
  }
}
