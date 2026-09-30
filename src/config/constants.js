/**
 * WEEVIL WARS — global tuning constants.
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
  BUG_SCALE: 2,             // world size = catalogue (sprite design) radius × this
  GRAVITY: 400,             // px/s² — F_grip = μ · m · g
  RPM_TO_SPEED: 0.0072,     // v_max = rpm · r_tire · k · wear
  TIRE_WEAR_FLOOR: 0.5,     // worn-out tires still deliver 50% top speed
  LATERAL_GRIP: 1.0,        // fraction of grip resisting sideways slide
  IDLE_BRAKE: 0.9,          // fraction of grip used to brake when not driving
  OVERSPEED_DECEL: 520,     // px/s² bleed-off above v_max (after lunges/impulses)
  RESTITUTION: 0.15,
  ARRIVE_RADIUS: 14,
  REVERSE_ANGLE: (120 * Math.PI) / 180, // target this far off the travel direction flips forward/reverse
  REVERSE_SPEED: 0.65,      // reverse top speed as a share of v_max
  PUSHED_SPEED: 25,         // moving this fast against your drive direction = being pushed
  PUSH_BACK_ARC: Math.PI / 4, // while pushed, aim within 45° of the pusher to keep pushing back
  PULL_OUT_HOLD: 0.8,       // seconds spent rolling with the push while steering out
  SWERVE_TURN_MULT: 3.2,    // handbrake-turn steering rate multiplier
  SWERVE_LATERAL_GRIP: 0.35, // tires slide during the handbrake arc
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
  DASH_COST: 8,               // swipe handbrake turn
  SWERVE_MOVING_SPEED: 25,   // above this, a swipe follows the actual direction of motion
  SWERVE_SIDE_THRESHOLD: 0.35, // |sin| of swipe vs travel needed for a left/right turn
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
  HIT_PADDING: 16,
  MENU_RADIUS: 78,
  MENU_DEADZONE: 26,
  MENU_TIME_SCALE: 0.3,
});

/**
 * Pilot ability. Skill has nothing to do with the vehicle: anyone can buy a
 * good bug. The fight record is the tell — few fights or all losses means a
 * novice, the win/loss split shows how good they are, a long record a veteran.
 */
export const PILOT_SKILL = Object.freeze({
  // [weight, fights before you meet them, skill range]
  NOVICE: { weight: 0.3, fights: [0, 4], skill: [0.05, 0.25] },
  REGULAR: { weight: 0.45, fights: [8, 30], skill: [0.25, 0.85] },
  VETERAN: { weight: 0.25, fights: [40, 120], skill: [0.35, 0.95] },
  TIER_CAP: [0.4, 0.15],  // skill ≤ 0.4 + tier × 0.15, so the cheapest bugs aren't flown by aces
  LEARN: 0.004,           // skill gained per fight
  BACKS_IN: 0.6,          // skill needed to know a back-to-front shell pushes harder in reverse
  RIVAL: 0.15,            // your rival's skill: hopeless, until the tournament
  RIVAL_FINAL: 0.9,       // …where they finally learn to drive
  ELITE: [0.75, 0.95],    // tournament pilots: veterans, every one
});

/** A pilot's chance of winning a fight, from their skill. */
export const winRate = (skill) => Math.min(0.95, Math.max(0.05, 0.1 + 0.8 * skill));

export const ECONOMY = Object.freeze({
  CURRENCY_SYMBOL: '§',
  START_SPARE: 3,            // starting cash covers repairs + the cheapest motor, leaving just this — play for titles to get ahead
  JUNK_CONDITION: [0.25, 0.5], // starter parts are at least 50% damaged
  SELL_RATE: 0.6,            // resale fraction of value × condition
  SCRAP_RATE: 0.2,           // a stripped bare frame sells for this share of its value
  SCRAP_BELOW: 0.2,          // parts at 80%+ damage are scrap: no repairs, no fitting (a mechanic can save anything above 0%)
  SCRAP_PRICE: 10,           // all a scrap part fetches
  REPAIR_CAP: 0.9,           // DIY repairs only get a part back to 90% — a mechanic gets it to 100%
  REPAIR_RATE: 0.45,         // $ per missing HP = rate · value / maxHp
  PRICE_SWING: 0.25,         // buy/sell prices land within ±25% of base value
  PRICE_AGAINST: 0.7,        // chance the swing goes against you (dearer to buy, cheaper to sell)
  PRICE_AGAINST_MANAGER: 0.4, // …with a manager negotiating
  HOT_STREAK_WINS: 3,        // on a win streak this long…
  HOT_STREAK_PREMIUM: [0.1, 0.2], // …sale prices (after the swing) are multiplied by 1.1–1.2
  RARE_DEAL_THRESHOLD: 0.8,  // price < 80% of value → flagged by the manager
  MECHANIC_SHOWS_AT_WINS: 3,  // staff only appear on the Admin tab once you've made a name
  MANAGER_SHOWS_AT_WINS: 5,
  MECHANIC_HIRE: 150,
  MECHANIC_WAGE: 35,
  MANAGER_HIRE: 200,
  MANAGER_WAGE: 30,
  STAFF_GRACE: 3,
  BLACKLIST_BOUTS: 5,        // dismiss staff you owe → nobody will work for you for this many bouts
  DEBT_RECOVERY: 1.5,        // …and they take parts until they've recovered the debt × this (interest and losses)
  DEBT_EXTRA: 25,            // …plus a little extra for their trouble
  DEBT_TAKE_CHANCE: 0.5,     // chance a part goes missing after each bout while they're collecting            // bouts you can leave a missed wage unpaid before that staff member quits
  BOUNTY_BASE: 110,          // base stake a challenger expects (scaled by tier)
  BOUNTY_PER_TIER: 120,
  BOARD_SIZE: 5,             // challengers on the board, spread across difficulties
  POOL_TIERS: [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4], // the regular pilots (pool of 20: the rookie, these 14 and 5 elites)
  ELITE_PILOTS: 5,           // tournament pilots: held off the board until 5★ pilots are your level
  ELITE_AT_STARS: 4,         // …i.e. your best ride reaches this many stars
  PILOT_STIPEND: 40,         // sponsors' pocket money per fight cycle
  RIVAL_EDGE: 1.05,          // your rival keeps their bug rated this far above your best
                             // (your rival is the first alien you beat in a title match)
  RIVAL_GAP: [3, 5],         // bouts the rival stays away after each appearance (so they show up roughly every 5th round)
  MATCHED_CHALLENGERS: 2,    // board slots rating-matched to your best vehicle (≤ 1 star higher)
  MATCH_TOLERANCE: 0.2,      // an even match stays on the board while within ±20% of your best rating
  ROOKIE_UNTIL_WINS: 2,      // board always offers an easy rookie until this many wins

  // Wagers & haggling
  COUNTER_STEP: 10,          // challenger counter-offers are multiples of this
  MIN_COUNTER_GAP: 100,      // they won't counter over less than this — they just accept
  WAGER_TOLERANCE: 0.12,     // offer within ±12% of what they want → accepted
  WAGER_PATIENCE: 0.04,      // tolerance widens this much per haggling round
  WAGER_CONCESSION: 0.6,     // counters land this far from your offer toward their target
  RIDICULOUS_FACTOR: 3,      // offers ≥3× or ≤⅓ of their target are ridiculous
  RIDICULOUS_ACCEPT: 0.1,    // …but they still accept one 10% of the time
  BANKROLL_MULT: 2.5,        // most a challenger can stake = base stake × this
  TITLE_REFUSAL: 0.3,        // chance a challenger refuses to play for titles (never the rookie's first offer, or right after you lose your only ride)
  RETURN_AFTER_REJECTIONS: 2,
  RETURN_CHANCE: 0.5,        // per rejection once the threshold is hit

  // Manager betting & match fixing
  MANAGER_BET_DEFAULT: 0.1,  // share of cash the manager may bet, set on hire
  MANAGER_BET_MAX: 1,        // slider goes up to 100% of spare cash
  MANAGER_MIN_CONVICTION: 0.1,
  MANAGER_PAYOUT: 2,         // a winning manager bet pays back double the stake
  FIXING_STREAK: 3,          // bet-on-you-to-lose + lost, this many times running
  FIXING_ESCAPE: 0.3,        // chance the arrest isn't applied (3rd and each later lose-bet)
  FIXING_WARNING: 2,         // show the match-fixing warning from this many
  ALL_IN_ACCEPT: 0.7,        // they countered above your cash and you went all in → they accept
  FIXING_FINE: 500,
  // Win too often with your manager backing you and the bookies catch on.
  HOT_STREAK: 3,             // wins in a row with the manager betting on you to win
  BIG_WIN_BET: 500,          // bets over this on a win are refused once you're on a hot streak…
                             // …and one more streak win later, the manager runs off with the stake
  FINE_BATTLES: 3,           // battles allowed to pay the fine

  MECHANIC_DISCOUNT: 0.9,    // mechanic gets 10% off parts & repairs
  MANAGER_FINDS_PICK: 0.8,   // chance the manager stocks the mechanic's pick after a fight
  MIN_VEHICLE_PRICE: 100,
  FIND_CHANCE: { epic: 0.016, legendary: 0.003 }, // per part on a generated bug (scaled up for better pilots)
  TEASER_CHANCE: 0.25,       // a restock shows off an epic/legendary part you can't afford
  MARKET_STOCK: { engine: 5, cooling: 4, enhancement: 4, tires: 5, weapon: 6, armor: 5 },
  MARKET_VEHICLES: 4,
  TOURNAMENT_UNLOCK_WINS: 5,
  TOURNAMENT_ROUNDS: 5,
  TOURNAMENT_ROUND_NAMES: ['Round One', 'Round Two', 'Quarter-Final', 'Semi-Final', 'Grand Final'],
  TOURNAMENT_PRIZE: 20000,
  TOURNAMENT_FEE: 1000,
  TOURNAMENT_SPARE: 500,     // the manager only suggests entering with this much left after the fee
  TOURNAMENT_READY: 0.8,     // …and once your best ride rates this close to a tournament-grade build
  TOURNAMENT_NUDGE_EVERY: 4, // bouts between reminders       // paid on every entry, no refunds
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
  front: { label: 'Weapons', types: ['weapon'], blurb: 'Weapon hardpoints' },
  center: { label: 'Inside', types: ['engine', 'cooling', 'enhancement'], blurb: 'Drive motor, cooling & enhancements' },
  sides: { label: 'Running Gear', types: ['tires'], blurb: 'Tires / treads' },
  hull: { label: 'Shell', types: ['chassis', 'armor'], blurb: 'Frame & armour plating' },
});

export const WEAPON_CLASSES = Object.freeze({
  neutralizer: { label: 'Stamina Neutralizer', color: '#5ad8ff' },
  strength: { label: 'Strength Destroyer', color: '#ff7a3d' },
  grip: { label: 'Grip Destroyer', color: '#b6ff5a' },
});

export const SAVE_KEY = 'battle-bugs-save-v1';
