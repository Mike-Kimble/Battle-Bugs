import { BattleBug } from './BattleBug.js';

/**
 * A pilot's racing side: the same alien (name, planet, story, wallet), but a
 * separate Race Bug built for the S-track, and their own racing skill and
 * record. Racers stand in for pilots on the Race board, so the haggling,
 * titles and betting code works on them unchanged.
 */
export class Racer {
  constructor(owner, { id, bug, skill, record, matched = false, titleAsked = false } = {}) {
    this.owner = owner;
    this.id = id || `race_${owner.id}`;
    this.bug = bug;
    this.skill = skill ?? owner.skill;
    this.record = record || { w: 0, l: 0 };
    this.matched = matched;
    this.titleAsked = titleAsked;
    this.nego = null;
  }

  get name() { return this.owner.name; }
  get planet() { return this.owner.planet; }
  get style() { return this.owner.style; }
  get story() { return this.owner.story; }
  get elite() { return this.owner.elite; }
  get rookie() { return this.owner.rookie; }
  set rookie(v) { /* the pilot's rookie status is theirs to lose, in a fight */ }
  /** One wallet for both: what they win racing pays for their battle bug too. */
  get purse() { return this.owner.purse; }
  set purse(v) { this.owner.purse = v; }
  /** Same face on both boards. */
  get portraitId() { return this.owner.id; }

  toJSON() {
    return { id: this.id, pilotId: this.owner.id, bug: this.bug.toJSON(), skill: this.skill, record: this.record, matched: this.matched, titleAsked: this.titleAsked };
  }

  static fromJSON(d, owner) {
    return new Racer(owner, { ...d, bug: BattleBug.fromJSON(d.bug) });
  }
}
