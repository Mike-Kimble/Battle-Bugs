import { PHYSICS, STAMINA, EVENTS } from '../config/constants.js';
import { Vector2D, clamp, approach, wrapAngle } from './Vector2D.js';

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

    const fDrive = engine ? engine.stats.force * engineRatio : 0;
    const fGripBase = tires ? tires.stats.mu * mass * PHYSICS.GRAVITY * tireRatio : 0;
    const fGrip = fGripBase * gripMod;
    const fUsable = Math.min(fDrive, fGrip);
    const accel = mass > 0 ? fUsable / mass : 0;

    const wear = PHYSICS.TIRE_WEAR_FLOOR + (1 - PHYSICS.TIRE_WEAR_FLOOR) * tireRatio;
    const vMax = engine && tires ? engine.stats.rpm * tires.stats.radius * PHYSICS.RPM_TO_SPEED * wear : 0;

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
      radius: chassis.stats.radius,
      staminaMax: chassis.stats.staminaMax,
      cooling: engine ? engine.stats.cooling : 0,
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
    const canDrive = !bug.stalled && s.fDrive > 0;

    if (canDrive && bug.lunge) {
      // Rams/shoves: heading already snapped, full power.
      throttle = 1;
    } else if (canDrive && bug.control.target) {
      const to = bug.control.target.sub(bug.pos);
      const dist = to.length();
      if (dist < PHYSICS.ARRIVE_RADIUS) {
        bug.control.target = null;
      } else {
        const diff = wrapAngle(to.angle() - bug.angle);
        const maxTurn = s.turnRate * dt;
        bug.angle = wrapAngle(bug.angle + clamp(diff, -maxTurn, maxTurn));
        const align = Math.cos(diff);
        throttle = align > 0.2 ? align : 0;
        throttle *= clamp(dist / PHYSICS.SLOW_RADIUS, 0.3, 1);
      }
    }

    const heading = Vector2D.fromAngle(bug.angle);
    const side = heading.perp();
    let fwd = bug.vel.dot(heading);
    let lat = bug.vel.dot(side);

    const vCap = s.vMax * (bug.lunge ? bug.lunge.speedMult : 1);
    const gripDecel = s.mass > 0 ? s.fGrip / s.mass : 0;

    if (throttle > 0) {
      if (fwd < vCap) fwd = Math.min(vCap, fwd + s.accel * throttle * dt);
    } else {
      fwd = approach(fwd, 0, gripDecel * PHYSICS.IDLE_BRAKE * dt);
    }
    if (fwd > vCap) fwd = approach(fwd, vCap, PHYSICS.OVERSPEED_DECEL * dt);
    lat = approach(lat, 0, gripDecel * PHYSICS.LATERAL_GRIP * dt);

    bug.vel = heading.scale(fwd).addInPlace(side, lat);
    bug.pos.addInPlace(bug.vel, dt);
    bug.throttle = throttle;
    bug.odometer += Math.abs(fwd) * dt;

    // Stamina: continuous drain ∝ F_drive · v while driving (partly offset by
    // cooling), full R_cool recovery while idle.
    if (throttle > 0) {
      const applied = s.fUsable * throttle;
      bug.stamina -= STAMINA.DRIVE_DRAIN_K * applied * (Math.abs(fwd) + STAMINA.PUSH_SPEED_FLOOR) * dt;
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
