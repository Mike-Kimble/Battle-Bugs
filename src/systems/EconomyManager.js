import { ECONOMY } from '../config/constants.js';
import {
  PARTS, PART_KEYS_BY_TYPE, STARTER_BUG, ALIEN_SYLLABLES, PLANETS, BUG_ADJECTIVES, BUG_NOUNS,
} from '../config/partsData.js';
import { BattleBug } from '../entities/BattleBug.js';
import { Part, makeId } from '../entities/Part.js';

// ───────────── RNG helpers ─────────────
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
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
  return `$${Math.round(n).toLocaleString('en-AU')} ${ECONOMY.CURRENCY}`;
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

  repairCostPerHp(part) {
    return (part.value / part.maxHp) * ECONOMY.REPAIR_RATE;
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
  buyPartListing(listingId) {
    const i = this.state.market.parts.findIndex((l) => l.id === listingId);
    if (i < 0) throw new Error('Listing gone');
    const listing = this.state.market.parts[i];
    this.state.spend(listing.price);
    this.state.market.parts.splice(i, 1);
    this.state.addPart(listing.part);
    return listing.part;
  }

  buyVehicleListing(listingId) {
    const i = this.state.market.vehicles.findIndex((l) => l.id === listingId);
    if (i < 0) throw new Error('Listing gone');
    const listing = this.state.market.vehicles[i];
    this.state.spend(listing.price);
    this.state.market.vehicles.splice(i, 1);
    this.state.addVehicle(listing.bug);
    return listing.bug;
  }

  sellPart(partUid) {
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
  hire(role) {
    if (this.state.staff[role]) return;
    const fee = role === 'mechanic' ? ECONOMY.MECHANIC_HIRE : ECONOMY.MANAGER_HIRE;
    this.state.spend(fee);
    this.state.staff[role] = true;
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

  makeChallenger(tier, opts = {}) {
    const bug = this.generateBug(tier, opts);
    const bounty = roundTo(ECONOMY.BOUNTY_BASE + tier * ECONOMY.BOUNTY_PER_TIER + rand(0, 80), 5);
    return {
      id: makeId('ch'),
      tier,
      bounty,
      difficulty: Math.min(1, 0.2 + tier * 0.15 + rand(-0.05, 0.05)),
      bug,
    };
  }

  generateChallengers() {
    const n = randInt(ECONOMY.CHALLENGER_MIN, ECONOMY.CHALLENGER_MAX);
    const base = this.baseTier;
    const board = [];
    for (let i = 0; i < n; i++) {
      const tier = i === 0 ? Math.max(1, base - 1) : clampTier(base + randInt(-1, 1));
      board.push(this.makeChallenger(tier));
    }
    board.sort((a, b) => a.tier - b.tier || a.bounty - b.bounty);
    this.state.challengers = board;
  }

  generateMarket() {
    const tierCap = clampTier(this.baseTier + 1);
    const parts = [];
    const types = ['engine', 'tires', 'armor', 'weapon', 'weapon', 'engine', 'tires', 'armor'];
    for (let i = 0; i < ECONOMY.MARKET_PARTS; i++) {
      const type = types[i % types.length];
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
      vehicles.push({ id: makeId('mk'), bug, price: roundTo(this.vehicleValue(bug) * markup, 5) });
    }
    this.state.market = { parts, vehicles };
  }

  // ───────────── Tournament ─────────────
  get tournamentUnlocked() {
    return this.state.record.challengerWins >= ECONOMY.TOURNAMENT_UNLOCK_WINS;
  }

  enterTournament() {
    const bug = this.state.activeBug;
    if (!this.tournamentUnlocked) throw new Error(`Win ${ECONOMY.TOURNAMENT_UNLOCK_WINS} challenger bouts to unlock`);
    if (!bug?.isBattleReady) throw new Error('Your active vehicle is not battle-ready');
    Object.assign(this.state.tournament, { entered: true, vehicleId: bug.id, round: 0, eliminated: false });
    this.state.tournament.opponent = this.tournamentOpponentJSON(0);
    this.state.addLog(`Entered the Inter-Planetary Tournament with ${bug.name}`);
  }

  withdrawTournament() {
    Object.assign(this.state.tournament, { entered: false, vehicleId: null, round: 0, opponent: null });
  }

  tournamentOpponentJSON(round) {
    const tier = clampTier(4 + round);
    const c = this.makeChallenger(tier, { condition: () => 1, fullSlots: true });
    c.difficulty = Math.min(1, 0.75 + round * 0.12);
    c.bounty = roundTo(600 + round * 500, 50);
    c.roundName = ['Quarter-Final', 'Semi-Final', 'Grand Final'][round] || `Round ${round + 1}`;
    return { ...c, bug: c.bug.toJSON() };
  }

  get tournamentOpponent() {
    const o = this.state.tournament.opponent;
    return o ? { ...o, bug: BattleBug.fromJSON(o.bug) } : null;
  }

  // ───────────── Soft-lock guard ─────────────
  get needsJunkyard() {
    return !this.state.vehicles.some((v) => v.isBattleReady) && this.state.money < ECONOMY.JUNKYARD_THRESHOLD;
  }

  claimJunkyardScrapper() {
    if (!this.needsJunkyard) throw new Error('The junkyard only helps the truly desperate');
    const bug = BattleBug.create({ ...STARTER_BUG, name: 'Junkyard Scrapper', armor: null, condition: () => rand(0.6, 0.8) });
    this.state.addVehicle(bug);
    if (!this.state.tournament.entered) this.state.activeVehicleId = bug.id;
    return bug;
  }

  // ───────────── Match settlement ─────────────
  /**
   * Apply the outcome of a bout.
   * @param {{result:'win'|'loss'|'tie', reason:string, challenger:object, opponentBug:BattleBug, tournament:boolean}} m
   */
  settleMatch({ result, reason, challenger, opponentBug, tournament }) {
    const s = this.state;
    const report = { result, reason, lines: [], bounty: 0, captured: null, champion: false };

    if (result === 'win') {
      s.record.wins++;
      report.bounty = challenger.bounty;
      s.earn(challenger.bounty);
      report.lines.push(`Bounty claimed: ${formatMoney(challenger.bounty)}`);

      opponentBug.pilot = null;
      opponentBug.resetForBattle(opponentBug.pos, 0);
      s.addVehicle(opponentBug);
      report.captured = opponentBug;
      report.lines.push(`Captured vehicle: ${opponentBug.name} (${Math.round(opponentBug.condition * 100)}% condition)`);

      if (tournament) {
        s.tournament.round++;
        if (s.tournament.round >= ECONOMY.TOURNAMENT_ROUNDS) {
          s.earn(ECONOMY.TOURNAMENT_PRIZE);
          report.lines.push(`Tournament prize: ${formatMoney(ECONOMY.TOURNAMENT_PRIZE)}`);
          report.champion = true;
          s.gameComplete = true;
          s.tournament.champion = true;
          this.withdrawTournament();
        } else {
          s.tournament.opponent = this.tournamentOpponentJSON(s.tournament.round);
          report.lines.push(`Advanced to tournament round ${s.tournament.round + 1} of ${ECONOMY.TOURNAMENT_ROUNDS}`);
        }
      } else {
        s.record.challengerWins++;
        if (s.record.challengerWins === ECONOMY.TOURNAMENT_UNLOCK_WINS) {
          report.lines.push('★ The Inter-Planetary Tournament is now OPEN to you!');
        }
      }
    } else if (result === 'loss') {
      s.record.losses++;
      report.lines.push(`No purse. You keep your battered vehicle.`);
      if (tournament) {
        s.tournament.eliminated = true;
        this.withdrawTournament();
        report.lines.push('Eliminated from the tournament. Upgrades unlocked — regroup and re-enter.');
      }
    } else {
      s.record.ties++;
      report.lines.push('Draw — neither vehicle is awarded.');
      if (tournament) report.lines.push('Tournament rules: the round will be re-fought.');
    }

    this.payStaff(report);
    if (s.staff.mechanic) this.runMechanic(report);
    if (s.staff.manager) this.runManager(report);

    this.generateChallengers();
    this.generateMarket();
    if (s.staff.manager) {
      const deals = [...s.market.parts, ...s.market.vehicles].filter((l) => this.isRareDeal(l));
      if (deals.length) report.lines.push(`Manager: ${deals.length} rare deal${deals.length > 1 ? 's' : ''} flagged on the Marketplace`);
    }

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
    const scrap = this.state.inventory.filter((p) => p.isBroken);
    if (!scrap.length) return;
    let total = 0;
    for (const p of scrap) total += this.sellPart(p.uid);
    report.lines.push(`Manager sold ${scrap.length} scrap part${scrap.length > 1 ? 's' : ''} for ${formatMoney(total)}`);
  }
}
