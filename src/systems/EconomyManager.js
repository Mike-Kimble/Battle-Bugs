import { ECONOMY } from '../config/constants.js';
import {
  PARTS, PART_KEYS_BY_TYPE, STARTER_BUG, ALIEN_SYLLABLES, PLANETS, BUG_ADJECTIVES, BUG_NOUNS, PILOT_STYLES, FIGHTING_STYLES, RIVAL_STORIES,
} from '../config/partsData.js';
import { BattleBug } from '../entities/BattleBug.js';
import { Part, makeId } from '../entities/Part.js';

// ───────────── RNG helpers ─────────────
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
/** What a challenger says once a fight is on. */
const ACCEPT_LINES = [
  "You're on!", "Let's do it!", "Sure, I wasn't doing much this afternoon anyway.", 'Hold my Cola.',
  'Hell yeah!', "Ok, let's go.", 'Sure thing, slick.',
];
const chance = (p) => Math.random() < p;
const clampTier = (t) => Math.max(1, Math.min(5, t));
const roundTo = (n, step) => Math.max(step, Math.round(n / step) * step);

export function alienName() {
  const s = ALIEN_SYLLABLES;
  return `${pick(s.start)}${pick(s.mid)}${pick(s.end)}`.replace(/^./, (c) => c.toUpperCase());
}

/** Pick a part key of `type`, preferring the band [tier-1, tier]. */
function pickPartKey(type, tier) {
  const all = PART_KEYS_BY_TYPE[type] || [];
  const band = all.filter((k) => PARTS[k].tier <= tier && PARTS[k].tier >= tier - 1);
  const pool = band.length ? band : all.filter((k) => PARTS[k].tier <= tier);
  return pick(pool.length ? pool : all);
}

export function formatMoney(n) {
  return `${ECONOMY.CURRENCY_SYMBOL}${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * All money-touching rules: pricing, repairs, trading, staff automation,
 * challenger/market generation, match settlement and tournament progression.
 */
export class EconomyManager {
  /** @param {import('../core/GameState.js').GameState} state */
  constructor(state) {
    this.state = state;
  }

  // ───────────── Pricing ─────────────
  partSellPrice(part) {
    const scrap = part.value * (this.state.staff.manager ? ECONOMY.MANAGER_SCRAP_RATE : ECONOMY.SCRAP_RATE);
    if (part.isBroken) return Math.round(scrap);
    return Math.round(Math.max(scrap * part.hpRatio, part.value * part.hpRatio * ECONOMY.SELL_RATE));
  }

  vehicleSellPrice(bug) {
    return bug.parts.reduce((s, p) => s + this.partSellPrice(p), 0);
  }

  /** Fair (pristine-scaled) worth of a vehicle, used for market listings. */
  vehicleValue(bug) {
    return bug.parts.reduce((s, p) => s + p.value * (0.3 + 0.7 * p.hpRatio), 0);
  }

  /** Mechanic on staff → 10% off parts and repairs. */
  get discount() {
    return this.state.staff.mechanic ? ECONOMY.MECHANIC_DISCOUNT : 1;
  }

  partPrice(listing) {
    return Math.max(1, Math.round(listing.price * this.discount));
  }

  repairCostPerHp(part) {
    return (part.value / part.maxHp) * ECONOMY.REPAIR_RATE * this.discount;
  }

  repairCost(part) {
    return part.missingHp > 0 ? Math.max(1, Math.ceil(part.missingHp * this.repairCostPerHp(part))) : 0;
  }

  repairAllCost(bug) {
    return bug.parts.reduce((s, p) => s + this.repairCost(p), 0);
  }

  // ───────────── Workshop transactions ─────────────
  /** Repair a part fully, or as far as funds allow. Returns HP restored. */
  repairPart(part, { budget = this.state.money } = {}) {
    const full = this.repairCost(part);
    if (full === 0) return 0;
    const per = this.repairCostPerHp(part);
    let hp;
    let cost;
    if (budget >= full) {
      hp = part.missingHp;
      cost = full;
    } else {
      hp = Math.floor(budget / per);
      cost = Math.ceil(hp * per);
    }
    if (hp <= 0 || cost > this.state.money) return 0;
    this.state.spend(cost);
    part.repair(hp);
    return hp;
  }

  repairAll(bug) {
    let restored = 0;
    for (const part of this.repairPriority(bug)) restored += this.repairPart(part);
    return restored;
  }

  repairPriority(bug) {
    return [bug.chassis, bug.engine, bug.tires, bug.armor, ...bug.weapons].filter((p) => p && p.missingHp > 0);
  }

  equipFromInventory(bug, partUid, slot) {
    this.assertUnlocked(bug);
    const part = this.state.getPart(partUid);
    if (!part) throw new Error('Part not in inventory');
    if (part.type === 'chassis') throw new Error('A chassis is a whole vehicle frame — it cannot be fitted');
    if (part.type === 'weapon' && bug.weaponSlots === 0) throw new Error('This chassis has no hardpoints');
    this.state.removePart(partUid);
    for (const displaced of bug.equip(part, slot)) this.state.addPart(displaced);
    return part;
  }

  unequipToInventory(bug, partUid) {
    this.assertUnlocked(bug);
    const part = bug.findPart(partUid);
    if (!part || !bug.unequip(part)) throw new Error('Cannot remove that part');
    this.state.addPart(part);
    return part;
  }

  assertUnlocked(bug) {
    if (this.state.isLocked(bug)) throw new Error('Tournament rules: upgrades & part swaps are locked (repairs allowed)');
  }

  // ───────────── Trading ─────────────
  /** In the tournament you're in the field: no buying or selling, only repairs with what you brought. */
  get inField() {
    return !!this.state.tournament.entered;
  }

  assertNotInField() {
    if (this.inField) throw new Error("You're in the field — no buying or selling until the tournament is over");
  }

  buyPartListing(listingId) {
    this.assertNotInField();
    const i = this.state.market.parts.findIndex((l) => l.id === listingId);
    if (i < 0) throw new Error('Listing gone');
    const listing = this.state.market.parts[i];
    this.state.spend(this.partPrice(listing));
    this.state.market.parts.splice(i, 1);
    this.state.addPart(listing.part);
    return listing.part;
  }

  buyVehicleListing(listingId) {
    this.assertNotInField();
    const i = this.state.market.vehicles.findIndex((l) => l.id === listingId);
    if (i < 0) throw new Error('Listing gone');
    const listing = this.state.market.vehicles[i];
    this.state.spend(listing.price);
    this.state.market.vehicles.splice(i, 1);
    this.state.addVehicle(listing.bug);
    if (!this.state.getVehicle(this.state.activeVehicleId)) this.state.activeVehicleId = listing.bug.id;
    return listing.bug;
  }

  sellPart(partUid) {
    this.assertNotInField();
    const part = this.state.getPart(partUid);
    if (!part) throw new Error('Part not in inventory');
    const price = this.partSellPrice(part);
    this.state.removePart(partUid);
    this.state.earn(price);
    return price;
  }

  assertDisposable(bug) {
    if (this.state.isLocked(bug)) throw new Error('That vehicle is entered in the tournament');
    if (this.state.vehicles.length <= 1) throw new Error('You cannot part with your last vehicle');
  }

  sellVehicle(id) {
    this.assertNotInField();
    const bug = this.state.getVehicle(id);
    if (!bug) throw new Error('No such vehicle');
    this.assertDisposable(bug);
    const price = this.vehicleSellPrice(bug);
    this.state.removeVehicle(id);
    this.state.earn(price);
    return price;
  }

  /** Strip a vehicle: parts go to inventory, the bare frame is sold as scrap. */
  stripVehicle(id) {
    this.assertNotInField();
    const bug = this.state.getVehicle(id);
    if (!bug) throw new Error('No such vehicle');
    this.assertDisposable(bug);
    const parts = [bug.engine, bug.tires, bug.armor, ...bug.weapons].filter(Boolean);
    parts.forEach((p) => this.state.addPart(p));
    const rate = this.state.staff.manager ? ECONOMY.MANAGER_SCRAP_RATE : ECONOMY.SCRAP_RATE;
    const scrap = Math.round(bug.chassis.value * rate * Math.max(0.25, bug.chassis.hpRatio));
    this.state.removeVehicle(id);
    this.state.earn(scrap);
    return { parts, scrap };
  }

  // ───────────── Staff ─────────────
  /** Staff only come looking for work once you've made a name (or are already on the books). */
  staffAvailable(role) {
    const wins = this.state.record.challengerWins;
    const need = role === 'mechanic' ? ECONOMY.MECHANIC_SHOWS_AT_WINS : ECONOMY.MANAGER_SHOWS_AT_WINS;
    return this.state.staff[role] || wins >= need;
  }

  hire(role) {
    if (this.state.staff[role]) return;
    const fee = role === 'mechanic' ? ECONOMY.MECHANIC_HIRE : ECONOMY.MANAGER_HIRE;
    this.state.spend(fee);
    this.state.staff[role] = true;
    if (role === 'manager') {
      this.state.managerBetPct = ECONOMY.MANAGER_BET_DEFAULT;
      this.state.fixStreak = 0;
    }
  }

  dismiss(role) {
    this.state.staff[role] = false;
  }

  isRareDeal(listing) {
    const item = listing.part || listing.bug;
    const fair = listing.part ? item.value * item.hpRatio : this.vehicleValue(item);
    return listing.price <= fair * ECONOMY.RARE_DEAL_THRESHOLD || item.rarity === 'rare';
  }

  // ───────────── Procedural generation ─────────────
  get baseTier() {
    return clampTier(1 + Math.floor(this.state.record.challengerWins / 2));
  }

  generateBug(tier, { condition = () => rand(0.7, 1), alien = true, fullSlots = false } = {}) {
    const chassis = pickPartKey('chassis', tier);
    const slots = PARTS[chassis].stats.weaponSlots;
    let weaponCount;
    if (fullSlots) weaponCount = slots;
    else if (tier <= 1) weaponCount = chance(0.45) ? 1 : 0;
    else if (tier === 2) weaponCount = 1;
    else weaponCount = Math.min(slots, chance(0.35 + tier * 0.1) ? 2 : 1);

    const weapons = Array.from({ length: weaponCount }, () => pickPartKey('weapon', tier + 1));
    const pilot = alien ? { name: alienName(), planet: pick(PLANETS) } : null;
    return BattleBug.create({
      name: `${pick(BUG_ADJECTIVES)} ${pick(BUG_NOUNS)}`,
      hue: randInt(0, 359),
      alien,
      pilot,
      chassis,
      engine: pickPartKey('engine', tier),
      tires: pickPartKey('tires', tier),
      armor: tier <= 1 && chance(0.4) ? null : pickPartKey('armor', tier),
      weapons,
      condition,
    });
  }

  // ───────────── Challenger pilots (a persistent pool) ─────────────
  /**
   * A pilot: a named alien with a play style, a backstory, a skill level,
   * a purse, a record and their own bug. Pilots live in `state.pool`, the
   * board shows a handful of them, and they all progress between fights.
   */
  makePilot(tier, { style = pick(FIGHTING_STYLES), bug = null, rookie = false } = {}) {
    const name = alienName();
    const planet = pick(PLANETS);
    const theBug = bug || this.generateBug(tier);
    // A zapper's story promises an arsenal — make sure there's at least something to zap with.
    if (style === 'zapper' && !theBug.weapons.length && theBug.weaponSlots) theBug.equip(Part.create(pickPartKey('weapon', tier + 1), rand(0.7, 1)));
    theBug.pilot = { name, planet };
    const p = {
      id: makeId('pl'),
      name,
      planet,
      style,
      story: pick(PILOT_STYLES[style].stories),
      skill: Math.min(0.95, 0.1 + tier * 0.16 + rand(-0.05, 0.05)),
      purse: roundTo((ECONOMY.BOUNTY_BASE + tier * ECONOMY.BOUNTY_PER_TIER) * rand(1, 2.5), 10),
      record: { w: 0, l: 0 },
      rookie,
      bug: theBug,
    };
    return this.refreshPilot(p);
  }

  /** Recompute the board-facing numbers after a pilot's bug or skill changes. */
  refreshPilot(p) {
    p.bug.pilot = { name: p.name, planet: p.planet };
    p.tier = this.vehicleStars(p.bug);
    p.bounty = roundTo(ECONOMY.BOUNTY_BASE + p.tier * ECONOMY.BOUNTY_PER_TIER, 5);
    p.difficulty = p.rookie && this.wantsRookie ? 0.05 : p.skill;
    return p;
  }

  /** Kept for callers that just want "a challenger of tier N": a new pool pilot. */
  makeChallenger(tier, opts = {}) {
    return this.makePilot(tier, opts);
  }

  junkBug(name) {
    const [lo, hi] = ECONOMY.JUNK_CONDITION;
    return BattleBug.create({
      ...STARTER_BUG, name, hue: randInt(0, 359), alien: true, engine: 'rust_motor', armor: null,
      condition: () => rand(lo + 0.2, hi + 0.25),
    });
  }

  /** A deliberately weak, unarmed, half-wrecked opponent for new pilots. */
  makeRookie() {
    const bug = BattleBug.create({
      name: `Rookie ${pick(BUG_NOUNS)}`, hue: randInt(0, 359), alien: true,
      chassis: 'scrapper_frame', engine: 'rust_motor', tires: 'bald_rollers', armor: null, weapons: [],
      condition: () => rand(0.5, 0.65),
    });
    const p = this.makePilot(1, { style: 'hapless', bug, rookie: true });
    p.skill = 0.05;
    return this.refreshPilot(p);
  }

  /** Build the starting pool: a rookie plus pilots spread across every tier. */
  ensurePool() {
    const s = this.state;
    if (!s.pool.length) {
      s.pool.push(this.makeRookie());
      for (const tier of ECONOMY.POOL_TIERS) s.pool.push(this.makePilot(tier));
    }
    for (const p of s.pool) this.refreshPilot(p);
  }

  /** New blood when the pool can't offer what the board needs. Retires a has-been if full. */
  recruit(pilot) {
    const s = this.state;
    s.pool.push(pilot);
    if (s.pool.length > ECONOMY.POOL_MAX) {
      const busy = new Set([...s.challengers, ...s.board.rejected].map((c) => c.id));
      const retiree = s.pool
        .filter((p) => !busy.has(p.id) && !this.rookieSlot(p) && p !== pilot && p.id !== s.rivalId)
        .sort((x, y) => (y.record.l - y.record.w) - (x.record.l - x.record.w))[0];
      if (retiree) s.pool = s.pool.filter((p) => p !== retiree);
    }
    return pilot;
  }

  get hasRookie() {
    return this.state.challengers.some((c) => c.rookie);
  }

  /** While you're new, the rookie only ever fills the rookie slot; afterwards they're just another pilot. */
  rookieSlot(p) {
    return p.rookie && this.wantsRookie;
  }

  get wantsRookie() {
    return this.state.record.challengerWins < ECONOMY.ROOKIE_UNTIL_WINS && this.state.board.tierShift === 0;
  }

  /** Pool pilots free to go on the board (not already there, not walked off). */
  get availablePilots() {
    const s = this.state;
    const taken = new Set([...s.challengers, ...s.board.rejected].map((c) => c.id));
    // The rival only turns up every few bouts.
    return s.pool.filter((p) => !taken.has(p.id) && (p.id !== s.rivalId || this.rivalDue));
  }

  sortBoard() {
    this.state.challengers.sort((a, b) => (this.rookieSlot(b) ? 1 : 0) - (this.rookieSlot(a) ? 1 : 0) || a.tier - b.tier || a.difficulty - b.difficulty);
  }

  /** A fresh board drawn from the pool. */
  generateChallengers() {
    this.ensurePool();
    for (const c of this.state.challengers) c.matched = false;
    this.state.challengers = [];
    this.refillBoard();
  }

  /**
   * Top the board back up to BOARD_SIZE from the pool: the rookie (while
   * you're new), two even matches for your best vehicle, then pilots spread
   * across the difficulty range (the strongest, once the board has scrolled).
   */
  refillBoard() {
    const s = this.state;
    this.ensurePool();
    if (this.wantsRookie && !this.hasRookie) {
      const rookie = this.availablePilots.find((p) => p.rookie) || this.recruit(this.makeRookie());
      s.challengers.push(rookie);
    }
    // Your rival turns up every few bouts (unless they've just walked off on you).
    const rival = this.rival;
    if (rival && this.rivalDue && !s.challengers.includes(rival) && this.availablePilots.includes(rival)) s.challengers.push(rival);
    while (s.challengers.filter((c) => c.matched).length < ECONOMY.MATCHED_CHALLENGERS && s.challengers.length < ECONOMY.BOARD_SIZE) {
      const target = this.bestVehicle ? this.rating(this.bestVehicle) : 0;
      const even = this.availablePilots
        .filter((p) => !this.rookieSlot(p) && p.id !== s.rivalId && this.isEvenMatch(p))
        .sort((x, y) => Math.abs(this.rating(x.bug) - target) - Math.abs(this.rating(y.bug) - target))[0];
      const c = even || this.recruit(this.makeMatchedChallenger());
      c.matched = true;
      s.challengers.push(c);
    }
    while (s.challengers.length < ECONOMY.BOARD_SIZE) {
      const rest = this.availablePilots.filter((p) => !this.rookieSlot(p)).sort((x, y) => this.rating(x.bug) - this.rating(y.bug));
      if (!rest.length) {
        s.challengers.push(this.recruit(this.makePilot(clampTier(this.baseTier + s.board.tierShift))));
        continue;
      }
      // Spread picks across the range; after a scroll, favour the strongest.
      const need = ECONOMY.BOARD_SIZE - s.challengers.length;
      const idx = s.board.tierShift > 0
        ? rest.length - 1
        : Math.min(rest.length - 1, Math.floor(((ECONOMY.BOARD_SIZE - need) / ECONOMY.BOARD_SIZE) * rest.length));
      s.challengers.push(rest[idx]);
    }
    for (const c of s.challengers) this.refreshPilot(c);
    this.sortBoard();
  }

  // ───────────── Your rival ─────────────
  get rival() {
    return this.state.rivalId ? this.state.pool.find((p) => p.id === this.state.rivalId) || null : null;
  }

  /** The first pilot you fight becomes your rival for the rest of the game. */
  setRival(pilot, result) {
    if (this.state.rivalId || !pilot?.record) return;
    this.state.rivalId = pilot.id;
    pilot.rivalOrigin = result === 'loss' ? 'won' : 'beaten';
    this.scheduleRival();
  }

  get boutsPlayed() {
    const r = this.state.record;
    return r.wins + r.losses + r.ties;
  }

  /** The rival vanishes for a while and turns up again in 4–6 bouts. */
  scheduleRival() {
    const [lo, hi] = ECONOMY.RIVAL_GAP;
    this.state.rivalNextAt = this.boutsPlayed + randInt(lo, hi);
  }

  /** Is it the rival's turn to show up on the board? */
  get rivalDue() {
    return !!this.state.rivalId && this.boutsPlayed >= this.state.rivalNextAt;
  }

  /**
   * Your rival keeps pace: once past their rookie days they take on a real
   * fighting style, get sharper every fight, and upgrade (or buy a whole
   * new ride) to stay just ahead of your best vehicle.
   */
  advanceRival() {
    const r = this.rival;
    const best = this.bestVehicle;
    if (!r || !best || this.rookieSlot(r)) return;
    if (r.rookie) {
      r.rookie = false;
      r.style = pick(FIGHTING_STYLES);
    }
    r.story = RIVAL_STORIES[r.rivalOrigin || 'beaten'];
    r.skill = Math.min(0.95, r.skill + 0.03);
    const target = this.rating(best) * ECONOMY.RIVAL_EDGE;
    for (let i = 0; i < 3 && this.rating(r.bug) < target; i++) {
      r.purse += 300;
      this.maintainPilot(r);
    }
    if (this.rating(r.bug) < target * 0.9) {
      // Parts alone won't do it — a new ride, rated just above yours.
      let bestBug = r.bug;
      for (let i = 0; i < 24; i++) {
        const bug = this.generateBug(clampTier(this.vehicleStars(best) + (i % 2)), { condition: () => 1 });
        if (Math.abs(this.rating(bug) - target) < Math.abs(this.rating(bestBug) - target)) bestBug = bug;
      }
      r.bug = bestBug;
    }
    this.refreshPilot(r);
  }

  /** Each pilot's between-fights life: an off-screen bout, then repairs and one upgrade. */
  progressPool(fought) {
    for (const p of this.state.pool) {
      if (p.rookie && this.wantsRookie) continue; // the rookie stays green until you've found your feet
      if (p !== fought) {
        const won = chance(0.4 + 0.2 * p.skill);
        const swing = p.bounty * (won ? rand(0.6, 1.2) : -rand(0.2, 0.4));
        p.purse = Math.max(0, Math.round(p.purse + swing + ECONOMY.PILOT_STIPEND));
        if (won) { p.record.w++; p.skill = Math.min(0.95, p.skill + 0.01); } else p.record.l++;
        for (const part of p.bug.parts) part.applyDamage(part.maxHp * rand(0, won ? 0.12 : 0.25));
      }
      this.maintainPilot(p);
    }
  }

  /** Pilots use the same logic as your mechanic: repair, then buy the optimal affordable part. */
  maintainPilot(p) {
    const bug = p.bug;
    for (const part of [bug.chassis, bug.engine, bug.tires, bug.armor, ...bug.weapons].filter(Boolean)) {
      const cost = Math.ceil(part.missingHp * (part.value / part.maxHp) * ECONOMY.REPAIR_RATE);
      if (cost <= p.purse) { p.purse -= cost; part.repair(); }
    }
    const pref = PILOT_STYLES[p.style]?.shops;
    const needs = this.diagnose(bug);
    needs.sort((x, y) => (x.urgent === y.urgent ? (y.type === pref) - (x.type === pref) : y.urgent - x.urgent));
    for (const { type } of needs) {
      const key = this.optimalPart(bug, type, p.purse, { owned: [], discount: 1 });
      if (!key) continue;
      p.purse -= PARTS[key].value;
      for (const old of bug.equip(new Part(key))) p.purse += Math.round(old.value * old.hpRatio * ECONOMY.SCRAP_RATE);
      break;
    }
    this.refreshPilot(p);
  }

  // ───────────── Even matches ─────────────
  /** Star rating (1–5) of a vehicle: the average tier of its parts. */
  vehicleStars(bug) {
    const parts = [bug.chassis, bug.engine, bug.tires, bug.armor, ...bug.weapons].filter(Boolean);
    return clampTier(Math.round(parts.reduce((sum, p) => sum + p.tier, 0) / parts.length));
  }

  /** Your highest-rated vehicle — even matches are pitched against it. */
  get bestVehicle() {
    let best = null;
    let bestR = -Infinity;
    for (const v of this.state.vehicles) {
      const r = this.rating(v);
      if (r > bestR) { best = v; bestR = r; }
    }
    return best;
  }

  /**
   * A new pilot whose bug is rated as close as possible to your best
   * vehicle, at its star level or at most one star higher.
   */
  makeMatchedChallenger() {
    const best = this.bestVehicle;
    if (!best) return this.makePilot(1);
    const target = this.rating(best);
    const star = this.vehicleStars(best);
    let pickBug = null;
    let err = Infinity;
    for (let i = 0; i < 24 && err > 0.06; i++) {
      const bug = this.generateBug(clampTier(star + (i % 2)));
      const e = Math.abs(this.rating(bug) - target) / target;
      if (e < err) { pickBug = bug; err = e; }
    }
    return this.makePilot(this.vehicleStars(pickBug), { bug: pickBug });
  }

  /** Still a fair fight for your current best vehicle? */
  isEvenMatch(c) {
    const best = this.bestVehicle;
    if (!best) return false;
    const target = this.rating(best);
    return this.vehicleStars(c.bug) <= this.vehicleStars(best) + 1 && Math.abs(this.rating(c.bug) - target) / target <= ECONOMY.MATCH_TOLERANCE;
  }

  generateMarket() {
    const tierCap = clampTier(this.baseTier + 1);
    const parts = [];
    const types = Object.entries(ECONOMY.MARKET_STOCK).flatMap(([type, n]) => Array(n).fill(type));
    for (const type of types) {
      const t = chance(0.12) ? 5 : tierCap;
      const pool = PART_KEYS_BY_TYPE[type].filter((k) => PARTS[k].tier <= t);
      const key = pick(pool);
      const condition = chance(0.45) ? 1 : rand(0.55, 0.95);
      const part = Part.create(key, condition);
      const markup = chance(0.15) ? rand(0.55, 0.78) : rand(ECONOMY.MARKUP_MIN, ECONOMY.MARKUP_MAX);
      parts.push({ id: makeId('mk'), part, price: roundTo(part.value * part.hpRatio * markup, 5) });
    }
    const vehicles = [];
    for (let i = 0; i < ECONOMY.MARKET_VEHICLES; i++) {
      const bug = this.generateBug(clampTier(tierCap - randInt(0, 1)), { alien: chance(0.5), condition: () => rand(0.6, 1) });
      if (!bug.alien) bug.name = `Used ${bug.name}`;
      const markup = chance(0.15) ? rand(0.6, 0.78) : rand(ECONOMY.MARKUP_MIN, ECONOMY.MARKUP_MAX);
      vehicles.push({ id: makeId('mk'), bug, price: Math.max(ECONOMY.MIN_VEHICLE_PRICE, roundTo(this.vehicleValue(bug) * markup, 5)) });
    }
    this.state.market = { parts, vehicles };
  }

  // ───────────── Confidence & wagers ─────────────
  /** Rough fighting strength used for odds, haggling and the manager's bets. */
  rating(bug) {
    const s = bug.getStats();
    const armor = bug.armor && !bug.armor.isBroken ? bug.armor.stats.absorb * bug.armor.hpRatio * 20 : 0;
    const guns = bug.weapons.filter((w) => !w.isBroken).length * 5;
    return s.fUsable / 1000 + s.fGrip / 2500 + bug.chassis.hp / 8 + s.staminaMax / 10 + s.vMax / 25 + guns + armor;
  }

  /**
   * The challenger's confidence of beating `bug` (0–1): stat difference,
   * their skill, and your current streak (wins in a row scare them).
   */
  confidence(c, bug = this.state.activeBug) {
    if (!bug) return 0.5;
    const streak = this.state.record.streak || 0;
    const x = (this.rating(c.bug) - this.rating(bug)) / 20
      + (c.difficulty - 0.4) * 1.5
      - Math.max(0, Math.min(streak, 6)) * 0.25
      + Math.max(0, Math.min(-streak, 6)) * 0.2;
    return 1 / (1 + Math.exp(-x));
  }

  /** What the challenger would like to play for. */
  targetStake(c) {
    const p = this.confidence(c);
    return Math.max(ECONOMY.COUNTER_STEP, roundTo(c.bounty * (0.35 + 1.3 * p), ECONOMY.COUNTER_STEP));
  }

  bankroll(c) {
    return roundTo(c.bounty * ECONOMY.BANKROLL_MULT, ECONOMY.COUNTER_STEP);
  }

  nego(c) {
    c.nego ||= { round: 0, target: null, counter: null, deal: null, log: [] };
    return c.nego;
  }

  /**
   * Make a cash offer. Returns { status: 'accept'|'counter'|'reject', amount, message }.
   * Confident challengers push the pot up, nervous ones push it down; a
   * ridiculous offer after the first bid can get you told to get lost.
   */
  offerCash(c, amount) {
    const s = this.state;
    amount = Math.round(amount);
    if (!(amount >= 1)) throw new Error('Offer something!');
    if (amount > s.money) throw new Error("You can't cover that stake");
    const n = this.nego(c);
    const who = c.bug.pilot?.name || c.bug.name;
    const p = this.confidence(c);
    const ideal = this.targetStake(c);
    n.target ??= ideal;
    n.round += 1;
    n.log.push({ who: 'you', text: `I'll fight you for ${formatMoney(amount)}.` });

    const respond = (status, value, text) => {
      if (status === 'accept') {
        n.deal = { type: 'cash', amount: value };
        n.counter = null;
      } else if (status === 'counter') {
        n.counter = value;
        n.target = value;
      }
      n.log.push({ who: 'them', text });
      const out = { status, amount: value, message: `${who}: ${text}` };
      if (status === 'reject') Object.assign(out, this.reject(c));
      return out;
    };

    if (n.counter != null && amount === n.counter) return respond('accept', amount, pick(ACCEPT_LINES));

    // They asked for more than you've got and you pushed everything in.
    if (n.counter != null && n.counter > s.money && amount === s.money) {
      if (chance(ECONOMY.ALL_IN_ACCEPT)) return respond('accept', amount, pick(ACCEPT_LINES));
      return respond('reject', amount, 'Come back when you have some real money. Now go away.');
    }

    const ridiculous = amount >= ideal * ECONOMY.RIDICULOUS_FACTOR || amount <= ideal / ECONOMY.RIDICULOUS_FACTOR;
    if (ridiculous) {
      if (chance(ECONOMY.RIDICULOUS_ACCEPT)) return respond('accept', amount, pick(ACCEPT_LINES));
      if (n.round > 1) return respond('reject', amount, amount > ideal ? 'Stop wasting my time. Get lost!' : 'Insulting. Get lost, grub.');
      return respond('counter', ideal, amount > ideal
        ? `Whoa, easy. ${formatMoney(ideal)} is more like it.`
        : `Is that a joke? ${formatMoney(ideal)} or nothing.`);
    }

    const bank = this.bankroll(c);
    if (amount > bank) return respond('counter', bank, `My pod only holds ${formatMoney(bank)}. That's my limit.`);

    const tol = ECONOMY.WAGER_TOLERANCE + ECONOMY.WAGER_PATIENCE * (n.round - 1);
    const confident = p >= 0.5;
    const t = n.target;
    if (confident ? amount >= t * (1 - tol) : amount <= t * (1 + tol)) {
      return respond('accept', amount, pick(ACCEPT_LINES));
    }
    const counter = roundTo(amount + (t - amount) * ECONOMY.WAGER_CONCESSION, ECONOMY.COUNTER_STEP);
    // Not worth haggling over small change — they take your number.
    if (Math.abs(counter - amount) < ECONOMY.MIN_COUNTER_GAP) return respond('accept', amount, pick(ACCEPT_LINES));
    return respond('counter', counter, confident
      ? `Pocket change. Make it ${formatMoney(counter)}.`
      : `Too rich for me. ${formatMoney(counter)}, tops.`);
  }

  /** Ask to play for titles (pink slips). 20% of challengers refuse. */
  offerTitles(c) {
    const n = this.nego(c);
    n.log.push({ who: 'you', text: 'Let\'s play for titles — winner takes the loser\'s vehicle.' });
    if (chance(ECONOMY.TITLE_REFUSAL)) {
      n.log.push({ who: 'them', text: 'My ride? Not a chance. Get lost.' });
      return { status: 'reject', message: `${c.bug.pilot?.name || c.bug.name}: My ride? Not a chance. Get lost.`, ...this.reject(c) };
    }
    n.deal = { type: 'titles' };
    n.counter = null;
    const line = pick(ACCEPT_LINES);
    n.log.push({ who: 'them', text: line });
    return { status: 'accept', message: line };
  }

  cancelDeal(c) {
    if (c.nego) c.nego.deal = null;
  }

  /**
   * A challenger walks off the board until you next fight. If the board
   * empties it scrolls up in difficulty; after repeated rejections the
   * first one to walk off may come back (50% per rejection).
   */
  reject(c) {
    const s = this.state;
    const b = s.board;
    s.challengers = s.challengers.filter((x) => x.id !== c.id);
    // The chat transcript survives the walk-off so the DM window can show it.
    const log = [...(c.nego?.log || []), { who: 'system', text: `${c.bug.pilot?.name || c.name || c.bug.name} has left the chat.` }];
    c.nego = null;
    b.rejected.push(c);
    b.rejections += 1;
    const out = { scrolled: false, returned: null, log };
    if (!s.challengers.length) {
      b.tierShift += 1;
      this.generateChallengers();
      out.scrolled = true;
    }
    if (b.rejections >= ECONOMY.RETURN_AFTER_REJECTIONS && b.rejected.length && chance(ECONOMY.RETURN_CHANCE)) {
      const back = b.rejected.shift();
      s.challengers.push(back);
      this.sortBoard();
      out.returned = back;
    }
    return out;
  }

  /** After any bout: remove the fought challenger, bring back the walk-offs, refill. */
  afterBout(challenger, tournament) {
    const s = this.state;
    if (!tournament) s.challengers = s.challengers.filter((x) => x.id !== challenger.id);
    for (const c of s.board.rejected) s.challengers.push(c);
    s.board.rejected = [];
    // The rival stays for one round only: fought or not, they vanish again for a while.
    const rival = this.rival;
    if (rival && (challenger === rival || s.challengers.includes(rival))) {
      s.challengers = s.challengers.filter((c) => c !== rival);
      this.scheduleRival();
    }
    s.board.rejections = 0;
    // Old haggling is void after a bout — including the pilot just fought, who may come straight back.
    challenger.nego = null;
    for (const c of s.pool) c.nego = null;
    // Every pilot in the pool has had their own week: bouts, repairs, upgrades.
    this.progressPool(tournament ? null : challenger);
    this.advanceRival();
    // Your best vehicle (and theirs) may have changed: replace even matches
    // that no longer fit so the board stays winnable.
    s.challengers = s.challengers.filter((c) => {
      if (!c.matched || this.isEvenMatch(c)) return true;
      c.matched = false; // back into the pool
      return false;
    });
    this.refillBoard();
  }

  // ───────────── Manager betting ─────────────
  /**
   * What the manager would bet on this fight (no money moves). They back the
   * side they believe in, sizing the bet by conviction up to `pct` of spare cash.
   * Returns { side, stake, mult, pWin, conviction } — stake 0 means no bet.
   */
  planManagerBet(c, bug, reserved = 0, pct = this.state.managerBetPct) {
    const s = this.state;
    const pWin = 1 - this.confidence(c, bug);
    const conviction = Math.abs(pWin - 0.5) * 2;
    const side = pWin >= 0.5 ? 'win' : 'lose';
    // A winning bet always pays double the stake.
    const mult = ECONOMY.MANAGER_PAYOUT;
    const pot = Math.max(0, s.money - reserved);
    const stake = !s.staff.manager || pct <= 0 || conviction < ECONOMY.MANAGER_MIN_CONVICTION
      ? 0
      : Math.floor(pot * pct * Math.min(1, conviction * 1.5));
    return { side, stake, mult, pWin, conviction };
  }

  /** Place the manager's bet for this fight; `pct` is the per-fight limit. */
  placeManagerBet(c, bug, reserved = 0, pct = this.state.managerBetPct) {
    if (this.inField) return null;
    const plan = this.planManagerBet(c, bug, reserved, pct);
    if (plan.stake < 1) return null;
    this.state.spend(plan.stake);
    return { side: plan.side, stake: plan.stake, mult: plan.mult };
  }

  settleManagerBet(bet, result, report) {
    const s = this.state;
    if (!bet) {
      s.fixStreak = 0;
      return;
    }
    const sideText = bet.side === 'win' ? 'to WIN' : 'to LOSE';
    if (result === 'tie') {
      s.earn(bet.stake);
      report.lines.push(`Manager's bet on you ${sideText} refunded (draw).`);
    } else if ((result === 'win') === (bet.side === 'win')) {
      const payout = Math.round(bet.stake * bet.mult);
      s.earn(payout);
      report.lines.push(`Manager bet ${formatMoney(bet.stake)} on you ${sideText} — collected ${formatMoney(payout)}.`);
    } else {
      report.lines.push(`Manager bet ${formatMoney(bet.stake)} on you ${sideText} — lost it.`);
    }

    // Only bets on you to LOSE count towards match fixing. Winning the fight
    // clears suspicion; a bet on you to win leaves it untouched.
    if (bet.side === 'lose' && result === 'loss') s.fixStreak = (s.fixStreak || 0) + 1;
    else if (result === 'win') s.fixStreak = 0;
    if (s.fixStreak >= ECONOMY.FIXING_STREAK && chance(ECONOMY.FIXING_ESCAPE)) {
      report.lines.push(`The stewards are sniffing around (${s.fixStreak} lose-bets paid out running)… your manager got away with it this time.`);
    } else if (s.fixStreak >= ECONOMY.FIXING_STREAK) {
      s.staff.manager = false;
      s.fixStreak = 0;
      s.fine = { amount: ECONOMY.FIXING_FINE, battlesLeft: ECONOMY.FINE_BATTLES };
      report.arrest = true;
      report.lines.push('🚨 Your manager kept betting on you to lose — and you kept losing. Arrested for match fixing!');
      report.lines.push(`Fine: ${formatMoney(ECONOMY.FIXING_FINE)}, payable within ${ECONOMY.FINE_BATTLES} battles or it's game over.`);
    }
  }

  payFine(amount = this.state.money) {
    const f = this.state.fine;
    if (!f) throw new Error('No fine outstanding');
    const pay = Math.min(amount, f.amount, this.state.money);
    if (pay <= 0) throw new Error('No funds to pay the fine');
    this.state.spend(pay);
    f.amount -= pay;
    if (f.amount <= 0) this.state.fine = null;
    return pay;
  }

  // ───────────── Tournament ─────────────
  get tournamentUnlocked() {
    return this.state.record.challengerWins >= ECONOMY.TOURNAMENT_UNLOCK_WINS;
  }

  enterTournament() {
    const bug = this.state.activeBug;
    if (!this.tournamentUnlocked) throw new Error(`Win ${ECONOMY.TOURNAMENT_UNLOCK_WINS} challenger bouts to unlock`);
    if (!bug?.isBattleReady) throw new Error('Your active vehicle is not battle-ready');
    if (!this.state.canAfford(ECONOMY.TOURNAMENT_FEE)) throw new Error(`The entry fee is ${formatMoney(ECONOMY.TOURNAMENT_FEE)}`);
    this.state.spend(ECONOMY.TOURNAMENT_FEE);
    Object.assign(this.state.tournament, { entered: true, vehicleId: bug.id, round: 0, eliminated: false });
    this.state.tournament.opponent = this.tournamentOpponentJSON(0);
    this.state.addLog(`Entered the Inter-Planetary Tournament with ${bug.name}`);
  }

  withdrawTournament() {
    Object.assign(this.state.tournament, { entered: false, vehicleId: null, round: 0, opponent: null });
  }

  /**
   * The strongest possible build by fighting rating: for every frame, the
   * best motor, tires and armour for it (greedy), armed with the best
   * weapons. Returns catalogue keys and the build's rating.
   */
  strongestBuild() {
    const make = (b) => BattleBug.create({ ...b, condition: () => 1 });
    const weaponsFor = (chassis) => PART_KEYS_BY_TYPE.weapon.slice()
      .sort((x, y) => PARTS[y].tier - PARTS[x].tier || PARTS[y].value - PARTS[x].value)
      .slice(0, PARTS[chassis].stats.weaponSlots);
    let best = null;
    for (const chassis of PART_KEYS_BY_TYPE.chassis) {
      const build = { chassis, engine: 'rust_motor', tires: 'bald_rollers', armor: null, weapons: weaponsFor(chassis) };
      for (const type of ['engine', 'tires', 'armor', 'engine', 'tires']) { // two passes: grip and power depend on each other
        const ranked = PART_KEYS_BY_TYPE[type]
          .map((k) => [k, this.rating(make({ ...build, [type]: k }))])
          .sort((x, y) => y[1] - x[1]);
        build[type] = ranked[0][0];
      }
      const r = this.rating(make(build));
      if (!best || r > best.rating) best = { build, rating: r };
    }
    return best;
  }

  /**
   * Tournament entrants are the hardest pilots in the game: every one runs
   * the strongest possible build, pristine and fully armed, and the pilots
   * get better each round (the Grand Final is flown at maximum skill).
   * Earlier rounds vary the weapon loadout; the final carries the best pair.
   */
  tournamentOpponentJSON(round) {
    const { build } = this.strongestBuild();
    const final = round >= ECONOMY.TOURNAMENT_ROUNDS - 1;
    const spec = { ...build };
    if (!final) {
      const pool = PART_KEYS_BY_TYPE.weapon.slice()
        .sort((x, y) => PARTS[y].tier - PARTS[x].tier || PARTS[y].value - PARTS[x].value)
        .slice(0, build.weapons.length + 1);
      spec.weapons = pool.sort(() => Math.random() - 0.5).slice(0, build.weapons.length);
    }
    const bug = BattleBug.create({
      ...spec,
      name: `${pick(BUG_ADJECTIVES)} ${pick(BUG_NOUNS)}`,
      hue: randInt(0, 359),
      alien: true,
      pilot: { name: alienName(), planet: pick(PLANETS) },
      condition: () => 1,
    });
    const rival = final ? this.rival : null;
    if (rival) {
      // Your rival, in the best machine money can buy.
      bug.name = rival.bug.name;
      bug.hue = rival.bug.hue;
      bug.pilot = { name: rival.name, planet: rival.planet };
    }
    const style = rival?.style || pick(FIGHTING_STYLES);
    const c = {
      id: rival ? rival.id : makeId('ch'),
      name: bug.pilot.name,
      planet: bug.pilot.planet,
      style,
      story: rival ? RIVAL_STORIES.final : pick(PILOT_STYLES[style].stories),
      record: rival ? { ...rival.record } : undefined,
      tier: 5,
      bounty: ECONOMY.TOURNAMENT_PRIZE,
      difficulty: Math.min(1, 0.9 + round * 0.05),
      roundName: ['Quarter-Final', 'Semi-Final', 'Grand Final'][round] || `Round ${round + 1}`,
      bug,
    };
    return { ...c, bug: c.bug.toJSON() };
  }

  get tournamentOpponent() {
    const o = this.state.tournament.opponent;
    return o ? { ...o, bug: BattleBug.fromJSON(o.bug) } : null;
  }

  // ───────────── Mechanic's advice ─────────────
  /** Rating of `bug` with `part` fitted in place of its equivalent (weapons: a free or the weakest slot). */
  ratingWith(bug, part) {
    const clone = BattleBug.fromJSON(bug.toJSON());
    const p = Part.fromJSON(part.toJSON());
    if (p.type === 'weapon') {
      if (clone.weapons.length >= clone.weaponSlots) {
        if (!clone.weaponSlots) return -Infinity;
        const worst = clone.weapons.reduce((w, x, i) => (x.value * x.hpRatio < clone.weapons[w].value * clone.weapons[w].hpRatio ? i : w), 0);
        clone.equip(p, worst);
      } else clone.equip(p);
    } else {
      clone.equip(p);
    }
    return this.rating(clone);
  }

  /** Could this part be had — already owned, or list price (after discount) within budget? */
  affordable(key, budget, { owned = this.state.inventory, discount = this.discount } = {}) {
    return owned.some((p) => p.key === key) || PARTS[key].value * discount <= budget;
  }

  /** The single best part of `type` for this bug within budget, judged on a pristine example of each. */
  optimalPart(bug, type, budget = Infinity, opts = {}) {
    const base = this.rating(bug);
    let best = null;
    for (const key of PART_KEYS_BY_TYPE[type]) {
      if (!this.affordable(key, budget, opts)) continue;
      const part = new Part(key);
      // Weapons all add the same raw rating, so break ties by quality (tier, then value).
      const gain = this.ratingWith(bug, part) - base + (type === 'weapon' ? PARTS[key].tier * 0.5 + PARTS[key].value / 1000 : 0);
      if (!best || gain > best.gain) best = { key, gain };
    }
    if (!best) return null;
    const current = type === 'weapon' ? null : bug[type];
    if (current?.key === best.key) return null; // already fitted
    return best.gain > 0.5 ? best.key : null;
  }

  /**
   * What's holding a bug back, most urgent first: [{type, reason, urgent}].
   * Shared by your mechanic and by the challengers' own pit crews.
   */
  diagnose(bug) {
    const s = bug.getStats();
    const needs = [];
    const add = (type, reason, urgent = true) => needs.push({ type, reason, urgent });
    if (!bug.engine) add('engine', "there's no motor in her");
    if (s.fDrive > s.fGrip * 1.05) add('tires', 'traction-limited — the motor out-muscles your tires');
    else if (s.fGrip > s.fDrive * 1.25) add('engine', 'power-limited — your tires can take more than the motor gives');
    if (!bug.armor) add('armor', "you've got no armour — every hit goes straight to the hull");
    if (bug.weapons.length < bug.weaponSlots) add('weapon', `you've got ${bug.weaponSlots - bug.weapons.length} empty hardpoint${bug.weaponSlots - bug.weapons.length > 1 ? 's' : ''}`);
    if (s.cooling < 12) add('engine', "your motor runs hot — you'll stall in long pushes");
    add('engine', 'more push always helps', false);
    add('tires', 'more grip always helps', false);
    add('armor', 'tougher plating', false);
    return needs;
  }

  /**
   * What the mechanic says about a bug: what's limiting it and the one
   * optimal part to fix that. Only optimal picks — if it isn't in your
   * spares or on the Marketplace, tough.
   * @returns {{lines: string[], pick: {key, type, reason}|null}}
   */
  mechanicAdvice(bug) {
    const out = { lines: [], pick: null };
    if (!bug) return out;
    const hurt = bug.parts.filter((p) => p.hpRatio < 0.5).sort((a, b) => a.hpRatio - b.hpRatio)[0];
    if (hurt) out.lines.push(`Fix your ${hurt.name} first — it's at ${Math.round(hurt.hpRatio * 100)}% and dragging everything down.`);
    if (this.inField) {
      if (!hurt) out.lines.push("We're in the field — no upgrades now. Just keep her patched up.");
      return out;
    }

    const needs = this.diagnose(bug).map((n) => [n.type, n.reason]);

    // Stay within budget: the best part you could actually pay for (or already own).
    const budget = this.state.money;
    for (const [type, reason] of needs) {
      const key = this.optimalPart(bug, type, budget);
      if (key) {
        out.pick = { key, type, reason };
        break;
      }
    }
    if (!out.pick) {
      const anyUpgrade = needs.some(([type]) => this.optimalPart(bug, type));
      out.lines.push(anyUpgrade
        ? `Nothing worth buying on ${formatMoney(budget)}. Win some cash and I'll find you something.`
        : "Honestly? She's as good as parts can make her.");
    }
    return out;
  }

  /** Where the mechanic's pick can be had right now. */
  pickAvailability(key) {
    const spare = this.state.inventory.find((p) => p.key === key);
    if (spare) return { where: 'spares', part: spare };
    const listing = this.state.market.parts.find((l) => l.part.key === key);
    if (listing) return { where: 'market', listing, price: this.partPrice(listing) };
    return { where: 'none' };
  }

  /** Manager's legwork: add the mechanic's pick to the Marketplace. */
  stockPick(key) {
    if (this.state.market.parts.some((l) => l.part.key === key)) return false;
    const part = Part.create(key, rand(0.75, 1));
    const price = roundTo(part.value * part.hpRatio * rand(ECONOMY.MARKUP_MIN, ECONOMY.MARKUP_MAX), 5);
    this.state.market.parts.unshift({ id: makeId('mk'), part, price, managerFind: true });
    return true;
  }

  // ───────────── New game ─────────────
  /**
   * Size the starting cash for a fresh junkyard start: exactly enough to
   * repair the Scrapper, buy the cheapest motor on the Marketplace and
   * place a §100 first bet (plus any champion's bonus).
   */
  setupNewGame() {
    const s = this.state;
    this.generateChallengers();
    this.generateMarket();
    const engines = () => s.market.parts.filter((l) => l.part.type === 'engine');
    if (!engines().some((l) => l.part.key === 'rust_motor')) {
      const part = Part.create('rust_motor', rand(0.8, 1));
      s.market.parts.unshift({ id: makeId('mk'), part, price: roundTo(part.value * part.hpRatio * rand(ECONOMY.MARKUP_MIN, 1.1), 5) });
    }
    // Cheapest motor to get running, counting what it'd cost to repair a used one.
    const motorCost = (l) => this.partPrice(l) + this.repairCost(l.part);
    const cheapestMotor = Math.min(...engines().map(motorCost));
    s.money = this.repairAllCost(s.activeBug) + cheapestMotor + ECONOMY.START_BET + (s.startBonus || 0);
    s.fresh = false;
    s.addLog(`Rolled a Junkyard Scrapper out of the scrapheap with ${formatMoney(s.money)} to your name.`);
  }

  // ───────────── Survival ─────────────
  /** Cash plus what the parts inventory would fetch. */
  get liquidWorth() {
    return this.state.money + this.state.inventory.reduce((sum, p) => sum + this.partSellPrice(p), 0);
  }

  /** With no vehicle left, make sure something affordable (≥ §100) is for sale. */
  ensureReplacementListing() {
    const s = this.state;
    if (s.vehicles.length || this.liquidWorth < ECONOMY.MIN_VEHICLE_PRICE) return;
    if (s.market.vehicles.some((l) => l.price <= this.liquidWorth)) return;
    const bug = BattleBug.create({ ...STARTER_BUG, engine: 'rust_motor', armor: null, condition: () => rand(0.55, 0.75) });
    const price = Math.max(ECONOMY.MIN_VEHICLE_PRICE, Math.min(roundTo(this.liquidWorth * 0.8, 5), 150));
    s.market.vehicles.unshift({ id: makeId('mk'), bug, price });
  }

  /** Returns a game-over reason, or null. Also records it on the state. */
  checkGameOver() {
    const s = this.state;
    if (s.gameOver) return s.gameOver;
    if (!s.vehicles.length && this.liquidWorth < ECONOMY.MIN_VEHICLE_PRICE) {
      s.gameOver = `No vehicles left and only ${formatMoney(this.liquidWorth)} to your name — you can't afford even the cheapest ride (${formatMoney(ECONOMY.MIN_VEHICLE_PRICE)}).`;
    } else if (s.fine && s.fine.battlesLeft <= 0 && s.fine.amount > 0) {
      s.gameOver = `You failed to pay the ${formatMoney(ECONOMY.FIXING_FINE)} match-fixing fine in time. The Galactic Sumo Authority has banned you for life.`;
    }
    return s.gameOver;
  }

  // ───────────── Match settlement ─────────────
  /**
   * Apply the outcome of a bout.
   * @param {{result:'win'|'loss'|'tie', reason:string, challenger:object, opponentBug:BattleBug,
   *   playerBug:BattleBug, tournament:boolean, stake:{type:'cash'|'titles', amount?:number}|null, bet:object|null}} m
   */
  settleMatch({ result, reason, challenger, opponentBug, playerBug, tournament, stake, bet }) {
    const s = this.state;
    const report = { result, reason, lines: [], bounty: 0, captured: null, lostVehicle: null, champion: false, arrest: false };
    // Clear fight-only state (ring-out fall, stalls, effects) so neither bug is drawn mid-plunge afterwards.
    for (const b of [playerBug, opponentBug]) b?.resetForBattle(b.pos, 0);

    if (result === 'win') s.record.wins++;
    else if (result === 'loss') s.record.losses++;
    else s.record.ties++;
    if (result === 'win') s.record.streak = Math.max(0, s.record.streak || 0) + 1;
    if (result === 'loss') s.record.streak = Math.min(0, s.record.streak || 0) - 1;

    const capture = () => {
      opponentBug.pilot = null;
      opponentBug.resetForBattle(opponentBug.pos, 0);
      s.addVehicle(opponentBug);
      s.newVehicleIds.add(opponentBug.id);
      report.captured = opponentBug;
      // Straight onto the hoist, compared against the vehicle that won it.
      if (!s.tournament.entered) {
        s.activeVehicleId = opponentBug.id;
        s.compareRef = { id: opponentBug.id, refId: playerBug.id };
      }
      report.lines.push(`Captured vehicle: ${opponentBug.name} (${Math.round(opponentBug.condition * 100)}% condition) — it's on your hoist.`);
    };

    if (tournament) {
      // No purses and no captured vehicles in the tournament — only the grand prize.
      if (result === 'win') {
        s.tournament.round++;
        if (s.tournament.round >= ECONOMY.TOURNAMENT_ROUNDS) {
          s.earn(ECONOMY.TOURNAMENT_PRIZE);
          report.bounty = ECONOMY.TOURNAMENT_PRIZE;
          report.lines.push(`Grand prize: ${formatMoney(ECONOMY.TOURNAMENT_PRIZE)}`);
          report.champion = true;
          s.gameComplete = true;
          s.tournament.champion = true;
          this.withdrawTournament();
        } else {
          s.tournament.opponent = this.tournamentOpponentJSON(s.tournament.round);
          report.lines.push(`Advanced to tournament round ${s.tournament.round + 1} of ${ECONOMY.TOURNAMENT_ROUNDS}`);
        }
      } else if (result === 'loss') {
        s.tournament.eliminated = true;
        this.withdrawTournament();
        report.lines.push('Eliminated from the tournament. Upgrades unlocked — regroup and re-enter.');
      } else {
        report.lines.push('Draw — tournament rules: the round will be re-fought.');
      }
    } else if (stake?.type === 'titles') {
      if (result === 'win') {
        capture();
        // They're back to the junkyard, like you once were.
        challenger.bug = this.junkBug(`Scrap ${pick(BUG_NOUNS)}`);
        this.refreshPilot(challenger);
      } else if (result === 'loss') {
        s.removeVehicle(playerBug.id);
        report.lostVehicle = playerBug;
        report.lines.push(`You lost the title: ${playerBug.name} now belongs to ${challenger.name || challenger.bug.pilot?.name || 'the challenger'}.`);
        // They keep whichever bug is better and sell the other.
        if (challenger.purse != null) {
          playerBug.alien = true;
          playerBug.resetForBattle(playerBug.pos, 0);
          if (this.rating(playerBug) > this.rating(challenger.bug)) {
            challenger.purse += Math.round(this.vehicleValue(challenger.bug) * ECONOMY.SELL_RATE);
            challenger.bug = playerBug;
          } else {
            challenger.purse += Math.round(this.vehicleValue(playerBug) * ECONOMY.SELL_RATE);
          }
          this.refreshPilot(challenger);
        }
        if (!s.vehicles.length) report.lines.push('You have no vehicles left — find a replacement on the Marketplace.');
      } else {
        report.lines.push('Draw — both titles stay put.');
      }
    } else if (stake?.type === 'cash') {
      if (result === 'win') {
        report.bounty = stake.amount;
        s.earn(stake.amount);
        if (challenger.purse != null) challenger.purse = Math.max(0, challenger.purse - stake.amount);
        report.lines.push(`Won the wager: +${formatMoney(stake.amount)}`);
      } else if (result === 'loss') {
        const paid = Math.min(stake.amount, s.money);
        s.spend(paid);
        if (challenger.purse != null) challenger.purse += paid;
        report.lines.push(`Lost the wager: −${formatMoney(paid)}`);
      } else {
        report.lines.push('Draw — the wager is void.');
      }
    }

    if (!tournament) this.setRival(challenger, result);
    if (!tournament && challenger.record && result !== 'tie') {
      if (result === 'win') challenger.record.l++; else challenger.record.w++;
    }
    if (!tournament && result === 'win') {
      s.record.challengerWins++;
      if (s.record.challengerWins === ECONOMY.TOURNAMENT_UNLOCK_WINS) report.lines.push('★ The Inter-Planetary Tournament is now OPEN to you!');
      if (s.record.challengerWins === ECONOMY.MECHANIC_SHOWS_AT_WINS) report.lines.push('A mechanic has heard about your wins and is looking for work — see the Admin tab.');
      if (s.record.challengerWins === ECONOMY.MANAGER_SHOWS_AT_WINS) report.lines.push('A manager wants to represent you — see the Admin tab.');
    }

    // An outstanding fine counts down before any new arrest is processed.
    if (s.fine) {
      s.fine.battlesLeft -= 1;
      if (s.fine.amount > 0) report.lines.push(`Fine outstanding: ${formatMoney(s.fine.amount)} — ${Math.max(0, s.fine.battlesLeft)} battle${s.fine.battlesLeft === 1 ? '' : 's'} left to pay.`);
    }
    this.settleManagerBet(bet, result, report);

    this.payStaff(report);
    if (s.staff.mechanic) this.runMechanic(report);
    if (s.staff.manager) this.runManager(report);

    this.afterBout(challenger, tournament);
    // The mechanic's pick is judged on the bug you'll fight with next.
    const mechPick = s.staff.mechanic ? this.mechanicAdvice(s.activeBug).pick : null;
    this.generateMarket();
    if (mechPick && s.staff.manager && !this.inField && chance(ECONOMY.MANAGER_FINDS_PICK)) {
      if (this.stockPick(mechPick.key)) report.lines.push(`Manager: tracked down the ${PARTS[mechPick.key].name} your mechanic wanted — it's on the Marketplace.`);
    }
    this.ensureReplacementListing();
    if (s.staff.manager) {
      const deals = [...s.market.parts, ...s.market.vehicles].filter((l) => this.isRareDeal(l));
      if (deals.length) report.lines.push(`Manager: ${deals.length} rare deal${deals.length > 1 ? 's' : ''} flagged on the Marketplace`);
    }

    report.gameOver = this.checkGameOver();
    s.addLog(`${result.toUpperCase()} vs ${challenger.bug?.name ?? opponentBug.name} — ${reason}`);
    return report;
  }

  payStaff(report) {
    const s = this.state;
    for (const [role, wage] of [['mechanic', ECONOMY.MECHANIC_WAGE], ['manager', ECONOMY.MANAGER_WAGE]]) {
      if (!s.staff[role]) continue;
      if (s.canAfford(wage)) {
        s.spend(wage);
        report.lines.push(`Paid ${role} wage: ${formatMoney(wage)}`);
      } else {
        s.staff[role] = false;
        report.lines.push(`Your ${role} quit — couldn't make payroll.`);
      }
    }
  }

  runMechanic(report) {
    const bug = this.state.activeBug;
    if (!bug) return;
    const before = this.state.money;
    const hp = this.repairAll(bug);
    if (hp > 0) report.lines.push(`Mechanic repaired ${Math.round(hp)} HP on ${bug.name} for ${formatMoney(before - this.state.money)}`);
    else if (this.repairAllCost(bug) > 0) report.lines.push('Mechanic: not enough funds for repairs.');
  }

  runManager(report) {
    if (this.inField) return;
    const scrap = this.state.inventory.filter((p) => p.isBroken);
    if (!scrap.length) return;
    let total = 0;
    for (const p of scrap) total += this.sellPart(p.uid);
    report.lines.push(`Manager sold ${scrap.length} scrap part${scrap.length > 1 ? 's' : ''} for ${formatMoney(total)}`);
  }
}
