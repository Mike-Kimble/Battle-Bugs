import { ECONOMY, EVENTS, SAVE_KEY } from '../config/constants.js';
import { STARTER_BUG } from '../config/partsData.js';
import { EventEmitter } from './EventEmitter.js';
import { Storage } from './Storage.js';
import { BattleBug } from '../entities/BattleBug.js';
import { Part } from '../entities/Part.js';

const SAVE_VERSION = 1;

/**
 * Persistent campaign state: money, hangar, inventory, boards, staff and tournament.
 * Holds live entity instances; serialises them on save.
 */
export class GameState extends EventEmitter {
  constructor() {
    super();
    this.money = ECONOMY.START_MONEY;
    this.vehicles = [];
    this.activeVehicleId = null;
    this.inventory = [];
    this.record = { wins: 0, losses: 0, ties: 0, challengerWins: 0, streak: 0 };
    this.challengers = [];
    // Walk-offs wait in `rejected` until you next fight; tierShift scrolls the board up in difficulty.
    this.board = { rejected: [], rejections: 0, tierShift: 0 };
    this.market = { parts: [], vehicles: [] };
    this.staff = { mechanic: false, manager: false };
    this.tournament = { entered: false, vehicleId: null, round: 0, eliminated: false, champion: false };
    this.gameComplete = false;
    this.gameOver = null;
    this.managerBetPct = 0;
    this.fixStreak = 0;
    this.fine = null; // { amount, battlesLeft }
    this.compareRef = null; // { id, refId }: captured vehicle vs the vehicle that won it (session only)
    this.log = [];
    this.newVehicleIds = new Set(); // captured this session, flagged NEW until put on the hoist
  }

  static newGame() {
    const state = new GameState();
    const starter = BattleBug.create({ ...STARTER_BUG });
    state.vehicles.push(starter);
    state.activeVehicleId = starter.id;
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
    s.challengers = (d.challengers || []).map(hydrate);
    s.board = { ...s.board, ...d.board, rejected: (d.board?.rejected || []).map(hydrate) };
    s.market = {
      parts: (d.market?.parts || []).map((l) => ({ ...l, part: Part.fromJSON(l.part) })),
      vehicles: (d.market?.vehicles || []).map((l) => ({ ...l, bug: BattleBug.fromJSON(l.bug) })),
    };
    s.staff = { ...s.staff, ...d.staff };
    s.tournament = { ...s.tournament, ...d.tournament };
    s.gameComplete = !!d.gameComplete;
    s.gameOver = d.gameOver || null;
    s.managerBetPct = d.managerBetPct ?? (s.staff.manager ? 0.1 : 0);
    s.fixStreak = d.fixStreak || 0;
    s.fine = d.fine || null;
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
      challengers: this.challengers.map((c) => ({ ...c, bug: c.bug.toJSON() })),
      board: { ...this.board, rejected: this.board.rejected.map((c) => ({ ...c, bug: c.bug.toJSON() })) },
      market: {
        parts: this.market.parts.map((l) => ({ ...l, part: l.part.toJSON() })),
        vehicles: this.market.vehicles.map((l) => ({ ...l, bug: l.bug.toJSON() })),
      },
      staff: this.staff,
      tournament: this.tournament,
      gameComplete: this.gameComplete,
      gameOver: this.gameOver,
      managerBetPct: this.managerBetPct,
      fixStreak: this.fixStreak,
      fine: this.fine,
      log: this.log.slice(-40),
    };
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

  addLog(msg) {
    this.log.push({ t: Date.now(), msg });
  }

  // ───────────── Vehicles ─────────────
  get activeBug() {
    return this.vehicles.find((v) => v.id === this.activeVehicleId) || this.vehicles[0] || null;
  }

  getVehicle(id) {
    return this.vehicles.find((v) => v.id === id) || null;
  }

  addVehicle(bug) {
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
