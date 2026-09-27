import { ECONOMY, WEAPON_CLASSES } from '../config/constants.js';
import { formatMoney } from '../systems/EconomyManager.js';
import { el, toast, hpBar, partCard, openModal, closeModal } from './WorkshopUI.js';

const TABS = [
  ['challengers', 'Challenger Board'],
  ['hangar', 'Hangar'],
  ['market', 'Marketplace'],
  ['staff', 'Staff'],
  ['tournament', 'Tournament'],
];

/**
 * The Terminal: hangar, marketplace, challenger board, staff office and
 * tournament desk. Also renders the top status bar.
 */
export class TerminalUI {
  constructor(root, header, { state, economy, sprite, onFight, onNewGame }) {
    this.root = root;
    this.header = header;
    this.state = state;
    this.economy = economy;
    this.sprite = sprite;
    this.onFight = onFight;
    this.onNewGame = onNewGame;
    this.tab = 'challengers';
    this.renaming = null;
  }

  act(fn, success) {
    try {
      const r = fn();
      if (success) toast(typeof success === 'function' ? success(r) : success, 'good');
      this.state.commit();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  render() {
    this.renderHeader();
    const body = {
      challengers: () => this.renderChallengers(),
      hangar: () => this.renderHangar(),
      market: () => this.renderMarket(),
      staff: () => this.renderStaff(),
      tournament: () => this.renderTournament(),
    }[this.tab]();

    const scroll = this.root.querySelector('.terminal-body')?.scrollTop ?? 0;
    this.root.replaceChildren(
      el('nav', { class: 'tabs', role: 'tablist' },
        TABS.map(([key, label]) => el('button', {
          class: `tab${this.tab === key ? ' active' : ''}${key === 'tournament' && this.economy.tournamentUnlocked ? ' glow' : ''}`,
          role: 'tab',
          'aria-selected': this.tab === key ? 'true' : 'false',
          onclick: () => { this.tab = key; this.render(); },
        }, label))),
      el('div', { class: 'terminal-body' }, body),
    );
    const tb = this.root.querySelector('.terminal-body');
    if (tb) tb.scrollTop = scroll;
  }

  renderHeader() {
    const s = this.state;
    const cw = Math.min(s.record.challengerWins, ECONOMY.TOURNAMENT_UNLOCK_WINS);
    this.header.replaceChildren(
      el('div', { class: 'logo' }, 'BATTLE', el('span', {}, 'BUGS')),
      el('div', { class: 'hud-stats' },
        el('div', { class: 'stat money' }, el('small', {}, 'Capital'), el('strong', {}, formatMoney(s.money))),
        el('div', { class: 'stat' }, el('small', {}, 'Record W·L·D'), el('strong', {}, `${s.record.wins}·${s.record.losses}·${s.record.ties}`)),
        el('div', { class: 'stat' }, el('small', {}, 'Tournament'),
          el('strong', {}, s.gameComplete ? '★ CHAMPION' : s.tournament.entered ? `Round ${s.tournament.round + 1}/${ECONOMY.TOURNAMENT_ROUNDS}` : `${cw}/${ECONOMY.TOURNAMENT_UNLOCK_WINS} wins`)),
      ),
    );
  }

  statChips(bug) {
    const s = bug.getStats();
    return el('div', { class: 'chips' },
      el('span', { class: 'chip', title: 'Mass' }, `${s.mass} kg`),
      el('span', { class: 'chip', title: 'Usable push force' }, `${(s.fUsable / 1000).toFixed(0)} kN push`),
      el('span', { class: 'chip', title: 'Grip limit' }, `${(s.fGrip / 1000).toFixed(0)} kN grip`),
      el('span', { class: 'chip', title: 'Top speed' }, `${Math.round(s.vMax)} px/s`),
      el('span', { class: 'chip', title: 'Stamina' }, `${s.staminaMax} stam`));
  }

  weaponChips(bug) {
    if (!bug.weapons.length) return el('div', { class: 'chips' }, el('span', { class: 'chip chip-dim' }, 'Unarmed'));
    return el('div', { class: 'chips' }, bug.weapons.map((w) => el('span', {
      class: 'chip chip-weapon', style: { borderColor: WEAPON_CLASSES[w.stats.class].color, color: WEAPON_CLASSES[w.stats.class].color },
      title: WEAPON_CLASSES[w.stats.class].label,
    }, w.name)));
  }

  // ───────────── Challenger board ─────────────
  renderChallengers() {
    const s = this.state;
    const active = s.activeBug;
    if (s.tournament.entered) {
      return el('div', { class: 'notice' }, 'You are entered in the Inter-Planetary Tournament. Fight your bracket from the Tournament tab.',
        el('button', { class: 'btn btn-primary', onclick: () => { this.tab = 'tournament'; this.render(); } }, 'Go to Tournament'));
    }
    if (!s.challengers.length) this.economy.generateChallengers();
    const ready = active?.isBattleReady;
    return el('div', {},
      el('p', { class: 'muted' }, `Alien challengers are queuing at the dohyo. Win to claim the bounty AND their entire vehicle. Your fighter: `,
        el('strong', {}, active ? active.name : '—'), ready ? '' : el('span', { class: 'bad' }, ' (not battle-ready)')),
      el('div', { class: 'card-grid' }, s.challengers.map((c) => this.challengerCard(c, { ready, label: c.rookie ? 'ROOKIE · EASY' : null, onFight: () => this.onFight(c, { tournament: false }) }))));
  }

  challengerCard(c, { ready, onFight, label }) {
    const bug = c.bug;
    return el('article', { class: 'card challenger' },
      el('div', { class: 'card-row' },
        this.sprite.renderThumbnail(bug, 88),
        el('div', { class: 'card-info' },
          label ? el('div', { class: 'badge badge-gold' }, label) : null,
          el('h3', {}, bug.name),
          bug.pilot ? el('div', { class: 'muted small' }, `Pilot ${bug.pilot.name} of ${bug.pilot.planet}`) : null,
          el('div', { class: 'tier' }, '★'.repeat(c.tier), el('span', { class: 'dim' }, '★'.repeat(5 - c.tier))),
          el('div', { class: 'small muted' }, `${bug.chassis.name} · ${Math.round(bug.condition * 100)}% condition`))),
      this.statChips(bug),
      this.weaponChips(bug),
      el('div', { class: 'card-foot' },
        el('div', { class: 'bounty' }, el('small', {}, 'Bounty'), el('strong', {}, formatMoney(c.bounty))),
        el('button', { class: 'btn btn-fight', disabled: !ready, onclick: onFight }, 'FIGHT')),
    );
  }

  // ───────────── Hangar ─────────────
  renderHangar() {
    const s = this.state;
    const wrap = el('div', {});
    if (this.economy.needsJunkyard) {
      wrap.append(el('div', { class: 'notice notice-warn' },
        'Nothing battle-ready and the coffers are dry. The junkyard will donate a beat-up Scrapper.',
        el('button', { class: 'btn btn-primary', onclick: () => this.act(() => this.economy.claimJunkyardScrapper(), 'A Junkyard Scrapper rolls into the hangar') }, 'Claim Junkyard Scrapper')));
    }
    wrap.append(el('h3', {}, `Vehicles (${s.vehicles.length})`));
    wrap.append(el('div', { class: 'card-grid' }, s.vehicles.map((bug) => this.vehicleCard(bug))));
    wrap.append(el('h3', {}, `Parts inventory (${s.inventory.length})`));
    if (!s.inventory.length) wrap.append(el('p', { class: 'muted' }, 'Empty. Strip captured vehicles or buy parts at the Marketplace.'));
    wrap.append(el('div', { class: 'card-grid parts' }, s.inventory.map((p) => this.sellPartCard(p))));
    return wrap;
  }

  sellPartCard(p) {
    return partCard(p, this.economy, {
      actions: [el('button', { class: 'btn btn-small', onclick: () => this.act(() => this.economy.sellPart(p.uid), (v) => `Sold ${p.name} for ${formatMoney(v)}`) },
        `${p.isBroken ? 'Scrap' : 'Sell'} ${formatMoney(this.economy.partSellPrice(p))}`)],
    });
  }

  vehicleCard(bug) {
    const s = this.state;
    const isActive = bug.id === s.activeVehicleId;
    const locked = s.isLocked(bug);
    const nameNode = this.renaming === bug.id
      ? el('form', {
        class: 'rename',
        onsubmit: (e) => {
          e.preventDefault();
          const v = e.target.elements.name.value.trim().slice(0, 24);
          this.renaming = null;
          if (v) this.act(() => { bug.name = v; }, 'Renamed');
          else this.render();
        },
      }, el('input', { name: 'name', value: bug.name, maxlength: 24, 'aria-label': 'Vehicle name' }), el('button', { class: 'btn btn-small', type: 'submit' }, 'Save'))
      : el('h3', {}, bug.name);

    const card = el('article', { class: `card vehicle${isActive ? ' active' : ''}` },
      el('div', { class: 'card-row' },
        this.sprite.renderThumbnail(bug, 80),
        el('div', { class: 'card-info' },
          isActive ? el('span', { class: 'badge' }, 'ACTIVE') : null,
          locked ? el('span', { class: 'badge badge-lock' }, '🔒 ENTERED') : null,
          nameNode,
          el('div', { class: 'small muted' }, bug.chassis.name),
          hpBar(bug.condition, { label: `Condition ${Math.round(bug.condition * 100)}%` }),
          bug.isBattleReady ? null : el('div', { class: 'small bad' }, bug.battleIssues()[0]))),
      this.statChips(bug),
      this.weaponChips(bug),
      el('div', { class: 'part-actions' },
        el('button', { class: 'btn btn-small btn-primary', disabled: isActive || s.tournament.entered, onclick: () => this.act(() => s.setActive(bug.id), `${bug.name} is on the hoist`) }, isActive ? 'On hoist' : 'Set active'),
        el('button', { class: 'btn btn-small', onclick: () => { this.renaming = bug.id; this.render(); } }, 'Rename'),
        el('button', {
          class: 'btn btn-small', disabled: locked || s.vehicles.length <= 1,
          onclick: () => this.confirm(`Strip ${bug.name}?`, 'Engine, tires, armour and weapons go to your inventory; the bare frame is sold as scrap.',
            () => this.act(() => this.economy.stripVehicle(bug.id), (r) => `Stripped ${r.parts.length} parts, frame scrapped for ${formatMoney(r.scrap)}`)),
        }, 'Strip'),
        el('button', {
          class: 'btn btn-small btn-danger', disabled: locked || s.vehicles.length <= 1,
          onclick: () => this.confirm(`Sell ${bug.name}?`, `You'll receive ${formatMoney(this.economy.vehicleSellPrice(bug))}.`,
            () => this.act(() => this.economy.sellVehicle(bug.id), (v) => `Sold for ${formatMoney(v)}`)),
        }, `Sell ${formatMoney(this.economy.vehicleSellPrice(bug))}`)),
    );
    return card;
  }

  confirm(title, text, onYes) {
    openModal(title, el('div', {},
      el('p', {}, text),
      el('div', { class: 'part-actions' },
        el('button', { class: 'btn btn-primary', onclick: () => { closeModal(); onYes(); } }, 'Confirm'),
        el('button', { class: 'btn', onclick: closeModal }, 'Cancel'))));
  }

  // ───────────── Marketplace ─────────────
  renderMarket() {
    const s = this.state;
    if (!s.market.parts.length && !s.market.vehicles.length) this.economy.generateMarket();
    const manager = s.staff.manager;
    const dealBadge = (l) => (manager && this.economy.isRareDeal(l) ? el('span', { class: 'badge badge-gold' }, '★ RARE DEAL') : null);

    return el('div', {},
      el('p', { class: 'muted' }, 'Stock rotates after every bout. ', manager ? 'Your manager is flagging rare deals.' : 'Hire a manager to have rare deals flagged.'),
      el('h3', {}, 'Parts'),
      el('div', { class: 'card-grid parts' }, s.market.parts.map((l) => partCard(l.part, this.economy, {
        extra: dealBadge(l),
        actions: [el('button', {
          class: 'btn btn-small btn-primary', disabled: s.money < l.price,
          onclick: () => this.act(() => this.economy.buyPartListing(l.id), `Bought ${l.part.name}`),
        }, `Buy ${formatMoney(l.price)}`)],
      }))),
      el('h3', {}, 'Whole vehicles'),
      el('div', { class: 'card-grid' }, s.market.vehicles.map((l) => el('article', { class: 'card vehicle' },
        el('div', { class: 'card-row' },
          this.sprite.renderThumbnail(l.bug, 80),
          el('div', { class: 'card-info' },
            dealBadge(l),
            el('h3', {}, l.bug.name),
            el('div', { class: 'small muted' }, l.bug.chassis.name),
            hpBar(l.bug.condition, { label: `Condition ${Math.round(l.bug.condition * 100)}%` }))),
        this.statChips(l.bug),
        this.weaponChips(l.bug),
        el('div', { class: 'card-foot' },
          el('div', { class: 'bounty' }, el('small', {}, 'Price'), el('strong', {}, formatMoney(l.price))),
          el('button', { class: 'btn btn-primary', disabled: s.money < l.price, onclick: () => this.act(() => this.economy.buyVehicleListing(l.id), `${l.bug.name} added to your hangar`) }, 'Buy'))),
      )),
      el('h3', {}, `Sell your parts (${s.inventory.length})`),
      s.inventory.length
        ? el('p', { class: 'muted small' }, `Parts you've removed or stripped. Buyers pay ${Math.round(ECONOMY.SELL_RATE * 100)}% of value × condition; broken parts fetch scrap only.`)
        : el('p', { class: 'muted small' }, 'No spare parts. Remove parts on the hoist or strip a captured vehicle to sell them here.'),
      el('div', { class: 'card-grid parts' }, s.inventory.map((p) => this.sellPartCard(p))),
      el('p', { class: 'muted small' }, 'Whole vehicles can be sold from the Hangar tab.'),
    );
  }

  // ───────────── Staff ─────────────
  renderStaff() {
    const s = this.state;
    const staffCard = (role, title, hire, wage, desc, icon) => el('article', { class: `card staff${s.staff[role] ? ' active' : ''}` },
      el('div', { class: 'staff-icon' }, icon),
      el('h3', {}, title),
      el('p', {}, desc),
      el('div', { class: 'small muted' }, `Hire fee ${formatMoney(hire)} · wage ${formatMoney(wage)} per bout`),
      s.staff[role]
        ? el('button', { class: 'btn btn-small', onclick: () => this.act(() => this.economy.dismiss(role), `${title} dismissed`) }, 'Dismiss')
        : el('button', { class: 'btn btn-small btn-primary', disabled: s.money < hire, onclick: () => this.act(() => this.economy.hire(role), `${title} hired`) }, `Hire ${formatMoney(hire)}`));

    return el('div', {},
      el('div', { class: 'card-grid' },
        staffCard('mechanic', 'Mechanic', ECONOMY.MECHANIC_HIRE, ECONOMY.MECHANIC_WAGE,
          'Automatically repairs every part on your active vehicle after each bout, as far as funds allow.', '🔧'),
        staffCard('manager', 'Manager', ECONOMY.MANAGER_HIRE, ECONOMY.MANAGER_WAGE,
          'Auto-sells broken scrap in your inventory at peak value (double scrap rate) and flags rare Marketplace deals.', '📈')),
      el('h3', {}, 'Recent log'),
      el('ul', { class: 'log' }, s.log.slice(-10).reverse().map((l) => el('li', {}, l.msg))),
      el('h3', {}, 'Office'),
      el('button', {
        class: 'btn btn-danger',
        onclick: () => this.confirm('Start a new game?', 'This wipes your save: vehicles, money and progress.', () => this.onNewGame()),
      }, 'New game (wipe save)'),
    );
  }

  // ───────────── Tournament ─────────────
  renderTournament() {
    const s = this.state;
    const eco = this.economy;
    const t = s.tournament;
    const wrap = el('div', { class: 'tournament' },
      el('h3', {}, 'The Inter-Planetary Tournament'),
      el('p', {}, `${ECONOMY.TOURNAMENT_ROUNDS} rounds against the galaxy's finest. Grand prize ${formatMoney(ECONOMY.TOURNAMENT_PRIZE)} and eternal glory. `,
        'On entry your vehicle is locked: no upgrades or part swaps — field repairs only.'));

    if (s.gameComplete) {
      wrap.append(el('div', { class: 'notice notice-gold' }, '★ You are the reigning Inter-Planetary Champion! The game is complete — keep brawling for fun.'));
    }

    if (!eco.tournamentUnlocked) {
      const n = s.record.challengerWins;
      wrap.append(el('div', { class: 'notice' }, `Locked. Win ${ECONOMY.TOURNAMENT_UNLOCK_WINS} challenger bouts to qualify (${n}/${ECONOMY.TOURNAMENT_UNLOCK_WINS}).`),
        hpBar(n / ECONOMY.TOURNAMENT_UNLOCK_WINS, { label: `${n}/${ECONOMY.TOURNAMENT_UNLOCK_WINS}` }));
      return wrap;
    }

    wrap.append(el('ol', { class: 'bracket' }, ['Quarter-Final', 'Semi-Final', 'Grand Final'].map((name, i) => el('li', {
      class: t.entered && i === t.round ? 'current' : t.entered && i < t.round ? 'done' : '',
    }, name))));

    if (!t.entered) {
      const bug = s.activeBug;
      wrap.append(
        t.eliminated ? el('p', { class: 'bad' }, 'You were eliminated last time. Regroup, upgrade and try again.') : null,
        el('p', {}, 'Entering with: ', el('strong', {}, bug?.name ?? '—'), bug && !bug.isBattleReady ? el('span', { class: 'bad' }, ' (not battle-ready)') : ''),
        el('button', {
          class: 'btn btn-fight', disabled: !bug?.isBattleReady,
          onclick: () => this.confirm('Enter the tournament?', `${bug.name} will be locked in: no upgrades or part swaps until you win or are eliminated.`,
            () => this.act(() => eco.enterTournament(), 'Entered! Good luck, pilot.')),
        }, 'ENTER TOURNAMENT'));
      return wrap;
    }

    const opp = eco.tournamentOpponent;
    const mine = s.getVehicle(t.vehicleId);
    wrap.append(
      el('p', {}, 'Your entrant: ', el('strong', {}, mine?.name ?? '—'), ` (${Math.round((mine?.condition ?? 0) * 100)}% condition). Repairs are allowed on the hoist.`),
      opp ? this.challengerCard(opp, {
        ready: mine?.isBattleReady,
        label: opp.roundName,
        onFight: () => this.onFight(opp, { tournament: true }),
      }) : null,
      el('button', {
        class: 'btn btn-small btn-danger',
        onclick: () => this.confirm('Withdraw?', 'You forfeit your place and must start from the Quarter-Final next time.', () => this.act(() => eco.withdrawTournament(), 'Withdrawn from the tournament')),
      }, 'Withdraw'),
    );
    return wrap;
  }
}
