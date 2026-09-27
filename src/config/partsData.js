/**
 * Part catalogue. Every Part instance references one of these definitions by key.
 *
 * Common fields: type, name, mass (kg), maxHp, value ($AUD, pristine), tier (1–5), rarity.
 * Type-specific `stats`:
 *   chassis: radius, staminaMax, weaponSlots, turn (rad/s), shape
 *   engine:  force (F_base), rpm, cooling (R_cool, stamina/s while idle)
 *   tires:   mu (μ), radius (tire radius → top speed)
 *   armor:   absorb (fraction of impact soaked by plating at full HP)
 *   weapon:  class, effect, cost (stamina), range, arc (deg), cooldown, + effect params
 */
export const PARTS = Object.freeze({
  // ───────────── CHASSIS ─────────────
  scrapper_frame: {
    type: 'chassis', name: 'Scrapper Frame', mass: 70, maxHp: 120, value: 120, tier: 1, rarity: 'common',
    stats: { radius: 26, staminaMax: 100, weaponSlots: 1, turn: 4.2, shape: 'scrapper' },
    description: 'Bolted-together junk. Honest, if unlovely.',
  },
  beetle_shell: {
    type: 'chassis', name: 'Beetle Shell', mass: 95, maxHp: 180, value: 380, tier: 2, rarity: 'common',
    stats: { radius: 29, staminaMax: 110, weaponSlots: 1, turn: 3.8, shape: 'beetle' },
    description: 'Domed elytra plating. Hard to tip, hard to hurt.',
  },
  roach_lowrider: {
    type: 'chassis', name: 'Roach Lowrider', mass: 60, maxHp: 100, value: 420, tier: 2, rarity: 'common',
    stats: { radius: 24, staminaMax: 130, weaponSlots: 2, turn: 5.0, shape: 'roach' },
    description: 'Light, twitchy, twin hardpoints.',
  },
  mantis_frame: {
    type: 'chassis', name: 'Mantis Frame', mass: 80, maxHp: 140, value: 560, tier: 3, rarity: 'uncommon',
    stats: { radius: 27, staminaMax: 120, weaponSlots: 2, turn: 4.6, shape: 'mantis' },
    description: 'Segmented striker with raptorial fore-mounts.',
  },
  scarab_bulwark: {
    type: 'chassis', name: 'Scarab Bulwark', mass: 130, maxHp: 260, value: 900, tier: 4, rarity: 'rare',
    stats: { radius: 32, staminaMax: 105, weaponSlots: 2, turn: 3.2, shape: 'scarab' },
    description: 'A rolling fortress. Slow to turn, slower to die.',
  },
  xeno_hornet: {
    type: 'chassis', name: 'Xeno Hornet', mass: 75, maxHp: 160, value: 1150, tier: 5, rarity: 'rare',
    stats: { radius: 26, staminaMax: 150, weaponSlots: 2, turn: 5.2, shape: 'hornet' },
    description: 'Alien bio-alloy frame with a huge power reserve.',
  },

  // ───────────── ENGINES ─────────────
  rust_motor: {
    type: 'engine', name: 'Rust-Bucket Motor', mass: 30, maxHp: 60, value: 80, tier: 1, rarity: 'common',
    stats: { force: 26000, rpm: 3800, cooling: 10 },
    description: 'It turns. Mostly.',
  },
  torque_block: {
    type: 'engine', name: 'Torque Block V4', mass: 45, maxHp: 90, value: 320, tier: 2, rarity: 'common',
    stats: { force: 42000, rpm: 3400, cooling: 9 },
    description: 'Low-revving shove monster.',
  },
  spinner_x: {
    type: 'engine', name: 'Spinner-X Turbine', mass: 28, maxHp: 55, value: 380, tier: 2, rarity: 'common',
    stats: { force: 30000, rpm: 5600, cooling: 12 },
    description: 'Screams to high RPM. Fast but fragile.',
  },
  fusion_core: {
    type: 'engine', name: 'Fusion Micro-Core', mass: 40, maxHp: 110, value: 1200, tier: 4, rarity: 'rare',
    stats: { force: 52000, rpm: 5000, cooling: 15 },
    description: 'Contained star in a tin can.',
  },
  plasma_twin: {
    type: 'engine', name: 'Plasma Twin-Drive', mass: 55, maxHp: 120, value: 1600, tier: 5, rarity: 'rare',
    stats: { force: 64000, rpm: 4600, cooling: 13 },
    description: 'Alien twin-plasma drive. Pushes planets.',
  },

  // ───────────── TIRES ─────────────
  bald_rollers: {
    type: 'tires', name: 'Bald Rollers', mass: 12, maxHp: 50, value: 40, tier: 1, rarity: 'common',
    stats: { mu: 0.8, radius: 7 },
    description: 'Tread is a distant memory.',
  },
  knobby_treads: {
    type: 'tires', name: 'Knobby Treads', mass: 18, maxHp: 70, value: 160, tier: 2, rarity: 'common',
    stats: { mu: 1.05, radius: 7 },
    description: 'Chunky lugs that bite the dohyo.',
  },
  racing_slicks: {
    type: 'tires', name: 'Racing Slicks', mass: 14, maxHp: 50, value: 200, tier: 2, rarity: 'common',
    stats: { mu: 0.9, radius: 9 },
    description: 'Big diameter, big top speed.',
  },
  crawler_tracks: {
    type: 'tires', name: 'Crawler Tracks', mass: 30, maxHp: 110, value: 420, tier: 3, rarity: 'uncommon',
    stats: { mu: 1.3, radius: 6 },
    description: 'Tank treads. Grip for days, speed for minutes.',
  },
  gecko_pads: {
    type: 'tires', name: 'Gecko Grip Pads', mass: 20, maxHp: 80, value: 900, tier: 4, rarity: 'rare',
    stats: { mu: 1.5, radius: 8 },
    description: 'Setae-lined alien pads. Sticks to anything.',
  },

  // ───────────── ARMOUR ─────────────
  scrap_plating: {
    type: 'armor', name: 'Scrap Plating', mass: 20, maxHp: 60, value: 60, tier: 1, rarity: 'common',
    stats: { absorb: 0.3 },
    description: 'Hubcaps and hope.',
  },
  steel_plate: {
    type: 'armor', name: 'Steel Plate', mass: 40, maxHp: 120, value: 220, tier: 2, rarity: 'common',
    stats: { absorb: 0.45 },
    description: 'Heavy, dependable, dull.',
  },
  titan_weave: {
    type: 'armor', name: 'Titan Weave', mass: 30, maxHp: 140, value: 600, tier: 3, rarity: 'uncommon',
    stats: { absorb: 0.55 },
    description: 'Woven titanium mesh. Light and tough.',
  },
  ablative_shell: {
    type: 'armor', name: 'Ablative Shell', mass: 55, maxHp: 200, value: 850, tier: 4, rarity: 'rare',
    stats: { absorb: 0.6 },
    description: 'Sheds layers so your hull doesn\'t.',
  },

  // ───────────── WEAPONS ─────────────
  emp_pulse: {
    type: 'weapon', name: 'EMP Pulse Dish', mass: 15, maxHp: 50, value: 350, tier: 2, rarity: 'common',
    stats: { class: 'neutralizer', effect: 'drain', cost: 30, range: 120, arc: 360, cooldown: 4, drain: 48 },
    description: 'Radial pulse. Drains opponent stamina, no structural damage.',
  },
  tesla_coil: {
    type: 'weapon', name: 'Tesla Induction Coil', mass: 22, maxHp: 60, value: 450, tier: 3, rarity: 'uncommon',
    stats: { class: 'neutralizer', effect: 'drain', cost: 22, range: 190, arc: 60, cooldown: 3, drain: 32 },
    description: 'Long forward arc bolt. Induces thermal stall.',
  },
  pneumatic_ram: {
    type: 'weapon', name: 'Pneumatic Ram', mass: 40, maxHp: 90, value: 400, tier: 2, rarity: 'common',
    stats: { class: 'strength', effect: 'ram', cost: 18, range: 50, arc: 70, cooldown: 2.5, engineDamage: 26, impulse: 220 },
    description: 'Piston punch to the drivetrain. Permanently lowers F_drive.',
  },
  spike_array: {
    type: 'weapon', name: 'Spike Array', mass: 30, maxHp: 80, value: 300, tier: 1, rarity: 'common',
    stats: { class: 'strength', effect: 'spikes', cost: 14, range: 12, arc: 100, cooldown: 4, duration: 2.2, engineDamage: 7, tick: 0.25 },
    description: 'Deploys drill-spikes. Front contact shreds engines.',
  },
  wedge_lifter: {
    type: 'weapon', name: 'Wedge Lifter', mass: 35, maxHp: 90, value: 380, tier: 2, rarity: 'common',
    stats: { class: 'grip', effect: 'lift', cost: 16, range: 45, arc: 80, cooldown: 3, liftTime: 1.8, gripMod: 0.1, exposeTime: 1.2 },
    description: 'Hydraulic wedge lifts drive wheels. μ → 0.',
  },
  slick_sprayer: {
    type: 'weapon', name: 'Slick Sprayer', mass: 25, maxHp: 60, value: 420, tier: 3, rarity: 'uncommon',
    stats: { class: 'grip', effect: 'slick', cost: 20, range: 150, arc: 360, cooldown: 5, puddleRadius: 60, puddleTime: 7, gripMod: 0.2, exposeTime: 1.0 },
    description: 'Lays an oil slick ahead. Anything on it loses grip.',
  },
});

export const PART_KEYS_BY_TYPE = Object.freeze(
  Object.entries(PARTS).reduce((acc, [key, def]) => {
    (acc[def.type] ||= []).push(key);
    return acc;
  }, {})
);

export function getPartDef(key) {
  const def = PARTS[key];
  if (!def) throw new Error(`Unknown part key: ${key}`);
  return def;
}

/** Keys of a type available at or below a tier. */
export function partsUpToTier(type, tier) {
  return (PART_KEYS_BY_TYPE[type] || []).filter((k) => PARTS[k].tier <= tier);
}

export const STARTER_BUG = Object.freeze({
  name: 'Scrapper Bug',
  hue: 28,
  chassis: 'scrapper_frame',
  engine: 'rust_motor',
  tires: 'bald_rollers',
  armor: 'scrap_plating',
  weapons: [],
});

// ───────────── Flavour tables for procedural opponents ─────────────
export const ALIEN_SYLLABLES = Object.freeze({
  start: ['Zor', 'Kr\'', 'Vex', 'Qui', 'Nyx', 'Glo', 'Xa', 'Th\'', 'Ul', 'Brr', 'Mox', 'Skree', 'Yth', 'Pz'],
  mid: ['la', 'ix', 'bo', 'rr', 'zz', 'ee', 'u', 'ka', 'th', 'on', 'yl', ''],
  end: ['x', 'nak', 'blorp', 'gg', 'vius', 'tar', 'loq', 'zix', 'um', 'ith', 'ok'],
});

export const PLANETS = Object.freeze([
  'Glorp IV', 'Mandibulon', 'Chitinia Prime', 'Vesp-9', 'The Ooze Belt', 'Kepler-Sting', 'Formica Major',
  'Nebula Nest', 'Arachnos', 'Dung Moon', 'Larvax', 'Thorax Station',
]);

export const BUG_ADJECTIVES = Object.freeze([
  'Rusty', 'Grim', 'Hyper', 'Mega', 'Toxic', 'Iron', 'Cosmic', 'Feral', 'Neon', 'Void', 'Chrome', 'Mad', 'Quantum', 'Rabid',
]);

export const BUG_NOUNS = Object.freeze([
  'Weevil', 'Stag', 'Tick', 'Mite', 'Hopper', 'Borer', 'Crusher', 'Chomper', 'Skitter', 'Mandible', 'Grub', 'Locust', 'Scuttler',
]);
