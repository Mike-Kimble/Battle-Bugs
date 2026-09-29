import { getPartDef } from '../config/partsData.js';
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

  constructor(key, { uid, hp } = {}) {
    this.def = getPartDef(key);
    this.key = key;
    this.uid = uid || makeId('pt');
    this.maxHp = this.def.maxHp;
    this.hp = hp == null ? this.maxHp : clamp(hp, 0, this.maxHp);
  }

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
  get isBroken() { return this.hp <= 0; }
  /** Too far gone to fit or repair — scrap only. The limit depends on who's in your workshop. */
  get isScrap() { return this.hp <= this.maxHp * Part.scrapBelow(); }
  get missingHp() { return this.maxHp - this.hp; }

  /** @returns {{dealt:number, broke:boolean}} */
  applyDamage(amount) {
    const before = this.hp;
    this.hp = Math.max(0, this.hp - Math.max(0, amount));
    return { dealt: before - this.hp, broke: before > 0 && this.hp <= 0 };
  }

  repair(amount = Infinity) {
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    return this.hp - before;
  }

  toJSON() {
    return { key: this.key, uid: this.uid, hp: Math.round(this.hp * 10) / 10 };
  }
}
