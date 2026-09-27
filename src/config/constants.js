/**
 * BATTLE BUGS — global tuning constants.
 * All distances are world pixels, all times are seconds unless suffixed (_MS).
 */

export const ARENA = Object.freeze({
  R0: 400,              // initial dohyo radius
  STATIC_UNTIL: 30,     // 0:00 – 0:30 static
  COLLAPSE_AT: 120,     // 2:00 radius reaches 0
  VIEW_MARGIN: 70,      // world px shown beyond R0
  FLASH_HZ: 3,          // perimeter warning flash rate while shrinking
});

export const MATCH = Object.freeze({
  COUNTDOWN: 3,
  DURATION: 120,        // clock hits 2:00 → tie
  TIE_WINDOW_MS: 250,   // both eliminated within this window → tie
  STALL_OUT_STRIKES: 3, // a bug that enters thermal stall this many times "stalls out"
  RESULT_DELAY: 1.4,    // seconds of slow-mo before the result screen
  FIXED_DT: 1 / 120,
  MAX_FRAME_DT: 0.1,
});

export const PHYSICS = Object.freeze({
  GRAVITY: 400,             // px/s² — F_grip = μ · m · g
  RPM_TO_SPEED: 0.0072,     // v_max = rpm · r_tire · k · wear
  TIRE_WEAR_FLOOR: 0.5,     // worn-out tires still deliver 50% top speed
  LATERAL_GRIP: 1.0,        // fraction of grip resisting sideways slide
  IDLE_BRAKE: 0.9,          // fraction of grip used to brake when not driving
  OVERSPEED_DECEL: 520,     // px/s² bleed-off above v_max (after lunges/impulses)
  RESTITUTION: 0.15,
  ARRIVE_RADIUS: 14,
  SLOW_RADIUS: 70,
  IMPACT_THRESHOLD: 70,     // px/s closing speed before damage is dealt
  IMPACT_DAMAGE_K: 0.00033, // dmg = k · (impact − threshold) · m_other · multipliers
  FRONT_ARC: Math.PI * 0.28,
  REAR_ARC: Math.PI * 0.72,
  FRONT_HIT_REDUCTION: 0.45,
});

export const STAMINA = Object.freeze({
  DRIVE_DRAIN_K: 4e-7,       // ΔS = k · F_drive · (|v| + floor) · dt
  PUSH_SPEED_FLOOR: 120,     // motor under load while pushing a stationary mass
  RECOVER_FRACTION: 0.2,     // stall clears at S ≥ 20%
  DRIVING_COOL_FRACTION: 0.2, // share of R_cool still recovered while driving
});

export const ACTIONS = Object.freeze({
  RAM_COST: 10,
  RAM_SPEED_MULT: 1.35,
  RAM_IMPACT_MULT: 1.3,
  RAM_DURATION: 0.45,
  SHOVE_COST: 25,
  SHOVE_SPEED_MULT: 1.9,
  SHOVE_IMPACT_MULT: 1.8,
  SHOVE_DURATION: 0.55,
  DASH_COST: 8,
  DASH_SPEED: 330,
  ACTION_COOLDOWN: 0.35,
  PUSH_THROUGH: 70,
  VICTORY_BRAKE: 0.25,       // survivor keeps this share of velocity when the foe is eliminated          // after a ram, keep driving this far past the target
  EXPOSED_DAMAGE_MULT: 1.5,  // grip weapons expose flanks while deploying
});

export const INPUT = Object.freeze({
  DOUBLE_TAP_MS: 260,
  LONG_PRESS_MS: 420,
  TAP_SLOP_PX: 12,
  SWIPE_MIN_PX: 38,
  SWIPE_MAX_MS: 450,
  HIT_PADDING: 16,
  MENU_RADIUS: 78,
  MENU_DEADZONE: 26,
  MENU_TIME_SCALE: 0.3,
});

export const ECONOMY = Object.freeze({
  CURRENCY_SYMBOL: '§',
  START_MONEY: 500,
  SELL_RATE: 0.6,            // resale fraction of value × condition
  SCRAP_RATE: 0.2,           // manual sale of broken parts
  MANAGER_SCRAP_RATE: 0.4,   // manager sells stripped scrap at peak value
  REPAIR_RATE: 0.45,         // $ per missing HP = rate · value / maxHp
  MARKUP_MIN: 0.85,
  MARKUP_MAX: 1.3,
  RARE_DEAL_THRESHOLD: 0.8,  // price < 80% of value → flagged by the manager
  MECHANIC_HIRE: 150,
  MECHANIC_WAGE: 35,
  MANAGER_HIRE: 200,
  MANAGER_WAGE: 30,
  BOUNTY_BASE: 110,
  BOUNTY_PER_TIER: 120,
  CHALLENGER_MIN: 3,
  CHALLENGER_MAX: 5,
  ROOKIE_UNTIL_WINS: 2,      // board always offers an easy rookie until this many wins
  MARKET_PARTS: 7,
  MARKET_VEHICLES: 2,
  TOURNAMENT_UNLOCK_WINS: 5,
  TOURNAMENT_ROUNDS: 3,
  TOURNAMENT_PRIZE: 5000,
  JUNKYARD_THRESHOLD: 250,   // below this with no battle-ready bug → free scrapper offered
});

export const RENDER = Object.freeze({
  PIXEL_SCALE: 2,            // world is drawn to a low-res buffer then upscaled
  HUD_TOP: 64,
  HUD_BOTTOM: 12,
});

export const EVENTS = Object.freeze({
  COLLISION: 'COLLISION',
  RING_OUT: 'RING_OUT',
  STALL: 'STALL',
  STALL_RECOVER: 'STALL_RECOVER',
  DAMAGE: 'DAMAGE',
  PART_BROKEN: 'PART_BROKEN',
  WEAPON_FIRE: 'WEAPON_FIRE',
  ACTION: 'ACTION',
  ACTION_FAIL: 'ACTION_FAIL',
  MATCH_START: 'MATCH_START',
  MATCH_END: 'MATCH_END',
  STATE_CHANGE: 'STATE_CHANGE',
});

export const PART_TYPES = Object.freeze({
  CHASSIS: 'chassis',
  ENGINE: 'engine',
  TIRES: 'tires',
  ARMOR: 'armor',
  WEAPON: 'weapon',
});

/** Hoist regions → which part types they expose. */
export const HOIST_REGIONS = Object.freeze({
  front: { label: 'Front', types: ['weapon'], blurb: 'Weapon hardpoints' },
  center: { label: 'Center', types: ['engine'], blurb: 'Drive motor & power cell' },
  sides: { label: 'Sides', types: ['tires'], blurb: 'Tires / treads' },
  hull: { label: 'Hull', types: ['chassis', 'armor'], blurb: 'Frame & armour plating' },
});

export const WEAPON_CLASSES = Object.freeze({
  neutralizer: { label: 'Stamina Neutralizer', color: '#5ad8ff' },
  strength: { label: 'Strength Destroyer', color: '#ff7a3d' },
  grip: { label: 'Grip Destroyer', color: '#b6ff5a' },
});

export const SAVE_KEY = 'battle-bugs-save-v1';
