/**
 * 2D vector. Methods without the `InPlace` suffix return new vectors.
 */
export class Vector2D {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle, length = 1) {
    return new Vector2D(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  static from(o) {
    return new Vector2D(o?.x ?? 0, o?.y ?? 0);
  }

  clone() { return new Vector2D(this.x, this.y); }
  set(x, y) { this.x = x; this.y = y; return this; }
  copy(v) { this.x = v.x; this.y = v.y; return this; }

  add(v) { return new Vector2D(this.x + v.x, this.y + v.y); }
  sub(v) { return new Vector2D(this.x - v.x, this.y - v.y); }
  scale(s) { return new Vector2D(this.x * s, this.y * s); }
  negate() { return new Vector2D(-this.x, -this.y); }

  addInPlace(v, s = 1) { this.x += v.x * s; this.y += v.y * s; return this; }
  scaleInPlace(s) { this.x *= s; this.y *= s; return this; }

  dot(v) { return this.x * v.x + this.y * v.y; }
  cross(v) { return this.x * v.y - this.y * v.x; }
  lengthSq() { return this.x * this.x + this.y * this.y; }
  length() { return Math.hypot(this.x, this.y); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y); }
  angle() { return Math.atan2(this.y, this.x); }

  /** Perpendicular (rotated +90°). */
  perp() { return new Vector2D(-this.y, this.x); }

  normalize() {
    const len = this.length();
    return len > 1e-9 ? new Vector2D(this.x / len, this.y / len) : new Vector2D(0, 0);
  }

  rotate(a) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return new Vector2D(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  lerp(v, t) {
    return new Vector2D(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t);
  }

  toJSON() { return { x: this.x, y: this.y }; }
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Move `value` toward `target` by at most `maxDelta`. */
export function approach(value, target, maxDelta) {
  if (value < target) return Math.min(value + maxDelta, target);
  if (value > target) return Math.max(value - maxDelta, target);
  return value;
}

/** Wrap an angle to (−π, π]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
