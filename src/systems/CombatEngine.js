import { ARENA, MATCH, PHYSICS, ACTIONS, EVENTS, PILOT_SKILL } from '../config/constants.js';
import { PILOT_STYLES, heavyGear, turbineLine, driveKind, gearWearMatches, worksWith } from '../config/partsData.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { Dohyo } from './Dohyo.js';
import { PhysicsEngine } from '../physics/PhysicsEngine.js';
import { Vector2D, wrapAngle, clamp } from '../physics/Vector2D.js';

const REASONS = {
  ringout: 'Ring out',
  destroyed: 'Catastrophic damage',
  stallout: 'Stalled out',
  time: 'Time — the arena collapsed',
  forfeit: 'Forfeit',
  finish: 'Across the line first',
  offtrack: 'Fell off the track',
  beaten: 'Beaten to the line',
};

/**
 * Runs a single bout: countdown, physics, collisions → damage, weapons,
 * ring shrink, eliminations and match resolution. Emits EVENTS.* for
 * renderers/UI; knows nothing about drawing or input.
 */
export class CombatEngine extends EventEmitter {
  /**
   * @param {{player: BattleBug, opponent: BattleBug, difficulty?: number}} opts
   */
  /** @param {{dohyo?: Dohyo}} opts dohyo: which ring (defaults to the classic) */
  /** training: a practice session — nothing wears out (no per-match wear, no chain wear). */
  /** extras: more opponents ([{ bug, difficulty, style }]) — a free-for-all, last one on the ring wins. */
  constructor({ player, opponent, difficulty = 0.5, style = null, dohyo = null, ai = true, training = false, extras = [] }) {
    super();
    this.training = training;
    this.dohyo = dohyo || new Dohyo(1);
    this.player = player;
    this.opponent = opponent;
    this.bugs = [player, opponent, ...extras.map((e) => e.bug)];
    this.physics = new PhysicsEngine(this);
    this.phase = 'countdown'; // countdown → fight → resolving → over
    this.countdown = MATCH.COUNTDOWN;
    this.time = 0;
    this.puddles = [];
    this.eliminations = [];
    this.firstElimAt = null;
    this.result = null;
    this.critRolled = new Set(); // vital parts already rolled for a breakdown this match
    this.critical = null;        // { bug, part }: a frame that broke down (catastrophic damage)
    this.winner = null;          // free-for-all: the last bug on the ring

    this.race = !!this.dohyo.isTrack;
    if (this.race) {
      // A race: you from one end of the S, them from the other.
      const a = this.dohyo.start(1);
      const b = this.dohyo.start(-1);
      player.resetForBattle(a.pos, a.angle);
      opponent.resetForBattle(b.pos, b.angle);
    } else if (this.bugs.length > 2) {
      // Free-for-all: spread round the ring, everyone facing the middle.
      this.bugs.forEach((b, i) => {
        const a = Math.PI + (i * Math.PI * 2) / this.bugs.length;
        b.resetForBattle(Vector2D.fromAngle(a, ARENA.R0 * 0.5), a + Math.PI);
      });
    } else {
      player.resetForBattle(new Vector2D(-ARENA.R0 * 0.45, 0), 0);
      opponent.resetForBattle(new Vector2D(ARENA.R0 * 0.45, 0), Math.PI);
    }
    // Durability: only cheap armour and cheap running gear can be wrecked in a
    // single match. Everything else loses at most MATCH_DAMAGE_CAP of its max HP
    // per match, so from full it takes at least two fights to drop to 15%.
    for (const bug of this.bugs) {
      for (const p of bug.parts) {
        const fragile = ['armor', 'tires', 'castor'].includes(p.type) && p.tier <= MATCH.FRAGILE_TIER;
        p.battleFloor = fragile ? null : Math.max(0, p.hp - p.maxHp * MATCH.DAMAGE_CAP);
      }
    }
    this.ai = !ai ? null // a training dummy has no pilot
      : this.race ? new RaceAI(opponent, player, difficulty, this.dohyo, -1)
        : new AIController(opponent, player, difficulty, style);
    this.ais = this.ai ? [this.ai, ...extras.map((e) => new AIController(e.bug, player, e.difficulty ?? difficulty, e.style ?? null))] : [];
    // Free-for-all: everyone picks someone to go for — not necessarily you.
    if (this.melee) for (const ai of this.ais) ai.foe = this.bugs.filter((b) => b !== ai.me)[Math.floor(Math.random() * (this.bugs.length - 1))];

    this.on(EVENTS.COLLISION, (c) => this.onCollision(c));
  }


  get arenaRadius() { return this.dohyo.radius(this.time); }
  /** The ring is getting harder (shrinking, hole growing, tilting, spinning up). */
  get shrinking() { return this.dohyo.changing(this.time); }
  onRing(pos) { return this.dohyo.onRing(pos, this.time); }
  edgeDistance(pos) { return this.dohyo.edgeDistance(pos, this.time); }
  get live() { return this.phase === 'fight' || this.phase === 'resolving'; }

  /** A free-for-all (more than two on the ring). */
  get melee() { return this.bugs.length > 2; }

  /** Who `bug` is up against: the other one — or, in a free-for-all, the nearest still on the ring. */
  other(bug) {
    if (!this.melee) return bug === this.player ? this.opponent : this.player;
    const rest = this.bugs.filter((b) => b !== bug);
    const alive = rest.filter((b) => !b.out);
    return (alive.length ? alive : rest).reduce((n, b) => (b.pos.distanceTo(bug.pos) < n.pos.distanceTo(bug.pos) ? b : n));
  }

  /** Has the bout been settled? (Two on the ring: anyone out. Free-for-all: you're out, or everyone else is.) */
  get decided() {
    if (!this.melee) return this.eliminations.length > 0;
    // A free-for-all plays out to the bitter end — even with you out — until one is left.
    return this.bugs.filter((b) => !b.out).length <= 1;
  }

  /** Pull a point back inside the current ring, leaving `margin` px to the edge. */
  clampInside(point, margin = 0) {
    return this.dohyo.clampInside(point, margin, this.time);
  }

  // ───────────── Main update ─────────────
  update(dt) {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'fight';
        this.emit(EVENTS.MATCH_START, {});
      }
      return;
    }

    if (this.live) this.time += dt;
    if (this.phase === 'fight') {
      for (const ai of this.ais) {
        if (this.melee) {
          // Stick with your target unless they're gone or someone else is clearly closer.
          const near = this.other(ai.me);
          if (ai.foe.out || near.pos.distanceTo(ai.me.pos) < ai.foe.pos.distanceTo(ai.me.pos) * ACTIONS.MELEE_SWITCH) ai.foe = near;
        }
        ai.update(dt, this);
      }
    }

    for (const bug of this.bugs) bug.control.face = this.other(bug).pos; // thrust-vectoring bugs keep facing their opponent
    if (this.live) this.dohyo.applyForces(this.bugs, dt, this.time); // slopes and turntables
    this.physics.step(this.bugs, dt, { puddles: this.puddles, floorVel: this.dohyo.floorVelocity(this.time), spin: this.dohyo.spinRate(this.time),
      slope: this.dohyo.slope(this.time), downhill: this.dohyo.tilted ? this.dohyo.downhill : null });
    if (this.live) for (const bug of this.bugs) { this.spinHit(bug); this.shaftStrain(bug, dt); }
    this.updateFallen(dt);
    this.updatePuddles(dt);

    if (this.live) this.checkEliminations();
  }

  updateFallen(dt) {
    for (const bug of this.bugs) {
      if (!bug.out) continue;
      bug.fall += dt;
      if (bug.outReason === 'ringout') {
        bug.pos.addInPlace(bug.vel, dt);
        bug.vel.scaleInPlace(0.97);
        bug.angle += dt * 4;
      } else {
        bug.vel.set(0, 0);
      }
    }
  }

  updatePuddles(dt) {
    for (const p of this.puddles) p.time -= dt;
    this.puddles = this.puddles.filter((p) => p.time > 0);
  }

  checkEliminations() {
    const R = this.arenaRadius;
    for (const bug of this.bugs) {
      if (bug.out) continue;
      let reason = null;
      if (this.dohyo.isOut(bug.pos, this.time)) reason = 'ringout';
      else if (bug.chassis.isBroken) reason = 'destroyed';
      else if (bug.stallStrikes >= MATCH.STALL_OUT_STRIKES) reason = 'stallout';
      if (reason) this.eliminate(bug, reason);
    }

    // A race: first with their whole vehicle over the centre line wins.
    if (this.race && this.phase === 'fight') {
      const done = [this.player, this.opponent].filter((b, i) => !b.out && this.dohyo.finished(b, i === 0 ? 1 : -1));
      if (done.length) {
        const won = done.includes(this.player);
        this.finish(won ? 'win' : 'loss', won ? 'finish' : 'beaten');
        return;
      }
    }

    if (this.phase === 'fight' && this.time >= MATCH.DURATION) {
      // Out of a free-for-all when the clock runs down: you still lost.
      this.finish(this.melee && this.player.out ? 'loss' : 'tie', 'time');
      return;
    }

    if (this.phase === 'resolving' && this.melee) {
      // Last one on the ring wins; you out with nobody left standing either is a draw.
      const allOut = this.bugs.every((b) => b.out);
      const windowClosed = (this.time - this.firstElimAt) * 1000 >= MATCH.TIE_WINDOW_MS;
      if (!allOut && !windowClosed) return;
      const mine = this.eliminations.find((e) => e.bug === this.player);
      const last = this.eliminations[this.eliminations.length - 1];
      const survivor = this.bugs.find((b) => !b.out) || null;
      this.winner = survivor;
      if (survivor === this.player) this.finish('win', last.reason);
      else if (!survivor && mine && last.time - mine.time <= MATCH.TIE_WINDOW_MS / 1000) this.finish('tie', mine.reason); // you went down with the last of them
      else this.finish('loss', mine?.reason || last.reason);
      return;
    }

    if (this.phase === 'resolving') {
      const bothOut = this.bugs.every((b) => b.out);
      const windowClosed = (this.time - this.firstElimAt) * 1000 >= MATCH.TIE_WINDOW_MS;
      if (bothOut) {
        this.finish('tie', this.eliminations[0].reason);
      } else if (windowClosed) {
        const loser = this.eliminations[0].bug;
        this.finish(loser === this.player ? 'loss' : 'win', this.eliminations[0].reason);
      }
    }
  }

  eliminate(bug, reason) {
    bug.out = true;
    bug.outReason = reason;
    bug.control.target = null;
    bug.control.cruise = null;
    bug.lunge = null;
    this.eliminations.push({ bug, reason, time: this.time });
    if (reason === 'ringout') this.emit(EVENTS.RING_OUT, { bug });
    if (reason === 'stallout') this.emit(EVENTS.STALL, { bug, strikes: bug.stallStrikes, stallOut: true });
    // A free-for-all goes on until it's settled.
    if (!this.decided) return;
    // The survivor digs in at the tawara: cancel its charge and brake hard so a
    // winning shove doesn't carry it over the edge too.
    for (const other of this.bugs) {
      if (other.out) continue;
      other.lunge = null;
      other.control.target = null;
      other.control.cruise = null;
      other.vel.scaleInPlace(ACTIONS.VICTORY_BRAKE);
    }
    if (this.firstElimAt === null) {
      this.firstElimAt = this.time;
      this.phase = 'resolving';
    }
  }

  finish(result, reasonKey) {
    if (this.phase === 'over') return;
    this.phase = 'over';
    for (const bug of this.bugs) for (const p of bug.parts) p.battleFloor = null;
    // Parts that grind themselves down (graphite discs) lose a set share every match.
    for (const bug of this.training ? [] : this.bugs) {
      for (const p of bug.parts) if (p.stats.wearPerMatch) p.hp = Math.max(p.maxHp * 0.01, p.hp - p.maxHp * p.stats.wearPerMatch);
      // A water mister keeps things cool, but the damp wears the drive it's on: its motor and drive train.
      for (let b = 0; b < bug.drives.length; b++) {
        const wear = bug.coolers.filter((c) => (c.bay || 0) === b && !c.isBroken && worksWith(c, bug)).reduce((x, c) => Math.max(x, c.stats.mistWear || 0), 0);
        if (!wear) continue;
        for (const p of [bug.drives[b], ...bug.drivetrain.filter((q) => (q.bay || 0) === b)]) {
          const floor = p.maxHp * MATCH.WORN_FLOOR;
          if (p.hp > floor) p.hp = Math.max(floor, p.hp - p.maxHp * wear);
        }
      }
      // Electric torque chews through gearing: worn out in 2 matches (cheap) to 5 (dear).
      for (const p of bug.drivetrain) {
        const life = gearWearMatches(p, bug);
        if (!life || p.isBroken) continue;
        const floor = p.maxHp * MATCH.WORN_FLOOR;
        p.hp = Math.max(floor, p.hp - (p.maxHp - floor) / life); // full → worn out over its life
        if (p.hp <= floor + 0.01) { p.failed = true; this.emit(EVENTS.PART_BROKEN, { bug, part: p, breakdown: true }); }
      }
    }
    let reason = REASONS[this.race && reasonKey === 'ringout' ? 'offtrack' : reasonKey] || reasonKey;
    const crit = this.critical;
    if (reasonKey === 'destroyed' && crit) {
      reason = `Catastrophic damage — ${crit.bug.name}'s ${crit.part.name} broke down at ${Math.round(crit.part.hpRatio * 100)}%`;
    }
    this.result = { result, reason, reasonKey, time: this.time, winner: this.winner?.name || null, playerOut: this.player.out };
    this.emit(EVENTS.MATCH_END, this.result);
  }

  forfeit() {
    if (this.phase === 'over') return;
    this.player.out = true;
    this.player.outReason = 'forfeit';
    this.finish('loss', 'forfeit');
  }

  // ───────────── Collisions & damage ─────────────
  onCollision({ a, b, normal, impact, spin }) {
    if (!this.live || spin) return; // spin hits deal their own damage (spinHit)
    if (impact > PHYSICS.IMPACT_THRESHOLD) {
      this.impactDamage(a, b, normal, impact);
      this.impactDamage(b, a, normal.negate(), impact);
      if (a.lunge) a.lunge = null;
      if (b.lunge) b.lunge = null;
    }
    this.spikeContact(a, b, normal);
    this.spikeContact(b, a, normal.negate());
  }

  /** @param {Vector2D} dir unit vector from attacker toward victim */
  impactDamage(attacker, victim, dir, impact) {
    const zone = victim.zoneFacing(dir.negate());
    let mult = attacker.lunge ? attacker.lunge.impactMult : 1;
    // A back-to-front shell is built to take hits on its tail, too.
    if (zone === 'front' || (zone === 'rear' && victim.chassis?.stats.backwards)) mult *= PHYSICS.FRONT_HIT_REDUCTION;
    const dmg = PHYSICS.IMPACT_DAMAGE_K * (impact - PHYSICS.IMPACT_THRESHOLD) * attacker.stats.mass * mult;
    const res = victim.takeDamage(dmg, zone, { side: victim.sideFacing(dir.negate()) });
    victim.lastHitBy = attacker;
    this.report(victim, res, { zone, source: attacker, kind: 'impact' });
  }

  spikeContact(attacker, victim, dir) {
    const spikes = attacker.weapons.find((w) => w.stats.effect === 'spikes');
    if (!spikes || attacker.effects.spikes <= 0 || attacker.effects.spikeTick > 0) return;
    if (attacker.zoneFacing(dir) !== 'front') return;
    attacker.effects.spikeTick = spikes.stats.tick;
    const eff = 0.5 + 0.5 * spikes.hpRatio;
    const res = victim.damageSlot('engine', spikes.stats.engineDamage * eff);
    this.report(victim, res, { zone: 'front', source: attacker, kind: 'spikes' });
  }

  report(bug, res, meta) {
    if (res.total > 0) {
      bug.effects.flash = 0.12;
      this.emit(EVENTS.DAMAGE, { bug, amount: res.total, hits: res.hits, ...meta });
    }
    for (const part of res.broken) this.emit(EVENTS.PART_BROKEN, { bug, part });
    this.checkCritical(bug, res);
  }

  /**
   * The frame, a drive or the running gear dropping to 15%: a 50% chance it
   * breaks down and stops working, just as if it were wrecked — a drive gives
   * no push, running gear no grip, and a frame that goes is catastrophic
   * damage. It keeps its HP, so a mechanic can still repair it. One roll per
   * part per match.
   */
  checkCritical(bug, res) {
    if (!this.live || bug.out) return;
    for (const { part } of res.hits) {
      const vital = part === bug.chassis || part === bug.tires || bug.drives.includes(part);
      if (!vital || part.failed || part.hpRatio > MATCH.CRITICAL || this.critRolled.has(part.uid)) continue;
      this.critRolled.add(part.uid);
      if (Math.random() >= MATCH.BREAKDOWN_CHANCE) continue;
      part.failed = true;
      this.emit(EVENTS.PART_BROKEN, { bug, part, breakdown: true });
      if (part === bug.chassis) {
        this.critical = { bug, part };
        this.eliminate(bug, 'destroyed');
        return;
      }
    }
  }

  // ───────────── Commands (player input & AI) ─────────────
  fail(bug, reason) {
    this.emit(EVENTS.ACTION_FAIL, { bug, reason });
    return false;
  }

  canAct(bug, cost) {
    if (!this.live) return false;
    if (bug.out) return false;
    if (bug.stalled) return this.fail(bug, 'THERMAL STALL');
    if (bug.stamina < cost) return this.fail(bug, 'LOW POWER');
    return true;
  }

  /** Steer toward a point (tap or held/dragged finger). Cancels any swipe cruise. */
  /** @param {{backing?: boolean}} opts backing: drive there tail first */
  moveTo(bug, point, { backing = false, route = false } = {}) {
    if (!this.live || bug.out) return;
    // AI pilots route round the donut hole rather than driving into it.
    const p = Vector2D.from(point);
    bug.control.target = route ? this.dohyo.route(bug.pos, p, bug.radius * 1.5, this.time) : p;
    bug.control.cruise = null;
    bug.control.backing = backing;
  }

  stop(bug) {
    bug.control.target = null;
    bug.control.cruise = null;
    bug.control.backing = false;
  }

  /**
   * Standard Ram (power=false) or Power Shove (power=true) toward the opponent.
   * No bug spins round to do it: it goes with whichever end is already closer
   * to facing them — nose first, or tail first in reverse (where a
   * back-to-front shell hits hardest).
   */
  ram(bug, power = false) {
    const target = this.other(bug);
    const cost = power ? ACTIONS.SHOVE_COST : ACTIONS.RAM_COST;
    if (bug.actionCooldown > 0 || target.out) return false;
    if (!this.canAct(bug, cost)) return false;

    const dir = target.pos.sub(bug.pos).normalize();
    const reverse = Math.abs(wrapAngle(dir.angle() - bug.angle)) > Math.PI / 2;
    const speedMult = power ? ACTIONS.SHOVE_SPEED_MULT : ACTIONS.RAM_SPEED_MULT;
    bug.angle = dir.angle() + (reverse ? Math.PI : 0);
    // Reversing is slower, except for shells geared for it.
    const revShare = reverse && !bug.chassis?.stats.backwards ? PHYSICS.REVERSE_SPEED : 1;
    const fwd = Math.max(0, bug.vel.dot(dir));
    bug.vel = dir.scale(Math.max(fwd, bug.stats.vMax * speedMult * 0.85 * revShare));
    bug.lunge = {
      time: power ? ACTIONS.SHOVE_DURATION : ACTIONS.RAM_DURATION,
      speedMult,
      impactMult: power ? ACTIONS.SHOVE_IMPACT_MULT : ACTIONS.RAM_IMPACT_MULT,
      power,
      reverse,
    };
    // Follow through, but never aim past the edge — shove them out, not yourself.
    bug.control.target = this.clampInside(target.pos.add(dir.scale(ACTIONS.PUSH_THROUGH)), bug.radius * 1.2);
    bug.control.cruise = null;
    bug.control.reverse = reverse;
    bug.control.backing = false;
    bug.stamina -= cost;
    bug.actionCooldown = ACTIONS.ACTION_COOLDOWN;
    this.emit(EVENTS.ACTION, { bug, type: power ? 'shove' : 'ram', dir });
    return true;
  }

  /**
   * Twin drives: a swipe spins the bug a full 360° on the spot (one drive
   * forward, one back). Anything it catches gets knocked further back than
   * a ram would send it. Swipe to the right of travel to spin clockwise.
   */
  spinAttack(bug, dir) {
    if (bug.actionCooldown > 0 || bug.spin) return false;
    if ((bug.cooldowns.spin || 0) > 0) return this.fail(bug, 'SPIN RECHARGING');
    if (!this.canAct(bug, ACTIONS.SPIN_COST)) return false;
    const heading = Vector2D.fromAngle(bug.angle);
    const cw = heading.cross(dir.normalize()) >= 0 ? 1 : -1;
    bug.spin = { time: ACTIONS.SPIN_DURATION, rate: (cw * 2 * Math.PI) / ACTIONS.SPIN_DURATION, hit: false };
    bug.lunge = null;
    bug.control.target = null;
    bug.control.cruise = null;
    bug.control.backing = false;
    bug.stamina -= ACTIONS.SPIN_COST;
    bug.actionCooldown = ACTIONS.SPIN_DURATION;
    bug.cooldowns.spin = ACTIONS.SPIN_COOLDOWN;
    this.emit(EVENTS.ACTION, { bug, type: 'spin', dir: heading });
    return true;
  }

  /**
   * A chain wears when it drives heavy tyres or tracks. A Standard Drive Shaft or
   * chain can't take full turbine revs: it snaps halfway through the match —
   * unless it's on the wheel side of a gearbox behind a High-Speed Shaft.
   */
  shaftStrain(bug, dt) {
    if (bug.out) return;
    // A chain driving heavy tyres or tracks wears while you drive.
    // (Each drive has its own shaft or chain.)
    for (const chain of bug.drivetrain.filter((p) => p.stats.shaft === 'chain' && !p.isBroken)) {
      if (this.training || !(bug.throttle > 0) || !heavyGear(bug)) break;
      const r = chain.applyDamage(chain.maxHp * ACTIONS.CHAIN_WEAR * bug.throttle * dt);
      if (r.broke) this.emit(EVENTS.PART_BROKEN, { bug, part: chain });
    }
    if (this.time < MATCH.DURATION / 2) return;
    // Only on a turbine's drive. A plain shaft lasts on the wheel side of the full line (High-Speed Shaft → gearbox → shaft).
    for (const shaft of bug.drivetrain.filter((p) => (p.stats.shaft === 'std' || p.stats.shaft === 'chain') && !p.isBroken
      && driveKind(bug, p.bay || 0) === 'turbine' && !turbineLine(bug, p.bay || 0).complete)) {
      shaft.hp = Math.min(shaft.hp, shaft.maxHp * 0.3);
      shaft.failed = true;
      this.emit(EVENTS.PART_BROKEN, { bug, part: shaft, breakdown: true });
    }
  }

  /** A spinning bug catches the opponent once per spin and flings them away. */
  spinHit(bug) {
    if (!bug.spin || bug.spin.hit || bug.out) return;
    const foe = this.other(bug);
    if (foe.out) return;
    const delta = foe.pos.sub(bug.pos);
    const dist = delta.length();
    if (dist > bug.radius + foe.radius + ACTIONS.SPIN_REACH || dist < 1e-6) return;
    bug.spin.hit = true;
    const n = delta.scale(1 / dist);
    const heft = clamp(Math.sqrt(bug.stats.mass / foe.stats.mass), 0.6, 1.5);
    const speed = bug.stats.vMax * ACTIONS.SPIN_KNOCK * heft;
    foe.vel = foe.vel.add(n.scale(Math.max(0, speed - foe.vel.dot(n))));
    foe.lunge = null;
    foe.spin = null;
    const zone = foe.zoneFacing(n.negate());
    let mult = ACTIONS.SPIN_IMPACT_MULT;
    if (zone === 'front' || (zone === 'rear' && foe.chassis?.stats.backwards)) mult *= PHYSICS.FRONT_HIT_REDUCTION;
    const dmg = PHYSICS.IMPACT_DAMAGE_K * Math.max(0, speed - PHYSICS.IMPACT_THRESHOLD) * bug.stats.mass * mult;
    const res = foe.takeDamage(dmg, zone, { side: foe.sideFacing(n.negate()) });
    foe.lastHitBy = bug;
    this.report(foe, res, { zone, source: bug, kind: 'impact' });
    this.emit(EVENTS.COLLISION, { a: bug, b: foe, normal: n, impact: speed, point: bug.pos.add(n.scale(bug.radius)), spin: true });
  }

  /**
   * Swipe: a handbrake turn. The bug keeps going the way it's actually
   * moving (forward, or backward if it's being shoved back), carves a sharp
   * 90° arc toward the swipe side, then drives straight at the new angle
   * until the next input. A swipe along the line of travel just drives
   * straight on; a swipe against it flips forward/reverse.
   */
  dash(bug, dir) {
    if (bug.twinDrive && !bug.stats.vector) return this.spinAttack(bug, dir);
    if (bug.actionCooldown > 0) return false;
    if (!this.canAct(bug, ACTIONS.DASH_COST)) return false;
    const d = dir.normalize();
    // Thrust vectoring: a swipe is just a quick nudge, about a vehicle's length, the way you swiped.
    if (bug.stats.vector) {
      bug.control.target = bug.pos.add(d.scale(bug.radius * ACTIONS.VECTOR_NUDGE));
      bug.control.backing = false;
      bug.control.reverse = false;
      bug.control.cruise = null;
      bug.stamina -= ACTIONS.DASH_COST;
      bug.actionCooldown = ACTIONS.ACTION_COOLDOWN;
      this.emit(EVENTS.ACTION, { bug, type: 'swerve', dir: d });
      return true;
    }
    const heading = Vector2D.fromAngle(bug.angle);
    const fwd = bug.vel.dot(heading);
    let reverse = Math.abs(fwd) > ACTIONS.SWERVE_MOVING_SPEED ? fwd < 0 : bug.control.reverse;
    const travel = heading.scale(reverse ? -1 : 1);
    const side = travel.cross(d);
    let angle;
    if (Math.abs(side) >= ACTIONS.SWERVE_SIDE_THRESHOLD) {
      angle = travel.angle() + Math.sign(side) * (Math.PI / 2);
    } else if (travel.dot(d) >= 0) {
      angle = travel.angle();
    } else {
      reverse = !reverse;
      angle = travel.angle() + Math.PI;
    }
    bug.control.target = null;
    bug.control.reverse = reverse;
    bug.control.backing = false;
    bug.control.cruise = { angle: wrapAngle(angle) };
    bug.stamina -= ACTIONS.DASH_COST;
    bug.actionCooldown = ACTIONS.ACTION_COOLDOWN;
    this.emit(EVENTS.ACTION, { bug, type: 'swerve', dir: travel });
    return true;
  }

  /** Geometry test: would this weapon connect right now? */
  weaponCheck(bug, weapon) {
    const target = this.other(bug);
    const toT = target.pos.sub(bug.pos);
    const centerDist = toT.length();
    const gap = centerDist - bug.radius - target.radius;
    const diff = Math.abs(wrapAngle(toT.angle() - bug.angle));
    const inArc = weapon.stats.arc >= 360 || diff <= (weapon.stats.arc * Math.PI) / 360;
    const inRange = gap <= weapon.stats.range;
    return { target, dir: toT.normalize(), centerDist, gap, inArc, inRange, hit: inArc && inRange && !target.out };
  }

  fireWeapon(bug, index) {
    const w = bug.weapons[index];
    if (!w) return this.fail(bug, 'NO WEAPON');
    if (w.isBroken) return this.fail(bug, 'WEAPON BROKEN');
    if ((bug.cooldowns[w.uid] || 0) > 0) return this.fail(bug, 'RECHARGING');
    const st = w.stats;
    if (!this.canAct(bug, st.cost)) return false;

    bug.stamina -= st.cost;
    bug.cooldowns[w.uid] = st.cooldown;
    const eff = 0.5 + 0.5 * w.hpRatio;
    const chk = this.weaponCheck(bug, w);
    const { target, dir } = chk;
    let hit = chk.hit;
    let point = target.pos.clone();

    switch (st.effect) {
      case 'drain':
        if (hit) {
          target.drainStamina(st.drain * eff);
          target.effects.flash = 0.2;
          this.physics.updateStall(target);
        }
        break;
      case 'ram':
        if (hit) {
          const res = target.damageSlot('engine', st.engineDamage * eff);
          target.vel.addInPlace(dir, (st.impulse * eff * 160) / target.stats.mass);
          this.report(target, res, { zone: 'front', source: bug, kind: 'ram' });
        }
        break;
      case 'spikes':
        bug.effects.spikes = st.duration;
        hit = true;
        break;
      case 'lift':
        bug.effects.exposed = st.exposeTime;
        if (hit) {
          target.effects.lifted = st.liftTime * eff;
          target.effects.liftGrip = st.gripMod;
          target.vel.addInPlace(dir, 90);
        }
        break;
      case 'slick': {
        bug.effects.exposed = st.exposeTime;
        const heading = Vector2D.fromAngle(bug.angle);
        const reach = Math.min(st.range, Math.max(70, chk.centerDist));
        point = bug.pos.add(heading.scale(reach));
        this.puddles.push({ pos: point, radius: st.puddleRadius, gripMod: st.gripMod, time: st.puddleTime, maxTime: st.puddleTime, seed: Math.random() * 1000 });
        hit = point.distanceTo(target.pos) < st.puddleRadius + target.radius * 0.4;
        break;
      }
      default:
        break;
    }

    this.emit(EVENTS.WEAPON_FIRE, { bug, weapon: w, target, hit, effect: st.effect, point, dir });
    return true;
  }
}

/**
 * Opponent brain: keeps off the edge, manages stamina, pushes outward,
 * rams when aligned and fires weapons when they would connect.
 */
export class AIController {
  /** @param {string|null} style a PILOT_STYLES key — shapes how the pilot fights */
  constructor(me, foe, difficulty = 0.5, style = null) {
    this.me = me;
    this.foe = foe;
    this.difficulty = difficulty;
    this.style = { ram: 1, shove: 1, fire: 1, dodge: 1, rest: 1, ...(PILOT_STYLES[style]?.ai || {}) };
    this.think = 0.4;
    this.reaction = 0.5 - 0.35 * difficulty;
    this.resting = false;
    // A good pilot in a back-to-front shell knows its secret: back into every fight.
    this.backs = !!me.chassis?.stats.backwards && difficulty >= PILOT_SKILL.BACKS_IN;
  }

  update(dt, engine) {
    this.engine = engine;
    const { me, foe, difficulty, style } = this;
    if (me.out || me.stalled || foe.out) return;
    this.think -= dt;
    if (this.think > 0) return;
    this.think = this.reaction * (0.7 + Math.random() * 0.6);

    // Distances measured as "how far towards an edge", so the same rules work on every dohyo.
    const R = ARENA.R0;
    const myD = R - engine.edgeDistance(me.pos);
    const foeD = R - engine.edgeDistance(foe.pos);
    const sFrac = me.stamina / me.stats.staminaMax;
    const toFoe = foe.pos.sub(me.pos);
    const dist = toFoe.length();

    // On a tilted ring a good pilot reads the slope: the downhill edge is the dangerous one.
    const tilt = this.slopeSense(engine);
    const nearDownhill = tilt && me.pos.length() > 1 && engine.dohyo.outward(me.pos, engine.time).dot(tilt.down) > 0.4;

    // 1. Edge danger: head for the middle (sooner when the ring falls away beneath you).
    if (myD > R - me.radius * (nearDownhill ? 1.7 + 4 * tilt.slope : 1.7)) {
      const safe = engine.dohyo.safePoint(me.pos, engine.time);
      engine.moveTo(me, safe, { route: true });
      if (dist < 120 && sFrac > 0.3 && !me.twinDrive && Math.random() < difficulty * 0.5 * style.dodge) {
        engine.dash(me, safe.sub(me.pos).normalize());
      }
      return;
    }

    // 2. Stamina management — idle to cool, hysteresis to avoid dithering.
    const low = (0.18 + 0.12 * difficulty) * style.rest; // hotheads barely rest, turtles rest early
    if (sFrac < low) this.resting = true;
    if (this.resting && sFrac > low + 0.25) this.resting = false;
    if (this.resting) {
      engine.stop(me);
      if (foe.lunge && dist < 140 && sFrac > 0.12 && !me.twinDrive) engine.dash(me, this.dodgeDir(toFoe));
      return;
    }

    // Spinner: good pilots know how far out their grip can hold them, and
    // fight their way back towards the middle before the floor flings them.
    const spinSafe = this.spinnerSafeRadius(engine);
    if (spinSafe !== null && me.pos.length() > spinSafe) {
      engine.moveTo(me, me.pos.scale(Math.min(0.5, (spinSafe * 0.4) / Math.max(1, me.pos.length()))));
      return;
    }

    // Low-skill pilots hesitate, idling instead of pressing the attack.
    if (Math.random() < (1 - difficulty) * 0.35) {
      engine.stop(me);
      return;
    }

    // 3. Weapons.
    me.weapons.forEach((w, i) => {
      if (this.shouldFire(engine, w, foeD, R, dist)) engine.fireWeapon(me, i);
    });

    // 4. Positioning, by temperament.
    const outward = foe.pos.length() > 1 ? engine.dohyo.outward(foe.pos, engine.time) : toFoe.normalize();
    const longGun = me.weapons.some((w) => !w.isBroken && w.stats.range >= 120);
    if (style.keepAway && longGun && dist < 200) {
      // Zappers hold at weapon range.
      engine.moveTo(me, engine.clampInside(foe.pos.sub(toFoe.normalize().scale(200)), me.radius * 1.5), { route: true });
    } else if (style.holdCenter && foeD < R * 0.6 && dist > 170) {
      // Turtles sit near the middle and wait for you to come to them (then brace and push back).
      engine.moveTo(me, engine.clampInside(engine.dohyo.safePoint(foe.pos, engine.time), me.radius * 1.5), { backing: this.backs, route: true });
    } else {
      // Everyone else closes in, aiming past the opponent to shove them outward.
      engine.moveTo(me, engine.clampInside(foe.pos.add(outward.scale(45)), me.radius * 1.2), { backing: this.backs, route: true });
    }

    // …and on the Spinner they never chase past it.
    if (spinSafe !== null && me.control.target && me.control.target.length() > spinSafe) {
      me.control.target = me.control.target.scale(spinSafe / me.control.target.length());
    }

    // 5. Rams & shoves when lined up.
    const facing = me.angle + (this.backs ? Math.PI : 0);
    const aligned = Math.abs(wrapAngle(toFoe.angle() - facing)) < 0.55;
    // With the hill behind them, a shove is worth more: good pilots go for it far more readily.
    const downhillShot = tilt && toFoe.dot(tilt.down) > dist * 0.4 ? 1 + 6 * tilt.slope : 1;
    if (dist < 180 && aligned && me.actionCooldown <= 0) {
      if (foeD > R * 0.5 / Math.sqrt(downhillShot) && sFrac > 0.6 && Math.random() < (0.1 + 0.35 * difficulty) * style.shove * downhillShot) engine.ram(me, true);
      else if (sFrac > 0.4 && Math.random() < (0.05 + 0.25 * difficulty) * style.ram) engine.ram(me, false);
    }

    // Twin drives: spin into them when they're close enough to catch — better pilots, more often.
    if (me.twinDrive && dist < me.radius + foe.radius + ACTIONS.SPIN_REACH && sFrac > 0.4 && me.actionCooldown <= 0 && !(me.cooldowns.spin > 0)
      && Math.random() < 0.05 + 0.25 * difficulty) {
      engine.dash(me, toFoe.perp());
      return;
    }

    // 6. Dodge incoming lunges.
    if (!me.twinDrive && foe.lunge && dist < 160 && sFrac > 0.25 && Math.random() < difficulty * 0.6 * style.dodge) {
      engine.dash(me, this.dodgeDir(toFoe));
    }
  }

  /**
   * On the Spinner, the radius a skilled pilot (skill ≥ SPIN_SKILL) won't go
   * beyond: where the grip needed to ride the floor round (ω²r) would use up
   * most of their grip. Better pilots cut it finer. Null otherwise.
   */
  spinnerSafeRadius(engine) {
    if (engine.dohyo.kind !== 5 || this.difficulty < PILOT_SKILL.SPIN_SKILL) return null;
    const w = engine.dohyo.spinRate(engine.time);
    if (w < 0.05) return null;
    const grip = this.me.stats.mass > 0 ? this.me.stats.fGrip / this.me.stats.mass : 0;
    const margin = 0.45 + 0.3 * this.difficulty; // share of their grip they'll spend just holding on
    const safe = (grip * margin) / (w * w);
    // Only once the spin is fast enough to matter: until then the ring's edge is the only danger.
    if (safe > engine.arenaRadius * 0.85) return null;
    return Math.max(this.me.radius * 2, safe);
  }

  /**
   * On a tilted ring, what a skilled pilot (skill ≥ SLOPE_SKILL) knows about it:
   * which way is down and how steep it is. Null otherwise, or while it's barely tilted.
   */
  slopeSense(engine) {
    if (!engine.dohyo.tilted || this.difficulty < PILOT_SKILL.SLOPE_SKILL) return null;
    const slope = engine.dohyo.slope(engine.time);
    return slope < 0.05 ? null : { down: engine.dohyo.downhill, slope };
  }

  /** Sidestep perpendicular to the threat, towards the safe part of the ring. */
  dodgeDir(toFoe) {
    let d = toFoe.perp().normalize();
    const safe = this.engine ? this.engine.dohyo.safePoint(this.me.pos, this.engine.time).sub(this.me.pos) : this.me.pos.negate();
    if (d.dot(safe) < 0) d = d.negate();
    return d;
  }

  shouldFire(engine, w, foeD, R, dist) {
    const { me, foe, difficulty } = this;
    if (w.isBroken || (me.cooldowns[w.uid] || 0) > 0) return false;
    if (me.stamina < w.stats.cost + 12) return false;
    if (Math.random() > (0.3 + 0.7 * difficulty) * this.style.fire) return false;
    const chk = engine.weaponCheck(me, w);
    switch (w.stats.effect) {
      case 'drain': return chk.hit && !foe.stalled && foe.stamina > 25;
      case 'ram':
      case 'lift': return chk.hit;
      case 'spikes': return dist < 110;
      case 'slick': return chk.inRange && foeD > R * 0.45;
      default: return false;
    }
  }
}

/**
 * A racing pilot on the Weevil Weave: follows the track towards the finish,
 * easing off into the hairpins, and shoves you out of the way when you're
 * in the lane ahead. Better pilots carry more speed and shove more often.
 */
export class RaceAI {
  /** @param {number} dir +1 racing from the start of the track, -1 from the end */
  constructor(me, foe, difficulty, track, dir) {
    this.me = me;
    this.foe = foe;
    this.difficulty = difficulty;
    this.track = track;
    this.dir = dir;
    this.think = 0.3;
  }

  update(dt, engine) {
    const { me, foe, track, dir, difficulty } = this;
    if (me.out || me.stalled) return;
    this.think -= dt;
    if (this.think > 0) return;
    const v = me.vel.length();
    // Quick reactions at speed: a fast bug covers a lot of track between decisions.
    this.think = Math.min(0.12 + (1 - difficulty) * 0.2, 30 / Math.max(1, v));
    // Nervous pilots lift off now and then.
    if (Math.random() < (1 - difficulty) * 0.12) { engine.stop(me); return; }
    const { s } = track.nearest(me.pos);
    const here = track.tangentAt(s);
    const turnAt = (d) => { const t = track.tangentAt(s + dir * d); return Math.abs(Math.atan2(here.cross(t), here.dot(t))); };
    // How fast this bug can take a hairpin on its grip (castors hardly at all), and how far it needs to slow down.
    const st = me.stats;
    const aLat = st.mass > 0 ? (st.fGrip / st.mass) * PHYSICS.LATERAL_GRIP * (st.lateralMult ?? 1) : 0;
    const vCurve = Math.sqrt(aLat * 130) * (0.55 + 0.35 * difficulty);
    // Brake whichever way stops harder: lift off and let the grip (and any reverse thrusters) slow you, or drive backwards.
    const aCoast = PhysicsEngine.idleBrake(st);
    const aReverse = st.accelRev ?? st.accel;
    const aBrake = Math.max(aCoast, aReverse) * 0.85;
    const brakeDist = Math.max(0, (v * v - vCurve * vCurve) / (2 * Math.max(1, aBrake))) + 60 + v * this.think;
    let bendAhead = false;
    for (let d = 40; d <= brakeDist; d += 40) if (turnAt(d) > 0.5) { bendAhead = true; break; }
    if (bendAhead && v > vCurve) {
      // Too hot for the bend: scrub off speed.
      if (aCoast >= aReverse) engine.stop(me);
      else engine.moveTo(me, me.pos.sub(me.vel.normalize().scale(120)));
      return;
    }
    // Look further ahead on the straights, closer (slower) into a hairpin.
    const look = turnAt(140) > 0.5 ? 55 + 45 * difficulty : 120 + 60 * difficulty;
    engine.moveTo(me, track.pointAt(s + dir * look));
    // The other racer in the lane ahead: shove them off (or out of the way).
    const toFoe = foe.pos.sub(me.pos);
    const dist = toFoe.length();
    const facing = Math.abs(Math.atan2(Vector2D.fromAngle(me.angle).cross(toFoe), Vector2D.fromAngle(me.angle).dot(toFoe))) < 0.5;
    if (!foe.out && dist < 170 && facing && me.actionCooldown <= 0 && me.stamina > 30 && Math.random() < 0.15 + 0.4 * difficulty) {
      engine.ram(me, Math.random() < 0.5);
    }
  }
}
