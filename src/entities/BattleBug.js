import { PHYSICS, ACTIONS } from '../config/constants.js';
import { Part, makeId } from './Part.js';
import { pushesThrust, hasDriveTrain, hasShaft, linkActive } from '../config/partsData.js';
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
  static DRIVETRAIN_SLOTS = 4; // gearboxes, shafts, props, rudders…

  constructor({ id, name, hue = 30, alien = false, pilot = null, chassis, engine = null, engine2 = null, tires = null, armor = null, weapons = [], coolers = [], mods = [], drivetrain = [] }) {
    if (!chassis) throw new Error('BattleBug requires a chassis');
    this.id = id || makeId('bug');
    this.name = name || 'Unnamed Bug';
    this.hue = hue;
    this.alien = alien;
    this.pilot = pilot; // { name, planet } for alien challengers
    this.chassis = chassis;
    // Drive bays: one, or two on the bigger shells (Drive 1 and Drive 2; any mix of motor types).
    this.drives = [engine, engine2].filter(Boolean).slice(0, this.driveSlots);
    this.tires = tires;
    this.armor = armor;
    this.weapons = weapons.slice(0, chassis.stats.weaponSlots);
    // Add-ons mount on a drive, and each drive has its own (part.bay says which).
    this.coolers = this.perBay(coolers, BattleBug.COOLER_SLOTS); // cooling add-ons
    this.mods = this.perBay(mods, BattleBug.MOD_SLOTS); // performance enhancements
    this.drivetrain = this.perBay(drivetrain, BattleBug.DRIVETRAIN_SLOTS);
    this.resetForBattle(new Vector2D(), 0);
  }

  /** Keep at most `per` add-ons on each drive bay (bays past the last drive fold back onto bay 0). */
  perBay(list, per) {
    const out = [];
    const bays = Math.max(1, this.drives.length);
    for (const p of list.filter(Boolean)) {
      if ((p.bay || 0) >= bays) delete p.bay;
      if (out.filter((q) => (q.bay || 0) === (p.bay || 0)).length < per) out.push(p);
    }
    return out;
  }

  /** Per-drive slot counts for each add-on type. */
  static perDrive(type) {
    return { cooling: BattleBug.COOLER_SLOTS, enhancement: BattleBug.MOD_SLOTS, drivetrain: BattleBug.DRIVETRAIN_SLOTS }[type] || 0;
  }

  static isAddOn(type) { return type === 'cooling' || type === 'enhancement' || type === 'drivetrain'; }

  /** The drive bay an add-on is mounted on. */
  bayOf(part) { return part.bay || 0; }

  /** The add-ons of a type mounted on drive bay `bay`. */
  addOnsOn(type, bay) {
    return (this.slotList(type) || []).filter((p) => this.bayOf(p) === bay);
  }

  /**
   * Twin drives: what one side has and the other hasn't, by part. Enhancements
   * and drive train need to match, or the better-equipped side pulls. (A
   * Limited-Slip Link joins the two drives, so one does for both.) Cooling runs
   * independently on each drive — matching it is optional (`cooling: true` to include it).
   * @returns {Array<{part, bay:number, missingOn:number}>}
   */
  unmatched({ cooling = false } = {}) {
    if (this.drives.length < 2) return [];
    // Different motor types need different kit: there's nothing to match — only what each puts down counts.
    if (this.drives[0].stats.kind !== this.drives[1].stats.kind) return [];
    const out = [];
    for (const list of cooling ? [this.coolers, this.mods, this.drivetrain] : [this.mods, this.drivetrain]) {
      const left = list.filter((p) => this.bayOf(p) === 0 && !p.stats.lsl && p.stats.kind !== 'diff');
      const right = list.filter((p) => this.bayOf(p) === 1 && !p.stats.lsl && p.stats.kind !== 'diff');
      const spare = [...right];
      for (const p of left) {
        const i = spare.findIndex((q) => q.key === p.key);
        if (i >= 0) spare.splice(i, 1);
        else out.push({ part: p, bay: 0, missingOn: 1 });
      }
      for (const p of spare) out.push({ part: p, bay: 1, missingOn: 0 });
    }
    // No room for another gearbox: there's no matching one up, so it's not a mismatch to fix.
    const gearboxes = this.drivetrain.filter((p) => p.stats.group === 'gearbox').length;
    if (gearboxes >= ((this.chassis.stats.drives || 1) > 1 ? 2 : 1)) return out.filter((u) => u.part.stats.group !== 'gearbox');
    return out;
  }

  /** Twin drives running the same cooling on both (worth a cooling bonus). */
  get coolingMatched() {
    return this.drives.length === 2 && this.coolers.some((c) => (c.bay || 0) === 0)
      && !this.unmatched({ cooling: true }).some((u) => u.part.type === 'cooling');
  }

  /** Fit bay 1 with copies of everything on bay 0 (pro-built twins leave the factory matched). */
  mirrorBays() {
    if (this.drives.length < 2) return;
    for (const { part, missingOn } of this.unmatched({ cooling: true })) {
      if (missingOn !== 1) continue;
      const copy = Part.create(part.key, part.hpRatio);
      copy.bay = 1;
      this.slotList(part.type).push(copy);
    }
  }

  /** Build from catalogue keys. `condition` may be a number or a () => number. */
  static create({ name, hue, alien, pilot, chassis, engine, engine2, tires, armor, weapons = [], coolers = [], mods = [], drivetrain = [], condition = 1 }) {
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
      drivetrain: drivetrain.map(mk),
    });
  }

  static fromJSON(o) {
    const p = (x) => (x ? Part.fromJSON(x) : null);
    // Saves from before each drive had its own add-ons: the cooling and enhancement
    // lists were split by position, and one drive train served both drives.
    if (!o.bays && o.engine2) {
      const bay = (list, per) => (list || []).map((x, i) => (x && i >= per ? { ...x, bay: 1 } : x));
      const shafts = (o.drivetrain || []).filter((x) => x && Part.fromJSON(x).stats.shaft).map((x) => ({ key: x.key, bay: 1 }));
      o = { ...o, coolers: bay(o.coolers, BattleBug.COOLER_SLOTS), mods: bay(o.mods, BattleBug.MOD_SLOTS), drivetrain: [...(o.drivetrain || []), ...shafts] };
    }
    // Saves from before the drive train existed: wheels now need a drive shaft, so fit the right one.
    if (o.drivetrain === undefined && o.tires && Part.fromJSON(o.tires).type === 'tires') {
      const kind = o.engine ? Part.fromJSON(o.engine).stats.kind : null;
      if (kind !== 'plasma') o = { ...o, drivetrain: [{ key: kind === 'turbine' ? 'high_speed_shaft' : 'standard_shaft' }] };
    }
    return new BattleBug({
      id: o.id, name: o.name, hue: o.hue, alien: o.alien, pilot: o.pilot,
      chassis: p(o.chassis), engine: p(o.engine), engine2: p(o.engine2), tires: p(o.tires), armor: p(o.armor),
      weapons: (o.weapons || []).map(p),
      coolers: (o.coolers || []).map(p),
      mods: (o.mods || []).map(p),
      drivetrain: (o.drivetrain || []).map(p),
    });
  }

  toJSON() {
    return {
      id: this.id, name: this.name, hue: this.hue, alien: this.alien, pilot: this.pilot, bays: true,
      chassis: this.chassis.toJSON(),
      engine: this.engine?.toJSON() ?? null,
      engine2: this.drives[1]?.toJSON() ?? null,
      tires: this.tires?.toJSON() ?? null,
      armor: this.armor?.toJSON() ?? null,
      weapons: this.weapons.map((w) => w.toJSON()),
      coolers: this.coolers.map((c) => c.toJSON()),
      mods: this.mods.map((m) => m.toJSON()),
      drivetrain: this.drivetrain.map((d) => d.toJSON()),
    };
  }

  // ───────────── Composition ─────────────
  get parts() {
    return [this.chassis, ...this.drives, this.tires, this.armor, ...this.weapons, ...this.coolers, ...this.mods, ...this.drivetrain].filter(Boolean);
  }
  /** The (first) drive motor. */
  get engine() { return this.drives[0] || null; }
  set engine(part) { if (part) this.drives[0] = part; else this.drives.shift(); }
  /** Drive bays on this frame: 1, or 2 on the bigger shells. */
  get driveSlots() { return this.chassis.stats.drives || 1; }
  /** Two working drives: it can spin on the spot. */
  get twinDrive() { return this.drives.length === 2 && this.drives.every((d) => !d.isBroken) && !linkActive(this); } // a Limited-Slip Link stops the spin
  get hull() { return this.chassis; }
  /** World/collision radius. The catalogue radius is the sprite design size. */
  get radius() { return this.chassis.stats.radius * PHYSICS.BUG_SCALE; }
  get designRadius() { return this.chassis.stats.radius; }
  get weaponSlots() { return this.chassis.stats.weaponSlots; }

  /** Multi-slot part types: the fitted list and how many fit. */
  slotList(type) {
    if (type === 'engine') return this.driveSlots > 1 ? this.drives : null;
    if (type === 'drivetrain') return this.drivetrain;
    return type === 'weapon' ? this.weapons : type === 'cooling' ? this.coolers : type === 'enhancement' ? this.mods : null;
  }

  slotCapacity(type) {
    if (type === 'engine') return this.driveSlots;
    // Cooling, enhancements and drive train mount on a drive: a set of slots for each one fitted.
    if (BattleBug.isAddOn(type)) return BattleBug.perDrive(type) * this.drives.length;
    return type === 'weapon' ? this.weaponSlots : 1;
  }

  /** The drive bay a new add-on goes on by default: one with room, preferring the side that lacks it. */
  defaultBay(part) {
    const n = this.drives.length;
    if (n < 2) return 0;
    const per = BattleBug.perDrive(part.type);
    const room = [0, 1].filter((b) => this.addOnsOn(part.type, b).length < per);
    const lacking = room.filter((b) => this.addOnsOn(part.type, b).filter((p) => p.key === part.key).length
      < this.addOnsOn(part.type, 1 - b).filter((p) => p.key === part.key).length);
    // Liquid cooling wants the side with its jacket.
    const jacketed = part.stats.jacket ? room.filter((b) => this.addOnsOn('cooling', b).some((c) => c.stats.jacketFor === part.stats.jacket)) : [];
    return lacking[0] ?? jacketed[0] ?? room[0] ?? 0;
  }

  /** The part in a single slot of this type (castors and tyres share the running gear). */
  slotPart(type) {
    return type === 'castor' || type === 'tires' ? this.tires : type === 'engine' ? this.engine : this[type] ?? null;
  }

  /** Twin drives can be any mix of motor types. */
  driveFits() {
    return true;
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
    return this.tires?.type === 'castor' && !!this.engine && !pushesThrust(this);
  }

  /** On wheels or tracks with a shaft motor but no working drive shaft: it can't move. */
  get unshafted() {
    const kind = this.engine?.stats.kind;
    return this.tires?.type === 'tires' && !!kind && kind !== 'turbine' && kind !== 'plasma' && !hasShaft(this);
  }

  get isBattleReady() {
    return !!this.engine && !!this.tires && !this.stranded && !this.unshafted && !this.parts.some((p) => p.isScrap)
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
    if (this.unshafted) issues.push('No drive shaft — the motor isn\'t connected to the wheels (they\'re next to free on the Marketplace)');
    if (this.stranded) issues.push("Castors aren't driven — they need a turbine or plasma drive, or a propeller or ducted fan");
    return issues;
  }

  /**
   * Equip a part. Returns the parts that were displaced (to go to inventory).
   * @param {Part} part
   * @param {number} [slot] slot index (for add-ons: on that drive)
   * @param {number} [bay] add-ons: which drive to mount on
   */
  equip(part, slot, bay) {
    const displaced = [];
    if (part.type === 'engine' && this.driveSlots < 2) {
      if (this.engine) displaced.push(this.engine);
      this.drives = [part];
      return displaced;
    }
    if (part.type === 'engine' && !this.driveFits(part, slot)) {
      if (slot !== undefined || this.drives.length > 1) throw new Error(`Twin drives must match — that's not a ${this.drives[0].stats.kind} motor`);
      // A single drive of another type: swap it out (anything on a second bay comes off too).
      displaced.push(...this.drives);
      this.drives = [part];
      for (const list of [this.coolers, this.mods, this.drivetrain]) {
        for (const p of list.filter((q) => this.bayOf(q) > 0)) { list.splice(list.indexOf(p), 1); delete p.bay; displaced.push(p); }
      }
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
      case 'drivetrain':
      case 'cooling':
      case 'enhancement': {
        // `slot` is the position on that drive's own list.
        if (!this.drives.length) throw new Error('Fit a drive first dummy!');
        const b = Math.min(bay ?? this.defaultBay(part), this.drives.length - 1);
        const list = this.slotList(part.type);
        const mine = this.addOnsOn(part.type, b);
        const per = BattleBug.perDrive(part.type);
        const idx = slot ?? (mine.length < per ? mine.length : per - 1);
        const old = mine[idx];
        if (old) {
          displaced.push(old);
          list.splice(list.indexOf(old), 1, part);
          delete old.bay;
        } else {
          list.push(part);
        }
        if (b) part.bay = b; else delete part.bay;
        break;
      }
      case 'engine':
      case 'weapon': {
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
      // A drive comes off with its own cooling, enhancements and drive train.
      this.drives.splice(d, 1);
      const off = [part];
      for (const list of [this.coolers, this.mods, this.drivetrain]) {
        for (const p of [...list]) {
          const b = this.bayOf(p);
          if (b === d) { list.splice(list.indexOf(p), 1); delete p.bay; off.push(p); }
          else if (b > d) { if (b - 1) p.bay = b - 1; else delete p.bay; }
        }
      }
      return off;
    }
    for (const slot of ['tires', 'armor']) {
      if (this[slot] === part) { this[slot] = null; return [part]; }
    }
    for (const list of [this.weapons, this.coolers, this.mods, this.drivetrain]) {
      const i = list.indexOf(part);
      if (i >= 0) { list.splice(i, 1); delete part.bay; return [part]; }
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
    this.regenWait = 0; // run dry: time until the chassis regen kicks in
    this.regenOn = false; // regen refilling you after you ran dry
    this.heat = 0; // 0–100: overheat at 100 (a thermal stall)
    this.stallKind = null; // while stalled: 'heat' (overheated) or 'power' (out of stamina)
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
    // A fluid coupling (or magnetic gearbox) cushions shocks before they reach the drive;
    // castors are tucked under the chassis and take half the knocks tyres would.
    const guard = this.drivetrain.filter((p) => !p.isBroken && p.stats.driveGuard).reduce((g, p) => Math.min(g, p.stats.driveGuard), 1);
    const shield = (part) => (this.drives.includes(part) ? guard : part?.type === 'castor' ? 0.5 : 1);
    hit(this.chassis, dmg * 0.6);
    hit(zonePart, dmg * 0.5 * shield(zonePart));
    if (zone === 'side' && this.drives.length > 1) hit(drive, dmg * 0.25 * guard);
    // The drive train rides along inside and takes a share of heavy hits (a CVT or strain wave gear won't last).
    if (zone !== 'front' && this.drivetrain.length) hit(this.drivetrain[Math.floor(Math.random() * this.drivetrain.length)], dmg * 0.2);
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
