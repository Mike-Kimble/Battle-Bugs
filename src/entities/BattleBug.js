import { PHYSICS, ACTIONS } from '../config/constants.js';
import { Part, makeId } from './Part.js';
import { PhysicsEngine } from '../physics/PhysicsEngine.js';
import { Vector2D, clamp } from '../physics/Vector2D.js';

const EMPTY_EFFECTS = () => ({ lifted: 0, liftGrip: 0.1, exposed: 0, spikes: 0, spikeTick: 0, flash: 0 });

/**
 * A vehicle: a chassis plus equipped parts, with runtime battle state.
 * Hull HP is the chassis HP — reaching 0 is catastrophic damage.
 */
export class BattleBug {
  constructor({ id, name, hue = 30, alien = false, pilot = null, chassis, engine = null, tires = null, armor = null, weapons = [] }) {
    if (!chassis) throw new Error('BattleBug requires a chassis');
    this.id = id || makeId('bug');
    this.name = name || 'Unnamed Bug';
    this.hue = hue;
    this.alien = alien;
    this.pilot = pilot; // { name, planet } for alien challengers
    this.chassis = chassis;
    this.engine = engine;
    this.tires = tires;
    this.armor = armor;
    this.weapons = weapons.slice(0, chassis.stats.weaponSlots);
    this.resetForBattle(new Vector2D(), 0);
  }

  /** Build from catalogue keys. `condition` may be a number or a () => number. */
  static create({ name, hue, alien, pilot, chassis, engine, tires, armor, weapons = [], condition = 1 }) {
    const cond = typeof condition === 'function' ? condition : () => condition;
    const mk = (key) => (key ? Part.create(key, cond()) : null);
    return new BattleBug({
      name, hue, alien, pilot,
      chassis: mk(chassis),
      engine: mk(engine),
      tires: mk(tires),
      armor: mk(armor),
      weapons: weapons.map(mk),
    });
  }

  static fromJSON(o) {
    const p = (x) => (x ? Part.fromJSON(x) : null);
    return new BattleBug({
      id: o.id, name: o.name, hue: o.hue, alien: o.alien, pilot: o.pilot,
      chassis: p(o.chassis), engine: p(o.engine), tires: p(o.tires), armor: p(o.armor),
      weapons: (o.weapons || []).map(p),
    });
  }

  toJSON() {
    return {
      id: this.id, name: this.name, hue: this.hue, alien: this.alien, pilot: this.pilot,
      chassis: this.chassis.toJSON(),
      engine: this.engine?.toJSON() ?? null,
      tires: this.tires?.toJSON() ?? null,
      armor: this.armor?.toJSON() ?? null,
      weapons: this.weapons.map((w) => w.toJSON()),
    };
  }

  // ───────────── Composition ─────────────
  get parts() {
    return [this.chassis, this.engine, this.tires, this.armor, ...this.weapons].filter(Boolean);
  }
  get hull() { return this.chassis; }
  /** World/collision radius. The catalogue radius is the sprite design size. */
  get radius() { return this.chassis.stats.radius * PHYSICS.BUG_SCALE; }
  get designRadius() { return this.chassis.stats.radius; }
  get weaponSlots() { return this.chassis.stats.weaponSlots; }
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

  get isBattleReady() {
    return !this.chassis.isBroken && !!this.engine && !!this.tires;
  }

  battleIssues() {
    const issues = [];
    if (this.chassis.isBroken) issues.push('Hull destroyed — repair the frame');
    if (!this.engine) issues.push('No engine fitted');
    if (!this.tires) issues.push('No tires fitted');
    if (this.engine?.isBroken) issues.push('Engine broken (no drive force)');
    if (this.tires?.isBroken) issues.push('Tires shredded (no grip)');
    return issues;
  }

  /**
   * Equip a part. Returns the parts that were displaced (to go to inventory).
   * @param {Part} part
   * @param {number} [slot] weapon slot index
   */
  equip(part, slot) {
    const displaced = [];
    switch (part.type) {
      case 'engine':
      case 'tires':
      case 'armor':
        if (this[part.type]) displaced.push(this[part.type]);
        this[part.type] = part;
        break;
      case 'weapon': {
        const idx = slot ?? (this.weapons.length < this.weaponSlots ? this.weapons.length : this.weaponSlots - 1);
        if (idx < 0 || this.weaponSlots === 0) throw new Error('No weapon hardpoints');
        if (this.weapons[idx]) displaced.push(this.weapons[idx]);
        this.weapons[idx] = part;
        this.weapons = this.weapons.filter(Boolean);
        break;
      }
      default:
        throw new Error(`Cannot equip a ${part.type}`);
    }
    return displaced;
  }

  /** Remove an equipped (non-chassis) part. Returns true if removed. */
  unequip(part) {
    if (part === this.chassis) return false;
    for (const slot of ['engine', 'tires', 'armor']) {
      if (this[slot] === part) { this[slot] = null; return true; }
    }
    const i = this.weapons.indexOf(part);
    if (i >= 0) { this.weapons.splice(i, 1); return true; }
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
  takeDamage(amount, zone = 'side', { bypassArmor = 0 } = {}) {
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

    const zonePart =
      zone === 'front' ? this.weapons.find((w) => !w.isBroken) || this.engine
        : zone === 'rear' ? this.engine
          : this.tires;
    hit(this.chassis, dmg * 0.6);
    hit(zonePart, dmg * 0.5);
    return result;
  }

  /** Targeted damage to one slot (strength destroyers hit the drivetrain). */
  damageSlot(slot, amount, { bypassArmor = 0.5 } = {}) {
    const result = { total: 0, hits: [], broken: [] };
    const part = this[slot];
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
