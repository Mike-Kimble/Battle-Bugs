import { DOHYO_KINDS } from '../systems/Dohyo.js';
import { ECONOMY, WEAPON_CLASSES } from '../config/constants.js';
import { formatMoney } from '../systems/EconomyManager.js';
import { PARTS, RARITY } from '../config/partsData.js';
import { el, toast, hpBar, partCard, openModal, closeModal, counterpart, vehicleCompare, sellStackButton } from './WorkshopUI.js';

const TABS = [
  ['hangar', 'Garage'],
  ['market', 'Marketplace'],
  ['challengers', 'Challengers'],
  ['staff', 'Admin'],
  ['training', 'Training'],
  ['tournament', 'Tournaments'],
];

const MARKET_CATEGORIES = [
  ['engine', 'Propulsion', 'Motors & power cores. Power, revs (top speed) and cooling.'],
  ['weapon', 'Weapons', 'Hardpoint-mounted weapons. Every activation costs stamina.'],
  ['tires', 'Running Gear', 'Driven tyres & tracks (need a drive shaft), and gliding castors (need thrust: a turbine or plasma drive, or a propeller or ducted fan).'],
  ['chassis', 'Chassis', 'Whole vehicles — each frame comes with its fitted parts.'],
  ['armor', 'Armour', 'Plating that soaks impact damage before it reaches the hull.'],
  ['sell', 'Sell', 'Every spare component in your inventory, ready to sell.'],
];

const PART_GROUPS = [['engine', 'Power Plant'], ['cooling', 'Cooling'], ['enhancement', 'Enhancements'], ['drivetrain', 'Drive Train'], ['weapon', 'Weapons'], ['tires', 'Running Gear'], ['armor', 'Armour']];

/** Propulsion splits into three aisles. */
const PROPULSION_SUBS = [
  ['engine', 'Power Plant', 'Motors & power cores. Power, revs (top speed) and cooling.'],
  ['cooling', 'Cooling', 'Heat exchangers, misters, radiators, fans, jackets… Three cooling slots. Not everything suits every drive.'],
  ['enhancement', 'Enhancement', 'Tunes, turbos, nitro, afterburners… One enhancement slot per drive. Not everything suits every drive.'],
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
 * The Terminal: garage, marketplace, challengers, staff office and
 * tournament desk. Also renders the top status bar.
 */
export class TerminalUI {
  constructor(root, header, tabbar, { state, economy, sprite, onFight, onTrain, onNewGame, onBack, onStandoff }) {
    this.root = root;
    this.header = header;
    this.tabbar = tabbar;
    this.marketCat = 'engine';
    this.state = state;
    this.economy = economy;
    this.sprite = sprite;
    this.onFight = onFight;
    this.onTrain = onTrain;
    this.onBack = onBack; // (back) => reopen the Garage area you came from
    this.onStandoff = onStandoff;
    this.trainingDohyo = 0; // 0 = random
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

  /** The tabs you can use: in the tournament, only the Garage and the Tournaments. */
  get visibleTabs() {
    return this.economy.inField ? TABS.filter(([k]) => k === 'hangar' || k === 'tournament') : TABS;
  }

  render() {
    if (!this.visibleTabs.some(([k]) => k === this.tab)) this.tab = 'tournament';
    this.renderHeader();
    const body = {
      challengers: () => this.renderChallengers(),
      hangar: () => this.renderHangar(),
      market: () => this.renderMarket(),
      staff: () => this.renderStaff(),
      training: () => this.renderTraining(),
      tournament: () => this.renderTournament(),
    }[this.tab]();

    const scroll = this.root.querySelector('.terminal-body')?.scrollTop ?? 0;
    const newCount = this.state.newVehicleIds.size;
    this.tabbar.replaceChildren(el('div', { class: 'tabs', role: 'tablist' },
      this.visibleTabs.map(([key, label]) => el('button', {
        class: `tab${this.tab === key ? ' active' : ''}${(key === 'tournament' && this.economy.tournamentUnlocked) || (key === 'staff' && Object.keys(this.state.arrears).length) ? ' glow' : ''}`,
        role: 'tab',
        'aria-selected': this.tab === key ? 'true' : 'false',
        onclick: () => this.setTab(key),
      }, label, key === 'hangar' && newCount ? el('span', { class: 'tab-count' }, `${newCount} NEW`) : null))));
    this.root.replaceChildren(el('div', { class: 'terminal-body' }, body));
    // The Garage tab is the hoist alone (swipe between vehicles); every other tab is the terminal alone.
    const ws = this.root.closest('#workshop-screen');
    ws?.classList.toggle('no-hoist', this.tab !== 'hangar');
    ws?.classList.toggle('hangar-mode', this.tab === 'hangar');
    const tb = this.root.querySelector('.terminal-body');
    if (tb) tb.scrollTop = this.keepScroll ? scroll : 0;
    this.keepScroll = true;
  }

  setTab(key) {
    if (key !== 'market') this.backTo = null; // the way back only lasts while you're shopping
    this.tab = key;
    this.keepScroll = false;
    this.render();
  }

  /** Back to the Garage, with the area (and tab) you came from open again. */
  goBack() {
    const back = this.backTo;
    this.setTab('hangar');
    if (back) this.onBack?.(back);
  }

  renderHeader() {
    const s = this.state;
    this.header.replaceChildren(
      el('div', { class: 'logo' }, 'WEEVIL', el('span', {}, 'WARS')),
      el('div', { class: 'hud-stats' },
        el('div', { class: 'stat money' }, el('small', {}, 'Capital'), el('strong', {}, formatMoney(s.money))),
        el('div', { class: 'stat' }, el('small', {}, 'Record W·L·D'), el('strong', {}, `${s.record.wins}·${s.record.losses}·${s.record.ties}`)),
        s.fine ? el('div', { class: 'stat fine-chip', title: 'Match-fixing fine' }, el('small', {}, 'Fine due'),
          el('strong', {}, `${formatMoney(s.fine.amount)} · ${s.fine.battlesLeft} left`)) : null,
        s.season > 1 ? el('div', { class: 'stat' }, el('small', {}, 'Season'), el('strong', {}, `${s.season}${s.titles ? ` · ${'★'.repeat(Math.min(s.titles, 5))}` : ''}`)) : null,
        el('div', { class: 'stat' }, el('small', {}, 'Streak'), el('strong', {}, streakText(s.record.streak))),
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
      return el('div', { class: 'notice' }, 'You are entered in the Inter-Planetary Tournament. Fight your bracket from the Tournaments tab.',
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
          el('button', { class: 'btn', onclick: () => this.setTab('hangar') }, 'Open the Garage'))) : null,
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

  /** A pilot's home dohyo. */
  venueLine(c) {
    if (this.economy.isRoamer(c)) return el('div', { class: 'small muted venue' }, 'No home dohyo · the ring is picked at random');
    // Their home ring only — where the next bout will be is for you to work out.
    const home = c.home || 1;
    return el('div', { class: 'small muted venue' }, `Home: Dohyo ${home} ${DOHYO_KINDS[home].name}`);
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
        controls.replaceChildren(el('p', { class: 'muted small chat-ended' }, 'Press ✕ to return to Challengers.'));
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

  // ───────────── Garage ─────────────
  /** The Garage is the hoist panel (WorkshopUI); the terminal column is hidden. */
  renderHangar() {
    return el('div', {});
  }

  /** A stack of like spares (× n) with its Sell button. */
  sellPartCard(group, extra = null) {
    const p = group.best;
    return partCard(p, this.economy, {
      group, extra,
      compareTo: p.type === 'chassis' ? undefined : counterpart(this.state.activeBug, p),
      actions: [sellStackButton(group, this.economy, (fn, msg) => this.act(fn, msg))],
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
      if (key === 'sell') return s.inventory.length + s.vehicles.filter((v) => !s.isLocked(v)).length;
      if (key === 'chassis') return s.market.vehicles.length;
      return s.market.parts.filter((l) => aisleOf(l.part) === key).length;
    };
    const myVehicles = s.vehicles.filter((v) => !s.isLocked(v));

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
    // Came here from a "Shop … on the Marketplace" button in the Garage: one tap takes you back to it.
    const back = this.backTo ? el('button', { class: 'btn btn-small back-btn', onclick: () => this.goBack() }, '← Back to the Garage') : null;
    const navWithBack = back ? el('div', {}, back, subnav) : subnav;

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
          el('button', { class: 'btn btn-primary', disabled: s.money < l.price, onclick: () => this.act(() => this.economy.buyVehicleListing(l.id), `${l.bug.name} is on the hoist`) }, 'Buy')))));
    } else {
      forSale = el('div', { class: 'card-grid parts' }, s.market.parts.filter((l) => aisleOf(l.part) === cat).map((l) => partCard(l.part, this.economy, {
        compareTo: counterpart(active, l.part),
        extra: dealBadge(l),
        actions: [...(() => {
          // Buy it and bolt it straight on where there's room and it suits (on twin drives: a button
          // per drive it fits); if it fits nowhere, it's just "Buy".
          const price = formatMoney(this.economy.partPrice(l));
          const broke = s.money < this.economy.partPrice(l);
          const bays = this.economy.fitBays(l.part, active);
          if (!bays.length) {
            return [el('button', { class: 'btn btn-small btn-primary', disabled: broke, onclick: () => this.act(() => this.economy.buyPartListing(l.id), `Bought ${l.part.name}`) }, `Buy ${price}`)];
          }
          return bays.map((b) => el('button', {
            class: 'btn btn-small btn-primary', disabled: broke,
            onclick: () => this.act(() => this.economy.buyAndFit(l.id, active, b ?? undefined), () => `Bought and fitted ${l.part.name} to ${b == null ? active.name : `Drive ${b + 1}`}${this.economy.strippedNote(l.part)}`),
          }, b == null ? `Buy & fit ${price}` : `Buy & fit to Drive ${b + 1} · ${price}`));
        })(),
        s.staff.mechanic ? el('span', { class: 'small muted' }, el('s', {}, formatMoney(l.price)), ' mechanic −10%') : null],
      })));
    }

    if (cat === 'sell') return this.renderSell(navWithBack, catBlurb, myVehicles);

    return el('div', { class: 'market' },
      navWithBack,
      el('p', { class: 'muted' }, catBlurb, ' Stock rotates after every bout. ',
        s.staff.mechanic && cat !== 'chassis' ? 'Your mechanic gets 10% off parts. ' : '',
        manager ? 'Your manager is flagging rare deals.' : ''),
      el('h3', {}, `${catLabel} for sale`),
      forSale.childElementCount ? forSale : el('p', { class: 'muted' }, 'Sold out — new stock arrives after your next bout.'),
      cat === 'chassis' && myVehicles.length ? el('p', { class: 'muted small' }, 'Selling one of your own vehicles? That\'s on the Sell tab.') : null,
    );
  }

  /**
   * The Sell tab: your spare parts in stacks, each with a tick box (plus
   * Select all and Sell all selected), then your vehicles.
   */
  renderSell(subnav, catBlurb, myVehicles) {
    const s = this.state;
    const eco = this.economy;
    const byType = PART_GROUPS.map(([type, label]) => [label, eco.spareGroups(s.inventory.filter((p) => aisleOf(p) === type))]).filter(([, gs]) => gs.length);
    const stacks = byType.flatMap(([, gs]) => gs);
    // Bare chassis can be ticked too (one with parts fitted is sold on its own, with its warning).
    const bare = myVehicles.filter((v) => v.parts.length === 1);
    const all = [...stacks.map((g) => ({ id: g.id, name: g.best.name, count: g.parts.length, price: eco.groupSellTotal(g, g.parts.length), sell: () => eco.sellFromGroup(g, g.parts.length) })),
      ...bare.map((v) => ({ id: `vehicle:${v.id}`, name: v.name, count: 1, price: eco.vehicleSellPrice(v), sell: () => eco.sellVehicle(v.id) }))];
    // Ticked items (forget any that have since gone).
    const picked = this.sellPicked || (this.sellPicked = new Set());
    for (const id of [...picked]) if (!all.some((g) => g.id === id)) picked.delete(id);
    const chosen = all.filter((g) => picked.has(g.id));
    const total = chosen.reduce((t, g) => t + g.price, 0);
    const items = chosen.reduce((t, g) => t + g.count, 0);
    const toggle = (id, on) => { if (on) picked.add(id); else picked.delete(id); this.render(); };
    const tick = (id, name) => el('label', { class: 'check-row small sell-tick' },
      el('input', { type: 'checkbox', checked: picked.has(id) || null, 'aria-label': `Select ${name}`, onchange: (e) => toggle(id, e.target.checked) }), 'Select');
    const bar = all.length ? el('div', { class: 'sell-bar' },
      el('label', { class: 'check-row' },
        el('input', {
          type: 'checkbox', checked: (chosen.length === all.length) || null, 'aria-label': 'Select all',
          onchange: (e) => { picked.clear(); if (e.target.checked) for (const g of all) picked.add(g.id); this.render(); },
        }), 'Select all'),
      el('button', {
        class: 'btn btn-small btn-primary', disabled: !chosen.length,
        onclick: () => this.confirm(`Sell ${items} item${items === 1 ? '' : 's'}?`, `Everything you've selected goes, for ${formatMoney(total)} in all.`,
          () => this.act(() => { eco.assertNotInField(); const v = chosen.reduce((t, g) => t + g.sell(), 0); picked.clear(); return v; }, (v) => `Sold ${items} item${items === 1 ? '' : 's'} for ${formatMoney(v)}`)),
      }, chosen.length ? `Sell all selected (${formatMoney(total)})` : 'Sell all selected')) : null;
    return el('div', { class: 'market' },
      subnav,
      el('p', { class: 'muted' }, catBlurb, ` Buyers pay ${Math.round(ECONOMY.SELL_RATE * 100)}% of value × condition; broken parts fetch scrap only.`),
      eco.hotStreak ? el('div', { class: 'notice notice-gold' }, `🔥 You're on a ${s.record.streak}-win streak — buyers want some of your secret sauce and are paying 10–20% extra.`) : null,
      bar,
      el('h3', {}, `Spare parts (${s.inventory.length})`),
      byType.length
        ? byType.map(([label, gs]) => [el('h4', {}, `${label} (${gs.reduce((t, g) => t + g.parts.length, 0)})`), el('div', { class: 'card-grid parts' }, gs.map((g) => this.sellPartCard(g, tick(g.id, g.best.name))))])
        : el('p', { class: 'muted' }, 'No spare components. Remove parts on the hoist or strip a vehicle to sell them here.'),
      el('h3', {}, `Your vehicles (${myVehicles.length})`),
      myVehicles.length
        ? el('div', { class: 'card-grid' }, myVehicles.map((bug) => this.vehicleSellCard(bug, bug.parts.length === 1 ? tick(`vehicle:${bug.id}`, bug.name) : null)))
        : el('p', { class: 'muted small' }, 'Your garage is empty.'));
  }

  vehicleSellCard(bug, extra = null) {
    const s = this.state;
    return el('article', { class: 'card vehicle' },
      el('div', { class: 'card-row' },
        this.sprite.renderThumbnail(bug, 64),
        el('div', { class: 'card-info' },
          el('h3', {}, bug.name),
          el('div', { class: 'small muted' }, `${bug.chassis.name} · ${this.vehicleKind(bug)}${bug.id === s.activeVehicleId ? ' · on the hoist' : ''}`),
          hpBar(bug.condition, { label: `Condition ${Math.round(bug.condition * 100)}%` }))),
      extra,
      el('div', { class: 'part-actions' },
        el('button', {
          class: 'btn btn-small btn-danger',
          onclick: () => this.confirm(`Sell ${bug.name}?`, this.economy.sellWarning(bug),
            () => this.act(() => this.economy.sellVehicle(bug.id), (v) => `Sold for ${formatMoney(v)}`)),
        }, `Sell ${formatMoney(this.economy.vehicleSellPrice(bug))}`)));
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
    const eco = this.economy;
    const staffCard = (role, title, hire, desc, icon) => {
      const employed = eco.employed(role);
      const mood = eco.staffMood(role);
      const wait = eco.rehireWait(role);
      const start = eco.startingPay(role);
      const startText = role === 'manager' ? `${Math.round(start * 100)}% of your winnings` : `${formatMoney(start)} per complete vehicle`;
      // Who they are: the one you've got, or whoever's applying. (What they're like, you find out.)
      const who = employed ? eco.person(role) : wait > 0 ? null : eco.candidate(role);
      return el('article', { class: `card staff${employed ? ' active' : ''}${mood.state === 'strike' ? ' striking' : ''}` },
        el('div', { class: 'staff-icon' }, icon),
        el('h3', {}, title, mood.state === 'strike' ? el('span', { class: 'badge badge-warn' }, 'ON STRIKE') : null),
        who ? el('div', { class: 'staff-name' }, employed ? who.name : `Applying: ${who.name}`) : null,
        el('p', {}, desc),
        employed ? this.renderWage(role, who?.name || title, mood) : wait > 0 ? null : el('div', { class: 'small muted' }, `Hire fee ${formatMoney(hire)} · wants ${startText}`),
        employed && role === 'manager' ? el('label', { class: 'check-row small' },
          el('input', {
            type: 'checkbox', checked: s.managerWages || null,
            onchange: (e) => this.act(() => eco.setManagerWages(e.target.checked), e.target.checked ? `${who?.name || 'Your manager'} is handling the wages` : "You're setting the wages"),
          }), ' Let my manager handle wages') : null,
        employed && s.arrears[role] ? this.renderArrears(role, title) : null,
        employed
          ? el('button', {
            class: 'btn btn-small',
            onclick: () => (s.arrears[role]
              ? this.confirm(`Dismiss your ${title.toLowerCase()}?`, `You still owe them ${formatMoney(s.arrears[role].amount)}. Walk away without paying and word gets round: nobody will work for you for ${ECONOMY.BLACKLIST_BOUTS} bouts. And they'll want their money back, one way or another.`,
                () => this.act(() => eco.dismiss(role), `${title} dismissed`))
              : mood.state === 'strike'
                ? this.confirm(`Fire your striking ${title.toLowerCase()}?`, `A replacement will take the job in ${ECONOMY.REHIRE_AFTER_FIRED} bouts — for half what this one is asking.`,
                  () => this.act(() => eco.dismiss(role), `${title} fired`))
                : this.act(() => eco.dismiss(role), `${title} dismissed`)),
          }, mood.state === 'strike' ? 'Fire' : 'Dismiss')
          : wait > 0
            ? el('div', { class: 'notice notice-warn small' }, `Nobody will take the job for ${wait} more bout${wait === 1 ? '' : 's'}.`)
            : el('button', { class: 'btn btn-small btn-primary', disabled: s.money < hire, onclick: () => this.act(() => eco.hire(role), `${title} hired`) }, `Hire ${formatMoney(hire)}`));
    };

    const show = (role) => eco.staffAvailable(role) || eco.rehireWait(role) > 0;
    const cards = [
      show('mechanic') ? staffCard('mechanic', 'Mechanic', ECONOMY.MECHANIC_HIRE,
        'Repairs your active vehicle after each bout, can save parts too far gone for anyone else (right down to 1%), gets you 10% off parts and repairs, and tells you the one upgrade that would help most. Paid per complete vehicle.', '🔧') : null,
      show('manager') ? staffCard('manager', 'Manager', ECONOMY.MANAGER_HIRE,
        'Bets on your fights, clears your scrap pile, flags rare deals — and usually tracks down the part your mechanic wants. Takes a cut of your winnings.', '📈') : null,
    ].filter(Boolean);
    return el('div', {},
      s.blacklist > 0 ? el('div', { class: 'notice notice-warn' }, el('strong', {}, 'Blacklisted. '),
        `You stiffed your staff and word got round — nobody will work for you for ${s.blacklist} more bout${s.blacklist === 1 ? '' : 's'}.`) : null,
      s.collectors.length ? el('p', { class: 'small warn-text' }, `Word is your old ${s.collectors[0].role} is still collecting what you owe. Keep an eye on your parts.`) : null,
      cards.length
        ? el('div', { class: 'card-grid' }, cards)
        : s.blacklist > 0 ? null : el('p', { class: 'muted' }, "Nobody wants to work for an unknown from the junkyard. Win some fights and people will come looking."),
      eco.employed('manager') ? this.renderBetting() : null,
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

  /** The wage you pay, set in the office, against the going rate — and how they feel about it. */
  renderWage(role, title, mood) {
    const s = this.state;
    const eco = this.economy;
    const manager = role === 'manager';
    const rate = eco.payOf(role);
    const going = eco.goingRate(role);
    const fmt = (v) => (manager ? `${Math.round(v * 100)}%` : formatMoney(v));
    const perBout = (v) => (manager
      ? `≈ ${formatMoney(v * s.earnAvg)} a bout at your average winnings`
      : `${formatMoney(v * eco.completeVehicles)} a bout for ${eco.completeVehicles} complete vehicle${eco.completeVehicles === 1 ? '' : 's'}`);
    const label = el('strong', {}, `${fmt(rate)}${manager ? ' of winnings' : ' per complete vehicle'}`);
    const note = el('div', { class: 'small muted' }, perBout(rate));
    // Mechanic's slider runs to three times the going rate; the manager's to 30%.
    const max = manager ? 30 : Math.max(100, Math.ceil((Math.max(going, rate) * 3) / 50) * 50);
    const step = manager ? 1 : Math.max(5, Math.round(max / 200 / 5) * 5);
    const toValue = (v) => (manager ? Number(v) / 100 : Number(v));
    const slider = el('input', {
      type: 'range', min: 0, max, step, value: manager ? Math.round(rate * 100) : rate, 'aria-label': `${title} wage`,
      oninput: (e) => { const v = toValue(e.target.value); label.textContent = `${fmt(v)}${manager ? ' of winnings' : ' per complete vehicle'}`; note.textContent = perBout(v); },
      onchange: (e) => this.act(() => eco.setPay(role, toValue(e.target.value)), (r) => (r === 'back' ? `${title} is back to work` : r === 'happy' ? `${title} is happy with that` : `${title}'s wage set`)),
    });
    const moodLine = mood.state === 'strike'
      ? el('div', { class: 'notice notice-warn small' }, `On strike for ${fmt(mood.ask)}. ${mood.bouts ? 'Last chance — one more bout and they quit.' : `Pay up within ${ECONOMY.STRIKE_QUIT_BOUTS} bouts or they quit.`}`)
      : mood.state === 'complaining'
        ? el('div', { class: 'notice notice-warn small' }, `Complaining: wants ${fmt(mood.ask)}. Do nothing before your next bout and they strike.`)
        : el('div', { class: 'small good-text' }, 'Content.');
    return el('div', { class: 'wage' },
      s.managerWages && s.staff.manager ? el('div', { class: 'small muted' }, 'Your manager sets this after every bout — move the slider to override it for the next one.') : null,
      el('div', { class: 'small' }, 'Wage: ', label),
      el('div', { class: 'slider-row' }, slider),
      note,
      el('div', { class: 'small muted' }, `Going rate: ${fmt(going)}${manager ? ' of winnings' : ' per complete vehicle'}`),
      moodLine,
      mood.state !== 'content'
        ? el('button', { class: 'btn btn-small btn-primary', onclick: () => this.act(() => eco.setPay(role, mood.ask), (r) => (r === 'back' ? `${title} is back to work` : `${title} is happy with that`)) }, `Pay what they ask: ${fmt(mood.ask)}`)
        : null);
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
  // ───────────── Training ─────────────
  renderTraining() {
    const s = this.state;
    const bug = s.activeBug;
    const ready = !!bug?.isBattleReady && !this.economy.inField;
    const pickDohyo = el('div', { class: 'subtabs subtabs-2', role: 'tablist' },
      [[0, 'Random'], ...Object.entries(DOHYO_KINDS).map(([k, d]) => [Number(k), `${k} ${d.name}`])].map(([k, label]) => el('button', {
        class: `subtab${this.trainingDohyo === k ? ' active' : ''}`,
        onclick: () => { this.trainingDohyo = k; this.render(); },
      }, label)));
    const card = (title, text, mode, label) => el('article', { class: 'card training' },
      el('h3', {}, title),
      el('p', {}, text),
      el('button', { class: 'btn btn-fight', disabled: !ready, onclick: () => this.onTrain(mode, this.trainingDohyo) }, label));
    return el('div', {},
      el('h2', {}, 'Training'),
      el('p', { class: 'muted' }, 'Practice for free: no stakes, no wages, no record. Sparring still dents you a little (40% of the damage sticks), but nothing wears out or uses up a match; the dummy costs nothing at all. Press Exit to leave whenever you like.'),
      !bug?.isBattleReady ? el('div', { class: 'notice notice-warn' }, bug ? bug.battleIssues()[0] : 'You need a vehicle.') : null,
      this.economy.inField ? el('div', { class: 'notice notice-warn' }, "You're in the tournament — no time for training.") : null,
      el('h3', {}, 'Dohyo'),
      pickDohyo,
      el('div', { class: 'card-grid' },
        card('Spar', 'A random opponent in a vehicle matched to yours, flown by a pilot of middling skill. Light damage only.', 'spar', 'SPAR'),
        card('Training Dummy', 'A motorless dummy vehicle with no weapons. It just sits there and gets pushed around — perfect for practising rams, shoves and ring-outs.', 'dummy', 'PRACTISE')));
  }

  /** The Scarab Standoff: a one-bout free-for-all, open after a 5-win streak. */
  renderStandoff() {
    const s = this.state;
    const eco = this.economy;
    const bug = s.activeBug;
    const fee = ECONOMY.STANDOFF_FEE;
    const card = el('div', { class: 'card standoff' },
      el('h3', {}, '🪲 Scarab Standoff'),
      el('p', {}, `You and two pilots of your level on the donut ring — three-way, every bug for itself. Last one standing wins ${formatMoney(ECONOMY.STANDOFF_PRIZE)}.`),
      el('p', { class: 'small muted' }, `Entry ${formatMoney(fee)}. It's one bout: no bracket, no wagers, no captures.`));
    if (!eco.standoffOpen) {
      const streak = Math.max(0, s.record.streak || 0);
      card.append(el('div', { class: 'notice' }, `Closed. Open while you're on a ${ECONOMY.STANDOFF_STREAK}-win streak (${Math.min(streak, ECONOMY.STANDOFF_STREAK)}/${ECONOMY.STANDOFF_STREAK}).`));
      return card;
    }
    if (eco.inField) {
      card.append(el('p', { class: 'muted small' }, 'Not while you\'re in the Inter-Planetary Tournament.'));
      return card;
    }
    const canPay = s.money >= fee;
    card.append(
      el('p', {}, 'Entering with: ', el('strong', {}, bug?.name ?? '—'), bug && !bug.isBattleReady ? el('span', { class: 'bad' }, ' (not battle-ready)') : ''),
      el('button', {
        class: 'btn btn-fight', disabled: !bug?.isBattleReady || !canPay,
        onclick: () => this.confirm('Enter the Scarab Standoff?', `Pay the ${formatMoney(fee)} entry fee and fight two pilots of your level at once on the donut. Last one standing wins ${formatMoney(ECONOMY.STANDOFF_PRIZE)}.`, () => this.onStandoff?.()),
      }, canPay ? `ENTER · ${formatMoney(fee)}` : `Entry ${formatMoney(fee)} — you have ${formatMoney(s.money)}`));
    return card;
  }

  renderTournament() {
    const s = this.state;
    const eco = this.economy;
    const t = s.tournament;
    const standoff = this.renderStandoff();
    const wrap = el('div', { class: 'tournament' },
      standoff,
      el('h3', {}, 'The Inter-Planetary Tournament'),
      el('p', {}, `${ECONOMY.TOURNAMENT_ROUNDS} rounds against the galaxy's finest. Win the final for the ${formatMoney(ECONOMY.TOURNAMENT_PRIZE)} grand prize — and the game. `,
        'No purses and no captured vehicles along the way.'),
      el('p', { class: 'small muted' }, "Once you enter you're in the field: you can't switch vehicles, the Marketplace is closed (no buying or selling) and your manager can't bet. You can swap in spare parts from your inventory and pay for repairs with the cash you bring. Can't afford them? Tough luck."));


    if (!eco.tournamentUnlocked) {
      const n = Math.max(0, Math.min(s.record.streak || 0, ECONOMY.TOURNAMENT_STREAK));
      wrap.append(el('div', { class: 'notice' }, `Closed. Open while you're on a ${ECONOMY.TOURNAMENT_STREAK}-win streak (${n}/${ECONOMY.TOURNAMENT_STREAK}).`),
        hpBar(n / ECONOMY.TOURNAMENT_STREAK, { label: `${n}/${ECONOMY.TOURNAMENT_STREAK}` }));
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
