import { ARENA, MATCH, PHYSICS, ACTIONS, EVENTS, PILOT_SKILL } from '../config/constants.js';
import { PILOT_STYLES, heavyGear } from '../config/partsData.js';
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
  constructor({ player, opponent, difficulty = 0.5, style = null, dohyo = null, ai = true, training = false }) {
    super();
    this.training = training;
    this.dohyo = dohyo || new Dohyo(1);
    this.player = player;
    this.opponent = opponent;
    this.bugs = [player, opponent];
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

    player.resetForBattle(new Vector2D(-ARENA.R0 * 0.45, 0), 0);
    opponent.resetForBattle(new Vector2D(ARENA.R0 * 0.45, 0), Math.PI);
    // Durability: only cheap armour and cheap running gear can be wrecked in a
    // single match. Everything else loses at most MATCH_DAMAGE_CAP of its max HP
    // per match, so from full it takes at least two fights to drop to 15%.
    for (const bug of this.bugs) {
      for (const p of bug.parts) {
        const fragile = ['armor', 'tires', 'castor'].includes(p.type) && p.tier <= MATCH.FRAGILE_TIER;
        p.battleFloor = fragile ? null : Math.max(0, p.hp - p.maxHp * MATCH.DAMAGE_CAP);
      }
    }
    this.ai = ai ? new AIController(opponent, player, difficulty, style) : null; // a training dummy has no pilot

    this.on(EVENTS.COLLISION, (c) => this.onCollision(c));
  }


  get arenaRadius() { return this.dohyo.radius(this.time); }
  /** The ring is getting harder (shrinking, hole growing, tilting, spinning up). */
  get shrinking() { return this.dohyo.changing(this.time); }
  onRing(pos) { return this.dohyo.onRing(pos, this.time); }
  edgeDistance(pos) { return this.dohyo.edgeDistance(pos, this.time); }
  get live() { return this.phase === 'fight' || this.phase === 'resolving'; }

  other(bug) { return bug === this.player ? this.opponent : this.player; }

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
    if (this.phase === 'fight' && this.ai) this.ai.update(dt, this);

    if (this.live) this.dohyo.applyForces(this.bugs, dt, this.time); // slopes and turntables
    this.physics.step(this.bugs, dt, { puddles: this.puddles, floorVel: this.dohyo.floorVelocity(this.time), spin: this.dohyo.spinRate(this.time) });
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

    if (this.phase === 'fight' && this.time >= MATCH.DURATION) {
      this.finish('tie', 'time');
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
    // The survivor digs in at the tawara: cancel its charge and brake hard so a
    // winning shove doesn't carry it over the edge too.
    for (const other of this.bugs) {
      if (other.out) continue;
      other.lunge = null;
      other.control.target = null;
      other.control.cruise = null;
      other.vel.scaleInPlace(ACTIONS.VICTORY_BRAKE);
    }
    if (reason === 'ringout') this.emit(EVENTS.RING_OUT, { bug });
    if (reason === 'stallout') this.emit(EVENTS.STALL, { bug, strikes: bug.stallStrikes, stallOut: true });
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
    }
    let reason = REASONS[reasonKey] || reasonKey;
    const crit = this.critical;
    if (reasonKey === 'destroyed' && crit) {
      reason = `Catastrophic damage — ${crit.bug.name}'s ${crit.part.name} broke down at ${Math.round(crit.part.hpRatio * 100)}%`;
    }
    this.result = { result, reason, reasonKey, time: this.time };
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
   * chain can't take turbine revs: it snaps halfway through
   * the match, leaving only the turbine's thrust. (Turbines want a High-Speed Shaft.)
   */
  shaftStrain(bug, dt) {
    if (bug.out) return;
    // A chain driving heavy tyres or tracks wears while you drive.
    const chain = bug.drivetrain.find((p) => p.stats.shaft === 'chain' && !p.isBroken);
    if (chain && !this.training && bug.throttle > 0 && heavyGear(bug)) {
      const res = { total: 0, hits: [], broken: [] };
      const r = chain.applyDamage(chain.maxHp * ACTIONS.CHAIN_WEAR * bug.throttle * dt);
      if (r.dealt > 0) res.hits.push({ part: chain, dealt: r.dealt });
      if (r.broke) { res.broken.push(chain); this.emit(EVENTS.PART_BROKEN, { bug, part: chain }); }
    }
    if (this.time < MATCH.DURATION / 2) return;
    const shaft = bug.drivetrain.find((p) => (p.stats.shaft === 'std' || p.stats.shaft === 'chain') && !p.isBroken);
    if (!shaft || bug.engine?.stats.kind !== 'turbine') return;
    shaft.hp = Math.min(shaft.hp, shaft.maxHp * 0.3);
    shaft.failed = true;
    this.emit(EVENTS.PART_BROKEN, { bug, part: shaft, breakdown: true });
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
    if (bug.twinDrive) return this.spinAttack(bug, dir);
    if (bug.actionCooldown > 0) return false;
    if (!this.canAct(bug, ACTIONS.DASH_COST)) return false;
    const d = dir.normalize();
    // Thrust vectoring on castors: no steering — the bug just shoots off the way you swiped.
    if (bug.stats.vector) {
      const speed = Math.max(bug.vel.length(), bug.stats.vMax * ACTIONS.VECTOR_KICK);
      bug.vel = d.scale(speed);
      bug.control.target = null;
      bug.control.backing = false;
      bug.control.reverse = false;
      bug.control.cruise = { angle: wrapAngle(d.angle()) };
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

    // 1. Edge danger: head for the middle.
    if (myD > R - me.radius * 1.7) {
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
    if (dist < 180 && aligned && me.actionCooldown <= 0) {
      if (foeD > R * 0.5 && sFrac > 0.6 && Math.random() < (0.1 + 0.35 * difficulty) * style.shove) engine.ram(me, true);
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
