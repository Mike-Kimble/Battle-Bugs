import { getPartDef, currentKey } from '../config/partsData.js';
import { clamp } from '../physics/Vector2D.js';

let idCounter = 0;

/** Short unique id, e.g. "pt_lx3k9a2b". */
export function makeId(prefix = 'id') {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/**
 * A single component instance. Static data comes from the catalogue;
 * only key, uid and current HP are persisted.
 */
export class Part {
  /** Condition at or below which a part is scrap (set by the economy: 20%, or 0% with a mechanic). */
  static scrapBelow = () => 0;
  /** How far a repair can bring a part back (set by the economy: 90%, or 100% with a mechanic). */
  static repairCap = () => 1;

  constructor(key, { uid, hp, usesLeft, failed } = {}) {
    this.def = getPartDef(key);
    this.key = currentKey(key); // old saves: retired parts come back as their replacements
    this.uid = uid || makeId('pt');
    this.maxHp = this.def.maxHp;
    this.hp = hp == null ? this.maxHp : clamp(hp, 0, this.maxHp);
    // Broke down in a fight (at 15% or below): stops working until it's repaired.
    this.failed = !!failed;
    // Consumables (cryo blocks, nitro…) last a set number of battles.
    this.usesLeft = this.def.stats.uses ? (usesLeft ?? this.def.stats.uses) : null;
  }

  /** A consumable that's been used up. */
  get spent() { return this.usesLeft === 0; }

  static create(key, condition = 1) {
    const part = new Part(key);
    part.hp = Math.round(part.maxHp * clamp(condition, 0, 1));
    return part;
  }

  static fromJSON(o) {
    return new Part(o.key, o);
  }

  get type() { return this.def.type; }
  get name() { return this.def.name; }
  get mass() { return this.def.mass; }
  get value() { return this.def.value; }
  get tier() { return this.def.tier; }
  get rarity() { return this.def.rarity; }
  get stats() { return this.def.stats; }
  get description() { return this.def.description; }

  get hpRatio() { return this.maxHp > 0 ? this.hp / this.maxHp : 0; }
  /** Not working: wrecked (0 HP) or broken down until repaired. */
  get isBroken() { return this.hp <= 0 || this.failed; }
  /** Too far gone to fit or repair — scrap only. The limit depends on who's in your workshop. */
  get isScrap() { return this.spent || this.hp <= this.maxHp * Part.scrapBelow(); }
  /** HP a repair could restore right now (none for scrap). */
  get repairableHp() { return this.isScrap ? 0 : Math.max(0, this.maxHp * Part.repairCap() - this.hp); }
  /** HP after the best repair available. */
  get repairedHp() { return this.hp + this.repairableHp; }
  get missingHp() { return this.maxHp - this.hp; }

  /** @returns {{dealt:number, broke:boolean}} */
  applyDamage(amount) {
    const before = this.hp;
    // In a fight, most parts can't lose more than a set share in one match (see CombatEngine).
    this.hp = Math.max(this.battleFloor ?? 0, this.hp - Math.max(0, amount));
    if (this.hp > before) this.hp = before;
    return { dealt: before - this.hp, broke: before > 0 && this.hp <= 0 };
  }

  repair(amount = Infinity) {
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    if (this.hp > before) this.failed = false; // any repair gets it working again
    return this.hp - before;
  }

  toJSON() {
    const o = { key: this.key, uid: this.uid, hp: Math.round(this.hp * 10) / 10 };
    if (this.usesLeft != null) o.usesLeft = this.usesLeft;
    if (this.failed) o.failed = true;
    return o;
  }
}
