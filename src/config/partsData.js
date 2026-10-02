/**
 * Part catalogue. Every Part instance references one of these definitions by key.
 *
 * Common fields: type, name, mass (kg), maxHp, value (§, pristine), tier (1–5), rarity, look.
 * Rarity: common · uncommon · rare are stocked by the Marketplace; epic and
 * legendary mostly turn up under the hood of other vehicles (won in title
 * matches or bought whole) — the shop only ever teases one you can't afford.
 * `look` is the sprite drawn for the part (a base design, recoloured by `glow`/`tint`).
 * Type-specific `stats`:
 *   chassis: radius, staminaMax, regen (0–100: stamina back every second, driving or not), weaponSlots, turn (rad/s), shape, drives?, backwards?
 *   engine:  force (F_base), rpm, cooling (R_cool, stamina/s while idle), kind
 *   tires:   mu (μ), radius (tire radius → top speed), kind
 *   castor:  roll (rolling resistance, μ-like), hold? (braking/sideways grip, defaults to roll),
 *            radius (→ top speed). Castors share the running-gear slot, aren't driven,
 *            and only move bugs with a thrust drive.
 *   armor:   absorb (fraction of impact soaked by plating at full HP), heat (traps engine heat; <0 vents it)
 *   weapon:  class, effect, cost (stamina), range, arc (deg), cooldown, + effect params
 */
const C = 'common', U = 'uncommon', R = 'rare', E = 'epic', L = 'legendary';
const chassis = (name, tier, rarity, value, mass, maxHp, stats, description) => ({ type: 'chassis', name, tier, rarity, value, mass, maxHp, stats, description });
const engine = (name, tier, rarity, value, mass, maxHp, stats, glow, description) => ({ type: 'engine', name, tier, rarity, value, mass, maxHp, stats, glow, description });
const tires = (name, tier, rarity, value, mass, maxHp, stats, look, description) => ({ type: 'tires', name, tier, rarity, value, mass, maxHp, stats, look, description });
const armor = (name, tier, rarity, value, mass, maxHp, stats, look, description) => ({ type: 'armor', name, tier, rarity, value, mass, maxHp, stats, look, description });
const weapon = (name, tier, rarity, value, mass, maxHp, stats, look, description) => ({ type: 'weapon', name, tier, rarity, value, mass, maxHp, stats, look, description });
const cooler = (name, tier, rarity, value, mass, stats, description) => ({ type: 'cooling', name, tier, rarity, value, mass, maxHp: 40 + tier * 15, stats, description });
const enhance = (name, tier, rarity, value, mass, stats, description) => ({ type: 'enhancement', name, tier, rarity, value, mass, maxHp: 40 + tier * 15, stats, description });
/** Drives that push with thrust rather than turning wheels — the only ones that can use castors. */
export const THRUST_DRIVES = Object.freeze(['turbine', 'plasma']);
const castor = (name, tier, rarity, value, mass, maxHp, stats, description) => ({ type: 'castor', name, tier, rarity, value, mass, maxHp, stats: { ...stats, kind: 'castor' }, description });
const drivetrain = (name, tier, rarity, value, mass, maxHp, stats, description) => ({ type: 'drivetrain', name, tier, rarity, value, mass, maxHp, stats, description });
/** Drives that turn a shaft (everything but turbine and plasma). */
const NON_THRUST = ['combustion', 'torque', 'electric'];
/** Drives that can turn a drive shaft (plasma can't drive wheels or tracks at all). */
const SHAFT_DRIVES = [...NON_THRUST, 'turbine'];
/** Gearboxes suit any shaft drive (on a turbine they only count with a High-Speed Shaft). */
const GEAR_DRIVES = SHAFT_DRIVES;

/** A working drive-train part of this kind is fitted (and suits the drive) — on drive bay `bay`, or on any. */
export function hasDriveTrain(bug, test, bay = null) {
  return (bug?.drivetrain || []).some((p) => (bay === null || (p.bay || 0) === bay) && !p.isBroken && !p.spent && test(p.stats) && worksWith(p, bug));
}

/**
 * A turbine's line to driven wheels on drive bay `bay`: High-Speed Shaft →
 * gearbox → drive shaft → running gear. `complete` when all three are there
 * and working; without the gearbox in the middle it just spins the wheels.
 */
export function turbineLine(bug, bay = 0) {
  const parts = (bug?.drivetrain || []).filter((p) => (p.bay || 0) === bay && !p.isBroken && !p.spent && worksWith(p, bug));
  const shafts = parts.filter((p) => p.stats.shaft).length;
  const hss = parts.some((p) => p.stats.shaft === 'hss');
  const gearbox = parts.some((p) => p.stats.group === 'gearbox');
  // A gearbox with no shaft on its wheel side drives nothing: the wheels aren't connected.
  const connected = shafts > 0 && !(gearbox && shafts < 2);
  return { shafts, hss, gearbox, connected, complete: hss && gearbox && shafts >= 2 };
}

/** Every drive has the full turbine line (see turbineLine). */
export function turbineComplete(bug) {
  const n = Math.max(1, bug?.drives?.length || 0);
  return Array.from({ length: n }, (_, b) => turbineLine(bug, b)).every((l) => l.complete);
}

/** Heavy running gear (tracks, or chunky tyres) that chews through a chain drive. */
export function heavyGear(bug) {
  const t = bug?.tires;
  return !!t && t.type === 'tires' && (t.stats.kind === 'track' || t.mass >= 18);
}

/** A working drive shaft is fitted (needed to turn wheels or tracks) — on drive bay `bay`, or on any. */
export function hasShaft(bug, bay = null) {
  return hasDriveTrain(bug, (s) => !!s.shaft, bay);
}

/**
 * Can this bug push itself along on castors? Thrust drives can; any other drive
 * needs a propeller or ducted fan (on drive bay `bay`, or on any).
 */
export function pushesThrust(bug, bay = null) {
  const drives = bug?.drives?.length ? bug.drives : bug?.engine ? [bug.engine] : [];
  // Twin drives can be different types: each pushes in its own way (or on any, with bay null).
  const kinds = bay === null ? drives.map((d) => d.stats.kind) : [drives[bay]?.stats.kind].filter(Boolean);
  if (!kinds.length) return false;
  return kinds.some((k) => THRUST_DRIVES.includes(k)) || hasDriveTrain(bug, (s) => !!s.prop, bay);
}

/** Motors that are hard on gearing: their instant torque chews through gearboxes. */
export const GEAR_EATERS = ['electric'];

/**
 * How many matches a gearbox (or torque converter) lasts on an electric or
 * drive before it's worn out: 2 for the cheapest, up to 5 for the
 * dearest. Null if it doesn't wear (another drive, or not gearing).
 */
export function gearWearMatches(part, bug) {
  const s = part.stats;
  if (s.group !== 'gearbox' && s.kind !== 'converter') return null;
  if (bug && !GEAR_EATERS.includes(driveKind(bug, part.bay || 0))) return null;
  const t = Math.max(0, Math.min(1, (part.value - 120) / (2400 - 120)));
  return 2 + 3 * t;
}

/** Twin drives coupled by a working Limited-Slip Link (it can't couple a plasma drive). */
export function linkActive(bug) {
  return (bug?.drives?.length || 0) > 1 && hasDriveTrain(bug, (s) => s.lsl) && !bug.drives.some((d) => d.stats.kind === 'plasma');
}

/** The motor type on drive bay `bay` (the first drive's when there's no second). */
export function driveKind(bug, bay = 0) {
  return (bug?.drives?.[bay] || bug?.engine)?.stats.kind ?? null;
}
// Drive types a part works with (omit `works` for "any").
const HOT = ['combustion', 'torque'];
const NOT_ELECTRIC = ['combustion', 'torque', 'turbine', 'plasma'];
/** Water misters: anything with electrics in it (electric, plasma) would short out. */
export const MIST_DRIVES = ['combustion', 'torque', 'turbine'];

export const PARTS = Object.freeze({
  // ───────────── CHASSIS (frames) ─────────────
  scrapper_frame: chassis('Aphid Husk', 1, C, 120, 70, 120, { radius: 26, staminaMax: 100, regen: 22, weaponSlots: 1, turn: 4.2, shape: 'aphid' }, 'A soft, pear-shaped shell patched with scrap. Honest, if unlovely.'),
  shopping_cart: chassis('Ant Gaster', 1, C, 100, 65, 110, { radius: 25, staminaMax: 95, regen: 8, weaponSlots: 1, turn: 4.4, shape: 'ant' }, 'Mostly abdomen. Carries many times its own weight, apparently.'),
  lawnmower_deck: chassis('Daddy No-Legs', 1, U, 150, 80, 135, { radius: 27, staminaMax: 102, regen: 36, weaponSlots: 1, turn: 3.9, shape: 'daddy' }, 'A daddy-long-legs that lost every leg in a bet. Round, tough and bitter about it.'),
  beetle_shell: chassis('Beetle Shell', 2, C, 380, 95, 180, { radius: 29, staminaMax: 110, regen: 31, weaponSlots: 1, turn: 3.8, shape: 'beetle', backwards: { fwd: 0.85, rev: 1.25 } }, 'Domed elytra plating. Hard to tip, hard to hurt.'),
  roach_lowrider: chassis('Roach Lowrider', 2, C, 420, 60, 100, { radius: 24, staminaMax: 130, regen: 45, weaponSlots: 2, turn: 5.0, shape: 'roach' }, 'Light, twitchy, twin hardpoints.'),
  tick_pod: chassis('Ladybird Pod', 2, U, 400, 85, 170, { radius: 26, staminaMax: 115, regen: 52, weaponSlots: 1, turn: 4.2, shape: 'beetle' }, 'Round, spotty and surprisingly hard to knock over.'),
  grasshopper_rig: chassis('Grasshopper Rig', 2, R, 460, 62, 118, { radius: 24, staminaMax: 124, regen: 71, weaponSlots: 2, turn: 5.1, shape: 'roach' }, 'Long legs folded underneath. Springy, quick and a bit flimsy.'),
  mantis_frame: chassis('Mantis Frame', 3, U, 560, 80, 140, { radius: 27, staminaMax: 120, regen: 40, weaponSlots: 2, turn: 4.6, shape: 'mantis' }, 'Segmented striker with raptorial fore-mounts.'),
  stag_brawler: chassis('Stag Brawler', 3, C, 620, 110, 210, { radius: 30, staminaMax: 110, regen: 17, weaponSlots: 2, turn: 3.8, shape: 'scarab', drives: 2 }, 'All shoulders. Built for leaning on people. Room for twin drives.'),
  weevil_wedge: chassis('Weevil Wedge', 3, U, 640, 90, 175, { radius: 28, staminaMax: 120, regen: 28, weaponSlots: 2, turn: 4.2, shape: 'beetle' }, 'A low nose that gets under things it shouldn\'t.'),
  dragonfly_frame: chassis('Dragonfly Frame', 3, R, 740, 68, 140, { radius: 25, staminaMax: 128, regen: 84, weaponSlots: 2, turn: 5.3, shape: 'hornet' }, 'A four-winged airframe on wheels. Darts about; hates being hit.'),
  scarab_bulwark: chassis('Scarab Bulwark', 4, R, 900, 130, 260, { radius: 32, staminaMax: 105, regen: 62, weaponSlots: 2, turn: 3.2, shape: 'scarab', backwards: { fwd: 0.85, rev: 1.25 } }, 'A rolling fortress. Slow to turn, slower to die.'),
  rhino_ram: chassis('Rhino Ram', 4, U, 880, 135, 270, { radius: 33, staminaMax: 104, regen: 33, weaponSlots: 2, turn: 3.3, shape: 'scarab', drives: 2 }, 'Horn first, questions never. Room for twin drives.'),
  locust_racer: chassis('Locust Racer', 4, R, 1000, 65, 150, { radius: 25, staminaMax: 145, regen: 88, weaponSlots: 2, turn: 5.5, shape: 'roach' }, 'Stripped to the rivets for speed. Swarms well.'),
  mantis_prime: chassis('Mantis Prime', 4, E, 1300, 90, 215, { radius: 28, staminaMax: 132, regen: 79, weaponSlots: 2, turn: 4.8, shape: 'mantis' }, 'A mantis frame with forearms of forged alloy. Built to grapple.'),
  hornet_interceptor: chassis('Hornet Interceptor', 5, R, 1150, 78, 175, { radius: 26, staminaMax: 138, regen: 93, weaponSlots: 2, turn: 5.2, shape: 'hornet' }, 'Striped, sleek and very fast, with a stamina reserve for days.'),
  goliath_hull: chassis('Goliath Hull', 5, R, 1400, 150, 330, { radius: 34, staminaMax: 115, regen: 66, weaponSlots: 2, turn: 3.2, shape: 'scarab', drives: 2 }, 'Less a vehicle, more a postcode. Room for twin drives.'),
  hercules_beetle: chassis('Hercules Beetle', 5, E, 1800, 130, 300, { radius: 32, staminaMax: 125, regen: 86, weaponSlots: 2, turn: 3.8, shape: 'scarab', drives: 2 }, 'A horned heavyweight that lifts a hundred times its own weight. Room for twin drives.'),
  jewel_scarab: chassis('Jewel Scarab', 5, L, 2600, 95, 260, { radius: 29, staminaMax: 150, regen: 100, weaponSlots: 2, turn: 4.9, shape: 'beetle', backwards: { fwd: 0.85, rev: 1.25 } }, 'The iridescent shell of a sacred beetle. Tough, balanced and absurdly pretty.'),
  titan_colossus: chassis('Titan Beetle', 5, L, 2500, 160, 380, { radius: 35, staminaMax: 132, regen: 94, weaponSlots: 2, turn: 3.6, shape: 'scarab', drives: 2 }, 'Shell of the biggest beetle ever recorded. Somehow still turns. Room for twin drives.'),

  // ───────────── ENGINES (propulsion) ─────────────
  rust_motor: engine('Rust-Bucket Motor', 1, C, 80, 30, 60, { force: 26000, rpm: 3800, cooling: 10, kind: 'combustion' }, '#ff8a3d', 'It turns. Mostly.'),
  lawn_thumper: engine('Lawn Thumper', 1, C, 90, 26, 55, { force: 24000, rpm: 4100, cooling: 11, kind: 'combustion' }, '#ffa04d', 'Pull-start single. Three pulls on a good day.'),
  sputter_single: engine('Sputter Single', 1, U, 140, 32, 62, { force: 28500, rpm: 3900, cooling: 9, kind: 'combustion' }, '#ff7a2d', 'Coughs like a smoker, pulls like a mule.'),
  torque_block: engine('Torque Block V4', 2, C, 320, 45, 90, { force: 46000, rpm: 3400, cooling: 9, kind: 'torque' }, '#ffb03d', 'Low-revving shove monster.'),
  spinner_x: engine('Spinner-X Turbine', 2, C, 380, 28, 55, { force: 30000, rpm: 5600, cooling: 12, kind: 'turbine' }, '#ffe14a', 'Screams to high RPM. Fast but fragile.'),
  volt_hub: engine('DC Electric Motor', 2, U, 420, 34, 70, { force: 36000, rpm: 4400, cooling: 14, kind: 'electric' }, '#5ad8ff', 'A plain brushed DC motor. Silent, cool and very good at sharing its battery.'),
  grub_diesel: engine('Grub-Diesel Twin', 2, R, 520, 52, 100, { force: 46000, rpm: 3500, cooling: 8, kind: 'torque' }, '#ffc03d', 'Runs on larva oil. Pushes like it means it.'),
  hive_v6: engine('Hive V6', 3, C, 620, 44, 95, { force: 46000, rpm: 4300, cooling: 11, kind: 'combustion' }, '#ff9a3d', 'The workhorse of the outer rings.'),
  whine_turbine: engine('Whine-Jet Turbine', 3, U, 720, 32, 65, { force: 36000, rpm: 6200, cooling: 13, kind: 'turbine' }, '#fff06a', 'You\'ll hear it two arenas away.'),
  magnetar_hub: engine('AC Induction Motor', 3, R, 880, 38, 85, { force: 44000, rpm: 4900, cooling: 16, kind: 'electric' }, '#6ae8ff', 'A rugged AC induction motor: no brushes to wear, runs cold.'),
  thorax_bigblock: engine('Thorax Big-Block', 3, E, 1100, 60, 120, { force: 56000, rpm: 3900, cooling: 9, kind: 'torque' }, '#ffcf3d', 'Illegal in four systems. Makes the ring shake.'),
  fusion_core: engine('Axial Flux Motor', 4, R, 1200, 40, 110, { force: 52000, rpm: 5000, cooling: 15, kind: 'electric' }, '#7dfcff', 'A flat pancake of an electric motor with huge torque for its size.'),
  ion_screamer: engine('Ion Screamer', 4, U, 1050, 34, 75, { force: 44000, rpm: 6400, cooling: 14, kind: 'turbine' }, '#e8ff7a', 'Ion-fed turbine. The top speed is frankly irresponsible.'),
  tectonic_v12: engine('Tectonic V12', 4, R, 1300, 64, 130, { force: 60000, rpm: 4000, cooling: 10, kind: 'torque' }, '#ffb85d', 'Twelve cylinders of continental drift.'),
  nebula_cell: engine('Brushless DC Motor', 4, E, 1500, 38, 115, { force: 56000, rpm: 5400, cooling: 18, kind: 'electric' }, '#9ad8ff', 'A brushless DC motor: efficient, quick to respond, hard to stall.'),
  plasma_twin: engine('Plasma Twin-Drive', 5, R, 1600, 55, 170, { force: 68000, rpm: 4600, cooling: 13, kind: 'plasma' }, '#c77dff', 'Alien twin-plasma drive. Pushes planets.'),
  quasar_turbine: engine('Quasar Turbine', 5, E, 1800, 36, 90, { force: 54000, rpm: 6600, cooling: 15, kind: 'turbine' }, '#fffaa0', 'Spins at the speed of gossip.'),
  plasma_lance: engine('Plasma Lance', 4, E, 1500, 44, 120, { force: 58000, rpm: 4900, cooling: 14, kind: 'plasma' }, '#a07dff', 'A needle of plasma thrust. Enough to shove a moon — and happy on castors.'),
  singularity_drive: engine('Maglev Motor', 5, L, 2600, 50, 140, { force: 72000, rpm: 5300, cooling: 16, kind: 'electric' }, '#ffffff', 'A magnetic-levitation motor: the rotor floats, nothing touches, nothing wears. Brutal torque.'),
  zero_point_core: engine('PM Sync Motor', 5, L, 2800, 42, 160, { force: 70000, rpm: 5600, cooling: 22, kind: 'electric' }, '#aaf0ff', 'A permanent-magnet synchronous motor: the most efficient electric drive there is. Runs very cold.'),

  // ───────────── TIRES (running gear) ─────────────
  bald_rollers: tires('Bald Rollers', 1, C, 40, 12, 50, { mu: 0.8, radius: 7, kind: 'wheel' }, { kind: 'wheels', body: '#4a4552', stripe: '#5d5866', gap: 0 }, 'Tread is a distant memory.'),
  junk_casters: tires('Bike Tyres', 1, C, 45, 10, 45, { mu: 0.76, radius: 7.5, kind: 'wheel' }, { kind: 'wheels', body: '#5a5462', stripe: '#77707e', gap: 0 }, 'Skinny tyres off a scrapped bicycle. Light and quick, not much grip.'),
  rubber_nubs: tires('Rubber Nubs', 1, U, 70, 14, 55, { mu: 0.88, radius: 6.5, kind: 'knobby' }, { kind: 'wheels', body: '#2a2630', stripe: '#46404e', gap: 4 }, 'Stubby lugs that bite a little.'),
  knobby_treads: tires('Knobby Treads', 2, C, 160, 18, 70, { mu: 1.05, radius: 7, kind: 'knobby' }, { kind: 'wheels', body: '#1d1a22', stripe: '#3a3542', gap: 5 }, 'Chunky lugs that bite the dohyo.'),
  racing_slicks: tires('Racing Slicks', 2, C, 200, 14, 50, { mu: 0.9, radius: 9, kind: 'slick' }, { kind: 'wheels', body: '#141218', stripe: '#c83a3a', gap: 0, big: true }, 'Big diameter, big top speed.'),
  balloon_wheels: tires('Balloon Wheels', 2, U, 180, 15, 55, { mu: 0.95, radius: 8.5, kind: 'wheel' }, { kind: 'wheels', body: '#3a3050', stripe: '#8a7ad0', gap: 0, big: true }, 'Bouncy. Forgiving. Mildly ridiculous.'),
  mud_paddles: tires('Mud Paddles', 2, R, 260, 20, 75, { mu: 1.12, radius: 7, kind: 'knobby' }, { kind: 'wheels', body: '#2a2218', stripe: '#6a5638', gap: 6 }, 'Paddle-lugs from the swamp moons. Dig in and shove.'),
  crawler_tracks: tires('Crawler Tracks', 3, U, 420, 30, 110, { mu: 1.3, radius: 6, kind: 'track' }, { kind: 'track', body: '#23202a', stripe: '#55505e', gap: 5 }, 'Tank treads. Grip for days, speed for minutes.'),
  street_slicks: tires('Street Slicks', 3, C, 450, 15, 60, { mu: 1.0, radius: 9.5, kind: 'slick' }, { kind: 'wheels', body: '#18161c', stripe: '#e0c040', gap: 0, big: true }, 'Road-legal on at least one planet.'),
  chitin_cleats: tires('Chitin Cleats', 3, U, 480, 20, 85, { mu: 1.2, radius: 7.5, kind: 'knobby' }, { kind: 'wheels', body: '#2a3a24', stripe: '#6a8a50', gap: 5 }, 'Shed claws, bolted on. Grippy and a bit gross.'),
  silk_slicks: tires('Silk Slicks', 3, R, 620, 13, 55, { mu: 1.05, radius: 10, kind: 'slick' }, { kind: 'wheels', body: '#1a1822', stripe: '#e8e0ff', gap: 0, big: true }, 'Spun by moth-worms. Whisper-quiet and very quick.'),
  gecko_pads: tires('Gecko Grip Pads', 4, R, 900, 20, 80, { mu: 1.5, radius: 8, kind: 'pads' }, { kind: 'track', body: '#1f3a22', stripe: '#6bff7a', gap: 7 }, 'Setae-lined alien pads. Sticks to anything.'),
  war_tracks: tires('War Tracks', 4, U, 850, 34, 140, { mu: 1.45, radius: 6.5, kind: 'track' }, { kind: 'track', body: '#2a2622', stripe: '#7a6a50', gap: 5 }, 'Ex-military. Still has the paperwork.'),
  mag_rollers: tires('Mag Rollers', 4, R, 950, 18, 80, { mu: 1.3, radius: 9, kind: 'wheel' }, { kind: 'wheels', body: '#20202a', stripe: '#5ad8ff', gap: 0, big: true }, 'Magnetised rims that hug the ring.'),
  hover_skids: tires('Hover Skids', 4, E, 1100, 12, 60, { mu: 1.15, radius: 10, kind: 'slick' }, { kind: 'wheels', body: '#1a1a2a', stripe: '#ff7ad8', gap: 0, big: true }, 'Barely touch the ground. That\'s the point, and the problem.'),
  titan_tracks: tires('Titan Tracks', 5, R, 1400, 38, 170, { mu: 1.6, radius: 7, kind: 'track' }, { kind: 'track', body: '#2a2a30', stripe: '#a0a0b0', gap: 6 }, 'Each link weighs more than you do.'),
  setae_pads: tires('Setae Pads', 5, E, 1500, 18, 90, { mu: 1.65, radius: 8.5, kind: 'pads' }, { kind: 'track', body: '#1a3a2a', stripe: '#9affb0', gap: 7 }, 'A million microscopic hairs. Sticks to the ring, and to fingers.'),
  comet_slicks: tires('Comet Slicks', 5, E, 1600, 14, 70, { mu: 1.25, radius: 10, kind: 'slick' }, { kind: 'wheels', body: '#101018', stripe: '#7afcff', gap: 0, big: true }, 'Leave a little tail of sparks. Very fast.'),
  void_grip: tires('Void-Grip Pads', 5, L, 2400, 16, 100, { mu: 1.8, radius: 9, kind: 'pads' }, { kind: 'track', body: '#10081a', stripe: '#c77dff', gap: 7 }, 'They grip the ring by bending space slightly. Probably fine.'),
  phase_wheels: tires('Phase Wheels', 5, L, 2300, 15, 100, { mu: 1.5, radius: 9.5, kind: 'wheel' }, { kind: 'wheels', body: '#141024', stripe: '#ffffff', gap: 0, big: true }, 'Half here, half somewhere else. The half here grips beautifully.'),

  // ───────────── CASTORS (undriven running gear, hidden under the chassis) ─────────────
  // Thrust drives only. Lower rolling resistance = quicker off the line, but you
  // glide: the bug keeps going until you thrust the other way.
  // `roll` is drag against the thrust; `hold` is what keeps the line and brakes (tyres run ~1–1.8).
  swivel_castors: castor('Swivel Castors', 2, C, 150, 10, 50, { roll: 0.1, hold: 0.3, radius: 8 }, 'Office-chair castors under a thrust bug. Cheap, squeaky, still slippery.'),
  ball_transfers: castor('Ball Transfer Units', 2, U, 230, 12, 60, { roll: 0.085, hold: 0.25, radius: 8.5 }, 'Steel balls in cups. Rolls any way you point it — and some ways you don\'t.'),
  nylon_glides: castor('Nylon Glides', 3, C, 380, 8, 55, { roll: 0.07, hold: 0.2, radius: 9 }, 'Low-friction pucks. Like driving on a freshly mopped floor.'),
  bearing_array: castor('Graphite Discs', 3, U, 520, 14, 70, { roll: 0.055, hold: 0.16, radius: 9.5, wearPerMatch: 0.38 }, 'Self-lubricating graphite pucks. Very little holds you back — but they grind themselves down and need rebuilding every two matches.'),
  air_skirt: castor('Air-Cushion Skirt', 4, R, 900, 12, 65, { roll: 0.04, hold: 0.1, radius: 10 }, 'Rides on a film of air. Brakes? What brakes?'),
  maglev_pucks: castor('Mag-Lev Pucks', 4, E, 1300, 10, 70, { roll: 0.025, hold: 0.08, radius: 10.5 }, 'Floats a finger-width off the ring. Stops about as well as a comet.'),
  // The Superconductor Array is flux-pinned to the ring: frictionless off the line, yet it
  // holds its line and brakes onto the spot you point at (`pinned`).
  superconductor_array: castor('Superconductor Array', 5, L, 2600, 9, 90, { roll: 0.005, hold: 1.1, pinned: true, radius: 11 }, 'Chilled to near absolute zero and flux-pinned to the ring. Almost no drag, so it leaps off the line — yet it holds its line and stops right where you point it.'),

  // ───────────── ARMOUR ─────────────
  tin_foil_wrap: armor('Tin-Foil Wrap', 1, C, 50, 8, 40, { absorb: 0.22, heat: 0 }, 'scrap_plating', 'Blocks mind-rays. Blocks very little else.'),
  scrap_plating: armor('Scrap Plating', 1, C, 60, 20, 60, { absorb: 0.3, heat: 0 }, 'scrap_plating', 'Hubcaps and hope.'),
  hubcap_mail: armor('Hubcap Mail', 1, U, 90, 24, 70, { absorb: 0.33, heat: 0.05 }, 'scrap_plating', 'Chain mail, but hubcaps. Clanks with pride.'),
  steel_plate: armor('Steel Plate', 2, C, 220, 40, 120, { absorb: 0.45, heat: 0.1 }, 'steel_plate', 'Heavy, dependable, dull.'),
  rubber_bumpers: armor('Rubber Bumpers', 2, C, 200, 22, 100, { absorb: 0.38, heat: 0 }, 'steel_plate', 'Boing. Surprisingly effective.'),
  chitin_plates: armor('Chitin Plates', 2, U, 300, 26, 110, { absorb: 0.42, heat: 0 }, 'titan_weave', 'Moulted shell plates. Light, and they breathe.'),
  lead_skirt: armor('Lead Skirt', 2, R, 340, 55, 150, { absorb: 0.5, heat: 0.2 }, 'steel_plate', 'Thick, heavy, radiation-proof. Traps heat like a duvet.'),
  titan_weave: armor('Titan Weave', 3, U, 600, 30, 140, { absorb: 0.55, heat: 0.05 }, 'titan_weave', 'Woven titanium mesh. Light and tough.'),
  boiler_plate: armor('Boiler Plate', 3, C, 560, 60, 190, { absorb: 0.6, heat: 0.25 }, 'steel_plate', 'Cut from an actual boiler. Keeps the heat in, as boilers do.'),
  vented_carapace: armor('Vented Carapace', 3, R, 650, 28, 130, { absorb: 0.5, heat: -0.1 }, 'titan_weave', 'Louvred shell plates that draw air over the motor.'),
  ceramic_tiles: armor('Ceramic Tiles', 3, R, 700, 34, 150, { absorb: 0.56, heat: 0.08 }, 'ablative_shell', 'Re-entry tiles. Shrug off hits, crack eventually.'),
  ablative_shell: armor('Ablative Shell', 4, R, 850, 55, 260, { absorb: 0.6, heat: 0.15 }, 'ablative_shell', 'Sheds layers so your hull doesn\'t.'),
  mirror_mesh: armor('Mirror Mesh', 4, R, 900, 30, 170, { absorb: 0.58, heat: 0 }, 'titan_weave', 'Reflective weave. Also great for checking your antennae.'),
  fortress_slab: armor('Fortress Slab', 4, U, 950, 80, 260, { absorb: 0.7, heat: 0.3 }, 'steel_plate', 'Nothing gets through. Including air.'),
  gel_armour: armor('Gel Armour', 4, E, 1250, 36, 190, { absorb: 0.62, heat: -0.05 }, 'ablative_shell', 'Wobbly, self-healing goo in a skin. Soaks hits and heat alike.'),
  bulwark_plate: armor('Bulwark Plate', 5, R, 1300, 95, 320, { absorb: 0.75, heat: 0.35 }, 'steel_plate', 'The thickest plate money can buy. Your motor will hate it.'),
  nano_scale: armor('Nano-Scale Mail', 5, E, 1500, 28, 210, { absorb: 0.66, heat: 0 }, 'titan_weave', 'Scales the size of atoms, arranged by very patient robots.'),
  dragon_hide: armor('Dragon Hide', 5, E, 1700, 40, 240, { absorb: 0.7, heat: -0.1 }, 'ablative_shell', 'From a creature that breathed fire, and so knew all about cooling.'),
  queen_carapace: armor("Queen's Carapace", 5, L, 2400, 34, 260, { absorb: 0.74, heat: -0.1 }, 'titan_weave', 'Royal shell. Light as silk, hard as a grudge.'),
  aegis_field: armor('Aegis Field', 5, L, 2600, 26, 230, { absorb: 0.78, heat: 0 }, 'ablative_shell', 'Not armour so much as a strongly worded force field.'),

  // ───────────── WEAPONS ─────────────
  // Stamina neutralizers
  static_zapper: weapon('Static Zapper', 1, C, 200, 12, 40, { class: 'neutralizer', effect: 'drain', cost: 22, range: 90, arc: 360, cooldown: 4.5, drain: 30 }, 'emp_pulse', 'A carpet, a balloon and a lot of rubbing.'),
  emp_pulse: weapon('EMP Pulse Dish', 2, C, 350, 15, 50, { class: 'neutralizer', effect: 'drain', cost: 30, range: 120, arc: 360, cooldown: 4, drain: 48 }, 'emp_pulse', 'Radial pulse. Drains opponent stamina, no structural damage.'),
  tesla_coil: weapon('Tesla Induction Coil', 3, U, 450, 22, 60, { class: 'neutralizer', effect: 'drain', cost: 22, range: 190, arc: 60, cooldown: 3, drain: 32 }, 'tesla_coil', 'Long forward arc bolt. Induces thermal stall.'),
  arc_lance: weapon('Arc Lance', 4, R, 900, 24, 70, { class: 'neutralizer', effect: 'drain', cost: 24, range: 230, arc: 40, cooldown: 3, drain: 40 }, 'tesla_coil', 'A narrow bolt from very far away. Rude.'),
  brainwave_jammer: weapon('Brainwave Jammer', 5, E, 1500, 18, 70, { class: 'neutralizer', effect: 'drain', cost: 26, range: 160, arc: 360, cooldown: 3.5, drain: 56 }, 'emp_pulse', 'Makes the other pilot forget which pedal is which.'),
  void_siphon: weapon('Void Siphon', 5, L, 2400, 20, 80, { class: 'neutralizer', effect: 'drain', cost: 20, range: 210, arc: 90, cooldown: 2.6, drain: 50 }, 'tesla_coil', 'Drinks energy straight out of the air between you.'),
  // Strength destroyers
  nail_bristles: weapon('Nail Bristles', 1, C, 150, 20, 60, { class: 'strength', effect: 'spikes', cost: 12, range: 12, arc: 90, cooldown: 4.5, duration: 1.8, engineDamage: 5, tick: 0.3 }, 'spike_array', 'A plank with nails in it. Classic.'),
  spike_array: weapon('Spike Array', 1, U, 300, 30, 80, { class: 'strength', effect: 'spikes', cost: 14, range: 12, arc: 100, cooldown: 4, duration: 2.2, engineDamage: 7, tick: 0.25 }, 'spike_array', 'Deploys drill-spikes. Front contact shreds engines.'),
  pneumatic_ram: weapon('Pneumatic Ram', 2, C, 400, 40, 90, { class: 'strength', effect: 'ram', cost: 18, range: 50, arc: 70, cooldown: 2.5, engineDamage: 26, impulse: 220 }, 'pneumatic_ram', 'Piston punch to the drivetrain. Permanently lowers F_drive.'),
  piston_punch: weapon('Piston Punch', 3, U, 620, 44, 100, { class: 'strength', effect: 'ram', cost: 18, range: 55, arc: 70, cooldown: 2.3, engineDamage: 32, impulse: 250 }, 'pneumatic_ram', 'A bigger piston. Subtlety not included.'),
  drill_crown: weapon('Drill Crown', 3, R, 680, 32, 90, { class: 'strength', effect: 'spikes', cost: 15, range: 14, arc: 110, cooldown: 3.6, duration: 2.6, engineDamage: 9, tick: 0.22 }, 'spike_array', 'A ring of spinning drills. Motors fear it.'),
  hammerhead: weapon('Hammerhead', 4, R, 1100, 50, 120, { class: 'strength', effect: 'ram', cost: 20, range: 60, arc: 80, cooldown: 2.2, engineDamage: 40, impulse: 300 }, 'pneumatic_ram', 'A sledgehammer on a spring. Knocks engines out of alignment.'),
  gravity_hammer: weapon('Gravity Hammer', 5, E, 1700, 48, 130, { class: 'strength', effect: 'ram', cost: 22, range: 65, arc: 80, cooldown: 2, engineDamage: 50, impulse: 360 }, 'pneumatic_ram', 'Hits with the weight of a small moon.'),
  mandible_shredder: weapon('Mandible Shredder', 5, L, 2500, 34, 120, { class: 'strength', effect: 'spikes', cost: 14, range: 16, arc: 120, cooldown: 3, duration: 3, engineDamage: 13, tick: 0.2 }, 'spike_array', 'Jaws from something that should have stayed extinct.'),
  // Grip destroyers
  scoop_plow: weapon('Scoop Plow', 1, C, 180, 30, 80, { class: 'grip', effect: 'lift', cost: 16, range: 40, arc: 70, cooldown: 3.5, liftTime: 1.2, gripMod: 0.2, exposeTime: 1.4 }, 'wedge_lifter', 'A snow plough from a planet without snow.'),
  wedge_lifter: weapon('Wedge Lifter', 2, C, 380, 35, 90, { class: 'grip', effect: 'lift', cost: 16, range: 45, arc: 80, cooldown: 3, liftTime: 1.8, gripMod: 0.1, exposeTime: 1.2 }, 'wedge_lifter', 'Hydraulic wedge lifts drive wheels. μ → 0.'),
  grease_gun: weapon('Grease Gun', 2, U, 300, 20, 55, { class: 'grip', effect: 'slick', cost: 18, range: 120, arc: 360, cooldown: 5.5, puddleRadius: 50, puddleTime: 6, gripMod: 0.3, exposeTime: 1.1 }, 'slick_sprayer', 'Squirts. Aim is optional.'),
  slick_sprayer: weapon('Slick Sprayer', 3, U, 420, 25, 60, { class: 'grip', effect: 'slick', cost: 20, range: 150, arc: 360, cooldown: 5, puddleRadius: 60, puddleTime: 7, gripMod: 0.2, exposeTime: 1.0 }, 'slick_sprayer', 'Lays an oil slick ahead. Anything on it loses grip.'),
  flipper_wedge: weapon('Flipper Wedge', 4, R, 1000, 38, 100, { class: 'grip', effect: 'lift', cost: 13, range: 50, arc: 90, cooldown: 2.8, liftTime: 2.2, gripMod: 0.05, exposeTime: 1.1 }, 'wedge_lifter', 'Gets under them and keeps them there.'),
  // ───────────── COOLING (propulsion add-ons, 3 slots) ─────────────
  // stats: cool (+stamina/s recovered), kind, works?, uses? (battles), boost? (fans), ventBonus?, staminaMax?
  tin_heat_sink: cooler('Tin Heat Sink', 1, C, 40, 4, { cool: 1.5, kind: 'heatsink' }, 'A slab of tin with ambitions. A fan or a mister makes it work harder.'),
  radiator_fins: cooler('Aluminium Heat Sink', 1, C, 70, 6, { cool: 2.5, kind: 'heatsink' }, 'Thin aluminium fins, big surface, honest work. A fan or a mister makes it work much harder.'),
  desk_fan: cooler('Fan', 1, C, 30, 3, { cool: 0.5, kind: 'fan', boost: 1.5, ventBonus: 3 }, 'Pretty useless on its own. Point it at water cooling, an oil cooler, a heat exchanger or vented armour and it earns its keep.'),
  water_mister: cooler('Water Mister', 1, U, 90, 8, { cool: 3, kind: 'mister', works: MIST_DRIVES, mist: 0.25, mistWear: 0.04 }, 'Sprays the motor like a sweaty athlete. Makes radiators, oil coolers, heat sinks and fans on its drive work harder — but the damp wears the drive faster. Combustion, torque and turbine only.'),
  heat_exchanger: cooler('Copper Heat Sink', 2, C, 220, 12, { cool: 4, kind: 'heatsink' }, 'A heavy copper block that drinks heat. A fan or a mister makes it work much harder.'),
  oil_cooler: cooler('Oil Cooler', 2, C, 200, 10, { cool: 4.5, kind: 'oil', jacket: 'oil' }, 'Keeps the oil from turning into soup. Plugs straight into combustion and torque motors; anything else needs an Oil Jacket fitted first.'),
  water_cooling: cooler('Pewter Radiator', 2, U, 300, 16, { cool: 5, kind: 'water', jacket: 'water' }, 'A dull grey water radiator that does the job. Plumbs straight into combustion and torque motors; anything else needs a Water Jacket fitted first.'),
  expansion_nozzle: cooler('Expansion Nozzle', 2, U, 280, 6, { cool: 7, kind: 'nozzle', works: ['turbine'] }, 'Bleeds turbine exhaust through a cold throat. Only works on turbines, and works very well.'),
  twin_fans: cooler('Twin Fans', 2, R, 180, 5, { cool: 0.8, kind: 'fan', boost: 1.7, ventBonus: 4 }, 'Two fans, twice the draught. Still wants something to blow on.'),
  mist_curtain: cooler('Mist Curtain', 3, U, 520, 10, { cool: 6, kind: 'mister', works: MIST_DRIVES, mist: 0.35, mistWear: 0.06 }, 'A whole wall of spray. Radiators, oil coolers, heat sinks and fans on its drive work much harder — but the drive wears faster in the wet. Combustion, torque and turbine only.'),
  big_rig_radiator: cooler('Aluminium Radiator', 3, C, 480, 22, { cool: 6.5, kind: 'water', jacket: 'water' }, 'A big aluminium water radiator. Heavy and very effective. Plumbs straight into combustion and torque motors; anything else needs a Water Jacket fitted first.'),
  silver_radiator: cooler('Silver Radiator', 3, R, 950, 14, { cool: 8.5, kind: 'water', jacket: 'water' }, 'A solid-silver water radiator: lighter and far better than aluminium. Plumbs straight into combustion and torque motors; anything else needs a Water Jacket fitted first.'),
  peltier_plates: cooler('Peltier Plates', 3, R, 700, 8, { cool: 5, kind: 'peltier', works: ['electric'], staminaMax: 1.05 }, 'Solid-state chillers. Need a proper power supply — electric only.'),
  vapour_chamber: cooler('Vapour Chamber', 3, R, 650, 7, { cool: 6.5, kind: 'exchanger' }, 'A sealed chamber that boils heat away and condenses it back. Works on anything; a fan makes it sing.'),
  ram_air_scoop: cooler('Ram-Air Scoop', 3, U, 560, 7, { cool: 5.5, kind: 'fins' }, 'Scoops air as you drive. Better than it looks.'),
  plasma_vent: cooler('Plasma Vent', 4, R, 1100, 10, { cool: 9, kind: 'nozzle', works: ['plasma'] }, 'Dumps heat straight out of a plasma core.'),
  nitrogen_loop: cooler('Liquid-Nitrogen Loop', 4, E, 1400, 18, { cool: 11, kind: 'water', jacket: 'nitrogen' }, 'Water cooling, but make it minus two hundred degrees. Drives other than combustion and torque need a Cryo Jacket fitted first.'),
  turbo_fan_array: cooler('Turbo Fan Array', 4, R, 900, 9, { cool: 1.2, kind: 'fan', boost: 2, ventBonus: 6 }, 'A wall of screaming fans. Doubles a good cooler; does little alone.'),
  cryo_block: cooler('Cryo Block', 4, E, 1300, 12, { cool: 18, kind: 'cryo', uses: 10 }, 'A slab of impossible cold. Unbeatable cooling — but it melts away after 10 battles.'),
  void_radiator: cooler('Void Radiator', 5, L, 2400, 8, { cool: 14, kind: 'exchanger' }, 'Radiates heat into another dimension. They haven\'t complained yet.'),
  // Encasement jackets: let liquid cooling run on drives without their own (not combustion or torque). Useless on their own.
  water_jacket: cooler('Water Jacket', 2, C, 150, 8, { cool: 1, kind: 'jacket', jacketFor: 'water' }, 'A sealed sleeve around the drive so a water radiator (pewter, aluminium or silver) can hook up to any drive, not just combustion and torque motors.'),
  oil_jacket: cooler('Oil Jacket', 2, C, 140, 8, { cool: 1, kind: 'jacket', jacketFor: 'oil' }, 'A sealed sleeve so an oil cooler (standard or gold) can hook up to any drive.'),
  cryo_jacket: cooler('Cryo Jacket', 4, R, 600, 10, { cool: 1.5, kind: 'jacket', jacketFor: 'nitrogen' }, 'An insulated casing rated for liquid nitrogen. Lets a Liquid-Nitrogen Loop run on any drive.'),
  glacier_heart: cooler('Regenerative Cryo', 5, L, 2600, 14, { cool: 12, kind: 'cryo', staminaMax: 1.1 }, 'A cryo unit that recondenses its own coolant. It never runs out.'),
  gold_oil_cooler: cooler('Gold Oil Cooler', 5, L, 2500, 9, { cool: 13, kind: 'oil', jacket: 'oil' }, 'A gold oil cooler: the best there is at shifting heat out of the oil. Plugs straight into combustion and torque motors; anything else needs an Oil Jacket fitted first.'),

  // ───────────── ENHANCEMENTS (propulsion add-ons, 1 slot) ─────────────
  // stats multipliers: force (power), accel, vMax (top speed), staminaMax, drain (<1 = sustain);
  // cool (+stamina/s recovery); works?, uses? (battles)
  air_filter: enhance('Pod Filter', 1, C, 60, 1, { kind: 'intake', force: 1.05, works: HOT }, 'An open pod filter lets a piston engine breathe. Modest, reliable.'),
  lucky_dice: enhance('Stage 1 Tune', 1, C, 40, 1, { kind: 'tune', staminaMax: 1.04 }, 'A basic remap of the motor controller. A little more staying power on any drive.'),
  chrome_exhaust: enhance('Ported Exhaust', 1, U, 110, 4, { kind: 'exhaust', force: 1.05, vMax: 1.03, works: HOT }, 'Ported and polished so a piston engine breathes out freely. Louder is faster. Slightly.'),
  spark_plugs: enhance('Iridium Spark Plugs', 1, U, 90, 1, { kind: 'ignition', force: 1.04, accel: 1.05, works: ['combustion'] }, 'A cleaner bang in every cylinder. Combustion engines only.'),
  turbocharger: enhance('Turbocharger', 2, C, 320, 8, { kind: 'turbo', force: 1.15, drain: 1.08, works: HOT }, 'Exhaust-driven boost for piston engines. Runs a little hotter.'),
  nos_bottle: enhance('NOS Bottle', 2, U, 260, 6, { kind: 'nitro', force: 1.25, accel: 1.25, drain: 1.1, uses: 5, works: ['combustion', 'torque', 'turbine'] }, 'Nitrous for the brave. Huge kick — good for 5 battles.'),
  capacitor_bank: enhance('Capacitor Bank', 2, U, 340, 7, { kind: 'capacitor', accel: 1.2, staminaMax: 1.05, works: ['electric'] }, 'Dumps stored charge on launch. Electric motors only.'),
  thermal_battery: enhance('Stage 2 Tune', 2, R, 420, 6, { kind: 'tune', cool: 3, staminaMax: 1.06 }, 'A proper remap: runs the motor cooler and longer. Great recovery on any drive.'),
  light_flywheel: enhance('Lightweight Flywheel', 2, C, 240, 3, { kind: 'flywheel', accel: 1.12, works: ['combustion', 'torque'] }, 'Less spinning mass, snappier launches. Only piston motors have a flywheel to lighten — combustion and torque drives.'),
  supercharger: enhance('Supercharger', 3, U, 640, 12, { kind: 'turbo', force: 1.2, drain: 1.1, works: HOT }, 'Belt-driven boost. Big power, hotter running.'),
  afterburner: enhance('Afterburner', 3, R, 780, 8, { kind: 'burner', vMax: 1.15, accel: 1.1, drain: 1.18, works: ['turbine'] }, 'Sets the exhaust on fire on purpose. Turbines only.'),
  regen_brakes: enhance('Regen Brakes', 3, U, 560, 6, { kind: 'regen', cool: 2, drain: 0.93, works: ['electric'] }, 'Turns braking back into charge. Electric only.'),
  stamina_governor: enhance('Stamina Governor', 3, C, 500, 4, { kind: 'governor', drain: 0.85, force: 0.95 }, 'Holds the motor back a touch so it lasts much longer.'),
  launch_control: enhance('Launch Control', 3, R, 720, 4, { kind: 'launch', accel: 1.2, cool: 1 }, 'A little box that gets every start perfect. Works with anything.'),
  twin_turbo: enhance('Twin Turbo', 4, R, 1150, 14, { kind: 'turbo', force: 1.25, drain: 1.1, works: HOT }, 'Two turbos. Twice the whistle.'),
  ion_injector: enhance('Ion Injector', 4, R, 1200, 6, { kind: 'injector', force: 1.15, vMax: 1.08, works: ['turbine', 'electric', 'plasma'] }, 'Charged-particle boost for turbine, electric and plasma drives.'),
  fusion_stabiliser: enhance('Plasma Stabiliser', 4, E, 1500, 8, { kind: 'stabiliser', drain: 0.8, staminaMax: 1.1, works: ['plasma'] }, 'Tames a star in a can. Barely breaks a sweat all bout.'),
  plasma_overdrive: enhance('Plasma Overdrive', 5, E, 1900, 10, { kind: 'overdrive', force: 1.3, vMax: 1.08, drain: 1.15, works: ['plasma'] }, 'Pushes a plasma drive past the red line. And keeps pushing.'),
  neural_copilot: enhance('Stage 3 Tune', 5, L, 2600, 4, { kind: 'tune', accel: 1.2, cool: 4, drain: 0.9 }, 'The full works: a bespoke remap that feathers every input so you never waste a drop. Works with anything.'),
  time_warp_nitro: enhance('Time-Warp Nitro', 5, L, 2800, 6, { kind: 'nitro', force: 1.4, accel: 1.4, uses: 3, works: null }, 'Nitro from next week. Unbelievable — for 3 battles.'),

  // ───────────── DRIVE TRAIN (propulsion, 4 slots) ─────────────
  // stats: kind, group? (only one per group works), works?, note (one-line effect), and effects:
  //   force/accel/vMax/turn/grip/drain multipliers, brake (braking & holding when idle), driveGuard (impact
  //   damage reaching the drive), tyresOnly (no effect on castors), vector, reverser, rudder, shaft ('hss' | 'std'), wheelsOnly (tyres, not tracks),
  //   prop (thrust efficiency), propRpm (thrust scales with revs), lsl, tcu.
  thrust_vectoring: drivetrain('Thrust-Vectoring Nozzle', 3, R, 800, 6, 70, { kind: 'vector', vector: true, note: 'Castors: moves wherever you touch without steering, always facing the opponent. Needs a thrust drive, or a prop or fan' }, 'Swivels the exhaust instead of the bug. On castors she goes wherever you touch — sideways, backwards, anywhere — without steering, and always keeps her nose on the opponent. A swipe is a quick nudge, about a vehicle\'s length, the way you swiped.'),
  reverse_thrusters: drivetrain('Reverse Thrusters', 2, U, 350, 8, 70, { kind: 'reverser', brake: 3, turn: 1.3, works: THRUST_DRIVES, note: 'Brakes hard and turns on the spot' }, 'Clamshell buckets that throw the thrust forwards. Stops a thrust bug in its tracks and lets it pivot on the spot.'),
  rudders: drivetrain('Rudders', 1, C, 80, 4, 50, { kind: 'rudder', rudder: true, turn: 1.2, note: 'Sharper steering (razor-sharp with a prop or fan on castors)' }, 'Fins in the airflow. Sharper steering for anything — and with a propeller or ducted fan on castors, the tightest turns in the game.'),
  high_speed_shaft: drivetrain('High-Speed Shaft', 3, U, 600, 10, 90, { kind: 'shaft', group: 'shaft', shaft: 'hss', force: 0.95, works: SHAFT_DRIVES, note: 'Drive shaft strong enough for turbine revs. Tougher, but passes on 5% less torque than a standard shaft' }, 'A stronger, balanced drive shaft that can take a turbine\'s revs. Any motor but plasma needs a drive shaft to turn wheels or tracks — and a turbine needs this one: a turbine to driven wheels runs High-Speed Shaft → gearbox → drive shaft.'),
  overdrive_gearbox: drivetrain('Overdrive Gearbox', 3, U, 540, 14, 100, { kind: 'gearbox', group: 'gearbox', force: 0.94, vMax: 1.18, works: GEAR_DRIVES, note: 'Gears up: much more top speed, a little less push' }, 'Tall gears for the long straights. Much more top speed, a little less shove. On a turbine a gearbox only works in the full line: High-Speed Shaft → gearbox → drive shaft. Two gearboxes in line add up.'),
  standard_shaft: drivetrain('Standard Drive Shaft', 1, C, 15, 12, 60, { kind: 'shaft', group: 'shaft', shaft: 'std', works: SHAFT_DRIVES, note: 'Connects the motor to the wheels. Snaps on a turbine, except behind its gearbox' }, 'The bare minimum: any motor but plasma needs a drive shaft to turn wheels or tracks. Always in stock and next to free. Full turbine revs snap it halfway through a match — but on the wheel side of a turbine\'s gearbox (High-Speed Shaft → gearbox → this) it lasts.'),
  chain_sprockets: drivetrain('Chain & Sprockets', 1, C, 40, 4, 50, { kind: 'shaft', group: 'shaft', shaft: 'chain', works: SHAFT_DRIVES, note: 'Light drive for light wheels — wears fast on heavy ones' }, 'A bike chain instead of a drive shaft: much lighter, and fine for light wheels. Heavy tyres and tracks stretch and chew it up fast, so expect a lot of repairs. Turbine revs snap it.'),
  propeller: drivetrain('Propeller', 2, C, 260, 9, 60, { kind: 'prop', group: 'prop', prop: 0.75, works: SHAFT_DRIVES, note: 'Shaft motors push as thrust (castors); turbines get more thrust' }, 'Bolt it to the output shaft and any motor becomes a thrust drive, castors and all. On a turbine it adds to the thrust.'),
  ducted_fan: drivetrain('Ducted Fan', 3, R, 720, 11, 75, { kind: 'prop', group: 'prop', prop: 0.85, propRpm: true, works: SHAFT_DRIVES, note: 'Thrust for any shaft motor, more the higher it revs; boosts turbines' }, 'A fan in a tight shroud. Like a propeller, but it turns high revs into far more thrust — a turbine gets a big shove from one.'),
  limited_slip_link: drivetrain('Limited-Slip Link', 2, U, 420, 10, 90, { kind: 'lsl', lsl: true, works: SHAFT_DRIVES, note: 'Twin drives: no pull when one side is hurt; no spin; lets a diff work. Not with plasma' }, 'Couples twin drives so they share torque. One side damaged? She still drives straight — and a Limited-Slip Differential can work across both — but the drives can\'t counter-rotate, so no spin attack.'),
  standard_gearbox: drivetrain('Reducer', 1, C, 120, 24, 130, { kind: 'gearbox', group: 'gearbox', force: 1.12, vMax: 0.92, works: GEAR_DRIVES, note: 'Trades revs for torque. Heavy, robust' }, 'A plain reduction gearbox: cogs in a cast-iron box. Trades a little top speed for torque. Heavy, cheap and very hard to break — and what a turbine needs between its High-Speed Shaft and the wheel-side shaft.'),
  cvt: drivetrain('CVT', 3, R, 760, 12, 55, { kind: 'gearbox', group: 'gearbox', force: 1.1, accel: 1.1, vMax: 1.1, works: GEAR_DRIVES, note: 'More low-end torque and top speed. Fragile' }, 'Continuously variable transmission: always the right gear. More low-end torque and more top speed — but the belt doesn\'t like being hit.'),
  worm_gear: drivetrain('Worm Gear', 3, R, 700, 30, 140, { kind: 'lockgear', group: 'gearbox', force: 1.35, vMax: 0.6, brake: 2.2, tyresOnly: ['brake'], works: GEAR_DRIVES, note: 'Huge torque, low top speed, hard to push when idle' }, 'A worm can turn the wheel, but the wheel can\'t turn the worm: stop driving and you\'re locked in place. Huge torque, dreadful top speed, very heavy.'),
  cycloidal_drive: drivetrain('Cycloidal Drive', 4, E, 1300, 18, 110, { kind: 'lockgear', group: 'gearbox', force: 1.3, vMax: 0.7, brake: 1.9, tyresOnly: ['brake'], works: GEAR_DRIVES, note: 'Big torque, low top speed, hard to push when idle' }, 'Lobed discs rolling inside pins. Nearly as stubborn as a worm gear at a fraction of the weight.'),
  strain_wave_gear: drivetrain('Strain Wave Gear', 5, L, 2400, 8, 60, { kind: 'lockgear', group: 'gearbox', force: 1.28, vMax: 0.75, brake: 1.7, tyresOnly: ['brake'], works: GEAR_DRIVES, note: 'Big torque, low top speed, hard to push. Light, delicate' }, 'A flexing steel cup inside a ring gear — robot-arm tech. Feather-light and grips when idle, but it doesn\'t take punishment.'),
  transfer_case: drivetrain('Transfer Case', 2, U, 400, 20, 110, { kind: 'transfer', grip: 1.12, tyresOnly: ['grip'], wheelsOnly: true, works: SHAFT_DRIVES, note: 'More traction on tyres (nothing for tracks or castors)' }, 'Sends drive to every wheel. More traction on tyres — tracks already drive along their whole length, so it does nothing for them.'),
  limited_slip_diff: drivetrain('Limited-Slip Differential', 3, U, 560, 10, 90, { kind: 'diff', turn: 1.25, tyresOnly: ['turn'], works: NON_THRUST, note: 'Tighter turning on tyres and tracks (twin drives: needs a Limited-Slip Link)' }, 'Lets the outside wheel drive through the corner. A much tighter turning circle on tyres and tracks. On twin drives it only works once a Limited-Slip Link joins them — then one does for both.'),
  fluid_coupling: drivetrain('Fluid Coupling', 3, U, 520, 14, 100, { kind: 'coupling', driveGuard: 0.55, accel: 0.97, works: NON_THRUST, note: 'Impacts do far less damage to the drive' }, 'The motor drives through a bath of oil, so shocks never reach it. Far less impact damage to the drive, a touch softer off the line.'),
  torque_converter: drivetrain('Torque Converter', 2, C, 240, 16, 100, { kind: 'converter', accel: 1.15, drain: 1.05, works: HOT, note: 'Harder launches for piston engines; runs warm. On castors, only with a prop or fan' }, 'Multiplies torque when you stamp on it. Harder launches for combustion and torque motors, a little extra heat.'),
  traction_control: drivetrain('Traction Control Unit', 4, R, 950, 3, 50, { kind: 'tcu', tcu: true, grip: 1.05, tyresOnly: ['grip', 'tcu'], works: SHAFT_DRIVES, note: 'Tyres: shrugs off half the grip lost to slicks & lifts. Not castors or plasma' }, 'Sensors on every wheel that cut the power the instant one slips. Halves the grip you lose to oil slicks, ice and lifters.'),
  magnetic_gearbox: drivetrain('Magnetic Gearbox', 5, E, 1900, 14, 150, { kind: 'gearbox', group: 'gearbox', force: 1.15, vMax: 1.1, drain: 0.95, driveGuard: 0.8, works: GEAR_DRIVES, note: 'Contactless gears: more push, speed and endurance' }, 'Gears that never touch — magnets do the meshing. More push and speed, cooler running, and shocks slip instead of breaking teeth.'),

  frost_cannon: weapon('Frost Cannon', 4, E, 1400, 28, 80, { class: 'grip', effect: 'slick', cost: 20, range: 180, arc: 360, cooldown: 4.5, puddleRadius: 75, puddleTime: 8, gripMod: 0.12, exposeTime: 0.9 }, 'slick_sprayer', 'Freezes a patch of ring solid. Skating lessons not provided.'),
});

/** Rarity order, how often each turns up on a generated bug, and where it can be found. */
export const RARITY = Object.freeze({
  common: { rank: 0, weight: 1, label: 'Common', shop: true },
  uncommon: { rank: 1, weight: 0.6, label: 'Uncommon', shop: true },
  rare: { rank: 2, weight: 0.3, label: 'Rare', shop: true },
  epic: { rank: 3, weight: 0.12, label: 'Epic', shop: false },
  legendary: { rank: 4, weight: 0.05, label: 'Legendary', shop: false },
});

/**
 * Part combinations that help or hurt. Each rule's `when(bug)` checks the build;
 * `mods` multiply derived stats: force, grip, vMax, cooling, staminaMax, drain.
 * Only a mechanic will point these out — without one you just see the numbers.
 */
export const INTERACTIONS = Object.freeze([
  // Castors: undriven, so only thrust drives can use them.
  { id: 'castor_thrust', good: true, mods: {},
    when: (b) => b.tires?.type === 'castor' && pushesThrust(b),
    text: 'Thrust on castors — nothing holding you back but rolling resistance. You\'ll glide like you\'re on ice: to slow down, thrust the other way.' },
  { id: 'castor_nodrive', good: false, mods: {},
    when: (b) => b.tires?.type === 'castor' && !!b.engine && !pushesThrust(b),
    text: 'Castors aren\'t driven — that motor can\'t move you on them. Fit a turbine or plasma drive, a propeller or ducted fan, or proper tyres.' },
  // Drive train combinations.
  { id: 'no_shaft', good: false, mods: {},
    when: (b) => b.tires?.type === 'tires' && NON_THRUST.includes(b.engine?.stats.kind) && !hasShaft(b),
    text: 'No drive shaft — the motor isn\'t connected to the wheels, so she won\'t move. They\'re next to free on the Marketplace.' },
  { id: 'turbine_no_shaft', good: false, mods: {},
    when: (b) => b.tires?.type === 'tires' && b.engine?.stats.kind === 'turbine' && !hasShaft(b),
    text: 'No working drive shaft — the turbine is only pushing with its thrust, at half strength. A High-Speed Shaft connects it to the wheels.' },
  { id: 'plasma_wheels', good: false, mods: {},
    when: (b) => b.tires?.type === 'tires' && b.engine?.stats.kind === 'plasma',
    text: 'Plasma can\'t drive wheels or tracks — it\'s only pushing with thrust, at half strength. Put it on castors.' },
  { id: 'turbine_std_shaft', good: false, mods: {},
    when: (b) => b.engine?.stats.kind === 'turbine' && hasDriveTrain(b, (s) => s.shaft === 'std' || s.shaft === 'chain') && !turbineComplete(b),
    text: 'That shaft is taking the full turbine revs — it\'ll snap halfway through a match. Run a High-Speed Shaft on the turbine, then a gearbox: a plain shaft on the wheel side of the gearbox lasts.' },
  { id: 'turbine_geared', good: true, mods: { force: 1.12 },
    when: (b) => b.engine?.stats.kind === 'turbine' && b.tires?.type === 'tires' && turbineComplete(b),
    text: 'High-Speed Shaft → gearbox → drive shaft: the full turbine line. Screaming revs turned into real wheel torque. +12% drive.' },
  { id: 'chain_heavy', good: false, mods: {},
    when: (b) => hasDriveTrain(b, (s) => s.shaft === 'chain') && heavyGear(b),
    text: 'That chain is dragging heavy running gear — it\'ll stretch and wear out fast. Expect to repair it after every fight, or fit a drive shaft.' },
  { id: 'prop_rudder', good: true, mods: {},
    when: (b) => b.tires?.type === 'castor' && hasDriveTrain(b, (s) => !!s.prop) && hasDriveTrain(b, (s) => s.rudder),
    text: 'Prop and rudders on castors — she steers like a fish. And the castors are tucked under, out of harm\'s way.' },
  { id: 'lsl_single', good: false, mods: {},
    when: (b) => hasDriveTrain(b, (s) => s.lsl) && (b.drives?.length || 0) < 2,
    text: 'That Limited-Slip Link is doing nothing — it needs twin drives.' },
  // Twin drive bays.
  { id: 'twin_empty', good: false, mods: {},
    when: (b) => (b.chassis?.stats.drives || 1) > 1 && b.drives?.length === 1,
    text: 'There\'s a second drive bay going begging — fit another motor and she\'ll spin on the spot (swipe).' },
  { id: 'twin_spin', good: true, mods: {},
    when: (b) => b.drives?.length === 2 && b.drives.every((d) => !d.isBroken),
    text: 'Twin drives: swipe and she spins 360° on the spot — knocks them back further than a ram.' },
  { id: 'twin_uneven', good: false, mods: {},
    when: (b) => b.drives?.length === 2 && Math.abs(b.drives[0].hpRatio - b.drives[1].hpRatio) > 0.15,
    text: 'One drive is a lot more beaten up than the other — she pulls to one side. Repair them evenly.' },
  // Secret: these shells are built back to front — weaker going forward, much stronger pushing in reverse.
  // Nobody tells you about the reverse part.
  { id: 'backwards', good: false, mods: {},
    when: (b) => !!b.engine && !!b.chassis?.stats.backwards,
    dynamic: (b) => ({ force: b.chassis.stats.backwards.fwd }),
    text: "Drive force is down 15%, I just don't get it, this is all backwards." },
  { id: 'turbine_tracks', good: false, mods: { force: 0.75 },
    when: (b) => b.engine?.stats.kind === 'turbine' && b.tires?.stats.kind === 'track' && !hasDriveTrain(b, (s) => s.shaft === 'hss'),
    text: 'That turbine bogs down in heavy tracks without a High-Speed Shaft. −25% drive.' },
  { id: 'turbine_pads', good: false, mods: { force: 0.85 },
    when: (b) => b.engine?.stats.kind === 'turbine' && b.tires?.stats.kind === 'pads' && !hasDriveTrain(b, (s) => s.shaft === 'hss'),
    text: 'Grip pads drag on a turbine. −15% drive.' },
  { id: 'turbine_slicks', good: true, mods: { vMax: 1.08 },
    when: (b) => b.engine?.stats.kind === 'turbine' && b.tires?.stats.kind === 'slick',
    text: 'Turbine on slicks — lets it rev out. +8% top speed.' },
  { id: 'torque_slicks', good: false, mods: { grip: 0.85 },
    when: (b) => b.engine?.stats.kind === 'torque' && b.tires?.stats.kind === 'slick',
    text: 'All that torque just spins those slicks. −15% grip.' },
  { id: 'torque_tracks', good: true, mods: { force: 1.1 },
    when: (b) => b.engine?.stats.kind === 'torque' && b.tires?.stats.kind === 'track',
    text: 'Big torque through tracks — a proper bulldozer. +10% drive.' },
  { id: 'electric_zappers', good: false, mods: { staminaMax: 0.85 },
    when: (b) => b.engine?.stats.kind === 'electric' && b.weapons.some((w) => w.stats.class === 'neutralizer'),
    text: 'Your electric motor shares its battery with the zapper. −15% stamina.' },
  { id: 'hot_armour', good: false, mods: {},
    when: (b) => (b.armor?.stats.heat || 0) > 0.12,
    dynamic: (b) => ({ cooling: 1 - b.armor.stats.heat, drain: 1 + b.armor.stats.heat }),
    text: 'That thick plating traps engine heat — slower cooling and hotter running.' },
  { id: 'hot_armour_hot_motor', good: false, mods: { cooling: 0.85, drain: 1.1 },
    when: (b) => (b.armor?.stats.heat || 0) > 0.12 && (b.engine?.stats.cooling ?? 99) <= 10,
    text: 'A hot-running motor under thick plating — they make each other worse.' },
  { id: 'vented', good: true, mods: {},
    when: (b) => (b.armor?.stats.heat || 0) < 0,
    dynamic: (b) => ({ cooling: 1 - b.armor.stats.heat }),
    text: 'Vented armour pulls air over the motor. Better cooling.' },
  { id: 'plasma_heavy', good: false, mods: { vMax: 0.92 },
    when: (b) => b.engine?.stats.kind === 'plasma' && (b.tires?.stats.kind === 'track'),
    text: 'Plasma drive through tracks wastes its top end. −8% top speed.' },
  { id: 'fusion_mag', good: true, mods: { force: 1.06 },
    when: (b) => ['fusion_core', 'singularity_drive'].includes(b.engine?.key) && b.tires?.key && ['mag_rollers', 'phase_wheels'].includes(b.tires.key),
    text: 'The motor\'s magnetic field couples with magnetic rims. +6% drive.' },
]);

export const PART_KEYS_BY_TYPE = Object.freeze(
  Object.entries(PARTS).reduce((acc, [key, def]) => {
    (acc[def.type] ||= []).push(key);
    return acc;
  }, {})
);

/** Parts that have left the catalogue (the old bio line) and what saved copies become. */
export const RETIRED_PARTS = Object.freeze({
  cricket_chassis: 'grasshopper_rig', wasp_dart: 'dragonfly_frame', hive_carapace: 'mantis_prime',
  xeno_hornet: 'hornet_interceptor', widow_frame: 'hercules_beetle', empress_chassis: 'jewel_scarab',
  hive_heart: 'plasma_lance', queen_engine: 'zero_point_core', coolant_gland: 'vapour_chamber',
  sugar_feeder: 'spark_plugs', nutrient_generator: 'thermal_battery', adrenal_pump: 'launch_control',
  hive_mind_link: 'neural_copilot', reduction_gearbox: 'standard_gearbox',
});

/** A catalogue key, following retired parts to their replacements. */
export const currentKey = (key) => RETIRED_PARTS[key] || key;

export function getPartDef(key) {
  const def = PARTS[currentKey(key)];
  if (!def) throw new Error(`Unknown part key: ${key}`);
  return def;
}

/** Keys of a type available at or below a tier. */
export function partsUpToTier(type, tier) {
  return (PART_KEYS_BY_TYPE[type] || []).filter((k) => PARTS[k].tier <= tier);
}

/** Fresh from the junkyard: no motor, everything else badly beaten up. */
export const STARTER_BUG = Object.freeze({
  name: 'Junkyard Scrapper',
  hue: 28,
  chassis: 'scrapper_frame',
  engine: null,
  tires: 'bald_rollers',
  armor: 'scrap_plating',
  weapons: [],
  drivetrain: ['standard_shaft'], // wheels need a drive shaft
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

// ───────────── Challenger pilots ─────────────
/**
 * Pilot personalities. `ai` tunes the opponent AI (multipliers on ram /
 * shove / weapon / dodge eagerness and on how soon they rest to cool),
 * and `shops` is what they buy first. Each pilot's bio lives in CHALLENGER_ROSTER.
 */
export const PILOT_STYLES = Object.freeze({
  bully: {
    label: 'Bully',
    ai: { ram: 2.0, shove: 1.5, fire: 1.0, dodge: 0.5, rest: 0.8 },
    shops: 'engine',
  },
  zapper: {
    label: 'Zapper',
    ai: { ram: 0.6, shove: 0.6, fire: 2.0, dodge: 1.0, rest: 1.0, keepAway: true },
    shops: 'weapon',
  },
  turtle: {
    label: 'Turtle',
    ai: { ram: 0.5, shove: 1.2, fire: 1.0, dodge: 0.8, rest: 1.6, holdCenter: true },
    shops: 'armor',
  },
  dodger: {
    label: 'Dodger',
    ai: { ram: 0.8, shove: 0.8, fire: 1.0, dodge: 2.5, rest: 1.0 },
    shops: 'tires',
  },
  sumo: {
    label: 'Sumo',
    ai: { ram: 1.0, shove: 2.0, fire: 0.7, dodge: 1.0, rest: 1.1 },
    shops: 'tires',
  },
  hothead: {
    label: 'Hothead',
    ai: { ram: 2.5, shove: 2.0, fire: 1.5, dodge: 0.3, rest: 0.3 },
    shops: 'engine',
  },
  hapless: {
    label: 'Rookie',
    ai: { ram: 0.6, shove: 0.4, fire: 0.5, dodge: 0.3, rest: 1.0 },
    shops: 'engine',
  },
});

/** Your rival's bio once they've sworn revenge, and for the Grand Final. */
export const RIVAL_STORIES = Object.freeze({
  beaten: '{name} still hasn\'t forgiven you for taking their ride in a title match. Every bolt on the {bug} has been fitted with you in mind.',
  final: 'It was always going to be {name}. From the day you took their ride to the Grand Final — one of you goes home a legend.',
});

/** What your rival DMs you after you take their ride. {bug} is the ride they lost. */
export const RIVAL_DM = Object.freeze([
  'That was NOT a fair fight.',
  'The ring was tilted, my {bug} had a wobbly wheel and I\'m 90% sure you were using a magnet.',
  'Enjoy my ride while it lasts. I\'m going to rebuild — bigger, faster, meaner — and when we meet again I\'m taking back what\'s mine. With interest.',
]);

/**
 * What your rival DMs you every time you beat them again — a fresh excuse each
 * time, in order, looping once they've run out. {bug} is the ride they fought in.
 */
export const RIVAL_EXCUSES = Object.freeze([
  ['RIGGED.', 'The ring was smaller on my side. I measured it afterwards. With my feelings.'],
  ["Funny how my {bug}'s motor cut out right when you touched it.", 'Magnets? Remote? Bribed the ring? I WILL find out.'],
  ['The referee is clearly your cousin.', "Don't deny it. You have the same antennae."],
  ['You call that a win? You drove like a coward and it worked. That\'s cheating with extra steps.'],
  ['My spies say your mechanic put something in my fuel.', "I don't have spies yet. But when I do, they'll confirm it."],
  ["The sun was in my eyes.", "Yes, it was an indoor arena. That's how bright your cheating was."],
  ['I had a cold. Also a curse. Also you cheated.', 'Rematch. Name the day. I\'ll bring a lawyer.'],
  ['Everyone saw you use a hidden turbo.', "Well, I saw it. Everyone I told also saw it, after I told them."],
  ["My {bug} was clearly still running in when we fought. That doesn't count.", 'Nothing you do counts. I checked the rules. I wrote the rules.'],
  ['This is the last time, you hear me? THE LAST TIME.', '…Until next time. Which will be different. Because I will win.'],
]);

/**
 * The challenger pool: 20 pilots, every one with a unique name, home world
 * and bio that hints at how they fight. {name} and {bug} are filled in.
 * The first entry is the rookie.
 */
export const CHALLENGER_ROSTER = Object.freeze([
  { name: 'Pib', planet: 'Larvax', style: 'hapless',
    story: 'Pib bought the {bug} this morning with a cereal-box coupon and is still reading the manual. Mid-bout. The steering is mostly theoretical.' },
  // Bullies — ram first, ask never
  { name: 'Grunkle Vox', planet: 'Dung Moon', style: 'bully',
    story: 'Grunkle Vox once headbutted a moon out of orbit and has been looking for something bigger ever since. Expect the {bug} straight up your tailpipe. Repeatedly.' },
  { name: 'Madame Thraxx', planet: 'Formica Major', style: 'bully',
    story: 'Banned from three spaceports for "aggressive parking". Madame Thraxx doesn\'t do tactics — just rams, shoves, and a few more rams for dessert.' },
  { name: 'Big Oggo', planet: 'Chitinia Prime', style: 'bully',
    story: 'Big Oggo\'s mum wanted a poet. What she got was a {bug} that treats every opponent like a door that needs opening.' },
  // Zappers — keep away and fire
  { name: 'Zizzle Kren', planet: 'Vesp-9', style: 'zapper',
    story: 'A retired lightning farmer, Zizzle Kren still can\'t resist pressing the big glowing button. Keep your stamina topped up.' },
  { name: 'Doctor Plink', planet: 'Nebula Nest', style: 'zapper',
    story: 'Doctor Plink keeps a tidy distance and a very untidy arsenal. The {bug} hums, crackles, and occasionally sets its own seat on fire.' },
  { name: 'Qixxa Sparkwhistle', planet: 'Kepler-Sting', style: 'zapper',
    story: 'Once short-circuited an entire hive-city "by accident". Qixxa fights from range and giggles every time an opponent stalls.' },
  // Turtles — park in the middle and wait
  { name: 'Old Mossback', planet: 'The Ooze Belt', style: 'turtle',
    story: 'Old Mossback believes patience is a weapon — the only one worth owning. Expect the {bug} parked mid-ring, daring you to come in.' },
  { name: 'Brr\'unt', planet: 'Thorax Station', style: 'turtle',
    story: 'Seventeen years as a tollbooth. Brr\'unt doesn\'t chase — Brr\'unt waits, braces, and lets you do something silly.' },
  { name: 'Snoozlo', planet: 'Glorp IV', style: 'turtle',
    story: 'The {bug}\'s previous owner died of boredom mid-bout. Snoozlo plays it slow, heavy and dead centre, with a nap between shoves.' },
  // Dodgers — make you miss
  { name: 'Flitterby Vash', planet: 'Mandibulon', style: 'dodger',
    story: 'A professional puddle-skater before sumo. Lunge at Flitterby\'s {bug} and you\'ll be halfway off the ring before you notice it isn\'t there.' },
  { name: 'Slipp', planet: 'Arachnos', style: 'dodger',
    story: 'Nobody has ever landed a clean hit on Slipp — including three ex-partners and a tax inspector. Rams are a gamble.' },
  { name: 'Wobbletop Nee', planet: 'Cryo Drift', style: 'dodger',
    story: 'The {bug} handles like a greased moth. Wobbletop Nee handbrake-turns at the last second and lets your momentum do the rest.' },
  // Sumo — shove you over the edge
  { name: 'Yokozuna Blorp', planet: 'Hive Nine', style: 'sumo',
    story: 'Learned ancient Earth sumo from one scratched holo-tape and got alarmingly good. Yokozuna Blorp loves the edge of the ring — yours.' },
  { name: 'Master Ukk', planet: 'Pupa Reach', style: 'sumo',
    story: 'A traditionalist: bow, shove, repeat. Master Ukk saves the big power shove for the moment your wheels get near the rope.' },
  { name: 'Tessel Rinq', planet: 'Stridulon', style: 'sumo',
    story: 'Tessel Rinq paces out the dohyo before every bout and knows exactly where your wheels will leave it.' },
  // Hotheads — flat out, then overheat
  { name: 'Scorch McGilly', planet: 'Magmoth', style: 'hothead',
    story: 'Scorch McGilly runs the {bug} flat out from the first second and has overheated in every bout ever lost. Survive the opening rush.' },
  { name: 'Rageblossom', planet: 'Xylo Rift', style: 'hothead',
    story: 'Anger-management dropout. Rageblossom rams everything, fires everything, then stalls in a sulk.' },
  { name: 'Krakkle Joon', planet: 'Sunspot Dirge', style: 'hothead',
    story: 'Krakkle Joon once challenged a sun to a staring contest. Brave, loud, and completely allergic to pacing.' },
  { name: 'Vexby Thrum', planet: 'Nectaris', style: 'hothead',
    story: 'Runs on fizzy nectar and grudges. Vexby Thrum goes full throttle at the bell, peaks at eleven seconds and spends the rest of the bout wheezing.' },
]);

export const FIGHTING_STYLES = Object.freeze(Object.keys(PILOT_STYLES).filter((k) => k !== 'hapless'));

/** Does this add-on (cooling / enhancement) work with the bug's drive? */
/** @param {number} [bay] for a part about to be fitted: the drive it's going on */
export function worksWith(part, bug, bay = null) {
  const s = part.stats;
  // Add-ons suit the motor on their own drive (twin drives can be different types).
  const fittedOn = [bug?.coolers, bug?.mods, bug?.drivetrain].some((l) => (l || []).includes(part));
  const drive = driveKind(bug, fittedOn ? (part.bay || 0) : (bay ?? 0));
  // Castors aren't driven: they need thrust (a thrust drive, or a propeller / ducted fan).
  if (part.type === 'castor') return pushesThrust(bug);
  // Liquid cooling plumbs straight into combustion and torque motors (they're water- and
  // oil-cooled already); any other drive needs the matching jacket — on the same drive.
  if (s.jacket) {
    if (PLUMBED_DRIVES.includes(drive)) return true;
    // Each drive needs its own jacket: a jacket on one drive does nothing for the other.
    const fitted = (bug.coolers || []).includes(part);
    const on = fitted ? (part.bay || 0) : bay;
    return !!drive && (bug.coolers || []).some((c) => c !== part && c.stats.jacketFor === s.jacket && (on == null || (c.bay || 0) === on));
  }
  if (!s.works) return true;
  return !!drive && s.works.includes(drive);
}

/** Drives with their own liquid cooling: radiators and coolers plumb straight in. */
export const PLUMBED_DRIVES = ['combustion', 'torque'];

/** Which jacket a liquid cooler needs on a non-combustion drive. */
export const JACKET_NAMES = Object.freeze({ water: 'Water Jacket', oil: 'Oil Jacket', nitrogen: 'Cryo Jacket' });

/** Readable drive-type names for "works with" notes. */
export const DRIVE_KINDS = Object.freeze({
  combustion: 'Combustion', torque: 'Torque', turbine: 'Turbine', electric: 'Electric', plasma: 'Plasma',
});
