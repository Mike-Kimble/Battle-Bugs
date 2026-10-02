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
  WORN_FLOOR: 0.21,     // a worn-out part is left just above the scrap line (repairable) and stops working
  COUNTDOWN: 3,
  DURATION: 120,        // clock hits 2:00 → tie
  TIE_WINDOW_MS: 250,   // both eliminated within this window → tie
  STALL_OUT_STRIKES: 3, // a bug that enters thermal stall this many times "stalls out"
  RESULT_DELAY: 1.4,    // seconds of slow-mo before the result screen
  HEAT_PAUSE: 3,        // seconds on the score between heats of a race
  FIXED_DT: 1 / 120,
  MAX_FRAME_DT: 0.1,
  DAMAGE_CAP: 0.425,    // most parts lose at most this share of max HP per match: from full, two fights to reach 15%
  FRAGILE_TIER: 2,      // …except armour and running gear at or below this tier, which can be wrecked in one
  CRITICAL: 0.15,       // frame, drive or running gear dropping to this share of max HP…
  BREAKDOWN_CHANCE: 0.5, // …has this chance of breaking down (stops working until repaired; a frame = catastrophic damage)
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
  TWIN_POWER: 0.7,          // twin drives: each motor, its cooling and every add-on work at 70% (2 motors = 1.4× one)
  PROP_BOOST: 0.2,          // a propeller / ducted fan on a turbine adds this × its efficiency to the thrust
  THRUST_ON_WHEELS: 0.5,    // a turbine or plasma drive on wheels with no working shaft pushes on thrust alone
  REVERSER_BRAKE: 0.8,      // reverse thrusters add this share of your acceleration as braking when you ease off
  ROLL_RESIST: 18,          // px/s² that free-rolling wheels lose to rolling resistance
  SLOPE_SKEW: 0.9,          // rad the nose is pulled towards downhill (at full slope) when moving across one
  SLOPE_SLEW: 3,            // rad/s a free-rolling bug turns to roll downhill (at full slope)
  CASTOR_THRUST: 1.3,       // a thrust drive on castors pushes this much harder than through wheels (before rolling resistance)
  VECTOR_FACE_RATE: 9,      // rad/s: a thrust-vectoring bug swings round to keep facing its opponent
  SLICK_CASTOR_SPEED: 0.5,  // castors in a slick: top speed + this × the grip lost (a 0.2-grip patch → +40%)
  WHEELSPIN: 0.5,           // turbine into the wheels with no gearbox: share of grip and control left
  MATCHED_COOLING: 1.1,     // twin drives running the same cooling: add-on cooling bonus
  UNMATCHED_PULL: 0.06,     // twin drives: pull (as imbalance) for each part one drive has and the other hasn't
  TWIN_SKEW: 0.7,           // rad off line at full imbalance between twin drives (one side dead)
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
  RECOVER_FRACTION: 0.2,     // stall clears at S ≥ 20%
  // Chassis regen (0–100) only kicks in once stamina has run out completely: after a
  // wait (12s at regen 0 down to 3s at 100) it refills you, faster the better the regen.
  REGEN_DELAY_WORST: 12,
  REGEN_DELAY_BEST: 3,
  REGEN_RATE_WORST: 4,       // stamina/s at regen 0
  REGEN_RATE_BEST: 20,       // …at regen 100
  // Normal driving, flat out: a Stamina score of 0 runs dry in 10s, 50 in 20s, 100 in 60s
  // (10 + 50 · score^2.32 — big tanks are worth a lot more than middling ones).
  EMPTY_SECONDS_WORST: 10,
  EMPTY_SECONDS_BEST: 60,
  EMPTY_CURVE: 2.32,
  // …for a 250kg bug. Heavier takes more energy to move: drain × √(mass / 250).
  MASS_REF: 250,
  MASS_EXP: 0.5,
  REST_SHARE: 0.35,          // resting brings stamina back too, but only at this share of the regen rate
});

/**
 * Heat: the first bottleneck. Driving hard and every move heats the motor;
 * cooling takes it away (less of it while you're driving). Hit 100% and you
 * overheat — a thermal stall until cooling brings you back down.
 */
export const HEAT = Object.freeze({
  MAX: 100,
  // Flat out, with a Cooling score of 0 you overheat in 7s; at a score of 100 you never do —
  // cooling removes that share of the heat you make, so it covers drive train and running gear losses too.
  OVERHEAT_SECONDS: 7,
  IDLE_COOL_BASE: 0.3,       // resting cools you even with no cooling: (base + cooling score) × the full-throttle heat rate
  WEAPON_FRACTION: 0.3,      // a weapon shot: 30% of its stamina cost
  // Running gear load: the harder the gear is to push along (grip, rolling resistance),
  // the more heat and stamina driving costs. Knobby Treads (μ 1.05) are 1.0.
  LOAD_REF_MU: 1.05,
  LOAD_TYRE_BASE: 0.6,       // tyres: base + (1 − base) · μ / ref…
  LOAD_KIND: { track: 1.2, pads: 1.1, slick: 0.9 }, // …× the tread type
  LOAD_CASTOR_BASE: 0.5,     // castors: base + roll × this
  LOAD_CASTOR_ROLL: 2,
  REF_EFFICIENCY: 0.97,      // a plain Standard Drive Shaft line: the 7s / 10–60s timings are for this
  RECOVER_AT: 0.4,           // an overheated motor restarts once it's cooled to 40%
});

export const ACTIONS = Object.freeze({
  RAM_COST: 15,
  RAM_HEAT: 10,
  RAM_SPEED_MULT: 1.35,
  RAM_IMPACT_MULT: 1.3,
  RAM_DURATION: 0.45,
  SHOVE_COST: 35,
  SHOVE_HEAT: 21,
  SHOVE_SPEED_MULT: 1.9,
  SHOVE_IMPACT_MULT: 1.8,
  SHOVE_DURATION: 0.55,
  DASH_COST: 8,               // swipe handbrake turn
  DASH_HEAT: 5,
  CHAIN_WEAR: 0.012,          // share of a chain's max HP lost per second of driving heavy tyres or tracks
  MELEE_SWITCH: 0.7,          // free-for-all: an AI switches target when someone is this much closer
  VECTOR_NUDGE: 2,            // thrust vectoring: a swipe nudges you this many body radii (a vehicle's length)
  VECTOR_COST_SHARE: 0.2,     // …costs 20% of your stamina (heat as a swerve)
  VECTOR_ACCEL: 1.75,         // …with 75% more acceleration
  VECTOR_BURST: 0.6,          // …for this long
  SPIN_COST: 35,              // twin drives: a swipe spins 360° on the spot instead
  SPIN_HEAT: 17,
  SPIN_COOLDOWN: 3,           // seconds before you can spin again
  SPIN_DURATION: 0.5,
  SPIN_REACH: 10,             // px beyond touching that the spin still catches the opponent
  SPIN_KNOCK: 1.6,            // knock-back speed as a share of the spinner's v_max: sends them ~1.3× as far as a ram
  SPIN_IMPACT_MULT: 1.4,
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
  SPIN_SKILL: 0.55,       // skill needed to fight to stay central on the Spinner
  SLOPE_SKILL: 0.55,      // skill needed to work the tilt: wary of the downhill edge, quick to shove downhill
  RIVAL: 0.15,            // your rival's skill: hopeless, until the tournament
  RIVAL_FINAL: 0.9,       // …where they finally learn to drive
  ELITE: [0.75, 0.95],    // tournament pilots: veterans, every one
});

/** A pilot's chance of winning a fight, from their skill. */
export const winRate = (skill) => Math.min(0.95, Math.max(0.05, 0.1 + 0.8 * skill));

export const ECONOMY = Object.freeze({
  CURRENCY_SYMBOL: '§',
  SPAR_DAMAGE: 0.4,          // share of the damage from a sparring session that sticks (the rest is padding and blunted weapons)
  START_SPARE: 3,            // starting cash covers repairs + the cheapest motor, leaving just this — play for titles to get ahead
  JUNK_CONDITION: [0.25, 0.5], // starter parts are at least 50% damaged
  SELL_RATE: 0.6,            // resale fraction of value × condition
  SCRAP_RATE: 0.2,           // a stripped bare frame sells for this share of its value
  SCRAP_BELOW: 0.2,          // parts at 80%+ damage are scrap: no repairs, no fitting (a mechanic can save anything above 0%)
  SCRAP_PRICE: 10,           // all a scrap part fetches
  // After a title fight, a mechanic's chance to salvage a part wrecked to 0% (60% on average):
  // by rarity, then less for pricier parts (−5% per §500 over §500, up to −15%), never below 15%.
  SALVAGE_CHANCE: { common: 0.8, uncommon: 0.7, rare: 0.6, epic: 0.45, legendary: 0.3 },
  SALVAGE_COST_STEP: 0.05,
  SALVAGE_COST_MAX: 0.15,
  SALVAGE_MIN: 0.15,
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
  MECHANIC_WAGE: 35,         // starting going rate: the mechanic's wage per complete vehicle, per bout
  MANAGER_HIRE: 200,
  MANAGER_WAGE: 30,
  MANAGER_PCT: 0.1,          // the manager's going rate: a share of what you earn each bout
  MECHANIC_GOING_SHARE: 0.03, // as you earn more, a mechanic expects this share of your average bout earnings per vehicle
  EARN_AVG: 0.3,             // how fast the average bout earnings follow the latest bout
  WAGE_CONTENT: 0.85,        // staff are content on at least this share of the going rate
  NEW_HIRE_SETTLE: 3,        // bouts a new hire takes their agreed wage without complaint
  STRIKE_QUIT_BOUTS: 2,      // still not paid what they asked this many bouts into a strike → they quit
  REHIRE_AFTER_QUIT: 3,      // bouts before anyone will take a job that someone quit
  REHIRE_AFTER_FIRED: 2,     // fire a striker: bouts before a replacement will start…
  REHIRE_FIRED_SHARE: 0.5,   // …for this share of what the striker was asking
  STAFF_GRACE: 3,
  BLACKLIST_BOUTS: 5,        // dismiss staff you owe → nobody will work for you for this many bouts
  DEBT_RECOVERY: 1.5,        // …and they take parts until they've recovered the debt × this (interest and losses)
  DEBT_EXTRA: 25,            // …plus a little extra for their trouble
  DEBT_TAKE_CHANCE: 0.5,     // chance a part goes missing after each bout while they're collecting            // bouts you can leave a missed wage unpaid before that staff member quits
  BOUNTY_BASE: 110,          // base stake a challenger expects (scaled by tier)
  BOUNTY_PER_TIER: 120,
  BOARD_SIZE: 5,             // challengers on the board, spread across difficulties
  POOL_TIERS: [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4], // the regular pilots (pool of 20: the rookie, these 14 and 5 elites)
  HOME_ONE_PILOTS: 2,        // pilots besides you and your rival whose home dohyo is Dohyo 1
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
  STANDOFF_STREAK: 3,        // win this many in a row to open the Scarab Standoff (while the streak lasts)
  STANDOFF_FEE: 250,
  WEAVE_FEE: 500,            // Weevil Weave: a three-round race, unlocked by winning the Scarab Standoff
  WEAVE_PRIZE: 3000,
  WEAVE_ROUNDS: 3,
  RACE_HEATS_TO_WIN: 2,      // Race tab races are best of 3: first to win two heats
  RACE_MAX_HEATS: 5,         // …with no-result heats re-run, up to this many in all
  STANDOFF_PRIZE: 1000,
  STANDOFF_DOHYO: 2,          // fought on the donut
  MATCH_FIND_FIRST: 0.4,     // manager's chance of finding a part to match your other drive at the first try…
  MATCH_FIND_STEP: 0.2,      // …and how much likelier after each bout they keep looking
  MIN_VEHICLE_PRICE: 100,
  FIND_CHANCE: { epic: 0.016, legendary: 0.003 }, // per part on a generated bug (scaled up for better pilots)
  TEASER_CHANCE: 0.25,       // a restock shows off an epic/legendary part you can't afford
  MARKET_STOCK: { engine: 5, cooling: 4, enhancement: 4, drivetrain: 4, tires: 5, castor: 3, weapon: 6, armor: 5 },
  MARKET_VEHICLES: 4,
  TOURNAMENT_STREAK: 10,     // win this many in a row to qualify for the Inter-Planetary Tournament (while the streak lasts)
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
  center: { label: 'Inside', types: ['engine', 'cooling', 'enhancement', 'drivetrain'], blurb: 'Power plant, cooling, enhancements & drive train' },
  sides: { label: 'Running Gear', types: ['tires'], blurb: 'Driven tyres and tracks, or gliding castors' },
  hull: { label: 'Shell', types: ['chassis', 'armor'], blurb: 'Frame & armour plating' },
});

export const WEAPON_CLASSES = Object.freeze({
  neutralizer: { label: 'Stamina Neutralizer', color: '#5ad8ff' },
  strength: { label: 'Strength Destroyer', color: '#ff7a3d' },
  grip: { label: 'Grip Destroyer', color: '#b6ff5a' },
});

export const SAVE_KEY = 'battle-bugs-save-v1';
