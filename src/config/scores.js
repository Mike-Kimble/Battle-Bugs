/**
 * Player-facing stats: every stat is a score where 100 ≈ the best the
 * Marketplace sells. Rare finds can score up to ~150, but the display (number
 * and bar) stops at 100 — you only find out how good they really are in the ring.
 * The physics keeps its real values; these are just the dials on the dashboard.
 */

/** A raw value as a score out of 100 (uncapped). */
const pct = (v, ref) => (ref ? (v / ref) * 100 : 0);

/** What the player sees: 0–100, whole numbers. */
export const shown = (s) => Math.max(0, Math.min(100, Math.round(s)));

/** Reference values that score 100. */
export const REF = Object.freeze({
  // engines
  force: 60000, rpm: 6400, cooling: 16,
  // tires
  mu: 1.6, tireRadius: 10,
  // armour
  absorb: 0.75,
  // chassis
  stamina: 150, turn: 5.5, regen: 100,
  // weapons, by effect
  drain: 48, ram: 40, spikes: 41, lift: 2.1, slick: 336, range: 230,
  // durability (max HP) and weight (kg) per part type
  durability: { chassis: 330, engine: 130, tires: 170, castor: 90, armor: 320, weapon: 130, cooling: 115, enhancement: 115, drivetrain: 150 },
  weight: { chassis: 160, engine: 64, tires: 38, castor: 14, armor: 95, weapon: 50, cooling: 22, enhancement: 14, drivetrain: 30 },
  // castors: glide = how little rolling resistance (0.12 scores 20); control = hold vs the best tyres
  castorRoll: 0.12,
  // add-ons: cooling added (stamina/s) and enhancement boosts (multiplier over 1)
  addCool: 12, fanBoost: 1, boostForce: 0.3, boostAccel: 0.3, boostSpeed: 0.15, boostRecovery: 4, boostSustain: 0.2, boostStamina: 0.1,
  // whole vehicle (derived stats)
  fDrive: 64000, fGrip: 150000, fUsable: 64000, accel: 400, vMax: 460, hull: 330, mass: 400,
});

/** Armour airflow: 60 is neutral plating; heat-trapping plate scores lower, vented plate higher. */
export const airflow = (heat = 0) => 60 - heat * 170;

/** A weapon's punch, whatever it does. */
export function weaponPower(stats) {
  switch (stats.effect) {
    case 'drain': return pct(stats.drain, REF.drain);
    case 'ram': return pct(stats.engineDamage, REF.ram);
    case 'spikes': return pct(stats.engineDamage / stats.tick, REF.spikes);
    case 'lift': return pct(stats.liftTime * (1 - stats.gripMod), REF.lift);
    case 'slick': return pct(stats.puddleRadius * stats.puddleTime * (1 - stats.gripMod), REF.slick);
    default: return 0;
  }
}

/**
 * Scores for one part: [{label, get(part) → score, neutral?}]. `get` uses the
 * part's current HP where damage matters; pass a pristine part for "repaired".
 */
export const PART_SCORES = {
  engine: [
    { label: 'Power', get: (p) => pct(p.stats.force * p.hpRatio, REF.force) },
    { label: 'Revs', get: (p) => pct(p.stats.rpm, REF.rpm) },
    { label: 'Cooling', get: (p) => pct(p.stats.cooling, REF.cooling) },
    { label: 'Durability', get: (p) => pct(p.hp, REF.durability.engine) },
    { label: 'Weight', get: (p) => pct(p.mass, REF.weight.engine), neutral: true },
  ],
  tires: [
    { label: 'Grip', get: (p) => pct(p.stats.mu * p.hpRatio, REF.mu) },
    { label: 'Speed', get: (p) => pct(p.stats.radius, REF.tireRadius) },
    { label: 'Durability', get: (p) => pct(p.hp, REF.durability.tires) },
    { label: 'Weight', get: (p) => pct(p.mass, REF.weight.tires), neutral: true },
  ],
  castor: [
    { label: 'Glide', get: (p) => 100 * (1 - (p.stats.roll * (2 - (p.hpRatio ?? 1))) / REF.castorRoll) + 20 },
    { label: 'Control', get: (p) => pct(p.stats.hold ?? p.stats.roll, REF.mu) },
    { label: 'Speed', get: (p) => pct(p.stats.radius, REF.tireRadius) },
    { label: 'Durability', get: (p) => pct(p.hp, REF.durability.castor) },
    { label: 'Weight', get: (p) => pct(p.mass, REF.weight.castor), neutral: true },
  ],
  armor: [
    { label: 'Protection', get: (p) => pct(p.stats.absorb * p.hpRatio, REF.absorb) },
    { label: 'Airflow', get: (p) => airflow(p.stats.heat) },
    { label: 'Durability', get: (p) => pct(p.hp, REF.durability.armor) },
    { label: 'Weight', get: (p) => pct(p.mass, REF.weight.armor), neutral: true },
  ],
  chassis: [
    { label: 'Hull', get: (p) => pct(p.hp, REF.durability.chassis) },
    { label: 'Stamina', get: (p) => pct(p.stats.staminaMax, REF.stamina) },
    { label: 'Regen', get: (p) => pct(p.stats.regen || 0, REF.regen) },
    { label: 'Agility', get: (p) => pct(p.stats.turn, REF.turn) },
    { label: 'Weight', get: (p) => pct(p.mass, REF.weight.chassis), neutral: true },
  ],
  cooling: [
    { label: 'Cooling', get: (p) => pct(p.stats.cool, REF.addCool) },
    { label: 'Fan boost', get: (p) => pct((p.stats.boost || 1) - 1, REF.fanBoost) },
    { label: 'Weight', get: (p) => pct(p.mass, REF.weight.cooling), neutral: true },
  ],
  enhancement: [
    { label: 'Power', get: (p) => pct((p.stats.force || 1) - 1, REF.boostForce) },
    { label: 'Acceleration', get: (p) => pct((p.stats.accel || 1) - 1, REF.boostAccel) },
    { label: 'Top speed', get: (p) => pct((p.stats.vMax || 1) - 1, REF.boostSpeed) },
    { label: 'Recovery', get: (p) => pct(p.stats.cool || 0, REF.boostRecovery) },
    { label: 'Sustain', get: (p) => pct(1 - (p.stats.drain || 1), REF.boostSustain) },
    { label: 'Stamina', get: (p) => pct((p.stats.staminaMax || 1) - 1, REF.boostStamina) },
    { label: 'Weight', get: (p) => pct(p.mass, REF.weight.enhancement), neutral: true },
  ],
  // Drive train: only the effects a part actually has are shown (like add-ons).
  drivetrain: [
    { label: 'Efficiency', get: (p) => Math.round((p.stats.eff ?? 1) * 100) },
    { label: 'Power', get: (p) => pct((p.stats.force || 1) - 1, 0.35) },
    { label: 'Acceleration', get: (p) => pct((p.stats.accel || 1) - 1, REF.boostAccel) },
    { label: 'Top speed', get: (p) => pct((p.stats.vMax || 1) - 1, REF.boostSpeed) },
    { label: 'Steering', get: (p) => pct((p.stats.turn || 1) - 1, 0.3) },
    { label: 'Grip', get: (p) => pct((p.stats.grip || 1) - 1, 0.12) },
    { label: 'Holding', get: (p) => pct((p.stats.brake || 1) - 1, 2) },
    { label: 'Drive protection', get: (p) => pct(1 - (p.stats.driveGuard || 1), 0.45) },
    { label: 'Durability', get: (p) => pct(p.hp, REF.durability.drivetrain) },
    { label: 'Weight', get: (p) => pct(p.mass, REF.weight.drivetrain), neutral: true },
  ],
  weapon: [
    { label: 'Power', get: (p) => weaponPower(p.stats) },
    { label: 'Range', get: (p) => pct(p.stats.range, REF.range) },
    { label: 'Efficiency', get: (p) => pct(12, p.stats.cost) },
    { label: 'Fire rate', get: (p) => pct(2, p.stats.cooldown) },
    { label: 'Weight', get: (p) => pct(p.mass, REF.weight.weapon), neutral: true },
  ],
};

/** Whole-vehicle scores from derived stats: [{label, key, get(stats, bug, repaired)}]. */
export const VEHICLE_SCORES = [
  { label: 'Push', key: 'fUsable', get: (s) => pct(s.fUsable, REF.fUsable) },
  { label: 'Grip', key: 'fGrip', get: (s) => pct(s.fGrip, REF.fGrip) },
  { label: 'Top speed', key: 'vMax', get: (s) => pct(s.vMax, REF.vMax) },
  { label: 'Acceleration', key: 'accel', get: (s) => pct(s.accel, REF.accel) },
  { label: 'Stamina', key: 'staminaMax', get: (s) => pct(s.staminaMax, REF.stamina) },
  { label: 'Regen', key: 'regen', get: (s) => pct(s.regen || 0, REF.regen) },
  { label: 'Cooling', key: 'cooling', get: (s) => pct(s.cooling, REF.cooling) },
  { label: 'Hull', key: 'hull', get: (s, bug, repaired) => pct(repaired ? bug.chassis.maxHp : bug.chassis.hp, REF.hull) },
  { label: 'Weight', key: 'mass', get: (s) => pct(s.mass, REF.mass), neutral: true },
];

/** The one-line summary under a part's name. */
export function partSummary(part) {
  const s = part.stats;
  const n = (v) => shown(v);
  switch (part.type) {
    case 'chassis': return `Stamina ${n(pct(s.staminaMax, REF.stamina))} · Regen ${n(pct(s.regen || 0, REF.regen))} · Agility ${n(pct(s.turn, REF.turn))} · ${s.weaponSlots} hardpoint${s.weaponSlots === 1 ? '' : 's'}${s.drives > 1 ? ' · twin drive bays' : ''}`;
    case 'engine': return `Power ${n(pct(s.force, REF.force))} · Revs ${n(pct(s.rpm, REF.rpm))} · Cooling ${n(pct(s.cooling, REF.cooling))}`;
    case 'tires': return `Grip ${n(pct(s.mu, REF.mu))} · Speed ${n(pct(s.radius, REF.tireRadius))}`;
    case 'drivetrain': {
      const drawbacks = [(s.vMax || 1) < 1 ? 'less top speed' : null, (s.drain || 1) > 1 ? 'runs warm' : null].filter(Boolean);
      return [s.note, ...drawbacks].join(' · ');
    }
    case 'castor': return `${s.wearPerMatch ? 'Wears out: rebuild every 2 matches · ' : ''}Glide ${n(PART_SCORES.castor[0].get(part))} · Control ${n(PART_SCORES.castor[1].get(part))} · needs thrust`;
    case 'armor': return `Protection ${n(pct(s.absorb, REF.absorb))} · Airflow ${n(airflow(s.heat))}`;
    case 'weapon': return `Power ${n(weaponPower(s))} · Range ${n(pct(s.range, REF.range))}`;
    case 'cooling':
    case 'enhancement': {
      // Only the effects this add-on actually has, plus its drawbacks.
      const bits = PART_SCORES[part.type].filter((r) => !r.neutral).map((r) => [r.label, r.get(part)]).filter(([, v]) => v >= 1)
        .map(([l, v]) => `${l} ${n(v)}`);
      if ((s.drain || 1) > 1) bits.push('runs hot');
      if ((s.force || 1) < 1) bits.push('less power');
      return bits.join(' · ') || 'Barely does anything';
    }
    default: return '';
  }
}
