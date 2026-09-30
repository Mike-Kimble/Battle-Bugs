import { PHYSICS, STAMINA, EVENTS } from '../config/constants.js';
import { Vector2D, clamp, approach, wrapAngle } from './Vector2D.js';
import { INTERACTIONS, worksWith, JACKET_NAMES, THRUST_DRIVES, pushesThrust, hasShaft, hasDriveTrain } from '../config/partsData.js';

/** Drive-train parts that live between the drive shaft and the wheels (useless without a shaft). */
const SHAFT_PARTS = ['gearbox', 'lockgear', 'transfer', 'diff', 'coupling', 'converter'];

/** Coolers a fan can blow on to boost. */
const FAN_BOOSTS = ['water', 'oil', 'exchanger'];

/**
 * Physics & derived-stats engine.
 *
 *   m         = m_chassis + Σ m_part
 *   F_drive   = F_base × (HP_engine / MaxHP_engine)
 *   F_grip    = μ_tires × m × g × (HP_tires / MaxHP_tires) × gripMod
 *   F_usable  = min(F_drive, F_grip)
 *   a         = F_usable / m
 *   v_max     = rpm × r_tire × k × wear(HP_tires)
 *   ΔS        ∝ F_drive · v   (continuous, while driving)
 */
export class PhysicsEngine {
  /** @param {import('../core/EventEmitter.js').EventEmitter} emitter */
  constructor(emitter) {
    this.emitter = emitter;
  }

  /**
   * The part combinations at work on this bug (see INTERACTIONS), each with
   * its resolved stat multipliers.
   * @returns {Array<{id, good, text, mods}>}
   */
  static interactions(bug) {
    const out = [];
    for (const rule of INTERACTIONS) {
      if (!rule.when(bug)) continue;
      out.push({ id: rule.id, good: rule.good, text: rule.text, mods: { ...rule.mods, ...(rule.dynamic?.(bug) || {}) } });
    }
    return out;
  }

  /**
   * Cooling add-ons and enhancements: folds their multipliers into `m` and
   * returns the extra cooling (stamina/s). Parts that don't suit the drive,
   * are used up, or are destroyed do nothing. Notes go into `interactions`
   * so the mechanic can talk about them.
   */
  static addOns(bug, m, interactions) {
    let cool = 0;
    // Twin drives: every add-on works at 70% (its bonus or penalty scaled back).
    const k = (bug.drives?.length || 0) > 1 ? PHYSICS.TWIN_POWER : 1;
    const scaled = (mult) => 1 + (mult - 1) * k;
    const live = (p) => !p.spent && !p.isBroken && worksWith(p, bug);
    const coolers = (bug.coolers || []).filter(live);
    const fans = coolers.filter((c) => c.stats.kind === 'fan');
    const boost = fans.reduce((b, f) => Math.max(b, f.stats.boost || 1), 1);
    for (const c of coolers) {
      cool += c.stats.cool;
      // A fan blowing on water cooling or a heat exchanger makes it far better.
      if (boost > 1 && FAN_BOOSTS.includes(c.stats.kind)) cool += c.stats.cool * (boost - 1);
      if (c.stats.staminaMax) m.staminaMax *= scaled(c.stats.staminaMax);
    }
    const vented = (bug.armor?.stats.heat || 0) < 0 && !bug.armor.isBroken;
    for (const f of fans) if (vented) cool += f.stats.ventBonus || 0;
    const partner = coolers.some((c) => FAN_BOOSTS.includes(c.stats.kind));
    if (fans.length && partner) interactions.push({ id: 'fan_boost', good: true, mods: {}, text: 'Your fan is blowing on the liquid cooling / heat exchanger — a big boost to cooling.' });
    else if (fans.length && vented) interactions.push({ id: 'fan_vent', good: true, mods: {}, text: 'Your fan pushes air through the vented armour. Nice.' });
    else if (fans.length) interactions.push({ id: 'fan_alone', good: false, mods: {}, text: 'A fan on its own does almost nothing — pair it with water or oil cooling, a heat exchanger or vented armour.' });

    for (const e of (bug.mods || []).filter(live)) {
      const s = e.stats;
      for (const key of ['force', 'accel', 'vMax', 'staminaMax', 'drain']) if (s[key]) m[key] *= scaled(s[key]);
      if (s.cool) cool += s.cool;
    }
    for (const p of [...(bug.coolers || []), ...(bug.mods || [])]) {
      if (p.spent) interactions.push({ id: `spent_${p.uid}`, good: false, mods: {}, text: `Your ${p.name} is used up — strip it out.` });
      else if (!worksWith(p, bug)) {
        interactions.push({ id: `nofit_${p.uid}`, good: false, mods: {},
          text: p.stats.jacket
            ? `Your ${p.name} needs ${/^[AEIOU]/.test(JACKET_NAMES[p.stats.jacket]) ? 'an' : 'a'} ${JACKET_NAMES[p.stats.jacket]} on this drive — it's dead weight without one.`
            : `Your ${p.name} doesn't work with this drive — it's dead weight.` });
      }
    }
    const jackets = (bug.coolers || []).filter((c) => c.stats.jacketFor);
    for (const j of jackets) {
      if (!(bug.coolers || []).some((c) => c.stats.jacket === j.stats.jacketFor)) {
        interactions.push({ id: `jacket_${j.uid}`, good: false, mods: {}, text: `Your ${j.name} isn't hooked up to anything — it needs its liquid cooler.` });
      }
    }
    return { cool: cool * k };
  }

  /**
   * Drive-train parts: folds their multipliers into `m` (force, accel, vMax,
   * turn, grip, drain, brake, lateral) and returns the special effects. Only
   * one part per group works (one gearbox, one shaft, one prop); parts that
   * don't suit the drive, or are broken, do nothing.
   */
  static driveTrain(bug, m, interactions, castor) {
    const fx = { vector: false, prop: 0, propRpm: false, lsl: false, tcu: false, guard: 1 };
    const groups = new Set();
    const turbine = bug.engine?.stats.kind === 'turbine';
    const hss = hasDriveTrain(bug, (s) => s.shaft === 'hss');
    const shaft = hasShaft(bug);
    const tracks = bug.tires?.stats.kind === 'track';
    for (const p of bug.drivetrain || []) {
      const s = p.stats;
      if (p.isBroken || !worksWith(p, bug)) {
        if (!p.isBroken) interactions.push({ id: `dt_nofit_${p.uid}`, good: false, mods: {}, text: `Your ${p.name} doesn't suit this drive — it's dead weight.` });
        continue;
      }
      // Gearboxes, diffs, couplings and the like sit between the drive shaft and the wheels.
      if (SHAFT_PARTS.includes(s.kind) && !castor && !shaft) {
        interactions.push({ id: `dt_noshaft_${p.uid}`, good: false, mods: {}, text: `Your ${p.name} does nothing without a drive shaft to connect it.` });
        continue;
      }
      // A gearbox on a turbine only works behind a High-Speed Shaft.
      if (s.group === 'gearbox' && turbine && !hss) {
        interactions.push({ id: `dt_nohss_${p.uid}`, good: false, mods: {}, text: `Your ${p.name} can't take turbine revs through a plain shaft — it needs a High-Speed Shaft on the turbine side.` });
        continue;
      }
      if (s.wheelsOnly && tracks) {
        interactions.push({ id: `dt_tracks_${p.uid}`, good: false, mods: {}, text: `A ${p.name} does nothing for tracks — they already drive along their whole length.` });
        continue;
      }
      if (s.group) {
        if (groups.has(s.group)) {
          interactions.push({ id: `dt_dup_${p.uid}`, good: false, mods: {}, text: `You've got two ${s.group === 'prop' ? 'propellers' : `${s.group}s`} — only one can do anything. The ${p.name} is dead weight.` });
          continue;
        }
        groups.add(s.group);
      }
      const onTyres = (k) => !(castor && s.tyresOnly?.includes(k)); // some parts only matter on driven wheels
      for (const k of ['force', 'accel', 'vMax', 'turn', 'grip', 'drain', 'brake']) if (s[k] && onTyres(k)) m[k] *= s[k];
      if (s.vector) fx.vector = true;
      if (s.prop) { fx.prop = s.prop; fx.propRpm = !!s.propRpm; }
      if (s.lsl) fx.lsl = true;
      if (s.tcu && onTyres('tcu')) fx.tcu = true;
      if (s.rudder) fx.rudder = true;
      if (s.kind === 'reverser') fx.reverser = true;
    }
    // Prop or ducted fan plus rudders on castors: steers like a fish.
    if (castor && fx.prop && fx.rudder) { m.turn *= 1.4; m.lateral *= 2.5; }
    return fx;
  }

  /**
   * Derive live stats for a bug from its equipped parts.
   * @param {import('../entities/BattleBug.js').BattleBug} bug
   * @param {{gripMod?: number}} mods
   */
  static deriveStats(bug, mods = {}) {
    const gripMod = mods.gripMod ?? 1;
    const chassis = bug.chassis;
    const engine = bug.engine;
    const tires = bug.tires;

    const mass = bug.parts.reduce((sum, p) => sum + p.mass, 0);
    // Twin drives add their force; a damaged side pulls the bug off line.
    const drives = bug.drives || (engine ? [engine] : []);
    const driveForces = drives.map((d) => (d.isBroken ? 0 : d.stats.force * d.hpRatio)); // broken down = no push
    const forceSum = driveForces.reduce((a, b) => a + b, 0);
    let twinBias = drives.length === 2 && forceSum > 0 ? (driveForces[0] - driveForces[1]) / forceSum : 0;
    const engineRatio = drives.length ? drives.reduce((t, d) => t + d.hpRatio, 0) / drives.length : 0;
    const tireRatio = tires && !tires.isBroken ? tires.hpRatio : 0;
    // Part combinations that help or hurt.
    const m = { force: 1, grip: 1, vMax: 1, cooling: 1, staminaMax: 1, drain: 1, accel: 1, turn: 1, brake: 1, lateral: 1 };
    const interactions = PhysicsEngine.interactions(bug);
    for (const it of interactions) for (const k in it.mods) m[k] *= it.mods[k];
    const addOns = PhysicsEngine.addOns(bug, m, interactions);
    const castor = tires?.type === 'castor';
    const dt = PhysicsEngine.driveTrain(bug, m, interactions, castor);
    if (dt.lsl) twinBias = 0; // a Limited-Slip Link shares torque: no pulling to one side

    // Two motors through one set of running gear: each gives at most 70% of its power.
    const fDrive = forceSum * (drives.length > 1 ? PHYSICS.TWIN_POWER : 1) * m.force;
    // Castors aren't driven: a thrust drive pushes the body straight (no traction
    // limit), less the rolling resistance. What holds the line and brakes is
    // `hold` — as slippery as the rolling resistance on most castors.
    const thrustDrive = THRUST_DRIVES.includes(engine?.stats.kind);
    const thrust = castor && !tires.isBroken && pushesThrust(bug);
    const rpmAvg = drives.length ? drives.reduce((t, d) => t + d.stats.rpm, 0) / drives.length : 0;
    // A propeller or ducted fan turns shaft power into thrust (a ducted fan makes more of high revs).
    const propEff = dt.prop * (dt.propRpm ? 0.7 + 0.5 * (rpmAvg / 6400) : 1);
    // A prop or fan on a turbine adds to its thrust (a fifth of the prop's own efficiency).
    const propBoost = thrustDrive ? propEff * PHYSICS.PROP_BOOST : 0;
    const thrustEff = thrustDrive ? PHYSICS.CASTOR_THRUST + propBoost : propEff;
    const rollForce = castor ? tires.stats.roll * (2 - tireRatio) * mass * PHYSICS.GRAVITY : 0; // damage adds drag
    const gripMu = castor ? (tires.stats.hold ?? tires.stats.roll) : tires?.stats.mu || 0;
    const fGripBase = tires ? gripMu * mass * PHYSICS.GRAVITY * (castor ? 1 : tireRatio) * m.grip : 0;
    const fGrip = fGripBase * gripMod;
    // Wheels and tracks need a drive shaft. Without one a turbine pushes on thrust alone
    // (half strength); plasma can never drive wheels; any other motor goes nowhere.
    const shaftDrive = !castor && !!engine && engine.stats.kind !== 'plasma' && hasShaft(bug);
    const wheelThrust = !castor && !shaftDrive && thrustDrive;
    const push = (f) => (castor ? (thrust ? Math.max(0, f * thrustEff - rollForce) : 0)
      : shaftDrive ? Math.min(f, fGrip)
        : wheelThrust ? f * (PHYSICS.THRUST_ON_WHEELS + propBoost) : 0);
    const fUsable = push(fDrive);
    const accel = mass > 0 ? (fUsable / mass) * m.accel : 0;
    // Back-to-front shells: the forward penalty is undone and then some in reverse.
    const back = chassis.stats.backwards;
    const fDriveRev = back ? (fDrive / back.fwd) * back.rev : fDrive;
    const accelRev = mass > 0 ? (push(fDriveRev) / mass) * m.accel : 0;

    const wear = PHYSICS.TIRE_WEAR_FLOOR + (1 - PHYSICS.TIRE_WEAR_FLOOR) * tireRatio;
    const vMax = engine && tires ? rpmAvg * tires.stats.radius * PHYSICS.RPM_TO_SPEED * wear * m.vMax : 0;

    return {
      mass,
      fDrive,
      fGrip,
      fGripBase,
      fUsable,
      accel,
      accelRev,
      vMax,
      engineRatio,
      tireRatio,
      gripMod,
      radius: chassis.stats.radius * PHYSICS.BUG_SCALE,
      staminaMax: Math.round(chassis.stats.staminaMax * m.staminaMax),
      cooling: engine ? Math.round((drives.reduce((t, d) => t + d.stats.cooling, 0) * (drives.length > 1 ? PHYSICS.TWIN_POWER : 1) * m.cooling + addOns.cool) * 10) / 10 : 0,
      twinBias,
      drainMult: m.drain,
      interactions,
      turnRate: chassis.stats.turn * (0.55 + 0.45 * tireRatio) * m.turn,
      brakeMult: m.brake,     // braking and holding ground when not driving
      lateralMult: m.lateral, // sideways grip (castors slide less with a prop & rudders)
      vector: castor && thrust && dt.vector,
      tcu: dt.tcu,
      reverser: !!dt.reverser,
      tractionLimited: shaftDrive && fGrip < fDrive,
      castor,
      pinned: castor && !!tires.stats.pinned,
      // Wheels or tracks nothing is holding: no motor, no working shaft, or a thrust
      // drive on wheels — unless a self-locking gearbox (worm, cycloidal, strain wave) holds them.
      freeRoll: !!tires && !castor && !tires.isBroken && !shaftDrive
        && !(bug.drivetrain || []).some((p) => p.stats.kind === 'lockgear' && !p.isBroken),
    };
  }

  /** Deceleration when not driving: grip-braking (times any drive-train brake), plus reverse thrusters firing. */
  static idleBrake(s) {
    if (!(s.mass > 0)) return 0;
    const grip = (s.fGrip / s.mass) * PHYSICS.IDLE_BRAKE * (s.brakeMult ?? 1);
    return grip + (s.reverser ? s.accel * PHYSICS.REVERSER_BRAKE : 0);
  }

  /** Current grip modifier from status effects and the environment (slick puddles). */
  gripModifier(bug, env) {
    let mod = 1;
    if (bug.effects.lifted > 0) mod = Math.min(mod, bug.effects.liftGrip ?? 0.1);
    for (const puddle of env.puddles || []) {
      if (bug.pos.distanceTo(puddle.pos) < puddle.radius + bug.radius * 0.4) {
        mod = Math.min(mod, puddle.gripMod);
      }
    }
    // Traction control cuts the power the instant a wheel slips: half the grip loss.
    if (bug.stats?.tcu) mod = 1 - (1 - mod) * 0.5;
    return mod;
  }

  /**
   * Advance the simulation.
   * @param {BattleBug[]} bugs
   * @param {number} dt
   * @param {{puddles?: Array}} env
   */
  step(bugs, dt, env = {}) {
    for (const bug of bugs) {
      if (bug.out) continue;
      this.integrate(bug, dt, env);
    }
    for (let i = 0; i < bugs.length; i++) {
      for (let j = i + 1; j < bugs.length; j++) {
        this.collide(bugs[i], bugs[j]);
      }
    }
  }

  integrate(bug, dt, env) {
    const s = PhysicsEngine.deriveStats(bug, { gripMod: this.gripModifier(bug, env) });
    bug.stats = s;
    bug.tickTimers(dt);

    let throttle = 0;
    let lateralGrip = PHYSICS.LATERAL_GRIP;
    const canDrive = !bug.stalled && s.fDrive > 0;
    const ctl = bug.control;
    // Direction of travel: the nose when driving forward, the tail in reverse.
    const travelAngle = () => bug.angle + (ctl.reverse ? Math.PI : 0);
    // Uneven twin drives: the stronger side keeps shoving the nose round, so
    // the bug settles off its line and drives in a curve.
    // On a slope, gravity swings the nose round towards downhill: moving across it you
    // have to steer against the pull (a steady skew, like an uneven twin drive).
    const downhillPull = () => {
      if (!env.slope) return 0;
      const h = Vector2D.fromAngle(bug.angle);
      return h.cross(env.downhill) * env.slope * PHYSICS.SLOPE_SKEW * (ctl.reverse ? -1 : 1);
    };
    const skew = () => (s.twinBias || 0) * PHYSICS.TWIN_SKEW * (ctl.reverse ? -1 : 1) + downhillPull();
    const steer = (diff, rate) => {
      const maxTurn = rate * dt;
      bug.angle = wrapAngle(bug.angle + clamp(diff + skew(), -maxTurn, maxTurn));
    };

    if (bug.spin) {
      // Twin drives turning opposite ways: a full 360° on the spot.
      bug.angle = wrapAngle(bug.angle + bug.spin.rate * dt); // no drive: it only brakes like an idle bug
      bug.spin.time -= dt;
      if (bug.spin.time <= 0) bug.spin = null;
    } else if (canDrive && bug.lunge) {
      // Rams/shoves: heading already snapped, full power (tail first for a reverse ram).
      ctl.reverse = !!bug.lunge.reverse;
      throttle = 1;
    } else if (canDrive && ctl.cruise) {
      // Swipe: a sharp, drifting 90° arc, then straight on at the new angle.
      const diff = wrapAngle(ctl.cruise.angle - travelAngle());
      const turning = Math.abs(diff) > 0.05;
      steer(diff, s.turnRate * (turning ? PHYSICS.SWERVE_TURN_MULT : 1));
      if (turning) lateralGrip = PHYSICS.SWERVE_LATERAL_GRIP;
      throttle = 1;
    } else if (canDrive && ctl.target) {
      const to = ctl.target.sub(bug.pos);
      const dist = to.length();
      if (dist < PHYSICS.ARRIVE_RADIUS) {
        ctl.target = null;
      } else if (ctl.backing) {
        // Backing in on purpose: tail first, and hold it even when shoved.
        ctl.reverse = true;
        const diff = wrapAngle(to.angle() - travelAngle());
        steer(diff, s.turnRate);
        const align = Math.cos(diff);
        throttle = (align > 0.2 ? align : 0) * clamp(dist / PHYSICS.SLOW_RADIUS, 0.3, 1);
      } else {
        // Being pushed? (moving against the way we're driving — backwards while
        // driving forward, or forwards while reversing.)
        const along = (env.floorVel ? bug.vel.sub(env.floorVel(bug.pos)) : bug.vel).dot(Vector2D.fromAngle(bug.angle));
        const pushed = ctl.reverse ? along > PHYSICS.PUSHED_SPEED : along < -PHYSICS.PUSHED_SPEED;
        if (pushed && ctl.pushHold <= 0) {
          // The push comes from the direction we're driving. Aim within 45° of it
          // to keep pushing back; aim anywhere else to go with the push and pull out.
          const fromPush = Math.abs(wrapAngle(to.angle() - travelAngle()));
          if (fromPush > PHYSICS.PUSH_BACK_ARC) {
            ctl.reverse = !ctl.reverse;
            ctl.pushHold = PHYSICS.PULL_OUT_HOLD;
          }
        }
        let diff = wrapAngle(to.angle() - travelAngle());
        if (ctl.pushHold > 0) {
          // Pulling out: keep rolling with the push while steering to the new heading.
          ctl.pushHold -= dt;
          steer(diff, s.turnRate);
          throttle = Math.max(0.6, Math.cos(diff));
        } else {
          // Target more than 120° off the direction of travel → flip forward/reverse.
          if (!pushed && Math.abs(diff) > PHYSICS.REVERSE_ANGLE) {
            ctl.reverse = !ctl.reverse;
            diff = wrapAngle(to.angle() - travelAngle());
          }
          steer(diff, s.turnRate);
          const align = Math.cos(diff);
          throttle = align > 0.2 ? align : 0;
        }
        throttle *= clamp(dist / PHYSICS.SLOW_RADIUS, 0.3, 1);
        // Flux-pinned castors brake onto the spot: coast off the power once the
        // stopping distance reaches the target.
        if (s.pinned && s.mass > 0) {
          const brake = PhysicsEngine.idleBrake(s) * 0.8;
          if (bug.vel.length() > Math.sqrt(2 * brake * dist)) throttle = 0;
        }
      }
    }

    // On a turntable everything is relative to the floor under the bug: that
    // point moves at ω × r (faster further out). Grip drags the bug towards the
    // floor's motion, limited like any other friction — so staying put far out
    // on a fast spin needs more grip than you have, and you slide off.
    const floor = env.floorVel ? env.floorVel(bug.pos) : null;
    const heading = Vector2D.fromAngle(bug.angle);
    const side = heading.perp();
    const rel = floor ? bug.vel.sub(floor) : bug.vel;
    let fwd = rel.dot(heading);
    let lat = rel.dot(side);

    const vCap = s.vMax * (bug.lunge ? bug.lunge.speedMult : 1);
    // Back-to-front shells are geared for reverse: no reverse speed penalty.
    const revShare = bug.chassis?.stats.backwards ? 1 : PHYSICS.REVERSE_SPEED;
    const vCapRev = s.vMax * revShare * (bug.lunge?.reverse ? bug.lunge.speedMult : 1);
    const gripDecel = s.mass > 0 ? s.fGrip / s.mass : 0;

    if (throttle > 0 && !ctl.reverse) {
      if (fwd < vCap) fwd = Math.min(vCap, fwd + s.accel * throttle * dt);
    } else if (throttle > 0) {
      if (fwd > -vCapRev) fwd = Math.max(-vCapRev, fwd - (s.accelRev ?? s.accel) * throttle * dt);
    } else if (s.freeRoll) {
      // Nothing holds the wheels: they just roll (the slope's pull stays in the velocity).
      fwd = approach(fwd, 0, PHYSICS.ROLL_RESIST * dt);
    } else {
      fwd = approach(fwd, 0, PhysicsEngine.idleBrake(s) * dt);
    }
    // A free-rolling bug on a slope slews round until it rolls straight downhill (either end first).
    if (s.freeRoll && env.slope && throttle === 0) {
      const toDown = wrapAngle(Math.atan2(env.downhill.y, env.downhill.x) - bug.angle);
      const aim = Math.abs(toDown) > Math.PI / 2 ? wrapAngle(toDown - Math.sign(toDown) * Math.PI) : toDown;
      bug.angle = wrapAngle(bug.angle + clamp(aim, -1, 1) * env.slope * PHYSICS.SLOPE_SLEW * dt);
    }
    // Free wheels coasting aren't bound by the motor's top speed (a motorless bug has none).
    if (!(s.freeRoll && throttle === 0)) {
      if (fwd > vCap) fwd = approach(fwd, vCap, PHYSICS.OVERSPEED_DECEL * dt);
      if (fwd < -vCapRev) fwd = approach(fwd, -vCapRev, PHYSICS.OVERSPEED_DECEL * dt);
    }
    lat = approach(lat, 0, gripDecel * lateralGrip * (s.lateralMult ?? 1) * dt);

    bug.vel = heading.scale(fwd).addInPlace(side, lat);
    if (floor) {
      bug.vel.addInPlace(floor, 1);
      bug.angle = wrapAngle(bug.angle + env.spin * dt); // the floor turns you with it
    }
    bug.pos.addInPlace(bug.vel, dt);
    bug.throttle = throttle;
    bug.odometer += Math.abs(fwd) * dt;

    // Stamina: continuous drain ∝ F_drive · v while driving (partly offset by
    // cooling), full R_cool recovery while idle.
    if (throttle > 0) {
      const applied = s.fUsable * throttle;
      bug.stamina -= STAMINA.DRIVE_DRAIN_K * applied * (Math.abs(fwd) + STAMINA.PUSH_SPEED_FLOOR) * s.drainMult * dt;
      bug.stamina += s.cooling * STAMINA.DRIVING_COOL_FRACTION * dt;
    } else {
      bug.stamina += s.cooling * dt;
    }
    bug.stamina = clamp(bug.stamina, 0, s.staminaMax);
    this.updateStall(bug, s);
  }

  updateStall(bug, s = bug.stats) {
    if (!bug.stalled && bug.stamina <= 0) {
      bug.stalled = true;
      bug.stallStrikes += 1;
      bug.control.target = null;
      bug.control.cruise = null;
      bug.lunge = null;
      this.emitter?.emit(EVENTS.STALL, { bug, strikes: bug.stallStrikes });
    } else if (bug.stalled && bug.stamina >= s.staminaMax * STAMINA.RECOVER_FRACTION) {
      bug.stalled = false;
      this.emitter?.emit(EVENTS.STALL_RECOVER, { bug });
    }
  }

  collide(a, b) {
    if (a.out || b.out) return;
    const delta = b.pos.sub(a.pos);
    const dist = delta.length();
    const minDist = a.radius + b.radius;
    if (dist >= minDist || dist < 1e-6) return;

    const n = delta.scale(1 / dist);
    const overlap = minDist - dist;
    const invA = 1 / a.stats.mass;
    const invB = 1 / b.stats.mass;
    const invSum = invA + invB;

    a.pos.addInPlace(n, -overlap * (invA / invSum));
    b.pos.addInPlace(n, overlap * (invB / invSum));

    const rel = b.vel.sub(a.vel).dot(n);
    let impact = 0;
    if (rel < 0) {
      impact = -rel;
      const j = (-(1 + PHYSICS.RESTITUTION) * rel) / invSum;
      a.vel.addInPlace(n, -j * invA);
      b.vel.addInPlace(n, j * invB);
    }

    const point = a.pos.add(n.scale(a.radius));
    this.emitter?.emit(EVENTS.COLLISION, { a, b, normal: n, impact, point });
  }
}
