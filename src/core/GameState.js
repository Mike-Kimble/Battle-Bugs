import { ECONOMY, EVENTS, SAVE_KEY } from '../config/constants.js';
import { STARTER_BUG, FIGHTING_STYLES, currentKey } from '../config/partsData.js';
import { DEFAULT_STAFF } from '../config/staff.js';
import { EventEmitter } from './EventEmitter.js';
import { Storage } from './Storage.js';
import { BattleBug } from '../entities/BattleBug.js';
import { Part } from '../entities/Part.js';

const SAVE_VERSION = 2; // v2: the fixed 20-pilot roster

/**
 * Persistent campaign state: money, garage, inventory, boards, staff and tournament.
 * Holds live entity instances; serialises them on save.
 */
export class GameState extends EventEmitter {
  constructor() {
    super();
    this.money = 0;
    this.fresh = false;     // set on a new game until the economy sizes the starting cash
    this.startBonus = 0;    // extra starting cash (a champion's prize)
    this.vehicles = [];
    this.activeVehicleId = null;
    this.inventory = [];
    this.record = { wins: 0, losses: 0, ties: 0, challengerWins: 0, streak: 0 };
    this.pool = [];         // every challenger pilot, persistent and progressing
    this.challengers = [];  // the ones on the board right now (same objects as in the pool)
    // Walk-offs wait in `rejected` until you next fight; tierShift scrolls the board up in difficulty.
    this.board = { rejected: [], rejections: 0, tierShift: 0 };
    this.market = { parts: [], vehicles: [] };
    this.staff = { mechanic: false, manager: false };
    this.tournament = { entered: false, vehicleId: null, round: 0, eliminated: false, champion: false };
    this.gameComplete = false;
    this.gameOver = null;
    this.season = 1;
    this.titles = 0; // championships won in earlier seasons
    this.managerBetPct = 0;
    this.fixStreak = 0;
    this.winBetStreak = 0; // wins in a row with the manager betting on you to win
    this.comeback = false;
    this.rivalExcuses = 0;
    this.sellQuotes = {}; // buyers' offers per item id, fixed until the next restock // how many excuses your rival has DM'd you (they never repeat until they run out) // lost your only ride: the next title offer is always accepted
    this.pendingDM = null; // { pilotId, lines } — a DM waiting for you back in the workshop
    this.discovered = new Set(); // every part key you've ever owned — the Codex, kept across seasons
    this.fine = null; // { amount, battlesLeft }
    this.rivalId = null; // the first alien you beat in a title match: they follow you to the Grand Final
    this.arrears = {};
    // Staff pay: the mechanic's rate per complete vehicle (§), the manager's share of your earnings (0–1).
    this.pay = { mechanic: null, manager: null };
    this.strike = {}; // role → true while they're on strike (on the books, not working)
    this.mood = {}; // role → { stage: 0 content | 1 complaining | 2 on strike, ask, bouts }
    this.rehire = {}; // role → { wait, ask }: bouts until anyone will take the job, and the wage they'll want
    this.earnAvg = 0; // your average earnings per bout (what staff measure their pay against)
    this.staffId = {}; // role → who you've hired (a STAFF_ROSTER key)
    this.candidate = {}; // role → who's applying for the job right now
    this.pendingWages = {}; // role → wages built up during the tournament, paid when it's over
    this.managerWages = false; // your manager sets the wages after each bout
    this.forgetIn = 0; // bouts until a scatter-brained manager next forgets the mechanic's wage
    this.managerHunt = {}; // part key → the manager's chance of finding one to match your other drive next time
    this.blacklist = 0; // bouts left that nobody will work for you (you stiffed your staff)
    this.collectors = []; // [{ role, owed, taken }] ex-staff helping themselves to your parts // { mechanic|manager: { amount, bouts } } — a missed wage, to pay in the Admin tab
    this.roamerId = null; // the homeless pilot (the rookie, unless they became your rival)
    this.elitesOut = false; // the tournament pilots have joined the board (after the first 5★ regular)
    this.rivalNextAt = 0; // bout count at which the rival next turns up on the board
    this.compareRef = null; // { id, refId }: captured vehicle vs the vehicle that won it (session only)
    this.log = [];
    this.newVehicleIds = new Set(); // captured this session, flagged NEW until put on the hoist
  }

  /**
   * A fresh game. A champion can start a new season from scratch, carrying
   * the grand prize as extra starting money.
   */
  static newGame({ bonus = 0, season = 1, titles = 0, discovered = [] } = {}) {
    const state = new GameState();
    state.fresh = true;
    state.startBonus = bonus;
    state.season = season;
    state.titles = titles;
    const [lo, hi] = ECONOMY.JUNK_CONDITION;
    const starter = BattleBug.create({ ...STARTER_BUG, condition: () => lo + Math.random() * (hi - lo) });
    state.discovered = new Set(discovered);
    state.addVehicle(starter);
    return state;
  }

  static load() {
    const data = Storage.load(SAVE_KEY);
    if (!data || data.version !== SAVE_VERSION) return null;
    try {
      return GameState.fromJSON(data);
    } catch (err) {
      console.warn('[GameState] corrupt save, starting fresh', err);
      return null;
    }
  }

  static fromJSON(d) {
    const s = new GameState();
    s.money = d.money;
    s.vehicles = d.vehicles.map(BattleBug.fromJSON);
    s.activeVehicleId = d.activeVehicleId;
    s.inventory = d.inventory.map(Part.fromJSON);
    s.record = { ...s.record, ...d.record };
    const hydrate = (c) => ({ ...c, bug: BattleBug.fromJSON(c.bug) });
    if (d.pool) {
      s.pool = d.pool.map(hydrate);
      const byId = new Map(s.pool.map((p) => [p.id, p]));
      s.challengers = (d.challengerIds || []).map((id) => byId.get(id)).filter(Boolean);
      s.board = { ...s.board, ...d.board, rejected: (d.board?.rejectedIds || []).map((id) => byId.get(id)).filter(Boolean) };
      delete s.board.rejectedIds;
    } else {
      // Older saves: the board and walk-offs become the start of the pool.
      s.challengers = (d.challengers || []).map(hydrate);
      s.board = { ...s.board, ...d.board, rejected: (d.board?.rejected || []).map(hydrate) };
      s.pool = [...s.challengers, ...s.board.rejected];
    }
    for (const p of s.pool) GameState.upgradeLegacyPilot(p);
    s.market = {
      parts: (d.market?.parts || []).map((l) => ({ ...l, part: Part.fromJSON(l.part) })),
      vehicles: (d.market?.vehicles || []).map((l) => ({ ...l, bug: BattleBug.fromJSON(l.bug) })),
    };
    s.staff = { ...s.staff, ...d.staff };
    s.tournament = { ...s.tournament, ...d.tournament };
    s.gameComplete = !!d.gameComplete;
    s.gameOver = d.gameOver || null;
    s.season = d.season || 1;
    s.fresh = !!d.fresh;
    s.startBonus = d.startBonus || 0;
    s.titles = d.titles || 0;
    s.managerBetPct = d.managerBetPct ?? (s.staff.manager ? 0.1 : 0);
    s.fixStreak = d.fixStreak || 0;
    s.winBetStreak = d.winBetStreak || 0;
    s.comeback = !!d.comeback;
    s.rivalExcuses = d.rivalExcuses || 0;
    s.sellQuotes = d.sellQuotes || {};
    s.tournamentNudgeAt = d.tournamentNudgeAt || 0;
    s.pendingDM = d.pendingDM || null;
    s.discovered = new Set((d.discovered || []).map(currentKey));
    for (const v of s.vehicles) s.discover(v.parts);
    s.discover(s.inventory);
    s.fine = d.fine || null;
    s.rivalId = d.rivalId || null;
    s.rivalNextAt = d.rivalNextAt || 0;
    s.elitesOut = !!d.elitesOut;
    s.roamerId = d.roamerId || null;
    s.arrears = d.arrears || {};
    s.pay = { mechanic: null, manager: null, ...d.pay };
    // Saves from before wages were set in the office: they're on the going rate.
    if (s.staff.mechanic && s.pay.mechanic == null) s.pay.mechanic = ECONOMY.MECHANIC_WAGE;
    if (s.staff.manager && s.pay.manager == null) s.pay.manager = ECONOMY.MANAGER_PCT;
    s.strike = d.strike || {};
    s.mood = d.mood || {};
    s.rehire = d.rehire || {};
    s.earnAvg = d.earnAvg || 0;
    s.staffId = d.staffId || {};
    // Saves from before staff had names: they turn out to be the ones who do it straight.
    for (const role of ['mechanic', 'manager']) {
      if ((s.staff[role] || s.strike[role]) && !s.staffId[role]) s.staffId[role] = DEFAULT_STAFF[role];
    }
    s.candidate = d.candidate || {};
    s.managerWages = !!d.managerWages;
    s.pendingWages = d.pendingWages || {};
    s.forgetIn = d.forgetIn || 0;
    s.managerHunt = d.managerHunt || {};
    s.blacklist = d.blacklist || 0;
    s.collectors = d.collectors || [];
    s.log = d.log || [];
    return s;
  }

  toJSON() {
    return {
      version: SAVE_VERSION,
      money: this.money,
      vehicles: this.vehicles.map((v) => v.toJSON()),
      activeVehicleId: this.activeVehicleId,
      inventory: this.inventory.map((p) => p.toJSON()),
      record: this.record,
      pool: this.pool.map((p) => ({ ...p, bug: p.bug.toJSON() })),
      challengerIds: this.challengers.map((c) => c.id),
      board: { rejections: this.board.rejections, tierShift: this.board.tierShift, rejectedIds: this.board.rejected.map((c) => c.id) },
      market: {
        parts: this.market.parts.map((l) => ({ ...l, part: l.part.toJSON() })),
        vehicles: this.market.vehicles.map((l) => ({ ...l, bug: l.bug.toJSON() })),
      },
      staff: this.staff,
      tournament: this.tournament,
      gameComplete: this.gameComplete,
      gameOver: this.gameOver,
      season: this.season,
      fresh: this.fresh,
      startBonus: this.startBonus,
      titles: this.titles,
      managerBetPct: this.managerBetPct,
      fixStreak: this.fixStreak,
      winBetStreak: this.winBetStreak,
      comeback: this.comeback,
      rivalExcuses: this.rivalExcuses,
      sellQuotes: this.sellQuotes,
      tournamentNudgeAt: this.tournamentNudgeAt || 0,
      pendingDM: this.pendingDM,
      discovered: [...this.discovered],
      fine: this.fine,
      rivalId: this.rivalId,
      rivalNextAt: this.rivalNextAt,
      elitesOut: this.elitesOut,
      roamerId: this.roamerId,
      arrears: this.arrears,
      pay: this.pay,
      strike: this.strike,
      mood: this.mood,
      rehire: this.rehire,
      earnAvg: this.earnAvg,
      staffId: this.staffId,
      candidate: this.candidate,
      managerWages: this.managerWages,
      pendingWages: this.pendingWages,
      forgetIn: this.forgetIn,
      managerHunt: this.managerHunt,
      blacklist: this.blacklist,
      collectors: this.collectors,
      log: this.log.slice(-60),
    };
  }

  /** Give pre-pool challengers a name, style, backstory, skill, purse and record. */
  static upgradeLegacyPilot(p) {
    p.name ||= p.bug.pilot?.name || 'Nameless';
    p.planet ||= p.bug.pilot?.planet || 'parts unknown';
    p.style ||= p.rookie ? 'hapless' : FIGHTING_STYLES[Math.floor(Math.random() * FIGHTING_STYLES.length)];
    p.story ||= '';
    p.skill ??= p.difficulty ?? 0.3;
    p.purse ??= (p.bounty || 200) * 2;
    p.record ||= { w: 0, l: 0 };
  }

  save() {
    Storage.save(SAVE_KEY, this.toJSON());
  }

  static wipe() {
    Storage.clear(SAVE_KEY);
  }

  /** Notify listeners and persist. Call after every mutation batch. */
  commit() {
    this.save();
    this.emit(EVENTS.STATE_CHANGE, this);
  }

  /** A log entry, optionally with the details (e.g. an end-of-battle report). */
  addLog(msg, lines = []) {
    this.log.push({ t: Date.now(), msg, lines: lines.slice() });
  }

  // ───────────── Vehicles ─────────────
  get activeBug() {
    return this.vehicles.find((v) => v.id === this.activeVehicleId) || this.vehicles[0] || null;
  }

  getVehicle(id) {
    return this.vehicles.find((v) => v.id === id) || null;
  }

  /** Log parts in the Codex. */
  discover(parts) {
    for (const p of parts) if (p) this.discovered.add(p.key);
  }

  addVehicle(bug) {
    this.discover(bug.parts);
    this.vehicles.push(bug);
    if (!this.activeVehicleId) this.activeVehicleId = bug.id;
  }

  removeVehicle(id) {
    const i = this.vehicles.findIndex((v) => v.id === id);
    if (i < 0) return null;
    const [bug] = this.vehicles.splice(i, 1);
    if (this.activeVehicleId === id) this.activeVehicleId = this.vehicles[0]?.id ?? null;
    return bug;
  }

  setActive(id) {
    if (this.tournament.entered) throw new Error('Vehicle is locked in for the tournament');
    if (!this.getVehicle(id)) throw new Error('No such vehicle');
    this.activeVehicleId = id;
  }

  /** Tournament entry locks upgrades & part swaps on the entered vehicle. */
  isLocked(bug) {
    return !!bug && this.tournament.entered && this.tournament.vehicleId === bug.id;
  }

  // ───────────── Inventory ─────────────
  addPart(part) {
    this.discover([part]);
    this.inventory.push(part);
  }

  removePart(uid) {
    const i = this.inventory.findIndex((p) => p.uid === uid);
    return i >= 0 ? this.inventory.splice(i, 1)[0] : null;
  }

  getPart(uid) {
    return this.inventory.find((p) => p.uid === uid) || null;
  }

  // ───────────── Money ─────────────
  canAfford(amount) {
    return this.money >= amount;
  }

  spend(amount) {
    if (amount > this.money) throw new Error('Insufficient funds');
    this.money -= Math.round(amount);
  }

  earn(amount) {
    this.money += Math.round(amount);
  }
}
