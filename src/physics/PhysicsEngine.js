import { PHYSICS, STAMINA, HEAT, ACTIONS, EVENTS } from '../config/constants.js';
import { REF } from '../config/scores.js';
import { Vector2D, clamp, approach, wrapAngle } from './Vector2D.js';
import { INTERACTIONS, worksWith, JACKET_NAMES, THRUST_DRIVES, pushesThrust, hasShaft, hasDriveTrain, turbineLine, driveKind, linkActive, gearWearMatches } from '../config/partsData.js';

/** Drive-train parts that live between the drive shaft and the wheels (useless without a shaft). */
const SHAFT_PARTS = ['gearbox', 'lockgear', 'transfer', 'diff', 'coupling', 'converter'];

/** Coolers a fan can blow on to boost. */
const FAN_BOOSTS = ['water', 'oil', 'exchanger', 'heatsink'];

/** What a water mister soaks to make it work harder: water radiators, oil coolers and heat sinks (and fans). */
const misted = (c) => (c.stats.kind === 'water' && c.stats.jacket === 'water') || c.stats.kind === 'oil' || c.stats.kind === 'heatsink';

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
    // A water mister soaks the radiators, oil coolers, heat sinks and fans on its drive: they all work harder.
    const mist = coolers.reduce((x, c) => Math.max(x, c.stats.mist || 0), 0);
    const boost = 1 + (fans.reduce((b, f) => Math.max(b, f.stats.boost || 1), 1) - 1) * (1 + mist);
    for (const c of coolers) {
      const base = c.stats.cool * (mist && misted(c) ? 1 + mist : 1);
      cool += base;
      // A fan blowing on liquid cooling, a heat sink or a heat exchanger makes it far better.
      if (boost > 1 && FAN_BOOSTS.includes(c.stats.kind)) cool += base * (boost - 1);
      if (c.stats.staminaMax) m.staminaMax *= scaled(c.stats.staminaMax);
    }
    const vented = (bug.armor?.stats.heat || 0) < 0 && !bug.armor.isBroken;
    for (const f of fans) if (vented) cool += (f.stats.ventBonus || 0) * (1 + mist);
    if (mist) {
      const wear = coolers.reduce((x, c) => Math.max(x, c.stats.mistWear || 0), 0);
      interactions.push({ id: `mist${bay}`, good: true, mods: {}, text: `Your mister soaks the radiators, oil coolers, heat sinks and fans${where} — they all work harder. But the damp wears that drive faster (about ${Math.round(wear * 100)}% a match).` });
    }
    const partner = coolers.some((c) => FAN_BOOSTS.includes(c.stats.kind));
    if (fans.length && partner) interactions.push({ id: `fan_boost${bay}`, good: true, mods: {}, text: `Your fan is blowing on the liquid cooling / heat sink${where} — a big boost to cooling.` });
    // Vented armour is the whole shell, not one drive: any fan can blow through it (one note will do).
    else if (fans.length && vented) { if (!interactions.some((i) => i.id === 'fan_vent')) interactions.push({ id: 'fan_vent', good: true, mods: {}, text: 'Your fan pushes air through the vented armour. Nice.' }); }
    else if (fans.length) interactions.push({ id: `fan_alone${bay}`, good: false, mods: {}, text: `A fan on its own${where} does almost nothing — pair it with a radiator, an oil cooler or a heat sink${where ? ' on the same drive' : ''}, or fit vented armour.` });

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
            ? `Your ${p.name} needs ${/^[AEIOU]/.test(JACKET_NAMES[p.stats.jacket]) ? 'an' : 'a'} ${JACKET_NAMES[p.stats.jacket]} on ${where ? PhysicsEngine.side(bay) : 'this drive'} — it's dead weight without one.`
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

  /** Gearboxes (reducers included) a chassis takes: two in a twin-bay shell, one otherwise. */
  static gearboxLimit(bug) {
    return (bug.chassis?.stats.drives || 1) > 1 ? 2 : 1;
  }

  /** "left" / "right" drive bay. */
  static side(bay) { return bay ? 'Drive 2' : 'Drive 1'; }

  /** " on Drive 1" on a twin, "" otherwise. */
  static bayName(bug, bay) {
    return (bug.drives?.length || 0) > 1 ? ` on ${PhysicsEngine.side(bay)}` : '';
  }

  /**
   * Drive-train parts on drive bay `bay`: folds their multipliers into `m`
   * (force, accel, vMax, turn, grip, drain, brake, lateral) and returns the
   * special effects. One shaft and one prop work on each drive; gearboxes are
   * counted across the whole vehicle (`shared`): up to two in a twin-bay shell, one
   * otherwise, on whichever drives they're on. Parts that don't suit the drive, or
   * are broken, do nothing.
   */
  static driveTrain(bug, m, interactions, castor, bay = 0, shared = {}) {
    const fx = { vector: false, prop: 0, propRpm: false, lsl: false, tcu: false, guard: 1, eff: 1 };
    const groups = { gearbox: 0 };
    shared.gearbox = shared.gearbox || 0;
    const turbine = driveKind(bug, bay) === 'turbine';
    const line = turbineLine(bug, bay);
    const shaft = hasShaft(bug, bay);
    const tracks = bug.tires?.stats.kind === 'track';
    const where = PhysicsEngine.bayName(bug, bay);
    // How many of each group count: a turbine runs two shafts on its drive (one each side
    // of the gearbox); gearboxes are a vehicle-wide limit — two in a twin-bay shell, else one.
    const limit = { shaft: turbine ? 2 : 1, gearbox: PhysicsEngine.gearboxLimit(bug) };
    // Gearboxes work one after another: their torque gains and speed losses add up.
    const gear = {};
    const propHere = hasDriveTrain(bug, (st) => !!st.prop, bay);
    for (const p of (bug.drivetrain || []).filter((q) => (q.bay || 0) === bay)) {
      const s = p.stats;
      if (p.isBroken || !worksWith(p, bug)) {
        if (!p.isBroken) interactions.push({ id: `dt_nofit_${p.uid}`, good: false, mods: {}, text: `Your ${p.name} doesn't suit this drive — it's dead weight.` });
        continue;
      }
      // Castors aren't driven: traction aids do nothing, and gearing only helps if it's driving a prop.
      if (castor && (s.kind === 'tcu' || s.kind === 'transfer')) {
        interactions.push({ id: `dt_castor_${p.uid}`, good: false, mods: {}, text: `A ${p.name} does nothing on castors — they aren't driven. It's dead weight.` });
        continue;
      }
      if (castor && (s.group === 'gearbox' || s.kind === 'converter') && !propHere) {
        interactions.push({ id: `dt_castor_${p.uid}`, good: false, mods: {}, text: `Your ${p.name}${where} has nothing to drive on castors — it needs a propeller or ducted fan on the same drive.` });
        continue;
      }
      // Thrust vectoring needs thrust to steer: a thrust drive, or a prop or fan on that drive.
      if (s.vector && !THRUST_DRIVES.includes(driveKind(bug, bay)) && !propHere) {
        interactions.push({ id: `dt_vector_${p.uid}`, good: false, mods: {}, text: `Your ${p.name}${where} has no thrust to steer — it needs a turbine or plasma drive, or a propeller or ducted fan.` });
        continue;
      }
      // A Limited-Slip Link can't couple a plasma drive (it has no shaft to share).
      if (s.lsl && (bug.drives || []).some((d) => d.stats.kind === 'plasma')) {
        interactions.push({ id: `dt_lslplasma_${p.uid}`, good: false, mods: {}, text: `A ${p.name} can't couple a plasma drive — there's no shaft to share. It's dead weight.` });
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
      // A differential on twin drives needs them joined by a Limited-Slip Link — then one does for both.
      const twin = (bug.drives?.length || 0) > 1;
      if (s.kind === 'diff' && twin) {
        if (!linkActive(bug)) {
          interactions.push({ id: `dt_diff_${p.uid}`, good: false, mods: {}, text: `A ${p.name} can't work across two separate drives — join them with a Limited-Slip Link first. Until then it's dead weight.` });
          continue;
        }
        if (shared.diff) continue; // the drives work as one: a second diff adds nothing
        shared.diff = true;
      }
      if (s.group) {
        const max = limit[s.group] || 1;
        const used = s.group === 'gearbox' ? shared.gearbox : (groups[s.group] || 0);
        if (used >= max) {
          const many = { 1: 'two', 2: 'three' }[max];
          interactions.push({ id: `dt_dup_${p.uid}`, good: false, mods: {}, text: s.group === 'gearbox'
            ? `You've got ${many} gearboxes — only ${max === 1 ? 'one' : max} can work in this chassis. The ${p.name} is dead weight.`
            : `You've got ${many} ${s.group === 'prop' ? 'propellers' : `${s.group}s`}${where || ' on one drive'} — only ${max === 1 ? 'one' : max} can do anything. The ${p.name} is dead weight.` });
          continue;
        }
        groups[s.group] = (groups[s.group] || 0) + 1;
        if (s.group === 'gearbox') shared.gearbox += 1;
      }
      // Every working part in the line loses a little to friction and inertia (dead weight doesn't turn).
      fx.eff *= s.eff ?? 1;
      const onTyres = (k) => !(castor && s.tyresOnly?.includes(k)); // some parts only matter on driven wheels
      for (const k of ['force', 'accel', 'vMax', 'turn', 'grip', 'drain', 'brake']) {
        if (!s[k] || !onTyres(k)) continue;
        if (s.group === 'gearbox') gear[k] = (gear[k] || 0) + (s[k] - 1);
        // Linked drives work as one: a diff on either drive turns the whole vehicle (undo the averaging across drives).
        else if (s.kind === 'diff' && twin) m[k] *= s[k] ** bug.drives.length;
        else m[k] *= s[k];
      }
      // Electric torque wears gearing out fast.
      const life = gearWearMatches(p, bug);
      if (life) interactions.push({ id: `dt_wear_${p.uid}`, good: false, mods: {}, text: `${/^[aeiou]/i.test(driveKind(bug, bay)) ? 'An' : 'A'} ${driveKind(bug, bay)} drive's instant torque chews through your ${p.name}${where} — it'll be worn out in about ${Math.round(life)} matches. Keep it repaired.` });
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
   * @param {{gripMod?: number, slick?: number}} mods slick: the grip left in an oil/grease/ice
   *   patch the bug is sitting in (1 = dry) — on castors it cuts rolling resistance too
   */
  static deriveStats(bug, mods = {}) {
    const gripMod = mods.gripMod ?? 1;
    const slick = mods.slick ?? 1;
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
    const coolBy = [];
    const shared = {}; // gearboxes are counted across both drives
    for (let b = 0; b < bays; b++) {
      const mm = ones();
      coolBy[b] = PhysicsEngine.addOns(bug, mm, interactions, b).cool;
      addCool += coolBy[b];
      fxs.push(PhysicsEngine.driveTrain(bug, mm, interactions, castor, b, shared));
      mb.push(mm);
    }
    for (const k of MULTS) if (k !== 'force') m[k] *= mb.reduce((t, mm) => t * mm[k], 1) ** (1 / bays);
    // Twin drives with the same cooling on both: the two loops work together, +10%.
    if (bug.coolingMatched) {
      addCool *= PHYSICS.MATCHED_COOLING;
      for (let b = 0; b < coolBy.length; b++) coolBy[b] *= PHYSICS.MATCHED_COOLING;
      interactions.push({ id: 'twin_cool_matched', good: true, mods: {}, text: 'Same cooling on both power plants — they work together. +10% cooling.' });
    }
    const any = (key) => fxs.some((f) => f[key]);
    const dt = { vector: any('vector'), lsl: any('lsl'), tcu: any('tcu'), reverser: any('reverser') };
    // A self-locking gearbox (worm, cycloidal, strain wave) holds the wheels, motor or not.
    dt.lock = (bug.drivetrain || []).some((p) => p.stats.kind === 'lockgear' && !p.isBroken);

    // Castors aren't driven: a thrust drive pushes the body straight (no traction
    // limit), less the rolling resistance. What holds the line and brakes is
    // `hold` — as slippery as the rolling resistance on most castors.
    // Twin drives can be different types: each is a thrust drive or not on its own.
    const isThrust = (d) => THRUST_DRIVES.includes(d?.stats.kind);
    // Damage adds drag; oil, grease or ice under castors takes it away (they lose hold, not speed).
    const dryRoll = castor ? tires.stats.roll * (2 - tireRatio) * mass * PHYSICS.GRAVITY : 0;
    const rollForce = dryRoll * slick;
    const gripMu = castor ? (tires.stats.hold ?? tires.stats.roll) : tires?.stats.mu || 0;
    const fGripBase = tires ? gripMu * mass * PHYSICS.GRAVITY * (castor ? 1 : tireRatio) * m.grip : 0;
    const fGrip = fGripBase * gripMod;
    // Two motors through one set of running gear: each gives at most 70% of its power.
    const twinK = drives.length > 1 ? PHYSICS.TWIN_POWER : 1;
    // Per drive: its force, through its own kit, and how it reaches the ground. Wheels
    // and tracks need a drive shaft on that drive; without one a turbine pushes on thrust
    // alone (half strength), plasma never drives wheels, any other motor goes nowhere.
    const per = drives.map((d, i) => {
      const thrustDrive = isThrust(d);
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
      return { f, mode, eff, cool: 0 };
    });
    const fDrive = per.reduce((t, d) => t + d.f, 0);
    const push = (scale, roll = rollForce) => {
      const sum = (mode) => per.filter((d) => d.mode === mode).reduce((t, d) => t + d.f * scale * d.eff, 0);
      if (castor) return Math.max(0, sum('thrust') - roll);
      return Math.min(sum('shaft'), fGrip) + sum('wheelThrust');
    };
    const shaftDrive = per.some((d) => d.mode === 'shaft');
    const thrust = per.some((d) => d.mode === 'thrust');
    const fUsable = push(1);
    const accel = mass > 0 ? (fUsable / mass) * m.accel : 0;
    // Reverse thrusters push on the air, not the floor: a slick doesn't change how hard they brake.
    const accelDry = mass > 0 ? (push(1, dryRoll) / mass) * m.accel : 0;
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
          text: `Your drives aren't matched: ${PhysicsEngine.side(u.bay)} has ${/^[AEIOU]/.test(u.part.name) ? 'an' : 'a'} ${u.part.name} ${PhysicsEngine.side(u.missingOn)} hasn't${odd.length > 1 ? ` (and ${odd.length - 1} more odd part${odd.length > 2 ? 's' : ''})` : ''}. She'll pull to one side — fit the same to both.` });
      }
      per.forEach((d, i) => {
        if (d.mode === 'none' && per[1 - i].mode !== 'none' && !drives[i].isBroken && tires && !castor && !isThrust(drives[i])) {
          interactions.push({ id: `twin_noshaft${i}`, good: false, mods: {}, text: `${PhysicsEngine.side(i)} has no drive shaft — it isn't turning the wheels at all.` });
        }
      });
    }
    if (dt.lsl) twinBias = 0; // a Limited-Slip Link shares torque: no pulling to one side

    const wear = PHYSICS.TIRE_WEAR_FLOOR + (1 - PHYSICS.TIRE_WEAR_FLOOR) * tireRatio;
    const slickSpeed = castor ? 1 + (1 - slick) * PHYSICS.SLICK_CASTOR_SPEED : 1; // less rolling resistance, more top speed
    const vMax = engine && tires ? rpmAvg * tires.stats.radius * PHYSICS.RPM_TO_SPEED * wear * m.vMax * slickSpeed : 0;

    // Twin drives: what each one contributes, so you can see which side needs work.
    // Push is shared out in proportion to what each drive actually puts down.
    const put = per.map((d) => (d.mode === 'none' ? 0 : d.f * d.eff));
    const putSum = put.reduce((a, b) => a + b, 0);
    const perDrive = drives.length > 1 ? drives.map((d, i) => {
      const pushI = putSum > 0 ? fUsable * (put[i] / putSum) : 0;
      return {
        fDrive: per[i].f,
        fUsable: pushI,
        accel: mass > 0 ? (pushI / mass) * m.accel : 0,
        vMax: rpmAvg > 0 ? vMax * (d.stats.rpm / rpmAvg) : 0,
        cooling: d.stats.cooling * twinK * m.cooling + (coolBy[i] || 0),
        driveEff: fxs[i]?.eff ?? 1,
      };
    }) : null;

    return {
      mass,
      fDrive,
      fGrip,
      fGripBase,
      fUsable,
      accel,
      accelRev,
      accelDry,
      vMax,
      engineRatio,
      tireRatio,
      gripMod,
      radius: chassis.stats.radius * PHYSICS.BUG_SCALE,
      staminaMax: Math.round(chassis.stats.staminaMax * m.staminaMax),
      regen: chassis.stats.regen || 0, // the shell's stamina regen rating (0–100)
      // Once you've run dry: how long before the regen starts, and how fast it refills you.
      regenDelay: STAMINA.REGEN_DELAY_WORST + (STAMINA.REGEN_DELAY_BEST - STAMINA.REGEN_DELAY_WORST) * (chassis.stats.regen || 0) / 100,
      regenRate: STAMINA.REGEN_RATE_WORST + (STAMINA.REGEN_RATE_BEST - STAMINA.REGEN_RATE_WORST) * (chassis.stats.regen || 0) / 100,
      perDrive,
      lsl: !!dt.lsl && drives.length > 1, // a Limited-Slip Link: the two drives work as one (cooling aside)
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
      // How hard the running gear is to push along: more grip and rolling resistance = more heat and stamina.
      gearLoad: PhysicsEngine.gearLoad(tires),
      // Drive train efficiency (each working part's rating multiplied together; a twin averages its drives):
      // what's lost is friction and inertia, so a less efficient line costs more heat and stamina.
      driveEff: fxs.reduce((t, f) => t + f.eff, 0) / fxs.length,
      driveEffs: fxs.length > 1 ? fxs.map((f) => f.eff) : null,
      pinned: castor && !!tires.stats.pinned,
      // Wheels or tracks nothing is holding: no motor, no working shaft, or a thrust
      // drive on wheels — unless a self-locking gearbox (worm, cycloidal, strain wave) holds them.
      freeRoll: !!tires && !castor && !tires.isBroken && !shaftDrive && !dt.lock,
    };
  }

  /** Running gear load (1 = Knobby Treads): grippy tyres and tracks work the motor harder, castors glide. */
  static gearLoad(tires) {
    if (!tires) return 1;
    const st = tires.stats;
    if (tires.type === 'castor') return HEAT.LOAD_CASTOR_BASE + (st.roll || 0) * HEAT.LOAD_CASTOR_ROLL;
    const base = HEAT.LOAD_TYRE_BASE;
    return (base + (1 - base) * (st.mu || HEAT.LOAD_REF_MU) / HEAT.LOAD_REF_MU) * (HEAT.LOAD_KIND[st.kind] || 1);
  }

  /** Deceleration when not driving: grip-braking (times any drive-train brake), plus reverse thrusters firing. */
  static idleBrake(s) {
    if (!(s.mass > 0)) return 0;
    const grip = (s.fGrip / s.mass) * PHYSICS.IDLE_BRAKE * (s.brakeMult ?? 1);
    return grip + (s.reverser ? (s.accelDry ?? s.accel) * PHYSICS.REVERSER_BRAKE : 0);
  }

  /** Current grip modifier from status effects and the environment (slick puddles). */
  /** Grip left by the slickest oil, grease or ice patch under the bug (1 = dry floor). */
  slickness(bug, env) {
    let slick = 1;
    for (const puddle of env.puddles || []) {
      if (bug.pos.distanceTo(puddle.pos) < puddle.radius + bug.radius * 0.4) slick = Math.min(slick, puddle.gripMod);
    }
    return slick;
  }

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
    const s = PhysicsEngine.deriveStats(bug, { gripMod: this.gripModifier(bug, env), slick: this.slickness(bug, env) });
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
        throttle = arrived ? 0.2 : clamp(Math.sqrt(2 * s.accel * (bug.vectorBurst > 0 ? ACTIONS.VECTOR_ACCEL : 1) * dist) / Math.max(1, s.vMax), 0.15, 1);
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
      const step = s.accel * (bug.vectorBurst > 0 ? ACTIONS.VECTOR_ACCEL : 1) * dt; // a swiped burst: 75% more
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

    // Two bottlenecks. Heat: driving under load heats the motor (∝ F_drive · v)
    // and cooling takes it away — overheat and you stall until it cools.
    // Stamina: driving (and every move) uses it up, and it doesn't come back
    // until it's run out completely — then the chassis regen kicks in.
    this.updateStall(bug, s); // hit empty or overheated (an EMP, a last shove…)? You stall straight away
    // Both run off the scores on the hoist (0–100): Cooling against heat, Stamina against the drain.
    const coolScore = Math.min(1, s.cooling / REF.cooling);
    const staminaScore = Math.min(1, s.staminaMax / REF.stamina);
    const heatRate = HEAT.MAX / HEAT.OVERHEAT_SECONDS; // flat out with no cooling at all
    // A ram, shove or spin is the motor flat out too — not a rest.
    const effort = bug.lunge || bug.spin ? 1 : throttle;
    const driving = effort > 0 && !bug.stalled;
    if (driving) {
      // Grip and rolling resistance take more energy; so does a drive train that wastes it.
      const load = (effort * s.drainMult * (s.gearLoad ?? 1) * HEAT.REF_EFFICIENCY) / (s.driveEff || 1);
      bug.heat += heatRate * (load - coolScore) * dt;
      const emptyIn = STAMINA.EMPTY_SECONDS_WORST + (STAMINA.EMPTY_SECONDS_BEST - STAMINA.EMPTY_SECONDS_WORST) * staminaScore ** STAMINA.EMPTY_CURVE;
      bug.stamina -= (s.staminaMax / emptyIn) * load * dt;
    } else {
      bug.heat -= heatRate * (HEAT.IDLE_COOL_BASE + coolScore) * dt; // resting cools you
    }
    bug.heat = clamp(bug.heat, 0, HEAT.MAX);
    // Resting brings a little stamina back — much slower than the regen once you've run dry.
    if (!driving && !bug.regenOn && !(bug.regenWait > 0) && bug.stamina > 0) bug.stamina += s.regenRate * STAMINA.REST_SHARE * dt;
    if (bug.stamina <= 0 && !bug.regenOn && !(bug.regenWait > 0)) {
      bug.regenWait = s.regenDelay; // run dry: the regen only starts after a wait
    }
    if (bug.regenWait > 0 && !bug.regenOn) {
      bug.regenWait -= dt;
      if (bug.regenWait <= 0) bug.regenOn = true;
    }
    if (bug.regenOn) {
      // Regen runs until you're full again (you can drive off once you're back to 20%).
      bug.stamina += s.regenRate * dt;
      if (bug.stamina >= s.staminaMax) bug.regenOn = false;
    }
    bug.stamina = clamp(bug.stamina, 0, s.staminaMax);
    this.updateStall(bug, s);
  }

  updateStall(bug, s = bug.stats) {
    if (!bug.stalled && (bug.heat >= HEAT.MAX || bug.stamina <= 0)) {
      bug.stalled = true;
      bug.stallKind = bug.heat >= HEAT.MAX ? 'heat' : 'power';
      if (bug.stallKind === 'heat') bug.stallStrikes += 1; // overheat three times and you've stalled out
      bug.control.target = null;
      bug.control.cruise = null;
      bug.lunge = null;
      this.emitter?.emit(EVENTS.STALL, { bug, strikes: bug.stallStrikes, kind: bug.stallKind });
    } else if (bug.stalled && bug.heat <= HEAT.MAX * HEAT.RECOVER_AT && bug.stamina >= s.staminaMax * STAMINA.RECOVER_FRACTION) {
      bug.stalled = false;
      bug.stallKind = null;
      this.emitter?.emit(EVENTS.STALL_RECOVER, { bug });
    } else if (bug.stalled) {
      // Still stuck: say which (an overheated motor that's cooled may still be out of stamina).
      bug.stallKind = bug.heat > HEAT.MAX * HEAT.RECOVER_AT ? 'heat' : 'power';
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
