import { ECONOMY, WEAPON_CLASSES } from '../config/constants.js';
import { formatMoney } from '../systems/EconomyManager.js';
import { el, toast, hpBar, partCard, openModal, closeModal, counterpart, vehicleCompare } from './WorkshopUI.js';

const TABS = [
  ['challengers', 'Challenger Board'],
  ['hangar', 'Hangar'],
  ['market', 'Marketplace'],
  ['staff', 'Staff'],
  ['tournament', 'Tournament'],
];

const MARKET_CATEGORIES = [
  ['engine', 'Propulsion', 'Motors & power cores. Drive force, RPM (top speed) and cooling.'],
  ['weapon', 'Weapons', 'Hardpoint-mounted weapons. Every activation costs stamina.'],
  ['tires', 'Running Gear', 'Tires & treads. Grip limit and top speed.'],
  ['chassis', 'Chassis', 'Whole vehicles — each frame comes with its fitted parts.'],
  ['armor', 'Armour', 'Plating that soaks impact damage before it reaches the hull.'],
];

function streakText(n = 0) {
  if (n > 0) return `W${n}`;
  if (n < 0) return `L${-n}`;
  return '—';
}

/**
 * The Terminal: hangar, marketplace, challenger board, staff office and
 * tournament desk. Also renders the top status bar.
 */
export class TerminalUI {
  constructor(root, header, tabbar, { state, economy, sprite, onFight, onNewGame }) {
    this.root = root;
    this.header = header;
    this.tabbar = tabbar;
    this.marketCat = 'engine';
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
    const newCount = this.state.newVehicleIds.size;
    this.tabbar.replaceChildren(el('div', { class: 'tabs', role: 'tablist' },
      TABS.map(([key, label]) => el('button', {
        class: `tab${this.tab === key ? ' active' : ''}${key === 'tournament' && this.economy.tournamentUnlocked ? ' glow' : ''}`,
        role: 'tab',
        'aria-selected': this.tab === key ? 'true' : 'false',
        onclick: () => this.setTab(key),
      }, label, key === 'hangar' && newCount ? el('span', { class: 'tab-count' }, `${newCount} NEW`) : null))));
    this.root.replaceChildren(el('div', { class: 'terminal-body' }, body));
    // The hoist and its stats belong to the Hangar; other tabs get the full width.
    this.root.closest('#workshop-screen')?.classList.toggle('no-hoist', this.tab !== 'hangar');
    const tb = this.root.querySelector('.terminal-body');
    if (tb) tb.scrollTop = this.keepScroll ? scroll : 0;
    this.keepScroll = true;
  }

  setTab(key) {
    this.tab = key;
    this.keepScroll = false;
    this.render();
  }

  renderHeader() {
    const s = this.state;
    const cw = Math.min(s.record.challengerWins, ECONOMY.TOURNAMENT_UNLOCK_WINS);
    this.header.replaceChildren(
      el('div', { class: 'logo' }, 'BATTLE', el('span', {}, 'BUGS')),
      el('div', { class: 'hud-stats' },
        el('div', { class: 'stat money' }, el('small', {}, 'Capital'), el('strong', {}, formatMoney(s.money))),
        el('div', { class: 'stat' }, el('small', {}, 'Record W·L·D'), el('strong', {}, `${s.record.wins}·${s.record.losses}·${s.record.ties}`)),
        s.fine ? el('div', { class: 'stat fine-chip', title: 'Match-fixing fine' }, el('small', {}, 'Fine due'),
          el('strong', {}, `${formatMoney(s.fine.amount)} · ${s.fine.battlesLeft} left`)) : null,
        el('div', { class: 'stat' }, el('small', {}, 'Streak'), el('strong', {}, streakText(s.record.streak))),
        el('div', { class: 'stat' }, el('small', {}, 'Tournament'),
          el('strong', {}, s.gameComplete ? '★ CHAMPION' : s.tournament.entered ? `Round ${s.tournament.round + 1}/${ECONOMY.TOURNAMENT_ROUNDS}` : `${cw}/${ECONOMY.TOURNAMENT_UNLOCK_WINS} wins`)),
      ),
    );
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
        el('button', { class: 'btn btn-primary', onclick: () => this.setTab('tournament') }, 'Go to Tournament'));
    }
    if (!s.challengers.length) this.economy.generateChallengers();
    const ready = active?.isBattleReady;
    const walked = s.board.rejected;
    return el('div', {},
      el('p', { class: 'muted' }, 'Pick a challenger and agree the stakes: haggle over ', el('strong', {}, 'cash'),
        ', or play for ', el('strong', {}, 'titles'), ' — winner drives off in the loser\'s vehicle. Your fighter: ',
        el('strong', {}, active ? active.name : '—'), active && !ready ? el('span', { class: 'bad' }, ' (not battle-ready)') : ''),
      !active ? el('div', { class: 'notice notice-warn' }, 'You have no vehicle. Buy one from Marketplace › Chassis.',
        el('button', { class: 'btn btn-primary', onclick: () => { this.marketCat = 'chassis'; this.setTab('market'); } }, 'Go to Chassis')) : null,
      s.board.tierShift ? el('p', { class: 'small warn-text' }, `▲ The board has scrolled up ${s.board.tierShift} difficulty level${s.board.tierShift > 1 ? 's' : ''} after everyone walked off.`) : null,
      walked.length ? el('p', { class: 'small muted' }, `Walked off (back after your next fight): ${walked.map((c) => c.bug.pilot?.name || c.bug.name).join(', ')}`) : null,
      el('div', { class: 'card-grid' }, s.challengers.map((c) => this.challengerCard(c, { ready, label: c.rookie ? 'ROOKIE · EASY' : null }))));
  }

  challengerCard(c, { ready, onFight, label }) {
    const bug = c.bug;
    const eco = this.economy;
    const deal = c.nego?.deal;
    let foot;
    if (onFight) {
      foot = el('div', { class: 'card-foot' },
        el('div', { class: 'bounty' }, el('small', {}, 'Purse'), el('strong', {}, formatMoney(c.bounty))),
        el('button', { class: 'btn btn-fight', disabled: !ready, onclick: onFight }, 'FIGHT'));
    } else if (deal) {
      const affordable = deal.type !== 'cash' || this.state.money >= deal.amount;
      foot = el('div', { class: 'card-foot' },
        el('div', { class: 'bounty' }, el('small', {}, 'Agreed stakes'), el('strong', {}, deal.type === 'cash' ? formatMoney(deal.amount) : 'TITLES')),
        el('div', { class: 'part-actions' },
          el('button', { class: 'btn btn-small', onclick: () => this.act(() => eco.cancelDeal(c)) }, 'Renegotiate'),
          el('button', { class: 'btn btn-fight', disabled: !ready || !affordable, onclick: () => this.fight(c, { tournament: false }) }, 'FIGHT')));
    } else {
      foot = el('div', { class: 'card-foot card-foot-end' },
        el('div', { class: 'part-actions' },
          el('button', { class: 'btn btn-small btn-primary', disabled: !ready, onclick: () => this.openNegotiation(c) }, 'Wager cash'),
          el('button', { class: 'btn btn-small btn-danger', disabled: !ready, onclick: () => this.askTitles(c) }, 'Play for titles')));
    }
    return el('article', { class: `card challenger${deal ? ' has-deal' : ''}` },
      el('div', { class: 'card-row' },
        this.sprite.renderThumbnail(bug, 88),
        el('div', { class: 'card-info' },
          label || c.matched ? el('div', { class: 'badges' },
            label ? el('span', { class: 'badge badge-gold' }, label) : null,
            c.matched ? el('span', { class: 'badge badge-match', title: 'Rated close to your best vehicle' }, 'EVEN MATCH') : null) : null,
          el('h2', { class: 'pilot-name' }, this.pilotName(c)),
          el('div', { class: 'bug-subtitle' }, `in the ${bug.name}`),
          bug.pilot ? el('div', { class: 'muted small' }, `of ${bug.pilot.planet}`) : null,
          el('div', { class: 'tier' }, '★'.repeat(c.tier), el('span', { class: 'dim' }, '★'.repeat(5 - c.tier))),
          el('div', { class: 'small muted' }, `${bug.chassis.name} · ${Math.round(bug.condition * 100)}% condition`))),
      vehicleCompare(bug, this.state.activeBug, { neutral: true }),
      this.weaponChips(bug),
      foot,
    );
  }

  pilotName(c) {
    return c.bug.pilot?.name || c.bug.name;
  }

  // ───────────── Pre-fight: manager's bet ─────────────
  /** With a manager on staff, set this fight's betting limit before the bell. */
  fight(c, opts) {
    const s = this.state;
    if (!s.staff.manager) {
      this.onFight(c, opts);
      return;
    }
    const eco = this.economy;
    const bug = opts.tournament ? s.getVehicle(s.tournament.vehicleId) : s.activeBug;
    const deal = opts.tournament ? null : c.nego?.deal;
    const reserved = deal?.type === 'cash' ? deal.amount : 0;
    let pct = s.managerBetPct;

    const preview = el('div', { class: 'bet-preview' });
    const pctLabel = el('strong', {});
    const update = () => {
      const plan = eco.planManagerBet(c, bug, reserved, pct);
      const side = plan.side === 'win' ? 'WIN' : 'LOSE';
      pctLabel.textContent = `${Math.round(pct * 100)}%`;
      preview.replaceChildren(...[
        el('div', {}, 'Your manager fancies you to ', el('strong', { class: plan.side === 'win' ? 'good' : 'bad' }, side)),
        plan.stake >= 1
          ? el('div', {}, `Bet: ${formatMoney(plan.stake)} on you to ${side} → pays ${formatMoney(plan.stake * plan.mult)} if right.`)
          : el('div', { class: 'muted' }, pct <= 0 ? 'No bet this fight.' : 'Not confident enough either way to bet.'),
        plan.side === 'lose' && plan.stake >= 1 && s.fixStreak >= ECONOMY.FIXING_WARNING
          ? el('div', { class: 'muted small' }, 'Word around the pits is this is starting to look like match-fixing… anyway.') : null,
      ].filter(Boolean));
    };
    const slider = el('input', {
      type: 'range', min: 0, max: Math.round(ECONOMY.MANAGER_BET_MAX * 100), step: 5, value: Math.round(pct * 100),
      'aria-label': 'Manager betting limit for this fight',
      oninput: (e) => { pct = Number(e.target.value) / 100; update(); },
    });
    update();
    openModal(`Pre-fight · ${this.pilotName(c)}`, el('div', { class: 'nego' },
      el('p', {}, 'Stakes: ', el('strong', {}, opts.tournament ? `Tournament purse ${formatMoney(c.bounty)}` : deal?.type === 'titles' ? 'TITLES' : formatMoney(deal?.amount ?? 0))),
      el('h3', {}, "Manager's betting limit for this fight"),
      el('div', { class: 'slider-row' }, slider, pctLabel),
      el('p', { class: 'small muted' }, `Share of your spare cash (${formatMoney(Math.max(0, s.money - reserved))}) the manager may bet — 0% means no bet. Default ${Math.round(s.managerBetPct * 100)}% (Staff tab).`),
      preview,
      el('div', { class: 'part-actions' },
        el('button', { class: 'btn btn-fight', onclick: () => { closeModal(); this.onFight(c, { ...opts, betPct: pct }); } }, 'FIGHT'))));
  }

  // ───────────── Stakes ─────────────
  /** Flash the outcome of a rejection (walk-off, board scroll, a return). */
  announce(r) {
    toast(r.message, r.status === 'reject' ? 'bad' : 'good');
    if (r.scrolled) toast('Everyone walked off — the board scrolls up: tougher challengers arrive!', 'bad');
    if (r.returned) toast(`${r.returned.bug.pilot?.name || r.returned.bug.name} has come back to the board.`, 'good');
  }

  /** Pink slips: straight to the challenger's answer — and the ring if they say yes. */
  askTitles(c) {
    const r = this.economy.offerTitles(c);
    this.announce(r);
    this.state.commit();
    if (r.status === 'accept') this.fight(c, { tournament: false });
  }

  openNegotiation(c) {
    const eco = this.economy;
    const s = this.state;
    const n = eco.nego(c);
    const who = this.pilotName(c);
    const onBoard = s.challengers.includes(c);
    const max = Math.max(1, s.money);
    // Slider starts on their counter-offer, or everything you have if you can't cover it.
    const start = n.counter != null ? Math.min(n.counter, max) : Math.min(max, Math.round(c.bounty / 10) * 10 || 10);
    const amountLabel = el('strong', { class: 'wager-amount' }, formatMoney(start));
    const offerBtn = el('button', { class: 'btn btn-primary', type: 'submit' });
    const setLabel = (v) => {
      amountLabel.textContent = formatMoney(v);
      offerBtn.textContent = n.counter != null && v === n.counter ? `Accept ${formatMoney(v)}` : `Offer ${formatMoney(v)}`;
    };
    const slider = el('input', {
      type: 'range', min: 1, max, step: 1, value: start, class: 'wager-slider',
      'aria-label': 'Your offer',
      oninput: (e) => setLabel(Number(e.target.value)),
    });
    setLabel(start);
    const offer = (amount) => {
      try {
        const r = eco.offerCash(c, Number(amount));
        s.commit();
        if (r.status === 'accept') {
          // Deal struck — straight into the ring (via the manager's window, if any).
          closeModal();
          toast(r.message, 'good');
          this.fight(c, { tournament: false });
          return;
        }
        if (r.status === 'reject') this.announce(r);
        this.openNegotiation(c);
      } catch (err) {
        toast(err.message, 'bad');
      }
    };

    const body = el('div', { class: 'nego' },
      el('div', { class: 'card-row' },
        this.sprite.renderThumbnail(c.bug, 64),
        el('div', { class: 'card-info' },
          el('h2', { class: 'pilot-name' }, who),
          el('div', { class: 'bug-subtitle' }, `in the ${c.bug.name}`))),
      el('div', { class: 'nego-log' }, n.log.length
        ? n.log.map((m) => el('div', { class: `msg msg-${m.who}` }, el('small', {}, m.who === 'you' ? 'You' : who), m.text))
        : el('div', { class: 'muted small' }, `Name your stake — you'll have to read ${who} yourself. Push a ridiculous number twice and they may walk off.`)),
    );

    if (!onBoard) {
      body.append(el('div', { class: 'notice notice-warn' }, `${who} has walked off the board.`),
        el('button', { class: 'btn', onclick: closeModal }, 'Close'));
    } else {
      if (n.counter != null && n.counter > s.money) {
        body.append(el('p', { class: 'small bad' }, `You can't cover their ${formatMoney(n.counter)} — the slider is set to everything you have.`));
      }
      body.append(
        el('form', {
          class: 'wager-form',
          onsubmit: (e) => { e.preventDefault(); offer(slider.value); },
        }, el('div', { class: 'wager-row' }, amountLabel, el('span', { class: 'muted small' }, `of ${formatMoney(s.money)}`)), slider, offerBtn),
      );
    }
    openModal(`Stakes · ${who}`, body);
  }

  // ───────────── Hangar ─────────────
  renderHangar() {
    const s = this.state;
    const wrap = el('div', {});
    if (!s.vehicles.length) {
      wrap.append(el('div', { class: 'notice notice-warn' },
        `Your hangar is empty. Buy a replacement from Marketplace › Chassis (from ${formatMoney(ECONOMY.MIN_VEHICLE_PRICE)}). Sell spare parts to raise cash.`,
        el('button', { class: 'btn btn-primary', onclick: () => { this.marketCat = 'chassis'; this.setTab('market'); } }, 'Go to Chassis')));
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
      compareTo: p.type === 'chassis' ? undefined : counterpart(this.state.activeBug, p),
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

    const isNew = s.newVehicleIds.has(bug.id);
    const card = el('article', { class: `card vehicle${isActive ? ' active' : ''}${isNew ? ' is-new' : ''}` },
      el('div', { class: 'card-row' },
        this.sprite.renderThumbnail(bug, 80),
        el('div', { class: 'card-info' },
          isActive ? el('span', { class: 'badge' }, 'ACTIVE') : null,
          isNew ? el('span', { class: 'badge badge-gold' }, 'NEW · CAPTURED') : null,
          locked ? el('span', { class: 'badge badge-lock' }, '🔒 ENTERED') : null,
          nameNode,
          el('div', { class: 'small muted' }, bug.chassis.name),
          hpBar(bug.condition, { label: `Condition ${Math.round(bug.condition * 100)}%` }),
          bug.isBattleReady ? null : el('div', { class: 'small bad' }, bug.battleIssues()[0]))),
      vehicleCompare(bug, s.activeBug),
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
    const active = s.activeBug;
    const cat = this.marketCat;
    const [, catLabel, catBlurb] = MARKET_CATEGORIES.find(([k]) => k === cat);
    const dealBadge = (l) => (manager && this.economy.isRareDeal(l) ? el('span', { class: 'badge badge-gold' }, '★ RARE DEAL') : null);

    const countFor = (key) => (key === 'chassis'
      ? s.market.vehicles.length
      : s.market.parts.filter((l) => l.part.type === key).length);
    const spares = cat === 'chassis'
      ? s.vehicles.filter((v) => v.id !== s.activeVehicleId && !s.isLocked(v))
      : s.inventory.filter((p) => p.type === cat);

    const subnav = el('div', { class: 'subtabs', role: 'tablist' }, MARKET_CATEGORIES.map(([key, label]) => el('button', {
      class: `subtab${key === cat ? ' active' : ''}`,
      role: 'tab',
      'aria-selected': key === cat ? 'true' : 'false',
      onclick: () => { this.marketCat = key; this.keepScroll = false; this.render(); },
    }, label, el('span', { class: 'subtab-count' }, countFor(key)))));

    let forSale;
    if (cat === 'chassis') {
      forSale = el('div', { class: 'card-grid' }, s.market.vehicles.map((l) => el('article', { class: 'card vehicle' },
        el('div', { class: 'card-row' },
          this.sprite.renderThumbnail(l.bug, 80),
          el('div', { class: 'card-info' },
            dealBadge(l),
            el('h3', {}, l.bug.name),
            el('div', { class: 'small muted' }, l.bug.chassis.name),
            hpBar(l.bug.condition, { label: `Condition ${Math.round(l.bug.condition * 100)}%` }))),
        vehicleCompare(l.bug, active),
        this.weaponChips(l.bug),
        el('div', { class: 'card-foot' },
          el('div', { class: 'bounty' }, el('small', {}, 'Price'), el('strong', {}, formatMoney(l.price))),
          el('button', { class: 'btn btn-primary', disabled: s.money < l.price, onclick: () => this.act(() => this.economy.buyVehicleListing(l.id), `${l.bug.name} added to your hangar`) }, 'Buy')))));
    } else {
      forSale = el('div', { class: 'card-grid parts' }, s.market.parts.filter((l) => l.part.type === cat).map((l) => partCard(l.part, this.economy, {
        compareTo: counterpart(active, l.part),
        extra: dealBadge(l),
        actions: [el('button', {
          class: 'btn btn-small btn-primary', disabled: s.money < this.economy.partPrice(l),
          onclick: () => this.act(() => this.economy.buyPartListing(l.id), `Bought ${l.part.name}`),
        }, `Buy ${formatMoney(this.economy.partPrice(l))}`),
        s.staff.mechanic ? el('span', { class: 'small muted' }, el('s', {}, formatMoney(l.price)), ' mechanic −10%') : null],
      })));
    }

    const sellCards = cat === 'chassis'
      ? spares.map((bug) => el('article', { class: 'card vehicle' },
        el('div', { class: 'card-row' },
          this.sprite.renderThumbnail(bug, 64),
          el('div', { class: 'card-info' },
            el('h3', {}, bug.name),
            el('div', { class: 'small muted' }, bug.chassis.name),
            hpBar(bug.condition, { label: `Condition ${Math.round(bug.condition * 100)}%` }))),
        el('div', { class: 'part-actions' },
          el('button', {
            class: 'btn btn-small btn-danger', disabled: s.vehicles.length <= 1,
            onclick: () => this.confirm(`Sell ${bug.name}?`, `You'll receive ${formatMoney(this.economy.vehicleSellPrice(bug))}.`,
              () => this.act(() => this.economy.sellVehicle(bug.id), (v) => `Sold for ${formatMoney(v)}`)),
          }, `Sell ${formatMoney(this.economy.vehicleSellPrice(bug))}`))))
      : spares.map((p) => this.sellPartCard(p));

    return el('div', { class: 'market' },
      subnav,
      el('p', { class: 'muted' }, catBlurb, ' Stock rotates after every bout. ',
        s.staff.mechanic && cat !== 'chassis' ? 'Your mechanic gets 10% off parts. ' : '',
        manager ? 'Your manager is flagging rare deals.' : 'Hire a manager to have rare deals flagged.'),
      el('h3', {}, `${catLabel} for sale`),
      forSale.childElementCount ? forSale : el('p', { class: 'muted' }, 'Sold out — new stock arrives after your next bout.'),
      el('h3', {}, cat === 'chassis' ? `Sell your vehicles (${spares.length})` : `Sell your spare ${catLabel.toLowerCase()} (${spares.length})`),
      spares.length
        ? el('div', { class: cat === 'chassis' ? 'card-grid' : 'card-grid parts' }, sellCards)
        : el('p', { class: 'muted small' }, cat === 'chassis'
          ? 'Only your hoist vehicle is in the hangar. Win or buy more to sell.'
          : `No spares. Remove parts on the hoist or strip a vehicle to sell them here. Buyers pay ${Math.round(ECONOMY.SELL_RATE * 100)}% of value × condition.`),
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
          'Repairs your active vehicle after each bout as far as funds allow, and gets you 10% off parts and repairs.', '🔧'),
        staffCard('manager', 'Manager', ECONOMY.MANAGER_HIRE, ECONOMY.MANAGER_WAGE,
          'Bets on your fights, sells broken scrap at peak value (double scrap rate) and flags rare Marketplace deals.', '📈')),
      s.staff.manager ? this.renderBetting() : null,
      s.fine ? this.renderFine() : null,
      el('h3', {}, 'Recent log'),
      el('ul', { class: 'log' }, s.log.slice(-10).reverse().map((l) => el('li', {}, l.msg))),
      el('h3', {}, 'Office'),
      el('button', {
        class: 'btn btn-danger',
        onclick: () => this.confirm('Start a new game?', 'This wipes your save: vehicles, money and progress.', () => this.onNewGame()),
      }, 'New game (wipe save)'),
    );
  }

  renderBetting() {
    const s = this.state;
    const pct = Math.round(s.managerBetPct * 100);
    const label = el('strong', {}, `${pct}% (up to ${formatMoney(s.money * s.managerBetPct)})`);
    const slider = el('input', {
      type: 'range', min: 0, max: Math.round(ECONOMY.MANAGER_BET_MAX * 100), step: 5, value: pct,
      'aria-label': 'Manager betting limit',
      oninput: (e) => { label.textContent = `${e.target.value}% (up to ${formatMoney((s.money * e.target.value) / 100)})`; },
      onchange: (e) => this.act(() => { s.managerBetPct = Number(e.target.value) / 100; }),
    });
    return el('div', { class: 'card betting' },
      el('h3', {}, 'Default manager betting limit'),
      el('p', { class: 'small' }, 'Before each fight your manager bets up to this share of your spare cash — on you to win, or on you to lose, whichever they believe. The stronger their conviction, the bigger the bet. You can adjust the limit for each fight on the pre-fight screen.'),
      el('div', { class: 'slider-row' }, slider, label),
      el('p', { class: 'small muted' }, "Set it to 0% and the manager won't bet."));
  }

  renderFine() {
    const f = this.state.fine;
    return el('div', { class: 'notice notice-warn fine' },
      el('strong', {}, `🚨 Match-fixing fine: ${formatMoney(f.amount)} outstanding`),
      el('span', {}, `Pay within ${f.battlesLeft} more battle${f.battlesLeft === 1 ? '' : 's'} or it's game over.`),
      el('div', { class: 'part-actions' },
        el('button', { class: 'btn btn-primary', disabled: this.state.money < 1, onclick: () => this.act(() => this.economy.payFine(), (v) => `Paid ${formatMoney(v)} towards the fine`) },
          this.state.money >= f.amount ? `Pay ${formatMoney(f.amount)}` : `Pay what you can (${formatMoney(this.state.money)})`)));
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
      wrap.append(...[
        t.eliminated ? el('p', { class: 'bad' }, 'You were eliminated last time. Regroup, upgrade and try again.') : null,
        el('p', {}, 'Entering with: ', el('strong', {}, bug?.name ?? '—'), bug && !bug.isBattleReady ? el('span', { class: 'bad' }, ' (not battle-ready)') : ''),
        el('button', {
          class: 'btn btn-fight', disabled: !bug?.isBattleReady,
          onclick: () => this.confirm('Enter the tournament?', `${bug.name} will be locked in: no upgrades or part swaps until you win or are eliminated.`,
            () => this.act(() => eco.enterTournament(), 'Entered! Good luck, pilot.')),
        }, 'ENTER TOURNAMENT')].filter(Boolean));
      return wrap;
    }

    const opp = eco.tournamentOpponent;
    const mine = s.getVehicle(t.vehicleId);
    wrap.append(...[
      el('p', {}, 'Your entrant: ', el('strong', {}, mine?.name ?? '—'), ` (${Math.round((mine?.condition ?? 0) * 100)}% condition). Repairs are allowed on the hoist.`),
      opp ? this.challengerCard(opp, {
        ready: mine?.isBattleReady,
        label: opp.roundName,
        onFight: () => this.fight(opp, { tournament: true }),
      }) : null,
      el('button', {
        class: 'btn btn-small btn-danger',
        onclick: () => this.confirm('Withdraw?', 'You forfeit your place and must start from the Quarter-Final next time.', () => this.act(() => eco.withdrawTournament(), 'Withdrawn from the tournament')),
      }, 'Withdraw'),
    ].filter(Boolean));
    return wrap;
  }
}
