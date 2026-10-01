import { PHYSICS, STAMINA, EVENTS } from '../config/constants.js';
import { Vector2D, clamp, approach, wrapAngle } from './Vector2D.js';
import { INTERACTIONS, worksWith, JACKET_NAMES, THRUST_DRIVES, pushesThrust, hasShaft, turbineLine } from '../config/partsData.js';

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
   * Cooling add-ons and enhancements on drive bay `bay`: folds their multipliers
   * into `m` and returns the extra cooling (stamina/s). Parts that don't suit the
   * drive, are used up, or are destroyed do nothing. Notes go into `interactions`
   * so the mechanic can talk about them.
   */
  static addOns(bug, m, interactions, bay = 0) {
    let cool = 0;
    // Twin drives: every add-on works at 70% (its bonus or penalty scaled back).
    const k = (bug.drives?.length || 0) > 1 ? PHYSICS.TWIN_POWER : 1;
    const scaled = (mult) => 1 + (mult - 1) * k;
    const on = (p) => (p.bay || 0) === bay;
    const where = PhysicsEngine.bayName(bug, bay);
    const live = (p) => !p.spent && !p.isBroken && worksWith(p, bug);
    const coolers = (bug.coolers || []).filter(on).filter(live);
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
    if (fans.length && partner) interactions.push({ id: `fan_boost${bay}`, good: true, mods: {}, text: `Your fan is blowing on the liquid cooling / heat exchanger${where} — a big boost to cooling.` });
    else if (fans.length && vented) interactions.push({ id: `fan_vent${bay}`, good: true, mods: {}, text: 'Your fan pushes air through the vented armour. Nice.' });
    else if (fans.length) interactions.push({ id: `fan_alone${bay}`, good: false, mods: {}, text: `A fan on its own${where} does almost nothing — pair it with water or oil cooling, a heat exchanger or vented armour on the same drive.` });

    for (const e of (bug.mods || []).filter(on).filter(live)) {
      const s = e.stats;
      for (const key of ['force', 'accel', 'vMax', 'staminaMax', 'drain']) if (s[key]) m[key] *= scaled(s[key]);
      if (s.cool) cool += s.cool;
    }
    for (const p of [...(bug.coolers || []), ...(bug.mods || [])].filter(on)) {
      if (p.spent) interactions.push({ id: `spent_${p.uid}`, good: false, mods: {}, text: `Your ${p.name} is used up — strip it out.` });
      else if (!worksWith(p, bug)) {
        interactions.push({ id: `nofit_${p.uid}`, good: false, mods: {},
          text: p.stats.jacket
            ? `Your ${p.name} needs ${/^[AEIOU]/.test(JACKET_NAMES[p.stats.jacket]) ? 'an' : 'a'} ${JACKET_NAMES[p.stats.jacket]} on ${where ? `the ${PhysicsEngine.side(bay)} drive` : 'this drive'} — it's dead weight without one.`
            : `Your ${p.name} doesn't work with this drive — it's dead weight.` });
      }
    }
    for (const j of (bug.coolers || []).filter(on).filter((c) => c.stats.jacketFor)) {
      if (!(bug.coolers || []).filter(on).some((c) => c.stats.jacket === j.stats.jacketFor)) {
        interactions.push({ id: `jacket_${j.uid}`, good: false, mods: {}, text: `Your ${j.name}${where} isn't hooked up to anything — it needs its liquid cooler on the same drive.` });
      }
    }
    return { cool: cool * k };
  }

  /** "left" / "right" drive bay. */
  static side(bay) { return bay ? 'right' : 'left'; }

  /** " on the left drive" on a twin, "" otherwise. */
  static bayName(bug, bay) {
    return (bug.drives?.length || 0) > 1 ? ` on the ${PhysicsEngine.side(bay)} drive` : '';
  }

  /**
   * Drive-train parts on drive bay `bay`: folds their multipliers into `m`
   * (force, accel, vMax, turn, grip, drain, brake, lateral) and returns the
   * special effects. Only one part per group works on each drive (one gearbox,
   * one shaft, one prop); parts that don't suit the drive, or are broken, do nothing.
   */
  static driveTrain(bug, m, interactions, castor, bay = 0) {
    const fx = { vector: false, prop: 0, propRpm: false, lsl: false, tcu: false, guard: 1 };
    const groups = {};
    const turbine = bug.engine?.stats.kind === 'turbine';
    const line = turbineLine(bug, bay);
    const shaft = hasShaft(bug, bay);
    const tracks = bug.tires?.stats.kind === 'track';
    const where = PhysicsEngine.bayName(bug, bay);
    // How many of each group count on this drive: a turbine runs two shafts (one each side
    // of the gearbox); a twin-bay shell running one drive has room for two gearboxes.
    const limit = { shaft: turbine ? 2 : 1, gearbox: (bug.chassis?.stats.drives || 1) > 1 && (bug.drives?.length || 0) < 2 ? 2 : 1 };
    // Gearboxes work one after another: their torque gains and speed losses add up.
    const gear = {};
    for (const p of (bug.drivetrain || []).filter((q) => (q.bay || 0) === bay)) {
      const s = p.stats;
      if (p.isBroken || !worksWith(p, bug)) {
        if (!p.isBroken) interactions.push({ id: `dt_nofit_${p.uid}`, good: false, mods: {}, text: `Your ${p.name} doesn't suit this drive — it's dead weight.` });
        continue;
      }
      // Gearboxes, diffs, couplings and the like sit between the drive shaft and the wheels.
      if (SHAFT_PARTS.includes(s.kind) && !castor && !shaft) {
        interactions.push({ id: `dt_noshaft_${p.uid}`, good: false, mods: {}, text: `Your ${p.name}${where} does nothing without a drive shaft to connect it.` });
        continue;
      }
      // A gearbox on a turbine only works in the full line: High-Speed Shaft → gearbox → drive shaft.
      if (s.group === 'gearbox' && turbine && !castor && !line.complete) {
        interactions.push({ id: `dt_nohss_${p.uid}`, good: false, mods: {},
          text: !line.hss
            ? `Your ${p.name}${where} can't take turbine revs through a plain shaft — it needs a High-Speed Shaft on the turbine side.`
            : `Your ${p.name}${where} isn't connected to the wheels — it needs a drive shaft or chain on the wheel side (High-Speed Shaft → gearbox → drive shaft).` });
        continue;
      }
      if (s.wheelsOnly && tracks) {
        interactions.push({ id: `dt_tracks_${p.uid}`, good: false, mods: {}, text: `A ${p.name} does nothing for tracks — they already drive along their whole length.` });
        continue;
      }
      if (s.group) {
        const max = limit[s.group] || 1;
        if ((groups[s.group] || 0) >= max) {
          const many = { 1: 'two', 2: 'three' }[max];
          interactions.push({ id: `dt_dup_${p.uid}`, good: false, mods: {}, text: `You've got ${many} ${s.group === 'prop' ? 'propellers' : `${s.group}s`}${where || ' on one drive'} — only ${max === 1 ? 'one' : max} can do anything. The ${p.name} is dead weight.` });
          continue;
        }
        groups[s.group] = (groups[s.group] || 0) + 1;
      }
      const onTyres = (k) => !(castor && s.tyresOnly?.includes(k)); // some parts only matter on driven wheels
      for (const k of ['force', 'accel', 'vMax', 'turn', 'grip', 'drain', 'brake']) {
        if (!s[k] || !onTyres(k)) continue;
        if (s.group === 'gearbox') gear[k] = (gear[k] || 0) + (s[k] - 1);
        else m[k] *= s[k];
      }
      if (s.vector) fx.vector = true;
      if (s.prop) { fx.prop = s.prop; fx.propRpm = !!s.propRpm; }
      if (s.lsl) fx.lsl = true;
      if (s.tcu && onTyres('tcu')) fx.tcu = true;
      if (s.rudder) fx.rudder = true;
      if (s.kind === 'reverser') fx.reverser = true;
    }
    for (const k in gear) m[k] *= Math.max(0.1, 1 + gear[k]);
    if ((groups.gearbox || 0) > 1) interactions.push({ id: `dt_twin_gear${bay}`, good: true, mods: {}, text: `Two gearboxes in line${where} — their torque gains and speed losses add up.` });
    // A gearbox with nothing on its wheel side: the wheels aren't driven — thrust only.
    if (turbine && !castor && bug.tires && shaft && !line.connected) {
      interactions.push({ id: `dt_unconnected${bay}`, good: false, mods: {},
        text: `Nothing on the wheel side of the gearbox${where} — the wheels aren't driven, so she's pushing on turbine thrust alone and the rest is dead weight. Fit a drive shaft or chain & sprockets after the gearbox.` });
    } else if (turbine && !castor && bug.tires && shaft && !line.complete) {
      // A turbine straight into the wheels with no gearbox in between just spins them.
      m.grip *= PHYSICS.WHEELSPIN; m.turn *= PHYSICS.WHEELSPIN;
      interactions.push({ id: `dt_wheelspin${bay}`, good: false, mods: {},
        text: `No reducer between the turbine and the wheels${where} — she just spins them: half the grip and half the control. Run High-Speed Shaft → gearbox → drive shaft.` });
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
    const drives = bug.drives || (engine ? [engine] : []);
    const engineRatio = drives.length ? drives.reduce((t, d) => t + d.hpRatio, 0) / drives.length : 0;
    const tireRatio = tires && !tires.isBroken ? tires.hpRatio : 0;
    // Part combinations that help or hurt.
    const MULTS = ['force', 'grip', 'vMax', 'cooling', 'staminaMax', 'drain', 'accel', 'turn', 'brake', 'lateral'];
    const ones = () => Object.fromEntries(MULTS.map((k) => [k, 1]));
    const m = ones();
    const interactions = PhysicsEngine.interactions(bug);
    for (const it of interactions) for (const k in it.mods) m[k] *= it.mods[k];
    const castor = tires?.type === 'castor';
    // Each drive has its own cooling, enhancements and drive train. Its drive force
    // goes through its own kit; everything else the vehicle gets as the average of
    // its drives (so a part on one side only is half as good — and pulls her off line).
    const bays = Math.max(1, drives.length);
    const mb = [];
    const fxs = [];
    let addCool = 0;
    for (let b = 0; b < bays; b++) {
      const mm = ones();
      addCool += PhysicsEngine.addOns(bug, mm, interactions, b).cool;
      fxs.push(PhysicsEngine.driveTrain(bug, mm, interactions, castor, b));
      mb.push(mm);
    }
    for (const k of MULTS) if (k !== 'force') m[k] *= mb.reduce((t, mm) => t * mm[k], 1) ** (1 / bays);
    // Twin drives with the same cooling on both: the two loops work together, +10%.
    if (bug.coolingMatched) {
      addCool *= PHYSICS.MATCHED_COOLING;
      interactions.push({ id: 'twin_cool_matched', good: true, mods: {}, text: 'Same cooling on both power plants — they work together. +10% cooling.' });
    }
    const any = (key) => fxs.some((f) => f[key]);
    const dt = { vector: any('vector'), lsl: any('lsl'), tcu: any('tcu'), reverser: any('reverser') };
    // A self-locking gearbox (worm, cycloidal, strain wave) holds the wheels, motor or not.
    dt.lock = (bug.drivetrain || []).some((p) => p.stats.kind === 'lockgear' && !p.isBroken);

    // Castors aren't driven: a thrust drive pushes the body straight (no traction
    // limit), less the rolling resistance. What holds the line and brakes is
    // `hold` — as slippery as the rolling resistance on most castors.
    const thrustDrive = THRUST_DRIVES.includes(engine?.stats.kind);
    const rollForce = castor ? tires.stats.roll * (2 - tireRatio) * mass * PHYSICS.GRAVITY : 0; // damage adds drag
    const gripMu = castor ? (tires.stats.hold ?? tires.stats.roll) : tires?.stats.mu || 0;
    const fGripBase = tires ? gripMu * mass * PHYSICS.GRAVITY * (castor ? 1 : tireRatio) * m.grip : 0;
    const fGrip = fGripBase * gripMod;
    // Two motors through one set of running gear: each gives at most 70% of its power.
    const twinK = drives.length > 1 ? PHYSICS.TWIN_POWER : 1;
    // Per drive: its force, through its own kit, and how it reaches the ground. Wheels
    // and tracks need a drive shaft on that drive; without one a turbine pushes on thrust
    // alone (half strength), plasma never drives wheels, any other motor goes nowhere.
    const per = drives.map((d, i) => {
      const f = (d.isBroken ? 0 : d.stats.force * d.hpRatio) * mb[i].force * twinK * m.force; // broken down = no push
      // A propeller or ducted fan turns shaft power into thrust (a ducted fan makes more of high revs).
      const propEff = fxs[i].prop * (fxs[i].propRpm ? 0.7 + 0.5 * (d.stats.rpm / 6400) : 1);
      // A prop or fan on a turbine adds to its thrust (a fifth of the prop's own efficiency).
      const propBoost = thrustDrive ? propEff * PHYSICS.PROP_BOOST : 0;
      // A turbine's gearbox needs a shaft (or chain) on its wheel side, or the wheels aren't driven at all.
      const shaft = !castor && d.stats.kind !== 'plasma' && hasShaft(bug, i) && (d.stats.kind !== 'turbine' || turbineLine(bug, i).connected);
      const thrusts = castor && !tires.isBroken && pushesThrust(bug, i);
      const mode = castor ? (thrusts ? 'thrust' : 'none') : shaft ? 'shaft' : thrustDrive ? 'wheelThrust' : 'none';
      const eff = mode === 'thrust' ? (thrustDrive ? PHYSICS.CASTOR_THRUST + propBoost : propEff)
        : mode === 'wheelThrust' ? PHYSICS.THRUST_ON_WHEELS + propBoost : 1;
      return { f, mode, eff };
    });
    const fDrive = per.reduce((t, d) => t + d.f, 0);
    const push = (scale) => {
      const sum = (mode) => per.filter((d) => d.mode === mode).reduce((t, d) => t + d.f * scale * d.eff, 0);
      if (castor) return Math.max(0, sum('thrust') - rollForce);
      return Math.min(sum('shaft'), fGrip) + sum('wheelThrust');
    };
    const shaftDrive = per.some((d) => d.mode === 'shaft');
    const thrust = per.some((d) => d.mode === 'thrust');
    const fUsable = push(1);
    const accel = mass > 0 ? (fUsable / mass) * m.accel : 0;
    // Back-to-front shells: the forward penalty is undone and then some in reverse.
    const back = chassis.stats.backwards;
    const accelRev = mass > 0 ? (push(back ? back.rev / back.fwd : 1) / mass) * m.accel : 0;
    const rpmAvg = drives.length ? drives.reduce((t, d) => t + d.stats.rpm, 0) / drives.length : 0;

    // Twin drives: the side putting more down pulls the nose round — a damaged drive, one
    // with no shaft, or one fitted with kit the other hasn't (each unmatched part pulls).
    let twinBias = 0;
    if (drives.length === 2) {
      const c = per.map((d) => (d.mode === 'none' ? 0 : d.f * d.eff));
      twinBias = c[0] + c[1] > 0 ? (c[0] - c[1]) / (c[0] + c[1]) : 0;
      const odd = bug.unmatched?.() || [];
      for (const u of odd) twinBias += (u.bay === 0 ? 1 : -1) * PHYSICS.UNMATCHED_PULL;
      twinBias = clamp(twinBias, -1, 1);
      if (odd.length) {
        const u = odd[0];
        interactions.push({ id: 'twin_unmatched', good: false, mods: {},
          text: `Your drives aren't matched: the ${PhysicsEngine.side(u.bay)} drive has ${/^[AEIOU]/.test(u.part.name) ? 'an' : 'a'} ${u.part.name} the ${PhysicsEngine.side(u.missingOn)} one hasn't${odd.length > 1 ? ` (and ${odd.length - 1} more odd part${odd.length > 2 ? 's' : ''})` : ''}. She'll pull to one side — fit the same to both.` });
      }
      per.forEach((d, i) => {
        if (d.mode === 'none' && per[1 - i].mode !== 'none' && !drives[i].isBroken && tires && !castor && !thrustDrive) {
          interactions.push({ id: `twin_noshaft${i}`, good: false, mods: {}, text: `Your ${PhysicsEngine.side(i)} drive has no drive shaft — it isn't turning the wheels at all.` });
        }
      });
    }
    if (dt.lsl) twinBias = 0; // a Limited-Slip Link shares torque: no pulling to one side

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
      cooling: engine ? Math.round((drives.reduce((t, d) => t + d.stats.cooling, 0) * twinK * m.cooling + addCool) * 10) / 10 : 0,
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
      freeRoll: !!tires && !castor && !tires.isBroken && !shaftDrive && !dt.lock,
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
    let vecDir = null; // thrust vectoring: the way it's pushing, whatever way it faces
    const floor0 = env.floorVel ? env.floorVel(bug.pos) : null;
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
      if (s.vector) {
        // Thrust vectoring: no steering at all — it just goes where you touched
        // (sideways, backwards, whatever), still facing the opponent, and the
        // nozzle fires against the slide to pull up on the spot.
        const arrived = dist < PHYSICS.ARRIVE_RADIUS * 0.5;
        const moving = (floor0 ? bug.vel.sub(floor0) : bug.vel).length();
        if (arrived && moving < 8) ctl.target = null;
        vecDir = arrived ? new Vector2D() : to.scale(1 / dist);
        // Ease off so it stops on the spot rather than sliding past (v² = 2·a·d).
        throttle = arrived ? 0.2 : clamp(Math.sqrt(2 * s.accel * dist) / Math.max(1, s.vMax), 0.15, 1);
      } else if (dist < PHYSICS.ARRIVE_RADIUS) {
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

    if (vecDir) {
      // Vectored thrust pushes straight at the target speed and direction.
      const want = vecDir.scale(vCap * throttle);
      const diff = want.sub(rel);
      const n = diff.length();
      const step = s.accel * dt;
      const next = n <= step ? want : rel.add(diff.scale(step / n));
      fwd = next.dot(heading);
      lat = next.dot(side);
    } else if (throttle > 0 && !ctl.reverse) {
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
    if (!(s.freeRoll && throttle === 0) && !vecDir) {
      if (fwd > vCap) fwd = approach(fwd, vCap, PHYSICS.OVERSPEED_DECEL * dt);
      if (fwd < -vCapRev) fwd = approach(fwd, -vCapRev, PHYSICS.OVERSPEED_DECEL * dt);
    }
    if (!vecDir) lat = approach(lat, 0, gripDecel * lateralGrip * (s.lateralMult ?? 1) * dt);
    // With a thrust-vectoring nozzle the body swings round to keep facing the opponent.
    if (s.vector && ctl.face && !bug.spin && !bug.lunge) {
      const to = ctl.face.sub(bug.pos);
      const diff = wrapAngle(to.angle() - bug.angle);
      bug.angle = wrapAngle(bug.angle + clamp(diff, -PHYSICS.VECTOR_FACE_RATE * dt, PHYSICS.VECTOR_FACE_RATE * dt));
    }

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
