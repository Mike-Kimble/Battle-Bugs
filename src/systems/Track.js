import { ARENA } from '../config/constants.js';
import { Vector2D } from '../physics/Vector2D.js';

/**
 * The Weevil Weave race track: an S. Three lanes (bottom, middle, top) joined
 * by two hairpins. You start at the bottom left, your opponent at the top
 * right, and the finish line runs across the middle of the S — whoever gets
 * their whole vehicle over it first wins. Leave the track and you've lost.
 *
 * It stands in for a Dohyo (same methods), so the fight engine, physics and
 * renderer can use it unchanged.
 */
export class Track {
  constructor() {
    this.kind = 'weave';
    this.isTrack = true;
    this.angle = 0;
    this.width = 170;
    this.halfWidth = this.width / 2;
    const h = 260; // lane spacing
    const r = h / 2; // hairpin radius
    const turnX = 200;
    const endX = 360;
    // Centre line, start (bottom left) → end (top right), sampled every few px.
    const pts = [];
    const line = (a, b) => { const n = Math.ceil(a.distanceTo(b) / 6); for (let i = 0; i < n; i++) pts.push(a.add(b.sub(a).scale(i / n))); };
    const arc = (c, from, to) => { const n = Math.ceil((Math.abs(to - from) * r) / 6); for (let i = 0; i < n; i++) pts.push(Vector2D.fromAngle(from + ((to - from) * i) / n, r).addInPlace(c, 1)); };
    line(new Vector2D(-endX, h), new Vector2D(turnX, h)); // bottom lane, heading right
    arc(new Vector2D(turnX, r), Math.PI / 2, -Math.PI / 2); // right hairpin, up
    line(new Vector2D(turnX, 0), new Vector2D(-turnX, 0)); // middle lane, heading left
    arc(new Vector2D(-turnX, -r), Math.PI / 2, (3 * Math.PI) / 2); // left hairpin, up
    line(new Vector2D(-turnX, -h), new Vector2D(endX, -h)); // top lane, heading right
    pts.push(new Vector2D(endX, -h));
    this.points = pts;
    // Distance along the centre line at each point.
    this.dist = [0];
    for (let i = 1; i < pts.length; i++) this.dist.push(this.dist[i - 1] + pts[i].distanceTo(pts[i - 1]));
    this.length = this.dist[this.dist.length - 1];
    this.finishAt = this.length / 2; // the finish line: across the middle of the S
  }

  get name() { return 'Weevil Weave'; }
  get blurb() { return 'An S-shaped race track. First across the centre line wins; fall off and you lose.'; }
  get tilted() { return false; }
  get downhill() { return new Vector2D(0, 1); }

  /** The nearest point on the centre line: { point, dist (from the line), s (along it), tangent }. */
  nearest(pos) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const d = this.points[i].distanceTo(pos);
      if (d < bd) { bd = d; best = i; }
    }
    const i = Math.min(best, this.points.length - 2);
    const tangent = this.points[i + 1].sub(this.points[i]).normalize();
    return { point: this.points[best], dist: bd, s: this.dist[best], tangent, index: best };
  }

  /** The centre-line point `s` px along the track (clamped). */
  pointAt(s) {
    const t = Math.max(0, Math.min(this.length, s));
    let i = 0;
    while (i < this.dist.length - 2 && this.dist[i + 1] < t) i++;
    const seg = this.dist[i + 1] - this.dist[i] || 1;
    return this.points[i].add(this.points[i + 1].sub(this.points[i]).scale((t - this.dist[i]) / seg));
  }

  /** Track direction at `s` (pointing from the start towards the end). */
  tangentAt(s) {
    return this.pointAt(s + 4).sub(this.pointAt(s - 4)).normalize();
  }

  /** Where each racer starts: dir +1 from the bottom left, -1 from the top right. */
  start(dir) {
    const s = dir > 0 ? 40 : this.length - 40;
    const t = this.tangentAt(s);
    return { pos: this.pointAt(s), angle: (dir > 0 ? t : t.negate()).angle() };
  }

  /** Has `bug` got all of itself over the finish line, racing in direction `dir`? */
  finished(bug, dir) {
    const { s } = this.nearest(bug.pos);
    return dir > 0 ? s - bug.radius > this.finishAt : s + bug.radius < this.finishAt;
  }

  // ───────────── The Dohyo interface ─────────────
  progress() { return 0; }
  changing() { return false; }
  radius() { return ARENA.R0; }
  hole() { return 0; }
  squash() { return 1; }
  slope() { return 0; }
  spinRate() { return 0; }
  isOut(pos) { return this.nearest(pos).dist > this.halfWidth; }
  onRing(pos) { return !this.isOut(pos); }
  edgeDistance(pos) { return this.halfWidth - this.nearest(pos).dist; }
  safePoint(pos) { return this.nearest(pos).point.clone(); }
  outward(pos) {
    const n = this.nearest(pos);
    const off = pos.sub(n.point);
    return off.length() > 1 ? off.normalize() : n.tangent.perp();
  }
  route(from, to) { return to; }
  clampInside(point, margin = 0) {
    const n = this.nearest(point);
    const room = Math.max(0, this.halfWidth - margin);
    if (n.dist <= room) return point.clone();
    return n.point.add(point.sub(n.point).normalize().scale(room));
  }
  applyForces() {}
  floorVelocity() { return null; }
  status() { return 'WEEVIL WEAVE · FIRST ACROSS THE CENTRE LINE WINS'; }
}
