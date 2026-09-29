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
  stamina: 150, turn: 5.5,
  // weapons, by effect
  drain: 48, ram: 40, spikes: 41, lift: 2.1, slick: 336, range: 230,
  // durability (max HP) and weight (kg) per part type
  durability: { chassis: 330, engine: 130, tires: 170, armor: 320, weapon: 130 },
  weight: { chassis: 160, engine: 64, tires: 38, armor: 95, weapon: 50 },
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
  armor: [
    { label: 'Protection', get: (p) => pct(p.stats.absorb * p.hpRatio, REF.absorb) },
    { label: 'Airflow', get: (p) => airflow(p.stats.heat) },
    { label: 'Durability', get: (p) => pct(p.hp, REF.durability.armor) },
    { label: 'Weight', get: (p) => pct(p.mass, REF.weight.armor), neutral: true },
  ],
  chassis: [
    { label: 'Hull', get: (p) => pct(p.hp, REF.durability.chassis) },
    { label: 'Stamina', get: (p) => pct(p.stats.staminaMax, REF.stamina) },
    { label: 'Agility', get: (p) => pct(p.stats.turn, REF.turn) },
    { label: 'Weight', get: (p) => pct(p.mass, REF.weight.chassis), neutral: true },
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
  { label: 'Cooling', key: 'cooling', get: (s) => pct(s.cooling, REF.cooling) },
  { label: 'Hull', key: 'hull', get: (s, bug, repaired) => pct(repaired ? bug.chassis.maxHp : bug.chassis.hp, REF.hull) },
  { label: 'Weight', key: 'mass', get: (s) => pct(s.mass, REF.mass), neutral: true },
];

/** The one-line summary under a part's name. */
export function partSummary(part) {
  const s = part.stats;
  const n = (v) => shown(v);
  switch (part.type) {
    case 'chassis': return `Stamina ${n(pct(s.staminaMax, REF.stamina))} · Agility ${n(pct(s.turn, REF.turn))} · ${s.weaponSlots} hardpoint${s.weaponSlots === 1 ? '' : 's'}`;
    case 'engine': return `Power ${n(pct(s.force, REF.force))} · Revs ${n(pct(s.rpm, REF.rpm))} · Cooling ${n(pct(s.cooling, REF.cooling))}`;
    case 'tires': return `Grip ${n(pct(s.mu, REF.mu))} · Speed ${n(pct(s.radius, REF.tireRadius))}`;
    case 'armor': return `Protection ${n(pct(s.absorb, REF.absorb))} · Airflow ${n(airflow(s.heat))}`;
    case 'weapon': return `Power ${n(weaponPower(s))} · Range ${n(pct(s.range, REF.range))}`;
    default: return '';
  }
}
