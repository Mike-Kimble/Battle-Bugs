import { DOHYO_KINDS } from '../systems/Dohyo.js';
import { ECONOMY, WEAPON_CLASSES } from '../config/constants.js';
import { formatMoney } from '../systems/EconomyManager.js';
import { PARTS, RARITY } from '../config/partsData.js';
import { el, toast, hpBar, partCard, openModal, closeModal, counterpart, vehicleCompare } from './WorkshopUI.js';

const TABS = [
  ['hangar', 'Hangar'],
  ['market', 'Marketplace'],
  ['challengers', 'Challenger Board'],
  ['staff', 'Admin'],
  ['tournament', 'Tournament'],
];

const MARKET_CATEGORIES = [
  ['engine', 'Propulsion', 'Motors & power cores. Power, revs (top speed) and cooling.'],
  ['weapon', 'Weapons', 'Hardpoint-mounted weapons. Every activation costs stamina.'],
  ['tires', 'Running Gear', 'Driven tyres & tracks (need a drive shaft), and gliding castors (need thrust: a turbine or plasma drive, or a propeller or ducted fan).'],
  ['chassis', 'Chassis', 'Whole vehicles — each frame comes with its fitted parts.'],
  ['armor', 'Armour', 'Plating that soaks impact damage before it reaches the hull.'],
  ['sell', 'Sell', 'Every spare component in your inventory, ready to sell.'],
];

const PART_GROUPS = [['engine', 'Drive'], ['cooling', 'Cooling'], ['enhancement', 'Enhancements'], ['drivetrain', 'Drive Train'], ['weapon', 'Weapons'], ['tires', 'Running Gear'], ['armor', 'Armour']];

/** Propulsion splits into three aisles. */
const PROPULSION_SUBS = [
  ['engine', 'Drive', 'Motors & power cores. Power, revs (top speed) and cooling.'],
  ['cooling', 'Cooling', 'Heat exchangers, misters, radiators, fans, jackets… Three cooling slots. Not everything suits every drive.'],
  ['enhancement', 'Enhancement', 'Turbos, nitro, afterburners… One enhancement slot per drive. Not everything suits every drive.'],
  ['drivetrain', 'Drive Train', 'Gearboxes, shafts, props, rudders and diffs. Four drive-train slots. Some suit thrust drives, some shaft drives — and some combos work far better together.'],
];
/** Categories with their own aisles, keyed by the top-level tab. */
const SUB_AISLES = { engine: PROPULSION_SUBS };
/** Castors sit in the Running Gear aisle alongside tyres. */
const aisleOf = (part) => (part.type === 'castor' ? 'tires' : part.type);
const aisleGroup = (cat) => Object.keys(SUB_AISLES).find((g) => SUB_AISLES[g].some(([k]) => k === cat)) || null;

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
    this.tab = 'hangar';
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
        class: `tab${this.tab === key ? ' active' : ''}${(key === 'tournament' && this.economy.tournamentUnlocked) || (key === 'staff' && Object.keys(this.state.arrears).length) ? ' glow' : ''}`,
        role: 'tab',
        'aria-selected': this.tab === key ? 'true' : 'false',
        onclick: () => this.setTab(key),
      }, label, key === 'hangar' && newCount ? el('span', { class: 'tab-count' }, `${newCount} NEW`) : null))));
    this.root.replaceChildren(el('div', { class: 'terminal-body' }, body));
    // The Hangar tab is the hoist alone (swipe between vehicles); every other tab is the terminal alone.
    const ws = this.root.closest('#workshop-screen');
    ws?.classList.toggle('no-hoist', this.tab !== 'hangar');
    ws?.classList.toggle('hangar-mode', this.tab === 'hangar');
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
      el('div', { class: 'logo' }, 'WEEVIL', el('span', {}, 'WARS')),
      el('div', { class: 'hud-stats' },
        el('div', { class: 'stat money' }, el('small', {}, 'Capital'), el('strong', {}, formatMoney(s.money))),
        el('div', { class: 'stat' }, el('small', {}, 'Record W·L·D'), el('strong', {}, `${s.record.wins}·${s.record.losses}·${s.record.ties}`)),
        s.fine ? el('div', { class: 'stat fine-chip', title: 'Match-fixing fine' }, el('small', {}, 'Fine due'),
          el('strong', {}, `${formatMoney(s.fine.amount)} · ${s.fine.battlesLeft} left`)) : null,
        s.season > 1 ? el('div', { class: 'stat' }, el('small', {}, 'Season'), el('strong', {}, `${s.season}${s.titles ? ` · ${'★'.repeat(Math.min(s.titles, 5))}` : ''}`)) : null,
        el('div', { class: 'stat' }, el('small', {}, 'Streak'), el('strong', {}, streakText(s.record.streak))),
        el('div', { class: 'stat' }, el('small', {}, 'Tournament'),
          el('strong', {}, s.gameComplete ? '★ CHAMPION' : s.tournament.entered ? `IN THE FIELD · R${s.tournament.round + 1}/${ECONOMY.TOURNAMENT_ROUNDS}` : `${cw}/${ECONOMY.TOURNAMENT_UNLOCK_WINS} wins`)),
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
      this.economy.tournamentReady ? el('div', { class: 'notice notice-gold' },
        `📈 Manager: "You're good enough for the Tournament, and you can cover the ${formatMoney(ECONOMY.TOURNAMENT_FEE)} entry with change to spare. I'd enter."`,
        el('button', { class: 'btn btn-small btn-primary', onclick: () => this.setTab('tournament') }, 'Go to Tournament')) : null,
      el('p', { class: 'muted' }, 'Pick a challenger and agree the stakes: haggle over ', el('strong', {}, 'cash'),
        ', or play for ', el('strong', {}, 'titles'), ' — winner drives off in the loser\'s vehicle. Your fighter: ',
        el('strong', {}, active ? active.name : '—'), active && !ready ? el('span', { class: 'bad' }, ' (not battle-ready)') : ''),
      !active ? el('div', { class: 'notice notice-warn' }, 'You have no vehicle. Buy one from Marketplace › Chassis.',
        el('button', { class: 'btn btn-primary', onclick: () => { this.marketCat = 'chassis'; this.setTab('market'); } }, 'Go to Chassis')) : null,
      active && !ready ? el('div', { class: 'notice notice-warn' },
        el('strong', {}, `${active.name} isn't ready to fight:`),
        el('ul', { class: 'issues' }, active.battleIssues().map((i) => el('li', {}, i))),
        el('div', { class: 'part-actions' },
          !active.engine ? el('button', { class: 'btn btn-primary', onclick: () => { this.marketCat = 'engine'; this.setTab('market'); } }, 'Buy a motor') : null,
          el('button', { class: 'btn', onclick: () => this.setTab('hangar') }, 'Open the Hangar'))) : null,
      el('p', { class: 'small muted' }, this.economy.nextIsHome
        ? '🏠 Next bout is at HOME — your Dohyo 1 (Classic). After that, away at theirs.'
        : '✈ Next bout is AWAY — on your opponent\'s home dohyo. Then back home.'),
      s.board.tierShift ? el('p', { class: 'small warn-text' }, `▲ The board has scrolled up ${s.board.tierShift} difficulty level${s.board.tierShift > 1 ? 's' : ''} after everyone walked off.`) : null,
      walked.length ? el('p', { class: 'small muted' }, `Walked off (back after your next fight): ${walked.map((c) => this.pilotName(c)).join(', ')}`) : null,
      el('div', { class: 'card-grid' }, s.challengers.map((c) => this.challengerCard(c, { ready }))));
  }

  challengerCard(c, { ready, onFight, label }) {
    const bug = c.bug;
    const eco = this.economy;
    const deal = c.nego?.deal;
    let foot;
    if (onFight) {
      foot = el('div', { class: 'card-foot' },
        el('div', { class: 'bounty' }, el('small', {}, 'Grand prize (win the final)'), el('strong', {}, formatMoney(ECONOMY.TOURNAMENT_PRIZE))),
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
        el('button', { class: 'btn btn-small btn-primary', disabled: !ready, onclick: () => this.openChat(c) }, 'Message'));
    }
    const story = c.story ? c.story.replaceAll('{name}', c.name).replaceAll('{planet}', c.planet).replaceAll('{bug}', `${bug.name}`) : null;
    return el('article', { class: `card challenger${deal ? ' has-deal' : ''}` },
      el('div', { class: 'card-row challenger-head' },
        this.sprite.renderPortrait(c, 72),
        el('div', { class: 'card-info' },
          label ? el('div', { class: 'badges' }, el('span', { class: 'badge badge-gold' }, label)) : null,
          el('h2', { class: 'pilot-name' }, this.pilotTitle(c)),
          el('div', { class: 'bug-subtitle' }, bug.name),
          el('div', { class: 'tier', title: 'Ranking' }, '★'.repeat(c.tier), el('span', { class: 'dim' }, '★'.repeat(5 - c.tier))),
          c.record ? el('div', { class: 'pilot-record' }, `Record ${c.record.w}W – ${c.record.l}L`) : null,
          this.venueLine(c)),
        this.sprite.renderThumbnail(bug, 72)),
      story ? el('p', { class: 'pilot-story' }, story) : null,
      onFight ? null : this.managerHunch(bug),
      this.weaponChips(bug),
      foot,
    );
  }

  /** Bare chassis, rolling chassis, semi-complete or complete. */
  vehicleKind(bug) {
    if (bug.parts.length === 1) return 'bare chassis';
    if (bug.parts.length === 2 && bug.tires) return 'rolling chassis';
    return bug.isBattleReady ? 'complete' : 'semi-complete';
  }

  /** Home dohyo, and where the next bout against them would be. */
  venueLine(c) {
    const home = c.home || 1;
    const venue = this.economy.venueFor(c);
    const at = this.economy.nextIsHome ? 'home' : 'away';
    return el('div', { class: 'small muted venue' }, `Home: Dohyo ${home} ${DOHYO_KINDS[home].name} · next bout ${at}: Dohyo ${venue} ${DOHYO_KINDS[venue].name}`);
  }

  /** With a manager, a word in your ear when a bug hides something special. */
  managerHunch(bug) {
    if (!this.state.staff.manager) return null;
    const gem = this.economy.hiddenGem(bug);
    if (!gem) return null;
    const where = { engine: 'under the hood', tires: 'in the running gear', armor: 'in the plating', weapon: 'in the weapons', chassis: 'in the frame' }[gem.type];
    return el('p', { class: `small manager-hunch rarity-${gem.rarity}` },
      `🕵 Manager: "Word is there's something ${gem.rarity === 'legendary' ? 'legendary' : 'special'} ${where} of this one."`);
  }

  pilotName(c) {
    return c.name || c.bug.pilot?.name || c.bug.name;
  }

  /** "Name of Planet". */
  pilotTitle(c) {
    const planet = c.planet || c.bug.pilot?.planet;
    return planet ? `${this.pilotName(c)} of ${planet}` : this.pilotName(c);
  }

  // ───────────── Pre-fight: manager's bet ─────────────
  /** With a manager on staff, set this fight's betting limit before the bell. */
  fight(c, opts) {
    const s = this.state;
    const deal = opts.tournament ? null : c.nego?.deal;
    const reserved = deal?.type === 'cash' ? deal.amount : 0;
    // No betting in the tournament, and nothing to bet once the wager takes all your cash.
    if (!s.staff.manager || opts.tournament || s.money - reserved < 1) {
      this.onFight(c, opts);
      return;
    }
    const eco = this.economy;
    const bug = s.activeBug;
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
        eco.bigBetFate(plan.side, plan.stake) === 'refused'
          ? el('div', { class: 'muted small' }, 'I wonder what kind of idiots are bankrolling these bets…') : null,
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
      el('p', { class: 'small muted' }, `Share of the cash left after your wager (${formatMoney(Math.max(0, s.money - reserved))}) the manager may bet — 0% means no bet. Default ${Math.round(s.managerBetPct * 100)}% (Admin tab).`),
      preview,
      el('div', { class: 'part-actions' },
        el('button', { class: 'btn btn-fight', onclick: () => { closeModal(); this.onFight(c, { ...opts, betPct: pct }); } }, 'FIGHT'))));
  }

  // ───────────── Stakes ─────────────
  /** A DM waiting for you (your new rival's promise of revenge): shown once, answered with "We'll see". */
  showPendingDM() {
    const s = this.state;
    const dm = s.pendingDM;
    if (!dm) return;
    s.pendingDM = null;
    s.save();
    const c = s.pool.find((p) => p.id === dm.pilotId);
    if (!c) return;
    const who = this.pilotName(c);
    const header = el('div', { class: 'chat-head' },
      this.sprite.renderPortrait(c, 32),
      el('h2', { class: 'chat-name' }, who));
    const logEl = el('div', { class: 'nego-log chat-log' },
      dm.lines.map((text) => el('div', { class: 'msg msg-them' }, el('small', {}, who), text)));
    const controls = el('div', { class: 'chat-controls' },
      el('div', { class: 'chat-go' }, el('span', {}),
        el('button', { class: 'btn btn-primary', onclick: closeModal }, "We'll see")));
    openModal(`Chat · ${who}`, el('div', { class: 'nego chat' }, logEl, controls), { header, className: 'modal-chat', modal: true });
    logEl.scrollTop = logEl.scrollHeight;
  }

  /**
   * DM window with a challenger: portrait + name up top, the chat log below,
   * controls underneath. The window is built once — replies are appended to the
   * log and only the controls change. A rejection ends the chat; only ✕ closes it.
   */
  openChat(c) {
    const eco = this.economy;
    const s = this.state;
    const who = this.pilotName(c);
    let log = eco.nego(c).log;
    let ended = false;

    const logEl = el('div', { class: 'nego-log chat-log' });
    const controls = el('div', { class: 'chat-controls' });
    const backdrop = () => document.querySelector('#modal-root .modal-backdrop');

    const message = (m) => (m.who === 'system'
      ? el('div', { class: 'msg msg-system' }, m.text)
      : el('div', { class: `msg msg-${m.who}` }, el('small', {}, m.who === 'you' ? 'You' : who), m.text));
    let shown = 0;
    const renderLog = () => {
      if (!log.length) {
        logEl.replaceChildren(el('div', { class: 'muted small' }, `Say something to ${who}. Name a cash stake, or play for titles — winner takes the loser's vehicle.`));
        return;
      }
      if (shown === 0) logEl.replaceChildren();
      for (; shown < log.length; shown++) logEl.append(message(log[shown]));
      logEl.scrollTop = logEl.scrollHeight;
    };

    const renderControls = () => {
      const n = c.nego;
      if (ended) {
        controls.replaceChildren(el('p', { class: 'muted small chat-ended' }, 'Press ✕ to return to the Challenger Board.'));
        return;
      }
      if (n?.deal) {
        // They've said yes: the only thing left to do is fight.
        controls.replaceChildren(el('div', { class: 'chat-go' },
          el('span', { class: 'muted small' }, `Stakes: ${n.deal.type === 'cash' ? formatMoney(n.deal.amount) : 'TITLES'}`),
          el('button', { class: 'btn btn-fight', onclick: () => { closeModal(); this.fight(c, { tournament: false }); } }, 'Go Battle')));
        return;
      }
      const max = Math.max(1, s.money);
      // Slider starts on their counter-offer, or everything you have if you can't cover it.
      const start = n?.counter != null ? Math.min(n.counter, max) : Math.min(max, Math.round(c.bounty / 10) * 10 || 10);
      const amountLabel = el('strong', { class: 'wager-amount' });
      const offerBtn = el('button', { class: 'btn btn-primary', type: 'submit' });
      const setLabel = (v) => {
        amountLabel.textContent = formatMoney(v);
        offerBtn.textContent = n?.counter != null && v === n.counter ? `Accept ${formatMoney(v)}` : `Wager ${formatMoney(v)}`;
      };
      const slider = el('input', {
        type: 'range', min: 1, max, step: 1, value: start, class: 'wager-slider',
        'aria-label': 'Your offer',
        oninput: (e) => setLabel(Number(e.target.value)),
      });
      setLabel(start);
      const short = n?.counter != null && n.counter > s.money;
      controls.replaceChildren(el('form', {
        class: 'wager-form',
        onsubmit: (e) => { e.preventDefault(); attempt(() => eco.offerCash(c, Number(slider.value))); },
      },
      el('div', { class: 'wager-row' }, amountLabel,
        el('span', { class: `small ${short ? 'bad' : 'muted'}` }, short ? `of ${formatMoney(s.money)} — can't cover ${formatMoney(n.counter)}` : `of ${formatMoney(s.money)}`)),
      slider,
      el('div', { class: 'part-actions' },
        offerBtn,
        el('button', { class: 'btn btn-danger', type: 'button', onclick: () => attempt(() => eco.offerTitles(c)) }, 'Play for titles'))));
    };

    // Their answer is added to the log; reject ends the chat, anything else updates the controls.
    const attempt = (fn) => {
      let r;
      try { r = fn(); } catch (err) { toast(err.message, 'bad'); return; }
      s.commit();
      if (r.status === 'reject') {
        ended = true;
        log = r.log;
        const bd = backdrop();
        if (bd) bd.onclick = null; // only the ✕ closes a finished chat
        if (r.scrolled) toast('Everyone walked off — the board scrolls up: tougher challengers arrive!', 'bad');
        if (r.returned) toast(`${this.pilotName(r.returned)} has come back to the board.`, 'good');
        this.render();
      }
      renderLog();
      renderControls();
    };

    renderLog();
    renderControls();
    const header = el('div', { class: 'chat-head' },
      this.sprite.renderPortrait(c, 32),
      el('h2', { class: 'chat-name' }, who));
    openModal(`Chat · ${who}`, el('div', { class: 'nego chat' }, logEl, controls), { header, className: 'modal-chat' });
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ───────────── Hangar ─────────────
  /** The Hangar is the hoist panel (WorkshopUI); the terminal column is hidden. */
  renderHangar() {
    return el('div', {});
  }

  sellPartCard(p) {
    return partCard(p, this.economy, {
      compareTo: p.type === 'chassis' ? undefined : counterpart(this.state.activeBug, p),
      actions: [el('button', { class: 'btn btn-small', onclick: () => this.act(() => this.economy.sellPart(p.uid), (v) => `Sold ${p.name} for ${formatMoney(v)}`) },
        `${p.isScrap ? 'Scrap' : 'Sell'} ${formatMoney(this.economy.partSellPrice(p))}`)],
    });
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
    if (this.economy.inField) {
      return el('div', { class: 'notice notice-warn' },
        el('strong', {}, "You're in the field."),
        "The Marketplace is closed to tournament entrants — no buying or selling until you're champion or knocked out. Field repairs are paid for with the cash you brought.");
    }
    if (!s.market.parts.length && !s.market.vehicles.length) this.economy.generateMarket();
    const manager = s.staff.manager;
    const active = s.activeBug;
    const cat = this.marketCat;
    const group = aisleGroup(cat);
    const [, catLabel, catBlurb] = (group ? SUB_AISLES[group] : MARKET_CATEGORIES).find(([k]) => k === cat);
    const pickKey = s.staff.mechanic && s.activeBug ? this.economy.mechanicAdvice(s.activeBug).pick?.key : null;
    const dealBadge = (l) => {
      const badges = [
        l.part && l.part.key === pickKey ? el('span', { class: 'badge badge-match' }, "🔧 MECHANIC'S PICK") : null,
        l.managerFind ? el('span', { class: 'badge badge-gold' }, '★ MANAGER FOUND') : null,
        l.teaser ? el('span', { class: `badge rarity-tag rarity-${l.part.rarity}` }, "✦ DEALER'S SHOWPIECE") : null,
        manager && this.economy.isRareDeal(l) ? el('span', { class: 'badge badge-gold' }, '★ RARE DEAL') : null,
      ].filter(Boolean);
      return badges.length ? el('div', { class: 'badges' }, badges) : null;
    };

    const countFor = (key) => {
      if (key === 'sell') return s.inventory.length;
      if (key === 'chassis') return s.market.vehicles.length;
      return s.market.parts.filter((l) => aisleOf(l.part) === key).length;
    };
    const spares = cat === 'chassis'
      ? s.vehicles.filter((v) => !s.isLocked(v))
      : s.inventory.filter((p) => aisleOf(p) === cat);

    const on = (key) => key === cat || key === group;
    const topnav = el('div', { class: 'subtabs', role: 'tablist' }, MARKET_CATEGORIES.map(([key, label]) => el('button', {
      class: `subtab${on(key) ? ' active' : ''}`,
      role: 'tab',
      'aria-selected': on(key) ? 'true' : 'false',
      onclick: () => { if (key !== group) this.marketCat = key; this.keepScroll = false; this.render(); },
    }, label, el('span', { class: 'subtab-count' }, SUB_AISLES[key] ? SUB_AISLES[key].reduce((n, [k]) => n + countFor(k), 0) : countFor(key)))));
    // Aisles within a category: Propulsion (Drive · Cooling · Enhancement), Running Gear (Tyres · Castors).
    const subnav = group
      ? el('div', {}, topnav, el('div', { class: 'subtabs subtabs-2', role: 'tablist' }, SUB_AISLES[group].map(([key, label]) => el('button', {
        class: `subtab${key === cat ? ' active' : ''}`,
        role: 'tab',
        'aria-selected': key === cat ? 'true' : 'false',
        onclick: () => { this.marketCat = key; this.keepScroll = false; this.render(); },
      }, label, el('span', { class: 'subtab-count' }, countFor(key))))))
      : topnav;

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
        // Sold as seen: you can't look under the hood.
        vehicleCompare(l.bug, active, { exterior: true }),
        el('p', { class: 'small muted under-hood' }, l.bug.engine
          ? 'Under the hood: ???'
          : l.bug.tires ? 'Rolling chassis — frame and running gear, no motor. Bring your own.' : 'Empty frame — nothing fitted. A blank canvas.'),
        this.managerHunch(l.bug),
        this.weaponChips(l.bug),
        el('div', { class: 'card-foot' },
          el('div', { class: 'bounty' }, el('small', {}, 'Price'), el('strong', {}, formatMoney(l.price))),
          el('button', { class: 'btn btn-primary', disabled: s.money < l.price, onclick: () => this.act(() => this.economy.buyVehicleListing(l.id), `${l.bug.name} added to your hangar`) }, 'Buy')))));
    } else {
      forSale = el('div', { class: 'card-grid parts' }, s.market.parts.filter((l) => aisleOf(l.part) === cat).map((l) => partCard(l.part, this.economy, {
        compareTo: counterpart(active, l.part),
        extra: dealBadge(l),
        actions: [this.economy.hasFreeSlot(active, l.part.type)
          // Nothing fitted there: buy it and bolt it straight on.
          ? el('button', {
            class: 'btn btn-small btn-primary', disabled: s.money < this.economy.partPrice(l),
            onclick: () => this.act(() => this.economy.buyAndFit(l.id, active), `Bought and fitted ${l.part.name} to ${active.name}`),
          }, `Buy & fit ${formatMoney(this.economy.partPrice(l))}`)
          : el('button', {
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
            el('div', { class: 'small muted' }, `${bug.chassis.name} · ${this.vehicleKind(bug)}${bug.id === s.activeVehicleId ? ' · on the hoist' : ''}`),
            hpBar(bug.condition, { label: `Condition ${Math.round(bug.condition * 100)}%` }))),
        el('div', { class: 'part-actions' },
          el('button', {
            class: 'btn btn-small btn-danger',
            onclick: () => this.confirm(`Sell ${bug.name}?`, this.economy.sellWarning(bug),
              () => this.act(() => this.economy.sellVehicle(bug.id), (v) => `Sold for ${formatMoney(v)}`)),
          }, `Sell ${formatMoney(this.economy.vehicleSellPrice(bug))}`))))
      : spares.map((p) => this.sellPartCard(p));

    if (cat === 'sell') {
      const groups = PART_GROUPS.map(([type, label]) => [label, s.inventory.filter((p) => aisleOf(p) === type)]).filter(([, ps]) => ps.length);
      return el('div', { class: 'market' },
        subnav,
        el('p', { class: 'muted' }, catBlurb, ` Buyers pay ${Math.round(ECONOMY.SELL_RATE * 100)}% of value × condition; broken parts fetch scrap only.`),
        this.economy.hotStreak ? el('div', { class: 'notice notice-gold' }, `🔥 You're on a ${s.record.streak}-win streak — buyers want some of your secret sauce and are paying 10–20% extra.`) : null,
        groups.length
          ? groups.map(([label, ps]) => [el('h3', {}, `${label} (${ps.length})`), el('div', { class: 'card-grid parts' }, ps.map((p) => this.sellPartCard(p)))])
          : el('p', { class: 'muted' }, 'No spare components. Remove parts on the hoist or strip a vehicle to sell them here.'));
    }

    return el('div', { class: 'market' },
      subnav,
      el('p', { class: 'muted' }, catBlurb, ' Stock rotates after every bout. ',
        s.staff.mechanic && cat !== 'chassis' ? 'Your mechanic gets 10% off parts. ' : '',
        manager ? 'Your manager is flagging rare deals.' : ''),
      el('h3', {}, `${catLabel} for sale`),
      forSale.childElementCount ? forSale : el('p', { class: 'muted' }, 'Sold out — new stock arrives after your next bout.'),
      ...(cat === 'chassis' ? [
        el('h3', {}, `Sell your vehicles (${spares.length})`),
        spares.length
          ? el('div', { class: 'card-grid' }, sellCards)
          : el('p', { class: 'muted small' }, 'Your hangar is empty.'),
      ] : []),
    );
  }

  // ───────────── Staff ─────────────
  /** A missed wage: what's owed, how long you've got, and a button to pay it. */
  renderArrears(role, title) {
    const owed = this.state.arrears[role];
    const left = ECONOMY.STAFF_GRACE - owed.bouts;
    return el('div', { class: 'notice notice-warn arrears' },
      el('div', {}, el('strong', {}, `Owed ${formatMoney(owed.amount)}`),
        ` — pay within ${left} bout${left === 1 ? '' : 's'} or your ${role} quits.`),
      el('button', {
        class: 'btn btn-small btn-primary', disabled: this.state.money < owed.amount,
        onclick: () => this.act(() => this.economy.payArrears(role), (v) => `Paid your ${title.toLowerCase()} ${formatMoney(v)}`),
      }, `Pay ${formatMoney(owed.amount)}`));
  }

  renderStaff() {
    const s = this.state;
    const staffCard = (role, title, hire, wage, desc, icon) => el('article', { class: `card staff${s.staff[role] ? ' active' : ''}` },
      el('div', { class: 'staff-icon' }, icon),
      el('h3', {}, title),
      el('p', {}, desc),
      el('div', { class: 'small muted' }, `Hire fee ${formatMoney(hire)} · wage ${formatMoney(wage)} per bout`),
      s.staff[role] && s.arrears[role] ? this.renderArrears(role, title) : null,
      s.staff[role]
        ? el('button', {
          class: 'btn btn-small',
          onclick: () => (s.arrears[role]
            ? this.confirm(`Dismiss your ${title.toLowerCase()}?`, `You still owe them ${formatMoney(s.arrears[role].amount)}. Walk away without paying and word gets round: nobody will work for you for ${ECONOMY.BLACKLIST_BOUTS} bouts. And they'll want their money back, one way or another.`,
              () => this.act(() => this.economy.dismiss(role), `${title} dismissed`))
            : this.act(() => this.economy.dismiss(role), `${title} dismissed`)),
        }, 'Dismiss')
        : el('button', { class: 'btn btn-small btn-primary', disabled: s.money < hire, onclick: () => this.act(() => this.economy.hire(role), `${title} hired`) }, `Hire ${formatMoney(hire)}`));

    const eco = this.economy;
    const cards = [
      eco.staffAvailable('mechanic') ? staffCard('mechanic', 'Mechanic', ECONOMY.MECHANIC_HIRE, ECONOMY.MECHANIC_WAGE,
        'Repairs your active vehicle after each bout, can save parts too far gone for anyone else (right down to 1%), gets you 10% off parts and repairs, and tells you the one upgrade that would help most.', '🔧') : null,
      eco.staffAvailable('manager') ? staffCard('manager', 'Manager', ECONOMY.MANAGER_HIRE, ECONOMY.MANAGER_WAGE,
        'Bets on your fights, clears your scrap pile, flags rare deals — and usually tracks down the part your mechanic wants.', '📈') : null,
    ].filter(Boolean);
    return el('div', {},
      s.blacklist > 0 ? el('div', { class: 'notice notice-warn' }, el('strong', {}, 'Blacklisted. '),
        `You stiffed your staff and word got round — nobody will work for you for ${s.blacklist} more bout${s.blacklist === 1 ? '' : 's'}.`) : null,
      s.collectors.length ? el('p', { class: 'small warn-text' }, `Word is your old ${s.collectors[0].role} is still collecting what you owe. Keep an eye on your parts.`) : null,
      cards.length
        ? el('div', { class: 'card-grid' }, cards)
        : s.blacklist > 0 ? null : el('p', { class: 'muted' }, "Nobody wants to work for an unknown from the junkyard. Win some fights and people will come looking."),
      s.staff.manager ? this.renderBetting() : null,
      s.fine ? this.renderFine() : null,
      this.renderCodex(),
      el('h3', {}, 'Log'),
      el('ul', { class: 'log' }, s.log.slice(-25).reverse().map((l) => el('li', {},
        el('span', { class: 'log-time' }, new Date(l.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), ' ', l.msg,
        l.lines?.length ? el('ul', { class: 'log-lines' }, l.lines.map((x) => el('li', {}, x))) : null))),
      el('h3', {}, 'Office'),
      el('button', {
        class: 'btn btn-danger',
        onclick: () => this.confirm('Start a new game?', 'This wipes your save: vehicles, money and progress.', () => this.onNewGame()),
      }, 'New game (wipe save)'),
    );
  }

  /** Every part in the game: the ones you've owned by name, the rest as a rarity-coloured ???. */
  renderCodex() {
    const s = this.state;
    const total = Object.keys(PARTS).length;
    const found = Object.keys(PARTS).filter((k) => s.discovered.has(k)).length;
    return el('div', { class: 'card codex' },
      el('h3', {}, `Parts Codex · ${found}/${total} discovered`),
      [['chassis', 'Frames'], ...PART_GROUPS].map(([type, label]) => {
        const keys = Object.keys(PARTS).filter((k) => aisleOf(PARTS[k]) === type)
          .sort((a, b) => PARTS[a].tier - PARTS[b].tier || RARITY[PARTS[a].rarity].rank - RARITY[PARTS[b].rarity].rank);
        return [
          el('div', { class: 'small muted' }, `${label} ${keys.filter((k) => s.discovered.has(k)).length}/${keys.length}`),
          el('div', { class: 'codex-grid' }, keys.map((k) => {
            const def = PARTS[k];
            const known = s.discovered.has(k);
            return el('span', { class: `codex-item rarity-${def.rarity}${known ? '' : ' unknown'}`, title: known ? `${def.name} — ★${def.tier} ${def.rarity}` : `★${def.tier} ${def.rarity}` },
              known ? def.name : '???');
          })),
        ];
      }));
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
      el('p', {}, `${ECONOMY.TOURNAMENT_ROUNDS} rounds against the galaxy's finest. Win the final for the ${formatMoney(ECONOMY.TOURNAMENT_PRIZE)} grand prize — and the game. `,
        'No purses and no captured vehicles along the way.'),
      el('p', { class: 'small muted' }, "Once you enter you're in the field: you can't switch vehicles, the Marketplace is closed (no buying or selling) and your manager can't bet. You can swap in spare parts from your inventory and pay for repairs with the cash you bring. Can't afford them? Tough luck."));


    if (!eco.tournamentUnlocked) {
      const n = s.record.challengerWins;
      wrap.append(el('div', { class: 'notice' }, `Locked. Win ${ECONOMY.TOURNAMENT_UNLOCK_WINS} challenger bouts to qualify (${n}/${ECONOMY.TOURNAMENT_UNLOCK_WINS}).`),
        hpBar(n / ECONOMY.TOURNAMENT_UNLOCK_WINS, { label: `${n}/${ECONOMY.TOURNAMENT_UNLOCK_WINS}` }));
      return wrap;
    }

    wrap.append(el('ol', { class: 'bracket' }, ECONOMY.TOURNAMENT_ROUND_NAMES.map((name, i) => el('li', {
      class: t.entered && i === t.round ? 'current' : t.entered && i < t.round ? 'done' : '',
    }, name))));

    if (!t.entered) {
      const bug = s.activeBug;
      const fee = ECONOMY.TOURNAMENT_FEE;
      const canPay = s.money >= fee;
      wrap.append(...[
        t.eliminated ? el('p', { class: 'bad' }, 'You were eliminated last time. Regroup, upgrade and try again.') : null,
        el('p', {}, 'Entering with: ', el('strong', {}, bug?.name ?? '—'), bug && !bug.isBattleReady ? el('span', { class: 'bad' }, ' (not battle-ready)') : ''),
        el('p', { class: canPay ? '' : 'bad' }, `Entry fee: ${formatMoney(fee)}${canPay ? '' : ` — you have ${formatMoney(s.money)}`}`),
        el('button', {
          class: 'btn btn-fight', disabled: !bug?.isBattleReady || !canPay,
          onclick: () => this.confirm('Enter the tournament?', `Pay the ${formatMoney(fee)} entry fee. ${bug.name} will be locked in: no Marketplace and no switching vehicles until you win or are eliminated — only the spares in your inventory.`,
            () => this.act(() => eco.enterTournament(), 'Entered! Good luck, pilot.')),
        }, `ENTER · ${formatMoney(fee)}`)].filter(Boolean));
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
        onclick: () => this.confirm('Withdraw?', `You forfeit your place and the entry fee — re-entering costs another ${formatMoney(ECONOMY.TOURNAMENT_FEE)} and starts again from ${ECONOMY.TOURNAMENT_ROUND_NAMES[0]}.`, () => this.act(() => eco.withdrawTournament(), 'Withdrawn from the tournament')),
      }, 'Withdraw'),
    ].filter(Boolean));
    return wrap;
  }
}
