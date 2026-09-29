import { PHYSICS, STAMINA, EVENTS } from '../config/constants.js';
import { Vector2D, clamp, approach, wrapAngle } from './Vector2D.js';
import { INTERACTIONS, worksWith, JACKET_NAMES } from '../config/partsData.js';

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
    const live = (p) => !p.spent && !p.isBroken && worksWith(p, bug);
    const coolers = (bug.coolers || []).filter(live);
    const fans = coolers.filter((c) => c.stats.kind === 'fan');
    const boost = fans.reduce((b, f) => Math.max(b, f.stats.boost || 1), 1);
    for (const c of coolers) {
      cool += c.stats.cool;
      // A fan blowing on water cooling or a heat exchanger makes it far better.
      if (boost > 1 && (c.stats.kind === 'water' || c.stats.kind === 'exchanger')) cool += c.stats.cool * (boost - 1);
      if (c.stats.staminaMax) m.staminaMax *= c.stats.staminaMax;
    }
    const vented = (bug.armor?.stats.heat || 0) < 0 && !bug.armor.isBroken;
    for (const f of fans) if (vented) cool += f.stats.ventBonus || 0;
    const partner = coolers.some((c) => c.stats.kind === 'water' || c.stats.kind === 'exchanger');
    if (fans.length && partner) interactions.push({ id: 'fan_boost', good: true, mods: {}, text: 'Your fan is blowing on the water cooling / heat exchanger — a big boost to cooling.' });
    else if (fans.length && vented) interactions.push({ id: 'fan_vent', good: true, mods: {}, text: 'Your fan pushes air through the vented armour. Nice.' });
    else if (fans.length) interactions.push({ id: 'fan_alone', good: false, mods: {}, text: 'A fan on its own does almost nothing — pair it with water cooling, a heat exchanger or vented armour.' });

    for (const e of (bug.mods || []).filter(live)) {
      const s = e.stats;
      for (const k of ['force', 'accel', 'vMax', 'staminaMax', 'drain']) if (s[k]) m[k] *= s[k];
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
    return { cool };
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
    const engineRatio = engine ? engine.hpRatio : 0;
    const tireRatio = tires ? tires.hpRatio : 0;
    // Part combinations that help or hurt.
    const m = { force: 1, grip: 1, vMax: 1, cooling: 1, staminaMax: 1, drain: 1, accel: 1 };
    const interactions = PhysicsEngine.interactions(bug);
    for (const it of interactions) for (const k in it.mods) m[k] *= it.mods[k];
    const addOns = PhysicsEngine.addOns(bug, m, interactions);

    const fDrive = engine ? engine.stats.force * engineRatio * m.force : 0;
    const fGripBase = tires ? tires.stats.mu * mass * PHYSICS.GRAVITY * tireRatio * m.grip : 0;
    const fGrip = fGripBase * gripMod;
    const fUsable = Math.min(fDrive, fGrip);
    const accel = mass > 0 ? (fUsable / mass) * m.accel : 0;

    const wear = PHYSICS.TIRE_WEAR_FLOOR + (1 - PHYSICS.TIRE_WEAR_FLOOR) * tireRatio;
    const vMax = engine && tires ? engine.stats.rpm * tires.stats.radius * PHYSICS.RPM_TO_SPEED * wear * m.vMax : 0;

    return {
      mass,
      fDrive,
      fGrip,
      fGripBase,
      fUsable,
      accel,
      vMax,
      engineRatio,
      tireRatio,
      gripMod,
      radius: chassis.stats.radius * PHYSICS.BUG_SCALE,
      staminaMax: Math.round(chassis.stats.staminaMax * m.staminaMax),
      cooling: engine ? Math.round((engine.stats.cooling * m.cooling + addOns.cool) * 10) / 10 : 0,
      drainMult: m.drain,
      interactions,
      turnRate: chassis.stats.turn * (0.55 + 0.45 * tireRatio),
      tractionLimited: fGrip < fDrive,
    };
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
    const steer = (diff, rate) => {
      const maxTurn = rate * dt;
      bug.angle = wrapAngle(bug.angle + clamp(diff, -maxTurn, maxTurn));
    };

    if (canDrive && bug.lunge) {
      // Rams/shoves: heading already snapped, full power forward.
      ctl.reverse = false;
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
      } else {
        // Being pushed? (moving against the way we're driving — backwards while
        // driving forward, or forwards while reversing.)
        const along = bug.vel.dot(Vector2D.fromAngle(bug.angle));
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
      }
    }

    const heading = Vector2D.fromAngle(bug.angle);
    const side = heading.perp();
    let fwd = bug.vel.dot(heading);
    let lat = bug.vel.dot(side);

    const vCap = s.vMax * (bug.lunge ? bug.lunge.speedMult : 1);
    const vCapRev = s.vMax * PHYSICS.REVERSE_SPEED;
    const gripDecel = s.mass > 0 ? s.fGrip / s.mass : 0;

    if (throttle > 0 && !ctl.reverse) {
      if (fwd < vCap) fwd = Math.min(vCap, fwd + s.accel * throttle * dt);
    } else if (throttle > 0) {
      if (fwd > -vCapRev) fwd = Math.max(-vCapRev, fwd - s.accel * throttle * dt);
    } else {
      fwd = approach(fwd, 0, gripDecel * PHYSICS.IDLE_BRAKE * dt);
    }
    if (fwd > vCap) fwd = approach(fwd, vCap, PHYSICS.OVERSPEED_DECEL * dt);
    if (fwd < -vCapRev) fwd = approach(fwd, -vCapRev, PHYSICS.OVERSPEED_DECEL * dt);
    lat = approach(lat, 0, gripDecel * lateralGrip * dt);

    bug.vel = heading.scale(fwd).addInPlace(side, lat);
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
