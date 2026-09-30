import { PHYSICS, ACTIONS } from '../config/constants.js';
import { Part, makeId } from './Part.js';
import { THRUST_DRIVES } from '../config/partsData.js';
import { PhysicsEngine } from '../physics/PhysicsEngine.js';
import { Vector2D, clamp } from '../physics/Vector2D.js';

const EMPTY_EFFECTS = () => ({ lifted: 0, liftGrip: 0.1, exposed: 0, spikes: 0, spikeTick: 0, flash: 0 });

/**
 * A vehicle: a chassis plus equipped parts, with runtime battle state.
 * Hull HP is the chassis HP — reaching 0 is catastrophic damage.
 */
export class BattleBug {
  static COOLER_SLOTS = 3; // e.g. jacket + liquid cooler + fan
  static MOD_SLOTS = 1;

  constructor({ id, name, hue = 30, alien = false, pilot = null, chassis, engine = null, engine2 = null, tires = null, armor = null, weapons = [], coolers = [], mods = [] }) {
    if (!chassis) throw new Error('BattleBug requires a chassis');
    this.id = id || makeId('bug');
    this.name = name || 'Unnamed Bug';
    this.hue = hue;
    this.alien = alien;
    this.pilot = pilot; // { name, planet } for alien challengers
    this.chassis = chassis;
    // Drive bays: one, or two on the bigger shells (left and right; same motor type).
    this.drives = [engine, engine2].filter(Boolean).slice(0, this.driveSlots);
    this.tires = tires;
    this.armor = armor;
    this.weapons = weapons.slice(0, chassis.stats.weaponSlots);
    this.coolers = coolers.filter(Boolean).slice(0, BattleBug.COOLER_SLOTS * this.driveSlots); // cooling add-ons
    this.mods = mods.filter(Boolean).slice(0, BattleBug.MOD_SLOTS * this.driveSlots); // performance enhancements
    this.resetForBattle(new Vector2D(), 0);
  }

  /** Build from catalogue keys. `condition` may be a number or a () => number. */
  static create({ name, hue, alien, pilot, chassis, engine, engine2, tires, armor, weapons = [], coolers = [], mods = [], condition = 1 }) {
    const cond = typeof condition === 'function' ? condition : () => condition;
    const mk = (key) => (key ? Part.create(key, cond()) : null);
    return new BattleBug({
      name, hue, alien, pilot,
      chassis: mk(chassis),
      engine: mk(engine),
      engine2: mk(engine2),
      tires: mk(tires),
      armor: mk(armor),
      weapons: weapons.map(mk),
      coolers: coolers.map(mk),
      mods: mods.map(mk),
    });
  }

  static fromJSON(o) {
    const p = (x) => (x ? Part.fromJSON(x) : null);
    return new BattleBug({
      id: o.id, name: o.name, hue: o.hue, alien: o.alien, pilot: o.pilot,
      chassis: p(o.chassis), engine: p(o.engine), engine2: p(o.engine2), tires: p(o.tires), armor: p(o.armor),
      weapons: (o.weapons || []).map(p),
      coolers: (o.coolers || []).map(p),
      mods: (o.mods || []).map(p),
    });
  }

  toJSON() {
    return {
      id: this.id, name: this.name, hue: this.hue, alien: this.alien, pilot: this.pilot,
      chassis: this.chassis.toJSON(),
      engine: this.engine?.toJSON() ?? null,
      engine2: this.drives[1]?.toJSON() ?? null,
      tires: this.tires?.toJSON() ?? null,
      armor: this.armor?.toJSON() ?? null,
      weapons: this.weapons.map((w) => w.toJSON()),
      coolers: this.coolers.map((c) => c.toJSON()),
      mods: this.mods.map((m) => m.toJSON()),
    };
  }

  // ───────────── Composition ─────────────
  get parts() {
    return [this.chassis, ...this.drives, this.tires, this.armor, ...this.weapons, ...this.coolers, ...this.mods].filter(Boolean);
  }
  /** The (first) drive motor. */
  get engine() { return this.drives[0] || null; }
  set engine(part) { if (part) this.drives[0] = part; else this.drives.shift(); }
  /** Drive bays on this frame: 1, or 2 on the bigger shells. */
  get driveSlots() { return this.chassis.stats.drives || 1; }
  /** Two working drives: it can spin on the spot. */
  get twinDrive() { return this.drives.length === 2 && this.drives.every((d) => !d.isBroken); }
  get hull() { return this.chassis; }
  /** World/collision radius. The catalogue radius is the sprite design size. */
  get radius() { return this.chassis.stats.radius * PHYSICS.BUG_SCALE; }
  get designRadius() { return this.chassis.stats.radius; }
  get weaponSlots() { return this.chassis.stats.weaponSlots; }

  /** Multi-slot part types: the fitted list and how many fit. */
  slotList(type) {
    if (type === 'engine') return this.driveSlots > 1 ? this.drives : null;
    return type === 'weapon' ? this.weapons : type === 'cooling' ? this.coolers : type === 'enhancement' ? this.mods : null;
  }

  slotCapacity(type) {
    if (type === 'engine') return this.driveSlots;
    return type === 'weapon' ? this.weaponSlots
      // Cooling and enhancements mount on a drive: slots for each one fitted.
      : type === 'cooling' ? BattleBug.COOLER_SLOTS * this.drives.length
        : type === 'enhancement' ? BattleBug.MOD_SLOTS * this.drives.length : 1;
  }

  /** The part in a single slot of this type (castors and tyres share the running gear). */
  slotPart(type) {
    return type === 'castor' || type === 'tires' ? this.tires : type === 'engine' ? this.engine : this[type] ?? null;
  }

  /** Twin drives must be the same motor type: can `part` go in drive bay `slot`? */
  driveFits(part, slot) {
    if (part.type !== 'engine' || this.driveSlots < 2) return true;
    const i = slot ?? (this.drives.length < 2 ? this.drives.length : 1);
    const other = this.drives[1 - i];
    return !other || other.stats.kind === part.stats.kind;
  }
  get mass() { return this.parts.reduce((s, p) => s + p.mass, 0); }

  getStats(mods) {
    return PhysicsEngine.deriveStats(this, mods);
  }

  /** HP-weighted condition across all parts, 0–1. */
  get condition() {
    let hp = 0;
    let max = 0;
    for (const p of this.parts) { hp += p.hp; max += p.maxHp; }
    return max ? hp / max : 0;
  }

  /** Running on castors with a drive that can't push them. */
  get stranded() {
    return this.tires?.type === 'castor' && !!this.engine && !THRUST_DRIVES.includes(this.engine.stats.kind);
  }

  get isBattleReady() {
    return !!this.engine && !!this.tires && !this.stranded && !this.parts.some((p) => p.isScrap)
      && !this.chassis.isBroken && !this.tires.isBroken && !this.drives.some((d) => d.isBroken);
  }

  battleIssues() {
    const issues = [];
    if (this.chassis.isScrap) issues.push('The frame is scrap — this vehicle is finished; strip or sell it');
    for (const p of this.parts) if (p.failed && !p.isScrap) issues.push(`${p.name} broke down — repair it to get it working`);
    for (const p of this.parts) if (p !== this.chassis && p.isScrap) issues.push(`${p.name} is scrap — remove it and sell it`);
    if (!this.engine) issues.push('No engine fitted');
    if (!this.tires) issues.push('No tires fitted');
    if (this.engine && this.engine.hp <= 0) issues.push('Engine broken (no drive force)');
    if (this.tires && this.tires.hp <= 0) issues.push(this.tires.type === 'castor' ? 'Castors wrecked' : 'Tires shredded (no grip)');
    if (this.stranded) issues.push("Castors aren't driven — they need a turbine or plasma drive");
    return issues;
  }

  /**
   * Equip a part. Returns the parts that were displaced (to go to inventory).
   * @param {Part} part
   * @param {number} [slot] weapon slot index
   */
  equip(part, slot) {
    const displaced = [];
    if (part.type === 'engine' && this.driveSlots < 2) {
      if (this.engine) displaced.push(this.engine);
      this.drives = [part];
      return displaced;
    }
    if (part.type === 'engine' && !this.driveFits(part, slot)) {
      if (slot !== undefined || this.drives.length > 1) throw new Error(`Twin drives must match — that's not a ${this.drives[0].stats.kind} motor`);
      // A single drive of another type: swap it out.
      displaced.push(...this.drives);
      this.drives = [part];
      return displaced;
    }
    switch (part.type) {
      case 'tires':
      case 'castor': // castors share the running-gear slot
        if (this.tires) displaced.push(this.tires);
        this.tires = part;
        break;
      case 'armor':
        if (this.armor) displaced.push(this.armor);
        this.armor = part;
        break;
      case 'engine':
      case 'weapon':
      case 'cooling':
      case 'enhancement': {
        const list = this.slotList(part.type);
        const cap = this.slotCapacity(part.type);
        const idx = slot ?? (list.length < cap ? list.length : cap - 1);
        if (idx < 0 || cap === 0) throw new Error(part.type === 'weapon' ? 'No weapon hardpoints' : 'No free slot');
        if (list[idx]) displaced.push(list[idx]);
        list[idx] = part;
        const packed = list.filter(Boolean);
        list.length = 0;
        list.push(...packed);
        break;
      }
      default:
        throw new Error(`Cannot equip a ${part.type}`);
    }
    return displaced;
  }

  /**
   * Remove an equipped (non-chassis) part. Returns the parts that came off
   * (a drive takes its cooling and enhancements with it), or false.
   */
  unequip(part) {
    if (part === this.chassis) return false;
    const d = this.drives.indexOf(part);
    if (d >= 0) {
      this.drives.splice(d, 1);
      const off = [part];
      for (const [list, per] of [[this.coolers, BattleBug.COOLER_SLOTS], [this.mods, BattleBug.MOD_SLOTS]]) {
        off.push(...list.splice(per * this.drives.length));
      }
      return off;
    }
    for (const slot of ['tires', 'armor']) {
      if (this[slot] === part) { this[slot] = null; return [part]; }
    }
    for (const list of [this.weapons, this.coolers, this.mods]) {
      const i = list.indexOf(part);
      if (i >= 0) { list.splice(i, 1); return [part]; }
    }
    return false;
  }

  findPart(uid) {
    return this.parts.find((p) => p.uid === uid) || null;
  }

  // ───────────── Battle runtime ─────────────
  resetForBattle(position, angle) {
    this.pos = position.clone();
    this.vel = new Vector2D();
    this.angle = angle;
    this.stats = this.getStats();
    this.stamina = this.stats.staminaMax;
    this.stalled = false;
    this.stallStrikes = 0;
    this.throttle = 0;
    this.odometer = 0;
    this.control = { target: null, reverse: false, cruise: null, pushHold: 0 };
    this.lunge = null;
    this.spin = null;
    this.actionCooldown = 0;
    this.cooldowns = {};
    this.effects = EMPTY_EFFECTS();
    this.out = false;
    this.outReason = null;
    this.fall = 0;
    this.lastHitBy = null;
  }

  tickTimers(dt) {
    const e = this.effects;
    e.lifted = Math.max(0, e.lifted - dt);
    e.exposed = Math.max(0, e.exposed - dt);
    e.spikes = Math.max(0, e.spikes - dt);
    e.spikeTick = Math.max(0, e.spikeTick - dt);
    e.flash = Math.max(0, e.flash - dt);
    this.actionCooldown = Math.max(0, this.actionCooldown - dt);
    for (const k in this.cooldowns) this.cooldowns[k] = Math.max(0, this.cooldowns[k] - dt);
    if (this.lunge) {
      this.lunge.time -= dt;
      if (this.lunge.time <= 0) this.lunge = null;
    }
  }

  drainStamina(amount) {
    this.stamina = clamp(this.stamina - amount, 0, this.stats.staminaMax);
  }

  /** Which drive bay is on the side facing world direction `dir`: 0 (left) or 1 (right). */
  sideFacing(dir) {
    const h = Vector2D.fromAngle(this.angle);
    return h.x * dir.y - h.y * dir.x < 0 ? 0 : 1;
  }

  /** Which body zone faces world direction `dir` ('front' | 'side' | 'rear'). */
  zoneFacing(dir) {
    const a = Math.abs(Math.atan2(dir.y, dir.x) - this.angle);
    const diff = Math.abs(((a + Math.PI) % (Math.PI * 2)) - Math.PI);
    if (diff <= PHYSICS.FRONT_ARC) return 'front';
    if (diff >= PHYSICS.REAR_ARC) return 'rear';
    return 'side';
  }

  /**
   * Apply structural damage. Armour soaks a share (scaled by its HP), the rest
   * is split between the hull and the part at the struck zone.
   * @returns {{total:number, hits:Array<{part:Part, dealt:number}>, broken:Part[]}}
   */
  takeDamage(amount, zone = 'side', { bypassArmor = 0, side } = {}) {
    const result = { total: 0, hits: [], broken: [] };
    if (amount <= 0) return result;
    const mult = this.effects.exposed > 0 ? ACTIONS.EXPOSED_DAMAGE_MULT : 1;
    let dmg = amount * mult;

    const hit = (part, n) => {
      if (!part || n <= 0) return;
      const r = part.applyDamage(n);
      if (r.dealt > 0) {
        result.total += r.dealt;
        result.hits.push({ part, dealt: r.dealt });
      }
      if (r.broke) result.broken.push(part);
    };

    if (this.armor && !this.armor.isBroken) {
      const absorb = this.armor.stats.absorb * this.armor.hpRatio * (1 - bypassArmor);
      const soaked = dmg * absorb;
      hit(this.armor, soaked * 0.8);
      dmg -= soaked;
    }

    // Twin drives: the one on the side that took the hit.
    const drive = this.drives[side ?? Math.floor(Math.random() * 2)] || this.engine;
    const zonePart =
      zone === 'front' ? this.weapons.find((w) => !w.isBroken) || drive
        : zone === 'rear' ? drive
          : this.tires;
    hit(this.chassis, dmg * 0.6);
    hit(zonePart, dmg * 0.5);
    if (zone === 'side' && this.drives.length > 1) hit(drive, dmg * 0.25);
    return result;
  }

  /** Targeted damage to one slot (strength destroyers hit the drivetrain). */
  damageSlot(slot, amount, { bypassArmor = 0.5 } = {}) {
    const result = { total: 0, hits: [], broken: [] };
    const part = slot === 'engine' ? this.drives[Math.floor(Math.random() * this.drives.length)] : this[slot];
    if (!part) return result;
    let dmg = amount * (this.effects.exposed > 0 ? ACTIONS.EXPOSED_DAMAGE_MULT : 1);
    if (this.armor && !this.armor.isBroken) {
      dmg *= 1 - this.armor.stats.absorb * this.armor.hpRatio * (1 - bypassArmor);
    }
    const r = part.applyDamage(dmg);
    if (r.dealt > 0) { result.total = r.dealt; result.hits.push({ part, dealt: r.dealt }); }
    if (r.broke) result.broken.push(part);
    return result;
  }
}
