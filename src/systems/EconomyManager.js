import { ECONOMY, PILOT_SKILL, winRate } from '../config/constants.js';
import {
  PARTS, PART_KEYS_BY_TYPE, STARTER_BUG, ALIEN_SYLLABLES, PLANETS, BUG_ADJECTIVES, BUG_NOUNS, PILOT_STYLES, FIGHTING_STYLES, RIVAL_STORIES, RIVAL_DM, RIVAL_EXCUSES, CHALLENGER_ROSTER, RARITY, worksWith, JACKET_NAMES, THRUST_DRIVES, heavyGear, turbineLine, turbineComplete, driveKind,
} from '../config/partsData.js';
import { STAFF_ROSTER } from '../config/staff.js';
import { BattleBug } from '../entities/BattleBug.js';
import { PhysicsEngine } from '../physics/PhysicsEngine.js';
import { Part, makeId } from '../entities/Part.js';

// ───────────── RNG helpers ─────────────
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
/** What a challenger says once a fight is on. */
/** What a pilot says when they won't put their ride on the line. */
const TITLE_REFUSALS = [
  'My ride? Not a chance. Get lost.',
  'Ummmm... No.',
  'In your dreams!',
  'Certainly!   Not.',
  "There's the door.",
  "I'd rather slam my antenna in the door.",
  'No thanks, chum.',
  'Why would I risk this for your junk?',
];

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

/** Parts the Marketplace stocks as a matter of course (common · uncommon · rare). */
export function shopKeys(type) {
  return (PART_KEYS_BY_TYPE[type] || []).filter((k) => RARITY[PARTS[k].rarity].shop);
}

const weightedPick = (keys) => {
  const total = keys.reduce((sum, k) => sum + RARITY[PARTS[k].rarity].weight, 0);
  let roll = Math.random() * total;
  for (const k of keys) {
    roll -= RARITY[PARTS[k].rarity].weight;
    if (roll <= 0) return k;
  }
  return keys[keys.length - 1];
};

/** Roll a rarity for one part on a generated bug; better pilots turn up with better finds. */
function rollRarity(tier) {
  const boost = Math.max(0.5, tier / 3);
  const r = Math.random();
  if (r < ECONOMY.FIND_CHANCE.legendary * boost) return 'legendary';
  if (r < (ECONOMY.FIND_CHANCE.legendary + ECONOMY.FIND_CHANCE.epic) * boost) return 'epic';
  if (r < 0.14) return 'rare';
  if (r < 0.4) return 'uncommon';
  return 'common';
}

/**
 * Pick a part key of `type` from the band [tier-1, tier]: roll a rarity, then
 * step down to the next rarity the band actually has.
 */
function pickPartKey(type, tier) {
  const all = PART_KEYS_BY_TYPE[type] || [];
  const t = Math.min(5, tier);
  let band = all.filter((k) => PARTS[k].tier <= t && PARTS[k].tier >= t - 1);
  if (!band.length) band = all.filter((k) => PARTS[k].tier <= t);
  if (!band.length) band = all;
  const want = RARITY[rollRarity(tier)].rank;
  // Nearest rarity the band has: step down first, then up (never a free upgrade to a gem).
  const order = [want, ...[1, 2, 3, 4].flatMap((d) => [want - d, want + d])].filter((r) => r >= 0 && r <= 4);
  for (const rank of order) {
    if (rank > want && rank >= RARITY.epic.rank) continue;
    const keys = band.filter((k) => RARITY[PARTS[k].rarity].rank === rank);
    if (keys.length) return pick(keys);
  }
  return pick(band);
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
    // A mechanic can bring back anything that isn't completely destroyed.
    Part.scrapBelow = () => (state.staff.mechanic ? 0 : ECONOMY.SCRAP_BELOW);
    // …and only a mechanic gets a part back to 100%.
    Part.repairCap = () => (state.staff.mechanic ? 1 : ECONOMY.REPAIR_CAP);
  }

  // ───────────── Pricing ─────────────
  /**
   * Haggling luck: price = base + sign × random(0–1) × 25% × base. The sign goes
   * against you (dearer when buying, cheaper when selling) 70% of the time —
   * only 40% with a manager doing the talking.
   * @param {'buy'|'sell'} side
   */
  priceSwing(side) {
    const against = chance(this.state.staff.manager ? ECONOMY.PRICE_AGAINST_MANAGER : ECONOMY.PRICE_AGAINST);
    const sign = (side === 'buy') === against ? 1 : -1;
    return 1 + sign * Math.random() * ECONOMY.PRICE_SWING;
  }

  /** A buyer's offer for an item, fixed until the next restock (so what you see is what you get). */
  sellQuote(id) {
    const q = this.state.sellQuotes;
    if (!(id in q)) {
      // On a hot streak, the usual haggle result is topped up by 10–20%.
      q[id] = this.priceSwing('sell') * (this.hotStreak ? 1 + rand(...ECONOMY.HOT_STREAK_PREMIUM) : 1);
    }
    return q[id];
  }

  /** On a 3+ win streak everyone wants some of your secret sauce. */
  get hotStreak() {
    return (this.state.record.streak || 0) >= ECONOMY.HOT_STREAK_WINS;
  }

  partSellBase(part) {
    return part.isScrap ? 0 : part.value * part.hpRatio * ECONOMY.SELL_RATE;
  }

  /** One buyer's rate per kind of part: like parts share it. */
  partSellPrice(part) {
    if (part.isScrap) return ECONOMY.SCRAP_PRICE;
    return Math.max(ECONOMY.SCRAP_PRICE, Math.round(this.partSellBase(part) * this.sellQuote(part.key)));
  }

  /**
   * Spares stacked like with like (same part; scrap kept apart), best condition
   * first. A stack shares one going rate — for one at 100% — and each part
   * fetches its share of it by condition.
   * @returns {Array<{key, parts: Part[], best: Part, scrap: boolean}>}
   */
  spareGroups(parts = this.state.inventory) {
    const map = new Map();
    for (const p of parts) {
      const id = `${p.key}${p.isScrap ? '|scrap' : ''}`;
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(p);
    }
    return [...map.values()].map((ps) => {
      ps.sort((a, b) => b.hpRatio - a.hpRatio);
      return { id: `${ps[0].key}${ps[0].isScrap ? '|scrap' : ''}`, key: ps[0].key, parts: ps, best: ps[0], scrap: ps[0].isScrap };
    });
  }

  /** What selling `count` from a stack would fetch (the worst-condition ones go first). */
  groupSellTotal(group, count) {
    return this.sellOrder(group).slice(0, count).reduce((t, p) => t + this.partSellPrice(p), 0);
  }

  sellOrder(group) {
    return [...group.parts].sort((a, b) => a.hpRatio - b.hpRatio);
  }

  /** Sell every part in each of these stacks at once. Returns the total. */
  sellGroups(groups) {
    this.assertNotInField();
    return groups.reduce((t, g) => t + this.sellFromGroup(g, g.parts.length), 0);
  }

  /** Sell `count` from a stack, worst condition first. Returns the total. */
  sellFromGroup(group, count) {
    this.assertNotInField();
    const n = Math.max(1, Math.min(group.parts.length, Math.round(count)));
    let total = 0;
    for (const p of this.sellOrder(group).slice(0, n)) {
      if (!this.state.getPart(p.uid)) throw new Error('Part not in inventory');
      total += this.partSellPrice(p);
      this.state.removePart(p.uid);
    }
    this.state.earn(total);
    return total;
  }

  vehicleSellPrice(bug) {
    const scrap = bug.parts.filter((p) => p.isScrap).length * ECONOMY.SCRAP_PRICE;
    const base = bug.parts.reduce((s, p) => s + this.partSellBase(p), 0);
    return Math.round(base * this.sellQuote(bug.id)) + scrap;
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
    const hp = part.repairableHp; // nothing for scrap; only up to 90% without a mechanic
    return hp > 0.5 ? Math.max(1, Math.ceil(hp * this.repairCostPerHp(part))) : 0;
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
      hp = part.repairableHp;
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
    return bug.parts.filter((p) => p.missingHp > 0 || p.failed); // every fitted part, drive train included
  }

  /** Why `part` can't go on `bug` right now, or null if it can. */
  fitProblem(part, bug, slot, bay) {
    if (!bug) return 'Nothing on the hoist';
    if (part.type === 'chassis') return 'A chassis is a whole vehicle frame — it cannot be fitted';
    if (part.isScrap) return `${part.name} is scrap — sell it for ${formatMoney(ECONOMY.SCRAP_PRICE)}`;
    // Cooling, enhancements and drive train all mount on a drive.
    if (BattleBug.isAddOn(part.type) && !bug.drives.length) return 'Fit a drive first dummy!';
    if (part.type === 'weapon' && bug.weaponSlots === 0) return 'This chassis has no hardpoints';
    // Add-ons go on a particular drive (the one you picked, or the one it'd go on by default).
    const onBay = BattleBug.isAddOn(part.type) && bug.drives.length > 1 ? (bay ?? bug.defaultBay(part)) : null;
    // Water on anything with electrics in it.
    if (part.stats.kind === 'mister' && ['electric', 'plasma'].includes(driveKind(bug, onBay ?? 0))) return 'Do you want to die today? Maybe not a good idea';
    // Gearboxes (reducers included): two in a twin-bay shell, one otherwise — wherever they go.
    // Swapping one gearbox for another is fine.
    if (part.stats.group === 'gearbox') {
      const fitted = bug.drivetrain.filter((p) => p.stats.group === 'gearbox' && p !== part).length;
      const replacing = slot != null && bug.addOnsOn('drivetrain', onBay ?? 0)[slot]?.stats.group === 'gearbox';
      if (fitted >= PhysicsEngine.gearboxLimit(bug) && !replacing) {
        // Both on the other drive and none on this one: point them at it.
        const here = onBay == null ? fitted : bug.addOnsOn('drivetrain', onBay).filter((p) => p.stats.group === 'gearbox').length;
        if (onBay != null && here === 0) return "This won't fit, maybe take a reducer off the other drive?";
        return 'No room dummy!';
      }
    }
    if (!this.fits(part, bug, onBay)) {
      if (part.stats.jacket && bug.drives.length > 1) return `That drive needs ${/^[AEIOU]/.test(JACKET_NAMES[part.stats.jacket]) ? 'an' : 'a'} ${JACKET_NAMES[part.stats.jacket]} of its own first`;
      return "Doesn't look like you can fit that here";
    }
    return null;
  }

  /** Could you buy this and bolt it straight on: a free slot, and it suits the vehicle? */
  canFitNow(part, bug) {
    return this.hasFreeSlot(bug, part.type) && !this.fitProblem(part, bug) && !this.state.isLocked(bug);
  }

  /**
   * Where a part could be bought and bolted straight on: on twin drives, the
   * drives (0, 1) with a free slot that it suits; otherwise [null] if it fits, [] if not.
   */
  fitBays(part, bug) {
    if (!bug || this.state.isLocked(bug)) return [];
    if (BattleBug.isAddOn(part.type) && bug.drives.length > 1) {
      const per = BattleBug.perDrive(part.type);
      return [0, 1].filter((b) => bug.addOnsOn(part.type, b).length < per && !this.fitProblem(part, bug, undefined, b));
    }
    return this.canFitNow(part, bug) ? [null] : [];
  }

  /** @param {number} [bay] cooling / enhancements / drive train: which drive to mount it on */
  equipFromInventory(bug, partUid, slot, bay) {
    const part = this.state.getPart(partUid);
    if (!part) throw new Error('Part not in inventory');
    const problem = this.fitProblem(part, bug, slot, bay);
    if (problem) throw new Error(problem);
    this.state.removePart(partUid);
    const displaced = bug.equip(part, slot, bay);
    for (const d of displaced) this.state.addPart(d);
    // A different type of motor: whatever on that drive doesn't suit it comes off into your spares.
    this.lastStripped = [];
    const swapped = part.type === 'engine' && displaced.some((d) => d.type === 'engine' && d.stats.kind !== part.stats.kind);
    if (swapped) {
      const b = bug.drives.indexOf(part);
      for (const p of [...bug.coolers, ...bug.mods, ...bug.drivetrain]) {
        if ((p.bay || 0) !== b || worksWith(p, bug)) continue;
        for (const off of bug.unequip(p) || []) { this.state.addPart(off); this.lastStripped.push(off); }
      }
    }
    this.tidyName(bug);
    return part;
  }

  /** " — took off X and Y (they don't suit a turbine)" after a motor swap that stripped parts, or "". */
  strippedNote(part) {
    const off = this.lastStripped || [];
    if (!off.length) return '';
    const names = off.map((p) => p.name);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
    return ` — took off the ${list} (${off.length > 1 ? "they don't" : "it doesn't"} suit ${/^[aeiou]/.test(part.stats.kind) ? 'an' : 'a'} ${part.stats.kind} motor)`;
  }

  /**
   * A project frame named by the dealer ("… Rolling Chassis", "… Bare Frame") loses
   * the tag once it's a complete vehicle — unless you've renamed it.
   */
  tidyName(bug) {
    const m = bug.name.match(/^(.*) (Rolling Chassis|Bare Frame)$/);
    if (m && bug.engine && bug.tires && !bug.unshafted && !bug.stranded) bug.name = m[1];
  }

  /**
   * Twin drives: fit the part that would match one drive to the other — from
   * your spares, or bought off the Marketplace. Returns where it came from.
   */
  fitMatching(bug, uid) {
    const u = bug.unmatched({ cooling: true }).find((x) => x.part.uid === uid);
    if (!u) throw new Error('Those drives already match');
    const spare = this.state.inventory.find((p) => p.key === u.part.key && !p.isScrap);
    if (spare) { this.equipFromInventory(bug, spare.uid, undefined, u.missingOn); return 'spares'; }
    const listing = this.state.market.parts.find((l) => l.part.key === u.part.key);
    if (!listing) throw new Error(`No ${u.part.name} in your spares or on the Marketplace`);
    const part = this.buyPartListing(listing.id);
    this.equipFromInventory(bug, part.uid, undefined, u.missingOn);
    return 'market';
  }

  /** Where a matching part could come from: 'spares', a Marketplace price, or null. */
  matchSource(key) {
    if (this.state.inventory.some((p) => p.key === key && !p.isScrap)) return { where: 'spares' };
    const listing = this.state.market.parts.find((l) => l.part.key === key);
    return listing ? { where: 'market', price: this.partPrice(listing) } : null;
  }

  /**
   * One go at finding a part to match your other drive: 40% the first time,
   * then 20% likelier after each bout they keep looking. Found → on the Marketplace.
   * @returns {{found: boolean, next?: number}}
   */
  huntForMatch(key) {
    const hunt = this.state.managerHunt || (this.state.managerHunt = {});
    // Some managers just pick up the phone and get it (or nearly always do).
    const odds = this.person('manager')?.find ?? hunt[key] ?? ECONOMY.MATCH_FIND_FIRST;
    if (chance(odds) && this.stockPick(key)) {
      delete hunt[key];
      return { found: true };
    }
    hunt[key] = Math.min(1, odds + ECONOMY.MATCH_FIND_STEP);
    return { found: false, next: hunt[key] };
  }

  /** Is the manager already looking for one of these? (Their next try is after your next bout.) */
  huntOdds(key) {
    return this.state.managerHunt?.[key] ?? null;
  }

  /** Send your manager looking for a part to match your other drive. */
  managerFind(key) {
    if (!this.state.staff.manager) throw new Error('You need a manager to go looking');
    this.assertNotInField();
    if (this.huntOdds(key) !== null) throw new Error('Your manager is already looking — give it a bout');
    if (this.matchSource(key)) throw new Error("There's already one to be had");
    return { name: PARTS[key].name, ...this.huntForMatch(key) };
  }

  /** Take a part off into your spares. Returns every part that came off (a drive brings its add-ons). */
  unequipToInventory(bug, partUid) {
    const part = bug.findPart(partUid);
    const off = part && bug.unequip(part);
    if (!off) throw new Error('Cannot remove that part');
    for (const p of off) this.state.addPart(p);
    return off;
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

  /** Can this part go on this bug at all? (Some add-ons only suit certain drives.) */
  fits(part, bug, bay = null) {
    if (part.type === 'weapon' && !bug.weaponSlots) return false;
    return worksWith(part, bug, bay);
  }

  /** Buy a part and fit it straight onto `bug` (for an empty slot). */
  /** @param {number} [bay] twin drives: which drive to fit it to */
  buyAndFit(listingId, bug, bay) {
    const listing = this.state.market.parts.find((l) => l.id === listingId);
    const problem = listing && this.fitProblem(listing.part, bug, undefined, bay);
    if (problem) throw new Error(problem);
    const part = this.buyPartListing(listingId);
    return this.equipFromInventory(bug, part.uid, undefined, bay);
  }

  /** Does `bug` have a free slot for a part of this type? */
  hasFreeSlot(bug, type) {
    if (!bug) return false;
    const list = bug.slotList(type);
    if (list) return list.length < bug.slotCapacity(type);
    return ['engine', 'tires', 'castor', 'armor'].includes(type) && !bug.slotPart(type);
  }

  buyVehicleListing(listingId) {
    this.assertNotInField();
    const i = this.state.market.vehicles.findIndex((l) => l.id === listingId);
    if (i < 0) throw new Error('Listing gone');
    const listing = this.state.market.vehicles[i];
    this.state.spend(listing.price);
    this.state.market.vehicles.splice(i, 1);
    this.state.addVehicle(listing.bug);
    this.state.activeVehicleId = listing.bug.id; // straight onto the hoist
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
  }

  sellVehicle(id) {
    this.assertNotInField();
    const bug = this.state.getVehicle(id);
    if (!bug) throw new Error('No such vehicle');
    this.assertDisposable(bug);
    const price = this.vehicleSellPrice(bug);
    this.state.removeVehicle(id);
    this.state.earn(price);
    this.ensureReplacementListing(); // sold your last one? something affordable turns up
    return price;
  }

  /** The confirmation text for selling a vehicle. */
  sellWarning(bug) {
    const price = this.vehicleSellPrice(bug);
    if (this.sellEndsGame(bug)) return `You'll receive ${formatMoney(price)}. It's your last vehicle and you won't be able to afford another (${formatMoney(ECONOMY.MIN_VEHICLE_PRICE)}) — game over.`;
    if (this.state.vehicles.length === 1) return `You'll receive ${formatMoney(price)}. It's your last vehicle — you'll need to buy another before you can fight.`;
    return `You'll receive ${formatMoney(price)}.`;
  }

  /** Selling `bug` would leave you with no vehicle and too little to buy another: game over. */
  sellEndsGame(bug) {
    return this.state.vehicles.length === 1 && this.state.vehicles[0] === bug
      && this.liquidWorth + this.vehicleSellPrice(bug) < ECONOMY.MIN_VEHICLE_PRICE;
  }

  /** Strip a vehicle down to its frame: every fitted part goes to your spares; the bare chassis stays on the hoist. */
  stripVehicle(id) {
    const bug = this.state.getVehicle(id);
    if (!bug) throw new Error('No such vehicle');
    const parts = bug.parts.filter((p) => p !== bug.chassis);
    for (const p of parts) {
      bug.unequip(p);
      this.state.addPart(p);
    }
    return { parts };
  }

  // ───────────── Staff ─────────────
  /** Staff only come looking for work once you've made a name (or are already on the books). */
  staffAvailable(role) {
    if (this.employed(role)) return true;
    if (this.state.blacklist > 0) return false;
    const wins = this.state.record.challengerWins;
    const need = role === 'mechanic' ? ECONOMY.MECHANIC_SHOWS_AT_WINS : ECONOMY.MANAGER_SHOWS_AT_WINS;
    return wins >= need;
  }

  /** On the books: working, or on strike. (`state.staff[role]` is only true while they're working.) */
  employed(role) {
    return !!(this.state.staff[role] || this.state.strike[role]);
  }

  /** Bouts before anyone will take the job (after someone quit or was fired), or 0. */
  rehireWait(role) {
    return this.state.rehire[role]?.wait || 0;
  }

  // ───────────── Wages ─────────────
  /** Your complete (battle-ready) vehicles: what the mechanic is paid by. */
  get completeVehicles() {
    return this.state.vehicles.filter((v) => v.isBattleReady).length;
  }

  /**
   * What a fair wage looks like given what you're earning: the mechanic's rate
   * per complete vehicle (§), or the manager's share of your earnings (0–1).
   */
  goingRate(role) {
    if (role === 'manager') return ECONOMY.MANAGER_PCT;
    return Math.max(ECONOMY.MECHANIC_WAGE, roundTo(this.state.earnAvg * ECONOMY.MECHANIC_GOING_SHARE, 5));
  }

  /** Who you've got in a role (their roster entry), or null. */
  person(role) {
    const id = this.state.staffId[role];
    return id ? { id, ...STAFF_ROSTER[role][id] } : null;
  }

  /** Who's applying for the job (rolled if nobody is yet). */
  candidate(role) {
    const s = this.state;
    if (!s.candidate[role] || !STAFF_ROSTER[role][s.candidate[role]]) this.rollCandidate(role);
    const id = s.candidate[role];
    return { id, ...STAFF_ROSTER[role][id] };
  }

  /** Someone new turns up for the job (never the one who just left). */
  rollCandidate(role, exclude = null) {
    const ids = Object.keys(STAFF_ROSTER[role]).filter((k) => k !== exclude && k !== this.state.staffId[role]);
    this.state.candidate[role] = pick(ids);
  }

  /** What someone expects to be paid: the going rate, give or take their own idea of their worth. */
  expectedPay(role, id = this.state.staffId[role]) {
    const going = this.goingRate(role);
    if (role === 'manager') return going;
    return roundTo(going * (STAFF_ROSTER.mechanic[id]?.pay ?? 1), 5);
  }

  /** The wage a new hire starts on: what the last one was asking, or what this one expects. */
  startingPay(role) {
    return this.state.rehire[role]?.ask ?? this.expectedPay(role, this.candidate(role).id);
  }

  /** Let the manager set the wages after each bout (you can still override them before the next). */
  setManagerWages(on) {
    this.state.managerWages = !!on;
    if (on) this.managerSetsWages();
  }

  /**
   * Your manager sets the wages — each in their own way: some short the
   * mechanic, some look after themselves first. Only while they're working.
   */
  managerSetsWages() {
    const s = this.state;
    if (!s.managerWages || !s.staff.manager) return;
    const m = this.person('manager');
    if (!m) return;
    if (this.employed('mechanic')) this.setPay('mechanic', roundTo(this.expectedPay('mechanic') * m.mechPay, 5));
    this.setPay('manager', Math.round(ECONOMY.MANAGER_PCT * m.selfPay * 1000) / 1000);
  }

  /** Does your mechanic know about this kind of part (on this vehicle)? */
  mechanicKnows(type, bug, stats = null) {
    const m = this.person('mechanic');
    if (!m) return true;
    if (type === 'weapon' && m.weapons === false) return false;
    if (m.blindTo) {
      // Nothing to do with the drive when you're running the one they don't know…
      if (bug?.engine?.stats.kind === m.blindTo && ['engine', 'cooling', 'enhancement', 'drivetrain'].includes(type)) return false;
      // …and they'll never put you in one.
      if (type === 'engine' && stats?.kind === m.blindTo) return false;
    }
    return true;
  }

  /** The agreed wage (staff with none on record are on the going rate). */
  payOf(role) {
    if (this.state.pay[role] == null) this.state.pay[role] = this.goingRate(role);
    return this.state.pay[role];
  }

  /** This bout's wage: the mechanic's rate × complete vehicles, the manager's share of `earned`. */
  wageDue(role, earned = 0) {
    const rate = this.payOf(role);
    return Math.round(role === 'manager' ? rate * Math.max(0, earned) : rate * this.completeVehicles);
  }

  /** How they feel about it: 'content', 'complaining' (with what they want) or 'strike'. */
  staffMood(role) {
    const m = this.state.mood[role];
    if (this.state.strike[role]) return { state: 'strike', ask: m?.ask, bouts: m?.bouts || 0 };
    if (m?.stage === 1) return { state: 'complaining', ask: m.ask };
    return { state: 'content', settling: m?.settle || 0 };
  }

  /** Set a wage in the office. Paying what they asked ends a complaint or a strike on the spot. */
  setPay(role, value) {
    const s = this.state;
    if (!this.employed(role)) throw new Error(`You don't have a ${role}`);
    s.pay[role] = Math.max(0, role === 'manager' ? Math.min(1, value) : Math.round(value));
    const m = s.mood[role];
    if (m?.stage > 0 && s.pay[role] >= m.ask) {
      const wasStriking = !!s.strike[role];
      delete s.mood[role];
      if (wasStriking) { delete s.strike[role]; s.staff[role] = true; }
      return wasStriking ? 'back' : 'happy';
    }
    return null;
  }

  /**
   * After each bout: is the pay fair for what you're earning? Underpaid staff
   * complain first; do nothing before the next bout and they strike; still not
   * paid what they asked two bouts into the strike and they quit. New hires
   * settle in for a few bouts first.
   */
  reviewPay(role, report) {
    const s = this.state;
    const title = this.person(role)?.name || (role === 'mechanic' ? 'Mechanic' : 'Manager');
    const fmt = (v) => (role === 'manager' ? `${Math.round(v * 100)}% of your winnings` : `${formatMoney(v)} per vehicle`);
    const rate = this.payOf(role);
    const fair = this.expectedPay(role);
    const m = s.mood[role] || { stage: 0 };
    // New hires give it a few bouts before they start moaning about the wage they agreed to.
    if (m.settle > 0) { m.settle -= 1; s.mood[role] = m; return; }
    if (m.stage === 0) {
      if (rate < fair * ECONOMY.WAGE_CONTENT) {
        s.mood[role] = { stage: 1, ask: fair, bouts: 0 };
        report.lines.push(`${title}: You're raking it in and I'm on peanuts. I want ${fmt(fair)} — sort it out in the office before the next bout or I down tools.`);
      }
      return;
    }
    if (rate >= m.ask) { delete s.mood[role]; return; }
    if (m.stage === 1) {
      s.mood[role] = { ...m, stage: 2, bouts: 0 };
      s.staff[role] = false;
      s.strike[role] = true;
      report.lines.push(`${title}: ON STRIKE until I get ${fmt(m.ask)}. Don't expect any work out of me.`);
      return;
    }
    m.bouts += 1;
    s.mood[role] = m;
    if (m.bouts >= ECONOMY.STRIKE_QUIT_BOUTS) {
      this.staffLeaves(role);
      s.rehire[role] = { wait: ECONOMY.REHIRE_AFTER_QUIT, ask: m.ask };
      report.lines.push(`${title} quit over pay. Word's out — nobody will take the job for ${ECONOMY.REHIRE_AFTER_QUIT} bouts, and they'll want ${fmt(m.ask)}.`);
    } else {
      report.lines.push(`${title} is still on strike — pay ${fmt(m.ask)} in the office or they walk.`);
    }
  }

  hire(role) {
    if (this.employed(role)) return;
    if (this.state.blacklist > 0) throw new Error("You're blacklisted — nobody will work for you right now");
    const wait = this.rehireWait(role);
    if (wait > 0) throw new Error(`Nobody will take the job for ${wait} more bout${wait === 1 ? '' : 's'}`);
    const fee = role === 'mechanic' ? ECONOMY.MECHANIC_HIRE : ECONOMY.MANAGER_HIRE;
    this.state.spend(fee);
    this.state.pay[role] = this.startingPay(role);
    this.state.staffId[role] = this.candidate(role).id;
    delete this.state.candidate[role];
    delete this.state.rehire[role];
    this.state.mood[role] = { stage: 0, settle: ECONOMY.NEW_HIRE_SETTLE };
    this.state.staff[role] = true;
    if (role === 'manager') this.state.forgetIn = randInt(5, 8);
    if (role === 'manager') {
      this.state.managerBetPct = ECONOMY.MANAGER_BET_DEFAULT;
      this.state.fixStreak = 0;
    }
  }

  /**
   * Let a staff member go. Owe them money and you're blacklisted, and they
   * start helping themselves to your parts until they've got it back —
   * with interest, their losses and a bit extra.
   */
  dismiss(role) {
    // Fire a striker and the next one will start in a couple of bouts — for half what they were asking.
    const striker = this.state.strike[role] ? this.state.mood[role] : null;
    const owed = this.state.arrears[role];
    if (owed) {
      this.state.blacklist = ECONOMY.BLACKLIST_BOUTS;
      this.state.collectors.push({ role, owed: Math.round(owed.amount * ECONOMY.DEBT_RECOVERY + ECONOMY.DEBT_EXTRA), taken: 0 });
      this.state.addLog(`Dismissed your ${role} without paying the ${formatMoney(owed.amount)} you owed. Blacklisted for ${ECONOMY.BLACKLIST_BOUTS} bouts.`);
    }
    this.staffLeaves(role);
    if (striker?.ask != null) {
      const ask = striker.ask * ECONOMY.REHIRE_FIRED_SHARE;
      this.state.rehire[role] = { wait: ECONOMY.REHIRE_AFTER_FIRED, ask: role === 'manager' ? Math.round(ask * 100) / 100 : roundTo(ask, 5) };
    }
  }

  /** After a bout: the blacklist wears off, and ex-staff you stiffed may take a part. */
  collectDebts(report) {
    const s = this.state;
    if (s.blacklist > 0) {
      s.blacklist -= 1;
      report.lines.push(s.blacklist ? `Still blacklisted — nobody will work for you for ${s.blacklist} more bout${s.blacklist === 1 ? '' : 's'}.` : 'Your blacklisting has run out — staff will talk to you again.');
    }
    const c = s.collectors[0];
    if (!c || !chance(ECONOMY.DEBT_TAKE_CHANCE)) return;
    // Anything that isn't a frame: spares first or straight off your vehicles.
    const fitted = s.vehicles.flatMap((v) => v.parts.filter((p) => p !== v.chassis).map((p) => [p, v]));
    const pool = [...s.inventory.map((p) => [p, null]), ...fitted];
    if (!pool.length) return;
    const [part, bug] = pick(pool);
    if (bug) {
      // Whatever was bolted to it falls off into your spares.
      for (const p of bug.unequip(part) || []) if (p !== part) s.addPart(p);
    } else s.removePart(part.uid);
    c.taken += Math.max(ECONOMY.SCRAP_PRICE, Math.round(part.value * part.hpRatio));
    report.lines.push(`Your ${part.name} has gone missing${bug ? ` from ${bug.name}` : ' from your spares'}…`);
    if (c.taken >= c.owed) {
      s.collectors.shift();
      report.lines.push(`Word is your old ${c.role} reckons you're square now.`);
    }
  }

  /** A staff member is gone (dismissed, quit or vanished): any back pay goes with them. */
  staffLeaves(role) {
    const gone = this.state.staffId[role];
    delete this.state.staffId[role];
    this.rollCandidate(role, gone);
    this.state.staff[role] = false;
    delete this.state.strike[role];
    delete this.state.mood[role];
    delete this.state.arrears[role];
  }

  /** Pay a staff member what you owe them (from the Admin tab). */
  payArrears(role) {
    const owed = this.state.arrears[role];
    if (!owed) return 0;
    this.state.spend(owed.amount);
    delete this.state.arrears[role];
    return owed.amount;
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

  /** A compatible add-on of `type` for a bug (or null). */
  pickAddOn(type, tier, bug) {
    for (let i = 0; i < 8; i++) {
      const key = pickPartKey(type, tier);
      const p = new Part(key);
      if (worksWith(p, bug)) return p;
    }
    return null;
  }

  // ───────────── Training ─────────────
  /** A random opponent rated as close as possible to `bug`, flown by a pilot of middling skill. */
  sparringPartner(bug) {
    const target = this.rating(bug);
    const tier = this.vehicleStars(bug);
    let best = null;
    for (let i = 0; i < 16; i++) {
      const b = this.generateBug(clampTier(tier + (i % 3) - 1), { condition: () => rand(0.8, 1) });
      if (!best || Math.abs(this.rating(b) - target) < Math.abs(this.rating(best) - target)) best = b;
    }
    const style = pick(FIGHTING_STYLES);
    return { name: best.pilot?.name || 'Sparring Partner', planet: best.pilot?.planet, style, difficulty: rand(0.35, 0.75), bug: best };
  }

  /** A training dummy: a sturdy frame on tyres, no motor and no weapons — it only moves when pushed. */
  trainingDummy() {
    const bug = BattleBug.create({ name: 'Training Dummy', hue: 45, alien: false, chassis: 'weevil_wedge', tires: 'knobby_treads', armor: 'rubber_bumpers', weapons: [] });
    return { name: 'Training Dummy', bug, difficulty: 0 };
  }

  /** The drive shaft a build needs: none on castors or for plasma, a High-Speed Shaft for turbines, else a standard one. */
  shaftFor(engineKey, tiresKey) {
    if (!engineKey || !tiresKey || PARTS[tiresKey].type === 'castor') return [];
    const kind = PARTS[engineKey].stats.kind;
    if (kind === 'plasma') return [];
    // A turbine needs the full line: High-Speed Shaft → reducer → drive shaft.
    return kind === 'turbine' ? ['high_speed_shaft', 'standard_gearbox', 'standard_shaft'] : ['standard_shaft'];
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
    const motor = pickPartKey('engine', tier);
    // Thrust builds often glide on castors (plasma almost always: it can't drive wheels).
    const kind = PARTS[motor].stats.kind;
    const gear = THRUST_DRIVES.includes(kind) && chance(kind === 'plasma' ? 0.85 : 0.3) ? pickPartKey('castor', tier) : pickPartKey('tires', tier);
    const bug = BattleBug.create({
      name: `${pick(BUG_ADJECTIVES)} ${pick(BUG_NOUNS)}`,
      hue: randInt(0, 359),
      alien,
      pilot,
      chassis,
      engine: motor,
      // Twin-bay shells usually carry a matching second motor.
      engine2: PARTS[chassis].stats.drives > 1 && chance(0.4 + tier * 0.1) ? motor : null,
      tires: gear,
      armor: tier <= 1 && chance(0.4) ? null : pickPartKey('armor', tier),
      weapons,
      drivetrain: this.shaftFor(motor, gear),
      condition,
    });
    // Better-equipped pilots run cooling and enhancements that suit their drive.
    if (tier >= 2 && chance(0.25 + tier * 0.1)) { const c = this.pickAddOn('cooling', tier, bug); if (c) bug.equip(c); }
    if (tier >= 3 && chance(0.15 + tier * 0.08)) { const m = this.pickAddOn('enhancement', tier, bug); if (m) bug.equip(m); }
    if (tier >= 2 && chance(0.2 + tier * 0.08)) { const d = this.pickAddOn('drivetrain', tier, bug); if (d) bug.equip(d); }
    bug.mirrorBays(); // a twin leaves the factory with both drives kitted out alike
    return bug;
  }

  // ───────────── Challenger pilots (a persistent pool) ─────────────
  /**
   * A pilot: a named alien with a play style, a backstory, a skill level,
   * a purse, a record and their own bug. Pilots live in `state.pool`, the
   * board shows a handful of them, and they all progress between fights.
   */
  makePilot(tier, entry, { bug = null, rookie = false, elite = false } = {}) {
    const { name, planet, style, story } = entry;
    const theBug = bug || this.generateBug(tier);
    // A zapper's story promises an arsenal — make sure there's at least something to zap with.
    if (style === 'zapper' && !theBug.weapons.length && theBug.weaponSlots) theBug.equip(Part.create(pickPartKey('weapon', tier + 1), rand(0.7, 1)));
    theBug.pilot = { name, planet };
    const p = {
      id: makeId('pl'),
      name,
      planet,
      style,
      story,
      ...this.pilotHistory(tier, elite),
      elite,
      purse: roundTo((ECONOMY.BOUNTY_BASE + tier * ECONOMY.BOUNTY_PER_TIER) * rand(1, 2.5), 10),
      rookie,
      bug: theBug,
    };
    return this.refreshPilot(p);
  }

  /**
   * How good a pilot is and the record that gives it away: a novice (a
   * handful of fights, mostly lost), a regular or a veteran (a long record).
   * The win/loss split follows their skill.
   */
  pilotHistory(tier, elite = false) {
    const kinds = [PILOT_SKILL.NOVICE, PILOT_SKILL.REGULAR, PILOT_SKILL.VETERAN];
    let roll = Math.random() * kinds.reduce((t, k) => t + k.weight, 0);
    const kind = elite ? PILOT_SKILL.VETERAN : kinds.find((k) => (roll -= k.weight) < 0) || kinds[0];
    const fights = randInt(...kind.fights);
    const [base, per] = PILOT_SKILL.TIER_CAP;
    const skill = elite ? rand(...PILOT_SKILL.ELITE) : Math.min(rand(...kind.skill), base + tier * per, 0.95);
    let w = 0;
    for (let i = 0; i < fights; i++) if (chance(winRate(skill))) w++;
    return { skill, record: { w, l: fights - w } };
  }

  /** Recompute the board-facing numbers after a pilot's bug or skill changes. */
  refreshPilot(p) {
    p.bug.pilot = { name: p.name, planet: p.planet };
    p.tier = this.vehicleStars(p.bug);
    p.bounty = roundTo(ECONOMY.BOUNTY_BASE + p.tier * ECONOMY.BOUNTY_PER_TIER, 5);
    p.difficulty = p.rookie && this.wantsRookie ? 0.05 : p.skill;
    return p;
  }

  junkBug(name) {
    const [lo, hi] = ECONOMY.JUNK_CONDITION;
    return BattleBug.create({
      ...STARTER_BUG, name, hue: randInt(0, 359), alien: true, engine: 'rust_motor', armor: null,
      condition: () => rand(lo + 0.2, hi + 0.25),
    });
  }

  /** A deliberately weak, unarmed, half-wrecked opponent for new pilots. */
  makeRookie(entry) {
    const bug = BattleBug.create({
      name: `Rookie ${pick(BUG_NOUNS)}`, hue: randInt(0, 359), alien: true,
      chassis: 'scrapper_frame', engine: 'rust_motor', tires: 'bald_rollers', armor: null, weapons: [], drivetrain: ['standard_shaft'],
      condition: () => rand(0.5, 0.65),
    });
    const p = this.makePilot(1, entry, { bug, rookie: true });
    p.skill = 0.05;
    p.record = { w: 0, l: 0 };
    return this.refreshPilot(p);
  }

  /**
   * Build the pool from the 20-pilot roster: the rookie, then everyone else
   * dealt a random starting tier, so each game's line-up plays differently.
   */
  ensurePool() {
    const s = this.state;
    if (!s.pool.length) {
      const [rookie, ...rest] = CHALLENGER_ROSTER;
      s.pool.push(this.makeRookie(rookie));
      // A random handful are the elite: tournament veterans in 5★ rides.
      const tiers = [...ECONOMY.POOL_TIERS, ...Array(ECONOMY.ELITE_PILOTS).fill(5)].sort(() => Math.random() - 0.5);
      rest.forEach((entry, i) => {
        const tier = tiers[i] ?? 3;
        s.pool.push(this.makePilot(tier, entry, { elite: tier === 5 }));
      });
    } else if (!s.pool.some((p) => p.elite)) {
      // Older saves: the strongest pilots become the elite.
      s.pool.filter((p) => !p.rookie && p.id !== s.rivalId).sort((x, y) => this.strength(y) - this.strength(x))
        .slice(0, ECONOMY.ELITE_PILOTS).forEach((p) => { p.elite = true; });
    }
    for (const p of s.pool) if (this.isRoamer(p)) delete p.home; // the rookie roams
    if (s.pool.some((p) => !p.home && !this.isRoamer(p))) this.assignHomes();
    for (const p of s.pool) this.refreshPilot(p);
  }

  /**
   * Home dohyo: Dohyo 1 is yours — and your rival's, and two other pilots'.
   * Everyone else is split evenly across the other four.
   */
  assignHomes() {
    const s = this.state;
    const others = s.pool.filter((p) => p.id !== s.rivalId && !this.isRoamer(p)).sort(() => Math.random() - 0.5);
    others.forEach((p, i) => { p.home = i < ECONOMY.HOME_ONE_PILOTS ? 1 : 2 + ((i - ECONOMY.HOME_ONE_PILOTS) % 4); });
    if (this.rival) this.rival.home = 1;
  }

  /**
   * Once the rookie is your rival, the homeless pilot is always the weakest one
   * left: after each bout, if someone else is now weakest, they swap — the new
   * weakest loses their home and the old one takes it.
   */
  repickRoamer() {
    const s = this.state;
    if (!s.roamerId) return;
    const old = s.pool.find((p) => p.id === s.roamerId);
    const worst = s.pool.filter((p) => p.id !== s.rivalId && !p.elite).sort((x, y) => this.strength(x) - this.strength(y))[0];
    if (!worst || worst === old) return;
    if (old) old.home = worst.home || 2;
    delete worst.home;
    s.roamerId = worst.id;
  }

  /** Keep the away dohyo (2–5) within one pilot of each other. */
  balanceHomes() {
    const pool = this.state.pool.filter((p) => p.home > 1);
    for (let guard = 0; guard < 8; guard++) {
      const by = [2, 3, 4, 5].map((k) => pool.filter((p) => p.home === k));
      const most = by.reduce((a, b) => (b.length > a.length ? b : a));
      const least = [2, 3, 4, 5][by.findIndex((g) => g.length === Math.min(...by.map((x) => x.length)))];
      if (most.length - Math.min(...by.map((x) => x.length)) <= 1) return;
      most[most.length - 1].home = least;
    }
  }

  /** Where the next bout is fought: at home (Dohyo 1) and away (their home dohyo) in turn. */
  get nextIsHome() {
    return this.boutsPlayed % 2 === 0;
  }

  /** The rookie has no home dohyo — until they become your rival. */
  isRoamer(p) {
    if (!p) return false;
    const id = this.state.roamerId;
    return id ? p.id === id : p.name === CHALLENGER_ROSTER[0].name && p.id !== this.state.rivalId;
  }

  /** The dohyo for a bout: the rookie's is random; everyone else plays home and away. */
  venueFor(challenger) {
    if (this.isRoamer(challenger)) return 1 + Math.floor(Math.random() * 5);
    return this.nextIsHome ? 1 : challenger?.home || 1;
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
    // The rival only turns up every few bouts; the elite wait for the first 5★ regular.
    return s.pool.filter((p) => !taken.has(p.id) && (p.id !== s.rivalId || this.rivalDue) && (!p.elite || s.elitesOut || p.id === s.rivalId));
  }

  /** A pilot's all-round strength: skill plus their ride. */
  strength(p) {
    return p.skill + this.rating(p.bug) / 1000;
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
      const rookie = this.availablePilots.find((p) => p.rookie);
      if (rookie) s.challengers.push(rookie);
    }
    // Your rival turns up every few bouts (unless they've just walked off on you).
    const rival = this.rival;
    if (rival && this.rivalDue && !s.challengers.includes(rival) && this.availablePilots.includes(rival)) s.challengers.push(rival);
    while (s.challengers.filter((c) => c.matched).length < ECONOMY.MATCHED_CHALLENGERS && s.challengers.length < ECONOMY.BOARD_SIZE) {
      const target = this.bestVehicle ? this.rating(this.bestVehicle) : 0;
      const even = this.availablePilots
        .filter((p) => !this.rookieSlot(p) && p.id !== s.rivalId && this.isEvenMatch(p))
        .sort((x, y) => Math.abs(this.rating(x.bug) - target) - Math.abs(this.rating(y.bug) - target))[0];
      const c = even || this.rematch();
      if (!c) break;
      c.matched = true;
      s.challengers.push(c);
    }
    while (s.challengers.length < ECONOMY.BOARD_SIZE) {
      const rest = this.availablePilots.filter((p) => !this.rookieSlot(p)).sort((x, y) => this.rating(x.bug) - this.rating(y.bug));
      if (!rest.length) break; // everyone else has walked off — a short board until your next fight
      // Spread picks across the range; after a scroll, favour the strongest.
      const need = ECONOMY.BOARD_SIZE - s.challengers.length;
      const idx = s.board.tierShift > 0
        ? rest.length - 1
        : Math.min(rest.length - 1, Math.floor(((ECONOMY.BOARD_SIZE - need) / ECONOMY.BOARD_SIZE) * rest.length));
      s.challengers.push(rest[idx]);
    }
    for (const c of s.challengers) this.refreshPilot(c);
    // The elite come out once 5★ pilots are your level: a 5★ regular on the board,
    // a 4★ ride of your own, or a board that's scrolled up after walk-offs.
    const best = this.bestVehicle;
    if (s.challengers.some((c) => !c.elite && c.tier >= 5) || (best && this.vehicleStars(best) >= ECONOMY.ELITE_AT_STARS) || s.board.tierShift > 0) s.elitesOut = true;
    this.sortBoard();
  }

  // ───────────── Your rival ─────────────
  get rival() {
    return this.state.rivalId ? this.state.pool.find((p) => p.id === this.state.rivalId) || null : null;
  }

  /**
   * The first alien you beat in a title match becomes your rival for the rest
   * of the game — and lets you know exactly how they feel about it.
   * @param {string} lostBugName the ride they just lost to you
   */
  setRival(pilot, lostBugName) {
    const s = this.state;
    if (s.rivalId || !pilot?.record) return false;
    const wasRoamer = this.isRoamer(pilot);
    s.rivalId = pilot.id;
    pilot.rookie = false; // no longer anybody's easy first fight
    // If the rookie becomes your rival they settle on Dohyo 1, and the next-worst pilot
    // takes over as the homeless one — so the easy fights stay on varied rings.
    if (wasRoamer) {
      const worst = s.pool.filter((p) => p !== pilot && !p.elite).sort((x, y) => this.strength(x) - this.strength(y))[0];
      if (worst) { s.roamerId = worst.id; delete worst.home; }
    }
    pilot.home = 1; // they move in on your home dohyo
    this.balanceHomes();
    pilot.skill = Math.min(pilot.skill, PILOT_SKILL.RIVAL); // rattled for good — until the tournament
    this.scheduleRival();
    s.pendingDM = { pilotId: pilot.id, lines: RIVAL_DM.map((l) => l.replaceAll('{bug}', lostBugName)) };
    return true;
  }

  /** Your rival's latest excuse, queued as a DM: a different one every time, looping when they run out. */
  rivalExcuse(rival, rideName) {
    const s = this.state;
    const i = (s.rivalExcuses || 0) % RIVAL_EXCUSES.length;
    s.rivalExcuses = (s.rivalExcuses || 0) + 1;
    s.pendingDM = { pilotId: rival.id, lines: RIVAL_EXCUSES[i].map((l) => l.replaceAll('{bug}', rideName || 'ride')) };
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
   * Your rival keeps pace — with money, not talent: they take on a real
   * fighting style and upgrade (or buy a whole new ride) to stay just ahead
   * of your best vehicle, but they never learn to drive it. Only in the
   * tournament do they finally get good.
   */
  advanceRival() {
    const r = this.rival;
    const best = this.bestVehicle;
    if (!r || !best || this.rookieSlot(r)) return;
    if (r.style === 'hapless') r.style = pick(FIGHTING_STYLES); // they've learned a thing or two since
    r.story = RIVAL_STORIES.beaten;
    r.skill = Math.min(r.skill, PILOT_SKILL.RIVAL);
    const target = this.rating(best) * ECONOMY.RIVAL_EDGE;
    for (let i = 0; i < 3 && this.rating(r.bug) < target; i++) {
      r.purse += 300;
      this.maintainPilot(r);
    }
    const mine = this.rating(best);
    if (this.rating(r.bug) <= mine) {
      // Parts alone won't do it — a new ride, always rated above yours.
      const score = (bug) => (this.rating(bug) > mine ? 0 : 1e6) + Math.abs(this.rating(bug) - target);
      let bestBug = r.bug;
      for (let i = 0; i < 40; i++) {
        const bug = this.generateBug(clampTier(this.vehicleStars(best) + (i % 3 ? 1 : 0)), { condition: () => 1 });
        if (score(bug) < score(bestBug)) bestBug = bug;
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
        const won = chance(winRate(p.skill));
        const swing = p.bounty * (won ? rand(0.6, 1.2) : -rand(0.2, 0.4));
        p.purse = Math.max(0, Math.round(p.purse + swing + ECONOMY.PILOT_STIPEND));
        if (won) p.record.w++; else p.record.l++;
        if (p.id !== this.state.rivalId) p.skill = Math.min(0.95, p.skill + PILOT_SKILL.LEARN);
        for (const part of p.bug.parts) part.applyDamage(part.maxHp * rand(0, won ? 0.12 : 0.25));
      }
      this.maintainPilot(p);
    }
  }

  /** Pilots use the same logic as your mechanic: repair, then buy the optimal affordable part. */
  maintainPilot(p) {
    const bug = p.bug;
    for (const part of bug.parts) {
      const cost = Math.ceil(part.missingHp * (part.value / part.maxHp) * ECONOMY.REPAIR_RATE);
      if (cost <= p.purse) { p.purse -= cost; part.repair(); }
    }
    const pref = PILOT_STYLES[p.style]?.shops;
    const needs = this.diagnose(bug);
    needs.sort((x, y) => (x.urgent === y.urgent ? (y.type === pref) - (x.type === pref) : y.urgent - x.urgent));
    for (const { type, only } of needs) {
      const key = this.optimalPart(bug, type, p.purse, { owned: [], discount: 1, only });
      if (!key) continue;
      let displaced;
      try { displaced = bug.equip(new Part(key)); } catch { continue; } // e.g. a motor that doesn't match its twin
      p.purse -= PARTS[key].value;
      // A twin gets one for each drive.
      const odd = bug.unmatched({ cooling: true }).filter((u) => u.part.key === key);
      for (const u of odd) { bug.equip(new Part(key), undefined, u.missingOn); p.purse -= PARTS[key].value; }
      for (const old of displaced) p.purse += Math.round(old.value * old.hpRatio * ECONOMY.SCRAP_RATE);
      break;
    }
    this.refreshPilot(p);
  }

  // ───────────── Even matches ─────────────
  /** Star rating (1–5) of a vehicle: the average tier of its parts. */
  vehicleStars(bug) {
    const parts = [bug.chassis, ...bug.drives, bug.tires, bug.armor, ...bug.weapons].filter(Boolean);
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
   * No pilot in the pool is an even match right now, so one of them goes
   * shopping: the free pilot closest to your level buys a ride rated as
   * close as possible to your best vehicle (at most one star higher).
   */
  rematch() {
    const s = this.state;
    const best = this.bestVehicle;
    const free = this.availablePilots.filter((p) => !this.rookieSlot(p) && p.id !== s.rivalId);
    if (!free.length) return null;
    const target = best ? this.rating(best) : 0;
    const p = free.sort((x, y) => Math.abs(this.rating(x.bug) - target) - Math.abs(this.rating(y.bug) - target))[0];
    if (best) {
      p.bug = this.matchedBug();
      if (p.style === 'zapper' && !p.bug.weapons.length && p.bug.weaponSlots) p.bug.equip(Part.create(pickPartKey('weapon', p.tier + 1), rand(0.7, 1)));
    }
    return this.refreshPilot(p);
  }

  /** A bug rated as close as possible to your best vehicle, at its star level or one higher. */
  matchedBug() {
    const best = this.bestVehicle;
    const target = this.rating(best);
    const star = this.vehicleStars(best);
    let pickBug = null;
    let err = Infinity;
    for (let i = 0; i < 24 && err > 0.06; i++) {
      const bug = this.generateBug(clampTier(star + (i % 2)));
      const e = Math.abs(this.rating(bug) - target) / target;
      if (e < err) { pickBug = bug; err = e; }
    }
    return pickBug;
  }

  /** Still a fair fight for your current best vehicle? */
  isEvenMatch(c) {
    const best = this.bestVehicle;
    if (!best) return false;
    const target = this.rating(best);
    return this.vehicleStars(c.bug) <= this.vehicleStars(best) + 1 && Math.abs(this.rating(c.bug) - target) / target <= ECONOMY.MATCH_TOLERANCE;
  }

  /**
   * What a vehicle looks worth from the outside. Nobody can see under the
   * hood, so the motor is priced like an ordinary one of its tier — a rare
   * engine inside is a bargain waiting to be found.
   */
  listingValue(bug) {
    const e = bug.engine;
    if (!e) return this.vehicleValue(bug);
    const same = shopKeys('engine').filter((k) => PARTS[k].tier === e.tier);
    const typical = same.length ? same.reduce((sum, k) => sum + PARTS[k].value, 0) / same.length : e.value;
    return this.vehicleValue(bug) - e.value * e.hpRatio + typical * e.hpRatio;
  }

  /** The rarest find (epic or legendary) on this bug, if any. */
  hiddenGem(bug) {
    return bug.parts
      .filter((p) => RARITY[p.rarity].rank >= RARITY.epic.rank)
      .sort((a, b) => RARITY[b.rarity].rank - RARITY[a.rarity].rank)[0] || null;
  }

  /** An epic or legendary part in the shop window, priced beyond what you have right now. */
  teaserListing() {
    if (!chance(ECONOMY.TEASER_CHANCE)) return null;
    const keys = Object.keys(PARTS).filter((k) => !RARITY[PARTS[k].rarity].shop && PARTS[k].type !== 'chassis');
    const key = weightedPick(keys);
    const part = Part.create(key, 1);
    const price = roundTo(part.value * rand(1.2, 1.6), 5);
    if (price <= this.state.money) return null; // only ever a tease
    return { id: makeId('mk'), part, price, teaser: true };
  }

  generateMarket() {
    this.state.sellQuotes = {}; // buyers change too
    const tierCap = clampTier(this.baseTier + 1);
    const parts = [];
    const types = Object.entries(ECONOMY.MARKET_STOCK).flatMap(([type, n]) => Array(n).fill(type));
    for (const type of types) {
      const t = chance(0.12) ? 5 : tierCap;
      const pool = shopKeys(type).filter((k) => PARTS[k].tier <= t);
      if (!pool.length) continue;
      const key = weightedPick(pool);
      const condition = chance(0.45) ? 1 : rand(0.55, 0.95);
      const part = Part.create(key, condition);
      parts.push({ id: makeId('mk'), part, price: roundTo(part.value * part.hpRatio * this.priceSwing('buy'), 5) });
    }
    // Drive shafts are always in stock, and cost next to nothing.
    const shaft = Part.create('standard_shaft', 1);
    parts.push({ id: makeId('mk'), part: shaft, price: Math.max(5, roundTo(shaft.value * this.priceSwing('buy'), 5)) });
    // Now and then a dealer puts something special in the window — always just out of reach.
    const tease = this.teaserListing();
    if (tease) parts.push(tease);
    const vehicles = [];
    for (let i = 0; i < ECONOMY.MARKET_VEHICLES; i++) {
      const bug = this.generateBug(clampTier(tierCap - randInt(0, 1)), { alien: chance(0.5), condition: () => rand(0.6, 1) });
      if (!bug.alien) bug.name = `Used ${bug.name}`;
      vehicles.push({ id: makeId('mk'), bug, price: Math.max(ECONOMY.MIN_VEHICLE_PRICE, roundTo(this.listingValue(bug) * this.priceSwing('buy'), 5)) });
    }
    // Project frames: an empty frame, and a rolling chassis (frame + running gear) — bring your own motor.
    for (const rolling of [false, true]) {
      const pool = shopKeys('chassis').filter((k) => PARTS[k].tier <= tierCap);
      const chassis = weightedPick(pool);
      const bug = BattleBug.create({
        name: `${PARTS[chassis].name} ${rolling ? 'Rolling Chassis' : 'Bare Frame'}`,
        hue: randInt(0, 359),
        chassis,
        tires: rolling ? weightedPick(shopKeys('tires').filter((k) => PARTS[k].tier <= tierCap)) : null,
        condition: () => rand(0.6, 1),
      });
      vehicles.push({ id: makeId('mk'), bug, price: Math.max(ECONOMY.SCRAP_PRICE * 5, roundTo(this.vehicleValue(bug) * this.priceSwing('buy'), 5)) });
    }
    this.state.market = { parts, vehicles };
  }

  // ───────────── Confidence & wagers ─────────────
  /** Rough fighting strength used for odds, haggling and the manager's bets. */
  rating(bug) {
    const s = bug.getStats();
    const armor = bug.armor && !bug.armor.isBroken ? bug.armor.stats.absorb * bug.armor.hpRatio * 20 : 0;
    const guns = bug.weapons.filter((w) => !w.isBroken).length * 5;
    const heat = s.cooling * 0.8 - (s.drainMult - 1) * 30;
    return s.fUsable / 1000 + s.fGrip / 2500 + bug.chassis.hp / 8 + s.staminaMax / 10 + s.vMax / 25 + guns + armor + heat;
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
    // Sure things: the rookie's first title offer, and your first one after losing
    // your only ride (everyone fancies taking a cheap replacement off you).
    const s = this.state;
    const sure = (c.rookie && !c.titleAsked) || s.comeback;
    c.titleAsked = true;
    if (!sure && chance(ECONOMY.TITLE_REFUSAL)) {
      const no = pick(TITLE_REFUSALS);
      n.log.push({ who: 'them', text: no });
      return { status: 'reject', message: `${c.bug.pilot?.name || c.bug.name}: ${no}`, ...this.reject(c) };
    }
    n.deal = { type: 'titles' };
    n.counter = null;
    s.comeback = false;
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
    this.repickRoamer();
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

  /**
   * What the bookies make of a big bet on you to win while you're on a hot
   * streak: 'refused' on the next one, 'stolen' after that (the manager
   * vanishes with the stake), otherwise null.
   */
  bigBetFate(side, stake) {
    if (side !== 'win' || stake <= ECONOMY.BIG_WIN_BET) return null;
    const n = this.state.winBetStreak || 0;
    return n > ECONOMY.HOT_STREAK ? 'stolen' : n === ECONOMY.HOT_STREAK ? 'refused' : null;
  }

  /** Place the manager's bet for this fight; `pct` is the per-fight limit. */
  placeManagerBet(c, bug, reserved = 0, pct = this.state.managerBetPct) {
    if (this.inField) return null;
    const plan = this.planManagerBet(c, bug, reserved, pct);
    if (plan.stake < 1) return null;
    const fate = this.bigBetFate(plan.side, plan.stake);
    // A refused bet never leaves your account; a stolen one leaves with the manager.
    if (fate !== 'refused') this.state.spend(plan.stake);
    return { side: plan.side, stake: plan.stake, mult: plan.mult, fate };
  }

  /** Hot streak: wins in a row backed by a big win-bet. A loss, a draw or a smaller bet resets it. */
  trackWinBetStreak(bet, result) {
    const s = this.state;
    const backed = bet?.side === 'win' && bet.stake >= ECONOMY.BIG_WIN_BET;
    s.winBetStreak = backed && result === 'win' ? (s.winBetStreak || 0) + 1 : 0;
  }

  settleManagerBet(bet, result, report, { tournament = false } = {}) {
    const s = this.state;
    if (!tournament) this.trackWinBetStreak(bet, result);
    if (!bet) {
      s.fixStreak = 0;
      return;
    }
    const sideText = bet.side === 'win' ? 'to WIN' : 'to LOSE';
    if (bet.fate === 'refused') {
      report.lines.push(`Your manager's ${formatMoney(bet.stake)} bet on you ${sideText} wasn't accepted — nobody will take bets against you any more.`);
      return;
    }
    if (bet.fate === 'stolen') {
      this.staffLeaves('manager');
      s.winBetStreak = 0;
      report.lines.push(`Your manager has mysteriously gone missing — along with the ${formatMoney(bet.stake)} they were meant to bet. You'll have to hire a new one.`);
      return;
    }
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
      this.staffLeaves('manager');
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
  /**
   * Your manager's call: unlocked, not already in, your best ride is close to
   * a tournament-grade build, and the entry fee leaves change to spare.
   */
  get tournamentReady() {
    const s = this.state;
    if (!s.staff.manager || !this.tournamentUnlocked || s.tournament.entered || s.gameComplete) return false;
    if (s.money < ECONOMY.TOURNAMENT_FEE + ECONOMY.TOURNAMENT_SPARE) return false;
    const best = this.bestVehicle;
    if (!best?.isBattleReady) return false;
    this.tourneyBar ??= this.strongestBuild().rating;
    return this.rating(best) >= this.tourneyBar * ECONOMY.TOURNAMENT_READY;
  }

  /** Open while you're on a 10-win streak (and, once you're in, until you're out). */
  get tournamentUnlocked() {
    return (this.state.record.streak || 0) >= ECONOMY.TOURNAMENT_STREAK || !!this.state.tournament.entered;
  }

  enterTournament() {
    const bug = this.state.activeBug;
    if (!this.tournamentUnlocked) throw new Error(`Win ${ECONOMY.TOURNAMENT_STREAK} in a row to qualify`);
    if (!bug?.isBattleReady) throw new Error('Your active vehicle is not battle-ready');
    if (!this.state.canAfford(ECONOMY.TOURNAMENT_FEE)) throw new Error(`The entry fee is ${formatMoney(ECONOMY.TOURNAMENT_FEE)}`);
    this.state.spend(ECONOMY.TOURNAMENT_FEE);
    Object.assign(this.state.tournament, { entered: true, vehicleId: bug.id, round: 0, eliminated: false, field: this.tournamentField() });
    this.state.tournament.opponent = this.tournamentOpponentJSON(0);
    this.state.addLog(`Entered the Inter-Planetary Tournament with ${bug.name}`);
  }

  // ───────────── Scarab Standoff ─────────────
  /** You're on a 5-win streak (or better): open for as long as the streak lasts. */
  get standoffOpen() {
    return (this.state.record.streak || 0) >= ECONOMY.STANDOFF_STREAK;
  }

  /** Open on the streak — and not while you're in the main tournament. */
  get standoffAvailable() {
    return this.standoffOpen && !this.inField;
  }

  /**
   * Two pilots of about your ability: the ones whose rides rate closest to
   * yours (no elite tournament pilots). They bring copies of their own bugs.
   */
  standoffField(bug) {
    const target = this.rating(bug);
    const pool = this.state.pool.filter((p) => !p.elite && p.bug?.isBattleReady)
      .sort((a, b) => Math.abs(this.rating(a.bug) - target) - Math.abs(this.rating(b.bug) - target))
      .slice(0, 5);
    const picks = [];
    while (picks.length < 2 && pool.length) picks.push(pool.splice(Math.floor(Math.random() * Math.min(pool.length, 3)), 1)[0]);
    while (picks.length < 2) { const p = this.sparringPartner(bug); picks.push({ ...p, skill: p.difficulty }); }
    return picks.map((p) => ({
      name: p.name, planet: p.planet, style: p.style, difficulty: p.skill ?? p.difficulty,
      bug: BattleBug.fromJSON({ ...p.bug.toJSON(), pilot: { name: p.name, planet: p.planet } }),
    }));
  }

  /** Pay the entry fee and meet your two opponents. */
  enterStandoff() {
    const bug = this.state.activeBug;
    if (!this.standoffAvailable) throw new Error(`Win ${ECONOMY.STANDOFF_STREAK} in a row to open the Scarab Standoff`);
    if (!bug?.isBattleReady) throw new Error(bug ? bug.battleIssues()[0] : 'No vehicle');
    if (!this.state.canAfford(ECONOMY.STANDOFF_FEE)) throw new Error(`The entry fee is ${formatMoney(ECONOMY.STANDOFF_FEE)}`);
    this.state.spend(ECONOMY.STANDOFF_FEE);
    this.state.addLog(`Entered the Scarab Standoff with ${bug.name}`);
    return this.standoffField(bug);
  }

  // ───────────── Weevil Weave ─────────────
  /** Unlocked for good by winning the Scarab Standoff. */
  get weaveOpen() {
    return !!this.state.weave.open;
  }

  /**
   * Three racers for the three rounds: pilots whose rides rate closest to yours
   * (no elites), getting better round by round. They race copies of their bugs.
   */
  weaveField(bug) {
    const target = this.rating(bug);
    const pool = this.state.pool.filter((p) => !p.elite && p.bug?.isBattleReady)
      .sort((a, b) => Math.abs(this.rating(a.bug) - target) - Math.abs(this.rating(b.bug) - target))
      .slice(0, 6);
    const picks = [];
    while (picks.length < ECONOMY.WEAVE_ROUNDS && pool.length) picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    while (picks.length < ECONOMY.WEAVE_ROUNDS) { const p = this.sparringPartner(bug); picks.push({ ...p, skill: p.difficulty }); }
    picks.sort((a, b) => (a.skill ?? a.difficulty) - (b.skill ?? b.difficulty));
    return picks.map((p) => ({
      name: p.name, planet: p.planet, style: p.style, difficulty: p.skill ?? p.difficulty,
      bug: BattleBug.fromJSON({ ...p.bug.toJSON(), pilot: { name: p.name, planet: p.planet } }).toJSON(),
    }));
  }

  enterWeave() {
    const s = this.state;
    const bug = s.activeBug;
    if (!this.weaveOpen) throw new Error('Win the Scarab Standoff to get into the Weevil Weave');
    if (s.weave.entered) throw new Error("You're already in the Weevil Weave");
    if (!bug?.isBattleReady) throw new Error(bug ? bug.battleIssues()[0] : 'No vehicle');
    if (!s.canAfford(ECONOMY.WEAVE_FEE)) throw new Error(`The entry fee is ${formatMoney(ECONOMY.WEAVE_FEE)}`);
    s.spend(ECONOMY.WEAVE_FEE);
    Object.assign(s.weave, { entered: true, round: 0, field: this.weaveField(bug) });
    s.addLog(`Entered the Weevil Weave with ${bug.name}`);
  }

  /** This round's racer (with a live bug), or null. */
  get weaveOpponent() {
    const w = this.state.weave;
    const o = w.entered ? w.field[w.round] : null;
    return o ? { ...o, bug: BattleBug.fromJSON(o.bug), id: `weave_${w.round}` } : null;
  }

  withdrawWeave() {
    Object.assign(this.state.weave, { entered: false, round: 0, field: [] });
  }

  /** The tournament is over for you (won, knocked out or withdrawn): staff get the wages they ran up. */
  withdrawTournament(report = null) {
    Object.assign(this.state.tournament, { entered: false, vehicleId: null, round: 0, opponent: null, field: null });
    this.payTournamentWages(report);
  }

  payTournamentWages(report) {
    const s = this.state;
    const lines = [];
    for (const [role, amount] of Object.entries(s.pendingWages || {})) {
      if (!(amount > 0) || !this.employed(role)) continue;
      const who = this.person(role)?.name || `Your ${role}`;
      if (s.canAfford(amount)) {
        s.spend(amount);
        lines.push(`Tournament over: paid ${who} the ${formatMoney(amount)} in wages they ran up.`);
      } else {
        const owed = s.arrears[role];
        if (owed) owed.amount += amount; else s.arrears[role] = { amount, bouts: 0 };
        lines.push(`Tournament over: you can't cover the ${formatMoney(amount)} ${who} is owed for it — pay it in the Admin tab within ${ECONOMY.STAFF_GRACE} bouts.`);
      }
    }
    s.pendingWages = {};
    if (report) report.lines.push(...lines);
    else for (const l of lines) s.addLog(l);
  }

  /**
   * The field: the strongest pilots in the pool, weakest first, with your
   * rival waiting in the Grand Final (or the strongest pilot of all if you
   * haven't made one yet).
   */
  tournamentField() {
    const s = this.state;
    const rival = this.rival;
    // The elite first, then the strongest of the rest if any are missing.
    const byStrength = s.pool.filter((p) => p !== rival)
      .sort((x, y) => (y.elite - x.elite) || this.strength(y) - this.strength(x));
    const n = ECONOMY.TOURNAMENT_ROUNDS;
    const field = byStrength.slice(0, rival ? n - 1 : n).reverse();
    if (rival) field.push(rival);
    return field.map((p) => p.id);
  }

  /**
   * The strongest possible build by fighting rating: for every frame, the
   * best motor, tires and armour for it (greedy), armed with the best
   * weapons. Returns catalogue keys and the build's rating.
   */
  strongestBuild({ allow = (k) => RARITY[PARTS[k].rarity].shop } = {}) {
    const keysOf = (type) => PART_KEYS_BY_TYPE[type].filter(allow);
    const make = (b) => BattleBug.create({ ...b, engine2: PARTS[b.chassis].stats.drives > 1 ? b.engine : null, drivetrain: this.shaftFor(b.engine, b.tires), condition: () => 1 });
    const weaponsFor = (chassis) => keysOf('weapon')
      .sort((x, y) => PARTS[y].tier - PARTS[x].tier || PARTS[y].value - PARTS[x].value)
      .slice(0, PARTS[chassis].stats.weaponSlots);
    let best = null;
    for (const chassis of keysOf('chassis')) {
      const build = { chassis, engine: 'rust_motor', tires: 'bald_rollers', armor: null, weapons: weaponsFor(chassis) };
      for (const type of ['engine', 'tires', 'armor', 'engine', 'tires']) { // two passes: grip and power depend on each other
        const ranked = keysOf(type)
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
   * the strongest possible build, pristine and fully armed. The pilots are
   * the elite, weakest first, each flying at their own skill.
   * Earlier rounds vary the weapon loadout; the final carries the best pair.
   */
  tournamentOpponentJSON(round) {
    const s = this.state;
    const n = ECONOMY.TOURNAMENT_ROUNDS;
    const final = round >= n - 1;
    // Shop-bought best builds; the Grand Final brings out the epic parts too.
    const { build } = this.strongestBuild(final ? { allow: (k) => RARITY[PARTS[k].rarity].rank <= RARITY.epic.rank } : {});
    const spec = { ...build };
    if (!final) {
      const pool = shopKeys('weapon')
        .sort((x, y) => PARTS[y].tier - PARTS[x].tier || PARTS[y].value - PARTS[x].value)
        .slice(0, build.weapons.length + 1);
      spec.weapons = pool.sort(() => Math.random() - 0.5).slice(0, build.weapons.length);
    }
    s.tournament.field ||= this.tournamentField();
    const pilot = s.pool.find((p) => p.id === s.tournament.field[round]) || s.pool[s.pool.length - 1];
    const isRival = pilot.id === s.rivalId;
    // Their own ride's name and paint job, rebuilt as the best machine money can buy.
    const bug = BattleBug.create({
      ...spec,
      engine2: PARTS[spec.chassis].stats.drives > 1 ? spec.engine : null,
      drivetrain: this.shaftFor(spec.engine, spec.tires),
      name: pilot.bug.name,
      hue: pilot.bug.hue,
      alien: true,
      pilot: { name: pilot.name, planet: pilot.planet },
      condition: () => 1,
    });
    const style = pilot.style === 'hapless' ? pick(FIGHTING_STYLES) : pilot.style;
    const c = {
      id: pilot.id,
      name: pilot.name,
      planet: pilot.planet,
      style,
      story: isRival && final ? RIVAL_STORIES.final : pilot.story,
      record: { ...pilot.record },
      tier: 5,
      bounty: ECONOMY.TOURNAMENT_PRIZE,
      // Each pilot flies at their own skill — your rival finally learns to drive in the final.
      difficulty: isRival ? Math.max(pilot.skill, PILOT_SKILL.RIVAL_FINAL) : pilot.skill,
      roundName: ECONOMY.TOURNAMENT_ROUND_NAMES[round] || `Round ${round + 1}`,
      home: pilot.home || 1,
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
    if (!this.fits(p, clone)) return -Infinity;
    const list = clone.slotList(p.type);
    if (BattleBug.isAddOn(p.type)) {
      // Add-ons go on a drive: judged as a matched set on a twin (one for each drive).
      if (!clone.drives.length) return -Infinity;
      const per = BattleBug.perDrive(p.type);
      for (let b = 0; b < clone.drives.length; b++) {
        const q = b ? Part.fromJSON({ ...part.toJSON(), uid: undefined }) : p;
        const mine = clone.addOnsOn(p.type, b);
        const worst = mine.length >= per ? mine.reduce((w, x, i) => (x.value * x.hpRatio < mine[w].value * mine[w].hpRatio ? i : w), 0) : undefined;
        clone.equip(q, worst, b);
      }
    } else if (list) {
      const cap = clone.slotCapacity(p.type);
      if (list.length >= cap) {
        if (!cap) return -Infinity;
        // Replace the weakest fitted one.
        const worst = list.reduce((w, x, i) => (x.value * x.hpRatio < list[w].value * list[w].hpRatio ? i : w), 0);
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
    // Only what you own or the shop normally stocks — your mechanic can't conjure rare parts.
    const owned = opts.owned || this.state.inventory;
    const keys = new Set([...shopKeys(type), ...owned.filter((p) => p.type === type).map((p) => p.key)]);
    for (const key of keys) {
      if (!this.affordable(key, budget, opts)) continue;
      if (opts.only && !opts.only(PARTS[key].stats)) continue;
      // No room for another gearbox (your mechanic won't suggest one).
      if (PARTS[key].stats.group === 'gearbox' && bug.drivetrain.filter((p) => p.stats.group === 'gearbox').length >= PhysicsEngine.gearboxLimit(bug)) continue;
      // A standard shaft would snap on a turbine: never the right call.
      if (['std', 'chain'].includes(PARTS[key].stats.shaft) && bug.engine?.stats.kind === 'turbine') continue;
      // …and a chain on heavy running gear would need repairing after every fight.
      if (PARTS[key].stats.shaft === 'chain' && heavyGear(bug)) continue;
      const part = new Part(key);
      // Weapons all add the same raw rating, so break ties by quality (tier, then value).
      if (!this.fits(part, bug)) continue;
      const gain = this.ratingWith(bug, part) - base + (type === 'weapon' ? PARTS[key].tier * 0.5 + PARTS[key].value / 1000 : 0);
      if (!best || gain > best.gain) best = { key, gain };
    }
    if (!best) return null;
    const current = bug.slotList(type) ? null : bug.slotPart(type);
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
    const add = (type, reason, urgent = true, only) => needs.push({ type, reason, urgent, only });
    if (!bug.engine) add('engine', "there's no motor in her");
    if (bug.unshafted) add('drivetrain', "there's no drive shaft — the motor isn't connected to the wheels", true, (st) => !!st.shaft);
    else if (bug.tires?.type === 'tires' && bug.engine?.stats.kind === 'turbine' && !turbineComplete(bug)) {
      // The turbine line: High-Speed Shaft → gearbox → drive shaft.
      const line = turbineLine(bug, 0);
      if (!line.hss) add('drivetrain', 'a turbine needs a High-Speed Shaft on the turbine side', true, (st) => st.shaft === 'hss');
      else if (!line.gearbox) add('drivetrain', "there's no gearbox behind the turbine — she's just spinning the wheels", true, (st) => st.group === 'gearbox');
      else add('drivetrain', "nothing on the wheel side of the gearbox — the wheels aren't driven, she's on thrust alone", true, (st) => !!st.shaft);
    }
    if (bug.stranded) add('tires', "castors aren't driven — this motor needs proper tyres");
    else if (s.castor) add('castor', 'less rolling resistance means harder acceleration', false);
    else if (s.fDrive > s.fGrip * 1.05) add('tires', 'traction-limited — the motor out-muscles your tires');
    else if (s.fGrip > s.fDrive * 1.25) add('engine', 'power-limited — your tires can take more than the motor gives');
    // Thrust on castors: grip isn't what moves you, so more of it is no use.
    const gliding = s.castor && !bug.stranded;
    if (!s.castor && THRUST_DRIVES.includes(bug.engine?.stats.kind)) add('castor', 'a thrust drive accelerates hardest on castors', false);
    if (!bug.armor) add('armor', "you've got no armour — every hit goes straight to the hull");
    if (bug.weapons.length < bug.weaponSlots) add('weapon', `you've got ${bug.weaponSlots - bug.weapons.length} empty hardpoint${bug.weaponSlots - bug.weapons.length > 1 ? 's' : ''}`);
    if (s.cooling < 12) add('cooling', "your motor runs hot — you'll stall in long pushes");
    if (bug.coolers.length < BattleBug.COOLER_SLOTS && s.cooling < 16) add('cooling', 'more cooling means longer pushes', false);
    if (!bug.mods.length) add('enhancement', 'an enhancement would give you an edge', false);
    add('engine', gliding ? 'more thrust always helps' : 'more push always helps', false);
    if (!gliding) add('tires', 'more grip always helps', false);
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
    const out = { lines: [], pick: null, combos: [] };
    if (!bug) return out;
    const junk = bug.parts.find((p) => p.isScrap);
    if (junk) out.lines.push(`Your ${junk.name} is finished — strip it and sell it for scrap.`);
    const hurt = bug.parts.filter((p) => !p.isScrap && p.hpRatio < 0.5).sort((a, b) => a.hpRatio - b.hpRatio)[0];
    if (hurt) out.lines.push(`Fix your ${hurt.name} first — it's at ${Math.round(hurt.hpRatio * 100)}% and dragging everything down.`);
    // Combinations: the bad ones first — that's what a mechanic is for.
    const combos = bug.getStats().interactions.slice().sort((a, b) => a.good - b.good);
    out.combos = combos.map((c) => ({ good: c.good, text: c.text }));
    if (this.inField) {
      if (!hurt) out.lines.push("We're in the field — no upgrades now. Just keep her patched up.");
      return out;
    }

    // Only what your mechanic actually knows about.
    const needs = this.diagnose(bug)
      .filter((n) => this.mechanicKnows(n.type, bug))
      .map((n) => [n.type, n.reason, (st) => (!n.only || n.only(st)) && this.mechanicKnows(n.type, bug, st)]);

    // Stay within budget: the best part you could actually pay for (or already own).
    const budget = this.state.money;
    for (const [type, reason, only] of needs) {
      const key = this.optimalPart(bug, type, budget, { only });
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
    const price = roundTo(part.value * part.hpRatio * this.priceSwing('buy'), 5);
    this.state.market.parts.unshift({ id: makeId('mk'), part, price, managerFind: true });
    return true;
  }

  // ───────────── New game ─────────────
  /**
   * Size the starting cash for a fresh junkyard start: exactly enough to
   * repair the Scrapper, buy the cheapest motor on the Marketplace and
   * have a measly §3 left over (plus any champion's bonus) — so the quick
   * way up is playing for titles.
   */
  setupNewGame() {
    const s = this.state;
    this.generateChallengers();
    this.generateMarket();
    const engines = () => s.market.parts.filter((l) => l.part.type === 'engine');
    if (!engines().some((l) => l.part.key === 'rust_motor')) {
      const part = Part.create('rust_motor', rand(0.8, 1));
      s.market.parts.unshift({ id: makeId('mk'), part, price: roundTo(part.value * part.hpRatio * this.priceSwing('buy'), 5) });
    }
    // Cheapest motor to get running, counting what it'd cost to repair a used one.
    const motorCost = (l) => this.partPrice(l) + this.repairCost(l.part);
    const cheapestMotor = Math.min(...engines().map(motorCost));
    s.money = this.repairAllCost(s.activeBug) + cheapestMotor + ECONOMY.START_SPARE + (s.startBonus || 0);
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
  /** standoff: the Scarab Standoff (three on the donut; the prize if you're the last one standing). */
  settleMatch({ result, reason, challenger, opponentBug, playerBug, tournament, stake, bet, standoff = false, winner = null, weave = false }) {
    const s = this.state;
    const startMoney = s.money;
    const report = { result, reason, lines: [], bounty: 0, captured: null, lostVehicle: null, champion: false, arrest: false };
    // Beating an established rival (not the win that makes them one) earns a fresh excuse by DM.
    const beatRival = !tournament && result === 'win' && !!s.rivalId && challenger.id === s.rivalId;
    const rivalRideName = opponentBug?.name;
    // Clear fight-only state (ring-out fall, stalls, effects) so neither bug is drawn mid-plunge afterwards.
    for (const b of [playerBug, opponentBug]) b?.resetForBattle(b.pos, 0);

    if (result === 'win') s.record.wins++;
    else if (result === 'loss') s.record.losses++;
    else s.record.ties++;
    const streakBefore = s.record.streak || 0;
    if (result === 'win') s.record.streak = Math.max(0, s.record.streak || 0) + 1;
    if (result === 'loss') s.record.streak = Math.min(0, s.record.streak || 0) - 1;
    if (result === 'win' && s.record.streak === ECONOMY.STANDOFF_STREAK) {
      report.lines.push(`★ ${ECONOMY.STANDOFF_STREAK} wins in a row — the Scarab Standoff is open to you while the streak lasts (Tournaments tab).`);
    }
    if (result === 'win' && s.record.streak === ECONOMY.TOURNAMENT_STREAK && !s.tournament.entered) {
      report.lines.push(`★ ${ECONOMY.TOURNAMENT_STREAK} wins in a row — the Inter-Planetary Tournament is OPEN to you while the streak lasts!`);
    }
    if (streakBefore >= ECONOMY.STANDOFF_STREAK && s.record.streak < ECONOMY.STANDOFF_STREAK) {
      const both = streakBefore >= ECONOMY.TOURNAMENT_STREAK && !s.tournament.entered && !tournament;
      report.lines.push(`Your winning streak is over — the Scarab Standoff${both ? ' and the Tournament are' : ' is'} closed until you win ${ECONOMY.STANDOFF_STREAK} in a row again${both ? ` (${ECONOMY.TOURNAMENT_STREAK} for the Tournament)` : ''}.`);
    }

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

    if (weave) {
      const w = s.weave;
      if (result === 'win') {
        w.round += 1;
        if (w.round >= ECONOMY.WEAVE_ROUNDS) {
          s.earn(ECONOMY.WEAVE_PRIZE);
          report.bounty = ECONOMY.WEAVE_PRIZE;
          report.lines.push(`Weevil Weave champion! +${formatMoney(ECONOMY.WEAVE_PRIZE)}`);
          this.withdrawWeave();
        } else {
          report.lines.push(`Won round ${w.round} of the Weevil Weave — next up: ${w.field[w.round].name} (Tournaments tab).`);
        }
      } else if (result === 'loss') {
        report.lines.push(`Out of the Weevil Weave in round ${w.round + 1}.`);
        this.withdrawWeave();
      } else {
        report.lines.push('Nobody crossed the line — the round will be raced again.');
      }
    } else if (standoff) {
      if (result === 'win') {
        s.earn(ECONOMY.STANDOFF_PRIZE);
        report.bounty = ECONOMY.STANDOFF_PRIZE;
        report.lines.push(`Last bug standing in the Scarab Standoff: +${formatMoney(ECONOMY.STANDOFF_PRIZE)}`);
        if (!s.weave.open) {
          s.weave.open = true;
          report.lines.push('★ The Weevil Weave is now open to you — a three-round race on the Tournaments tab.');
        }
      } else if (result === 'loss') {
        report.lines.push(winner
          ? `Knocked out of the Scarab Standoff — ${winner} was the last bug standing. The entry fee is gone.`
          : 'Knocked out of the Scarab Standoff, and nobody was left standing. The entry fee is gone.');
      } else {
        report.lines.push('Nobody left standing — no prize this time.');
      }
    } else if (tournament) {
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
          this.withdrawTournament(report);
        } else {
          s.tournament.opponent = this.tournamentOpponentJSON(s.tournament.round);
          report.lines.push(`Advanced to tournament round ${s.tournament.round + 1} of ${ECONOMY.TOURNAMENT_ROUNDS}`);
        }
      } else if (result === 'loss') {
        s.tournament.eliminated = true;
        this.withdrawTournament(report);
        report.lines.push('Eliminated from the tournament. The Marketplace is open again — regroup and re-enter.');
      } else {
        report.lines.push('Draw — tournament rules: the round will be re-fought.');
      }
    } else if (stake?.type === 'titles') {
      if (result === 'win') {
        const lostName = opponentBug.name;
        capture();
        // They're back to the junkyard, like you once were.
        challenger.bug = this.junkBug(`Scrap ${pick(BUG_NOUNS)}`);
        this.refreshPilot(challenger);
        // The first alien you beat for their title never forgets it.
        if (this.setRival(challenger, lostName)) report.lines.push(`${challenger.name} took that loss personally…`);
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
        if (!s.vehicles.length) {
          report.lines.push('You have no vehicles left — find a replacement on the Marketplace.');
          s.comeback = true; // the next title offer will be snapped up
        }
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

    if (beatRival) this.rivalExcuse(challenger, rivalRideName);
    if (stake?.type === 'titles') this.salvageAfterTitle([playerBug, opponentBug], report);
    // Consumables (cryo blocks, nitro…) fitted to your bug lose a battle's worth.
    for (const p of playerBug?.parts || []) {
      if (p.usesLeft == null || p.usesLeft <= 0) continue;
      p.usesLeft -= 1;
      if (p.usesLeft === 0) report.lines.push(`Your ${p.name} is used up — strip it out and scrap it.`);
      else if (p.usesLeft <= 2) report.lines.push(`Your ${p.name} has ${p.usesLeft} battle${p.usesLeft > 1 ? 's' : ''} left in it.`);
    }
    if (!tournament && challenger.record && result !== 'tie') {
      if (result === 'win') challenger.record.l++; else challenger.record.w++;
    }
    if (!tournament && !standoff && !weave && result === 'win') {
      s.record.challengerWins++;
      if (s.record.challengerWins === ECONOMY.MECHANIC_SHOWS_AT_WINS) report.lines.push('A mechanic has heard about your wins and is looking for work — see the Admin tab.');
      if (s.record.challengerWins === ECONOMY.MANAGER_SHOWS_AT_WINS) report.lines.push('A manager wants to represent you — see the Admin tab.');
    }

    // An outstanding fine counts down before any new arrest is processed.
    if (s.fine) {
      s.fine.battlesLeft -= 1;
      if (s.fine.amount > 0) report.lines.push(`Fine outstanding: ${formatMoney(s.fine.amount)} — ${Math.max(0, s.fine.battlesLeft)} battle${s.fine.battlesLeft === 1 ? '' : 's'} left to pay.`);
    }
    this.settleManagerBet(bet, result, report, { tournament });

    // What this bout earned you: purse, prizes, wagers and the manager's bet (its stake went in before the fight).
    const earned = Math.max(0, s.money - startMoney - (bet && bet.fate !== 'refused' ? bet.stake : 0));
    s.earnAvg = Math.round(s.earnAvg + (earned - s.earnAvg) * ECONOMY.EARN_AVG);
    this.payStaff(report, earned);
    this.collectDebts(report);
    if (s.staff.mechanic) this.runMechanic(report);
    if (s.staff.manager) this.runManager(report);

    this.afterBout(challenger, tournament);
    // The mechanic's pick is judged on the bug you'll fight with next.
    const mechPick = s.staff.mechanic ? this.mechanicAdvice(s.activeBug).pick : null;
    this.generateMarket();
    // The part your mechanic wants: the usual hunt (better odds each bout), unless your manager just gets it.
    if (mechPick && s.staff.manager && !this.inField && !this.matchSource(mechPick.key) && this.huntForMatch(mechPick.key).found) {
      report.lines.push(`Manager: tracked down the ${PARTS[mechPick.key].name} your mechanic wanted — it's on the Marketplace.`);
    }
    // Twin drives out of step: your manager goes hunting for the parts to match them up
    // (and gets likelier to turn one up with every bout they keep looking).
    if (s.staff.manager && !this.inField && s.activeBug) {
      const keys = [...new Set(s.activeBug.unmatched({ cooling: true }).map((u) => u.part.key))].filter((k) => !this.matchSource(k));
      for (const k of keys) {
        const r = this.huntForMatch(k);
        if (r.found) report.lines.push(`Manager: found a ${PARTS[k].name} to match your other drive — it's on the Marketplace.`);
        else report.lines.push(`Manager: still hunting for a ${PARTS[k].name} to match your other drive (${Math.round(r.next * 100)}% next time).`);
      }
    }
    for (const k of Object.keys(s.managerHunt || {})) {
      if (k !== mechPick?.key && !s.activeBug?.unmatched({ cooling: true }).some((u) => u.part.key === k)) delete s.managerHunt[k];
    }
    this.ensureReplacementListing();
    // In the tournament your manager isn't out shopping: no finds, no deals, no whispers.
    if (s.staff.manager && !this.inField) {
      const deals = [...s.market.parts, ...s.market.vehicles].filter((l) => this.isRareDeal(l));
      if (deals.length) report.lines.push(`Manager: ${deals.length} rare deal${deals.length > 1 ? 's' : ''} flagged on the Marketplace`);
      const gems = [...s.market.vehicles.map((l) => l.bug), ...s.challengers.map((c) => c.bug)].filter((b) => this.hiddenGem(b));
      if (gems.length) report.lines.push(`Manager: I've heard whispers about something rare out there — ${gems.length === 1 ? 'one ride' : `${gems.length} rides`} worth a closer look.`);
    }

    // Your manager reckons you're ready for the big one (repeats every few bouts until you enter).
    if (this.tournamentReady && this.boutsPlayed >= (s.tournamentNudgeAt || 0)) {
      report.lines.push(`Manager: You're good enough for the Tournament now, and you can cover the ${formatMoney(ECONOMY.TOURNAMENT_FEE)} entry with change to spare. I'd enter.`);
      s.tournamentNudgeAt = this.boutsPlayed + ECONOMY.TOURNAMENT_NUDGE_EVERY;
    }

    report.gameOver = this.checkGameOver();
    // The whole end-of-battle report goes in the log (Admin tab).
    const who = tournament ? challenger.name : `${challenger.name || opponentBug.pilot?.name || 'a challenger'}`;
    s.addLog(`${result.toUpperCase()} vs ${who} (${opponentBug.name}) — ${reason}`, report.lines);
    return report;
  }

  /**
   * Wages after every bout (the mechanic's rate × your complete vehicles, the
   * manager's share of what the bout earned), then each checks their pay
   * against the going rate. A missed wage is owed until you pay it in the
   * Admin tab. Go STAFF_GRACE bouts in a row after that without paying and
   * they quit — four bouts' grace in all, counting the one you missed.
   * Wages missed in the meantime are added to what you owe.
   */
  payStaff(report, earned = 0) {
    const s = this.state;
    // In the tournament nobody takes their pay (or gripes about it) until it's over: it builds up.
    if (this.inField) {
      for (const role of ['mechanic', 'manager']) {
        if (!s.staff[role]) continue;
        const wage = this.wageDue(role, earned);
        if (wage > 0) s.pendingWages[role] = (s.pendingWages[role] || 0) + wage;
      }
      return;
    }
    for (const role of ['mechanic', 'manager']) {
      // Nobody's taking the job yet: one bout closer.
      if (!this.employed(role)) {
        const r = s.rehire[role];
        if (r?.wait > 0 && --r.wait === 0) report.lines.push(`Word's gone quiet — ${role === 'mechanic' ? 'mechanics' : 'managers'} are taking calls again (see the Admin tab).`);
        this.rollCandidate(role); // someone else turns up looking for the job
        continue;
      }
      if (!s.strike[role]) this.payWage(role, earned, report); // strikers don't get paid
      if (this.employed(role)) this.reviewPay(role, report);
    }
    // Your manager sets next bout's wages (override them in the Admin tab before the bout).
    this.managerSetsWages();
  }

  payWage(role, earned, report) {
    const s = this.state;
    const owed = s.arrears[role];
    if (owed && ++owed.bouts >= ECONOMY.STAFF_GRACE) {
      this.staffLeaves(role);
      report.lines.push(`Your ${role} quit — you never paid the ${formatMoney(owed.amount)} you owed.`);
      return;
    }
    const wage = this.wageDue(role, earned);
    if (wage <= 0) return;
    // A scatter-brained manager handling the wages forgets the mechanic every so often.
    const forgot = role === 'mechanic' && s.managerWages && s.staff.manager && this.person('manager')?.forgets && --s.forgetIn <= 0;
    if (forgot) {
      s.forgetIn = randInt(5, 8);
      if (owed) owed.amount += wage; else s.arrears[role] = { amount: wage, bouts: 0 };
      report.lines.push(`Your mechanic wasn't paid this bout (${formatMoney(wage)}) — it's owed in the Admin tab.`);
      return;
    }
    if (s.canAfford(wage)) {
      s.spend(wage);
      report.lines.push(role === 'manager'
        ? `Paid your manager ${formatMoney(wage)} (${Math.round(s.pay.manager * 100)}% of ${formatMoney(earned)})`
        : `Paid your mechanic ${formatMoney(wage)} (${formatMoney(s.pay.mechanic)} × ${this.completeVehicles} complete vehicle${this.completeVehicles === 1 ? '' : 's'})`);
    } else if (owed) {
      owed.amount += wage;
      const left = ECONOMY.STAFF_GRACE - owed.bouts;
      report.lines.push(`Missed your ${role}'s wage again — you now owe ${formatMoney(owed.amount)}. Pay it in the Admin tab within ${left} bout${left === 1 ? '' : 's'} or they'll quit.`);
    } else {
      s.arrears[role] = { amount: wage, bouts: 0 };
      report.lines.push(`Missed your ${role}'s wage (${formatMoney(wage)}). Pay it in the Admin tab within ${ECONOMY.STAFF_GRACE} bouts or they'll quit.`);
    }
  }

  /** Chance your mechanic can bring a completely wrecked (0%) part back: cheap, common parts are easiest. */
  salvageChance(part) {
    const byRarity = ECONOMY.SALVAGE_CHANCE[part.rarity] ?? 0.6;
    const pricey = Math.min(ECONOMY.SALVAGE_COST_MAX, Math.max(0, (part.value - 500) / 500) * ECONOMY.SALVAGE_COST_STEP);
    return Math.max(ECONOMY.SALVAGE_MIN, byRarity - pricey);
  }

  /**
   * After a title fight (to the death), a mechanic has a go at every part of
   * yours that was wrecked to 0%. Salvaged parts come back at a sliver of HP,
   * repairable; the rest are scrap.
   */
  salvageAfterTitle(bugs, report) {
    const s = this.state;
    if (!s.staff.mechanic) return;
    for (const bug of bugs) {
      if (!bug || !s.getVehicle(bug.id)) continue;
      for (const p of bug.parts) {
        if (p.hp > 0 || p.spent) continue;
        if (chance(this.salvageChance(p))) {
          p.hp = Math.max(1, p.maxHp * 0.01);
          p.failed = true; // still not working until it's repaired
          report.lines.push(`Mechanic: salvaged the wrecked ${p.name} on ${bug.name} — it can be repaired.`);
        } else {
          report.lines.push(`Mechanic: the ${p.name} on ${bug.name} is beyond saving — scrap only.`);
        }
      }
    }
  }

  runMechanic(report) {
    const bug = this.state.activeBug;
    if (!bug) return;
    const before = this.state.money;
    const hp = this.repairAll(bug);
    if (hp > 0) report.lines.push(`Mechanic patched up ${bug.name} (now ${Math.round(bug.condition * 100)}% condition) for ${formatMoney(before - this.state.money)}`);
    else if (this.repairAllCost(bug) > 0) report.lines.push('Mechanic: not enough funds for repairs.');
  }

  runManager(report) {
    if (this.inField) return;
    const scrap = this.state.inventory.filter((p) => p.isScrap);
    if (!scrap.length) return;
    let total = 0;
    for (const p of scrap) total += this.sellPart(p.uid);
    report.lines.push(`Manager sold ${scrap.length} scrap part${scrap.length > 1 ? 's' : ''} for ${formatMoney(total)}`);
  }
}
