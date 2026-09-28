import { ECONOMY, EVENTS, MATCH, PHYSICS, INPUT, WEAPON_CLASSES } from './config/constants.js';
import { GameState } from './core/GameState.js';
import { Vector2D } from './physics/Vector2D.js';
import { CombatEngine } from './systems/CombatEngine.js';
import { EconomyManager, formatMoney } from './systems/EconomyManager.js';
import { InputManager } from './systems/InputManager.js';
import { CanvasRenderer } from './render/CanvasRenderer.js';
import { ArenaRenderer } from './render/ArenaRenderer.js';
import { SpriteRenderer } from './render/SpriteRenderer.js';
import { WorkshopUI, el, toast, closeModal } from './ui/WorkshopUI.js';
import { TerminalUI } from './ui/TerminalUI.js';

const $ = (sel) => document.querySelector(sel);

/**
 * Application shell: switches between the Workshop/Terminal screen and the
 * battle arena, runs the fixed-timestep game loop and routes events between
 * the decoupled systems.
 */
class App {
  constructor() {
    this.state = GameState.load() || GameState.newGame();
    this.economy = new EconomyManager(this.state);
    if (this.state.fresh) this.economy.setupNewGame();
    this.economy.ensurePool();
    const needsRookie = this.state.record.challengerWins < ECONOMY.ROOKIE_UNTIL_WINS && !this.economy.hasRookie;
    if (!this.state.challengers.length || needsRookie) this.economy.generateChallengers();
    else if (this.state.challengers.length < ECONOMY.BOARD_SIZE && !this.state.board.rejected.length) this.economy.refillBoard();
    if (!this.state.market.parts.length) this.economy.generateMarket();
    this.state.save();

    this.sprite = new SpriteRenderer();
    this.arena = new ArenaRenderer();
    this.renderer = new CanvasRenderer($('#game-canvas'));

    this.workshop = new WorkshopUI($('#hoist-panel'), { state: this.state, economy: this.economy, sprite: this.sprite });
    this.terminal = new TerminalUI($('#terminal-panel'), $('#topbar'), $('#tabbar'), {
      state: this.state,
      economy: this.economy,
      sprite: this.sprite,
      onFight: (challenger, opts) => this.startMatch(challenger, opts),
      onNewGame: () => this.newGame(),
    });
    this.state.on(EVENTS.STATE_CHANGE, () => {
      if (!this.engine && !this.state.gameOver && this.economy.checkGameOver()) {
        this.state.save();
        this.showGameOver();
      }
      this.renderUI();
    });

    this.input = new InputManager($('#game-canvas'), {
      screenToWorld: (x, y) => this.renderer.screenToWorld(x, y),
      clientToCss: (x, y) => this.renderer.clientToCss(x, y),
      hitTest: (w) => this.hitTest(w),
      onRing: (w) => !this.engine || w.length() <= this.engine.arenaRadius,
    });
    this.bindInput();

    this.engine = null;
    this.match = null;
    this.menu = null;
    this.raf = 0;
    this.lastFailFloat = 0;

    window.addEventListener('resize', () => this.engine && this.renderer.resize());
    this.showWorkshop();
    if (this.state.gameComplete) this.showChampion();
    else if (this.economy.checkGameOver()) this.showGameOver();
  }

  newGame() {
    GameState.wipe();
    window.location.reload();
  }

  /** Champion's reward: a fresh game from scratch, bankrolled by the grand prize. */
  newSeason() {
    const s = this.state;
    GameState.newGame({ bonus: ECONOMY.TOURNAMENT_PRIZE, season: s.season + 1, titles: s.titles + 1 }).save();
    window.location.reload();
  }

  showChampion() {
    const root = $('#overlay-root');
    const s = this.state;
    root.replaceChildren(el('div', { class: 'result-card result-win champion' },
      el('h1', {}, 'CHAMPION OF THE GALAXY'),
      el('p', { class: 'champion-text' }, `You won the Inter-Planetary Tournament${s.season > 1 ? ` in season ${s.season}` : ''} and the ${formatMoney(ECONOMY.TOURNAMENT_PRIZE)} grand prize. Game complete!`),
      el('p', { class: 'muted' }, `Final record ${s.record.wins}W · ${s.record.losses}L · ${s.record.ties}D${s.titles ? ` · ${s.titles + 1} championships` : ''}`),
      el('p', {}, `Start again from the junkyard — but with your ${formatMoney(ECONOMY.TOURNAMENT_PRIZE)} prize in the bank on top.`),
      el('button', { class: 'btn btn-primary btn-big', onclick: () => this.newSeason() }, `Start season ${s.season + 1} (+${formatMoney(ECONOMY.TOURNAMENT_PRIZE)})`)));
    root.classList.add('open');
  }

  renderUI() {
    if (this.engine) return;
    this.terminal.render();
    this.workshop.render();
  }

  showWorkshop() {
    $('#battle-screen').classList.remove('active');
    $('#workshop-screen').classList.add('active');
    $('#masthead').classList.remove('hidden');
    this.renderUI();
    this.terminal.showPendingDM(); // e.g. a freshly made rival with something to get off their chest
  }

  // ───────────── Battle lifecycle ─────────────
  startMatch(challenger, { tournament = false, betPct } = {}) {
    const player = tournament ? this.state.getVehicle(this.state.tournament.vehicleId) : this.state.activeBug;
    if (!player?.isBattleReady) {
      toast(player ? player.battleIssues()[0] : 'No vehicle', 'bad');
      return;
    }
    const stake = tournament ? null : challenger.nego?.deal;
    if (!tournament && !stake) {
      toast('Agree the stakes first — cash or titles', 'bad');
      return;
    }
    if (stake?.type === 'cash' && this.state.money < stake.amount) {
      toast(`You can't cover the ${formatMoney(stake.amount)} stake any more`, 'bad');
      return;
    }
    closeModal();
    this.state.newVehicleIds.clear();
    this.state.compareRef = null;
    this.workshop.stop();
    this.sprite.clear();

    const moneyBefore = this.state.money;
    // The manager bets from whatever isn't already staked on the fight.
    const bet = this.economy.placeManagerBet(challenger, player, stake?.type === 'cash' ? stake.amount : 0, betPct ?? this.state.managerBetPct);
    if (bet) toast(`Your manager bet ${formatMoney(bet.stake)} on you to ${bet.side === 'win' ? 'WIN' : 'LOSE'}`, bet.side === 'win' ? 'good' : 'bad');
    this.state.save();

    this.match = { challenger, tournament, stake, bet, player, moneyBefore, endTimer: null, banner: null };
    this.engine = new CombatEngine({ player, opponent: challenger.bug, difficulty: challenger.difficulty, style: challenger.style });
    this.wireEngine(this.engine);

    $('#workshop-screen').classList.remove('active');
    $('#masthead').classList.add('hidden');
    $('#battle-screen').classList.add('active');
    this.renderer.resize();
    this.buildBattleControls();
    this.input.enable();

    let last = performance.now();
    let acc = 0;
    const frame = (now) => {
      if (!this.engine) return;
      const realDt = Math.min((now - last) / 1000, MATCH.MAX_FRAME_DT);
      last = now;
      const scale = this.match.endTimer !== null ? 0.35 : this.menu ? INPUT.MENU_TIME_SCALE : 1;
      const dt = realDt * scale;
      acc += dt;
      while (acc >= MATCH.FIXED_DT) {
        this.engine.update(MATCH.FIXED_DT);
        acc -= MATCH.FIXED_DT;
      }
      this.sprite.update(dt);
      for (const b of this.engine.bugs) this.sprite.ambient(b, dt);
      this.draw(realDt);
      this.updateBattleControls();

      if (this.match.endTimer !== null) {
        this.match.endTimer -= realDt;
        if (this.match.endTimer <= 0) {
          this.finishMatch();
          return;
        }
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  wireEngine(engine) {
    const sp = this.sprite;
    const isPlayer = (b) => b === engine.player;

    engine.on(EVENTS.COLLISION, ({ point, impact }) => {
      if (impact > PHYSICS.IMPACT_THRESHOLD) {
        sp.sparks(point, Math.min(24, 4 + impact / 20), '#ffd24a', 120 + impact * 0.6);
        this.renderer.addShake(impact / 70);
      }
    });
    engine.on(EVENTS.DAMAGE, ({ bug, amount, kind }) => {
      sp.float(bug.pos.add(new Vector2D((Math.random() - 0.5) * 20, -bug.radius)), `-${Math.max(1, Math.round(amount))}`, isPlayer(bug) ? '#ff6a6a' : '#ffd24a', 10);
      if (kind === 'spikes') sp.sparks(bug.pos, 5, '#ff7a3d', 140);
    });
    engine.on(EVENTS.PART_BROKEN, ({ bug, part }) => {
      sp.float(bug.pos.add(new Vector2D(0, -bug.radius - 14)), `${part.name.toUpperCase()} BROKEN!`, '#ff4a4a', 9);
      sp.debris(bug.pos, '#8d93a0', 10);
      this.renderer.addShake(6);
    });
    engine.on(EVENTS.STALL, ({ bug, stallOut }) => {
      sp.float(bug.pos.add(new Vector2D(0, -bug.radius - 10)), stallOut ? 'STALLED OUT!' : 'THERMAL STALL!', '#7a9cff', 11);
      sp.ring(bug.pos, bug.radius * 2, '#4a6cff');
    });
    engine.on(EVENTS.STALL_RECOVER, ({ bug }) => sp.float(bug.pos.add(new Vector2D(0, -bug.radius)), 'REBOOTED', '#5ad8ff', 8));
    engine.on(EVENTS.RING_OUT, ({ bug }) => {
      sp.float(bug.pos.clone(), 'RING OUT!', '#ff4a4a', 14);
      sp.debris(bug.pos, '#cdbb8a', 14);
      this.renderer.addShake(10);
    });
    engine.on(EVENTS.ACTION, ({ bug, type, dir }) => {
      const tail = bug.pos.sub(dir.scale(bug.radius));
      for (let i = 0; i < (type === 'shove' ? 10 : 5); i++) sp.smoke(tail, 'rgba(160,140,110,0.6)');
      if (type === 'shove') sp.float(bug.pos.add(new Vector2D(0, -bug.radius - 8)), 'POWER SHOVE!', '#ffd24a', 9);
    });
    engine.on(EVENTS.ACTION_FAIL, ({ bug, reason }) => {
      if (!isPlayer(bug)) return;
      const now = performance.now();
      if (now - this.lastFailFloat < 500) return;
      this.lastFailFloat = now;
      sp.float(bug.pos.add(new Vector2D(0, -bug.radius - 8)), reason, '#8f86a8', 8);
    });
    engine.on(EVENTS.WEAPON_FIRE, (e) => this.weaponVfx(e));
    engine.on(EVENTS.MATCH_END, (res) => {
      const text = res.result === 'win' ? 'VICTORY!' : res.result === 'loss' ? 'DEFEAT' : 'DRAW';
      const color = res.result === 'win' ? '#5bd66b' : res.result === 'loss' ? '#ff4a4a' : '#ffd24a';
      this.match.banner = { text, color };
      this.match.endTimer = MATCH.RESULT_DELAY;
      this.menu = null;
      this.input.disable();
    });
  }

  weaponVfx({ bug, weapon, target, hit, effect }) {
    const sp = this.sprite;
    const color = WEAPON_CLASSES[weapon.stats.class].color;
    const front = bug.pos.add(Vector2D.fromAngle(bug.angle, bug.radius));
    const label = (text, c = color) => sp.float(target.pos.add(new Vector2D(0, -target.radius - 10)), text, c, 9);
    switch (effect) {
      case 'drain':
        if (weapon.stats.arc >= 360) {
          sp.ring(bug.pos, weapon.stats.range + bug.radius + target.radius, color, 0.5);
        } else {
          const end = hit ? target.pos : front.add(Vector2D.fromAngle(bug.angle, weapon.stats.range));
          sp.bolt(front, end, color);
          sp.bolt(front, end, '#ffffff', 0.15);
        }
        if (hit) { label(`-${Math.round(weapon.stats.drain)} STAMINA`); sp.sparks(target.pos, 10, color, 160); }
        break;
      case 'ram':
        sp.sparks(front, 8, '#ffd24a', 180);
        if (hit) { label('DRIVETRAIN HIT'); this.renderer.addShake(5); }
        break;
      case 'spikes':
        sp.float(bug.pos.add(new Vector2D(0, -bug.radius - 8)), 'SPIKES OUT', color, 8);
        break;
      case 'lift':
        sp.smoke(front, 'rgba(200,190,140,0.6)', 4);
        if (hit) label('LIFTED! μ→0');
        break;
      case 'slick':
        sp.spray(front, Vector2D.fromAngle(bug.angle));
        if (hit) label('SLICKED!');
        break;
      default:
        break;
    }
    if (!hit && effect !== 'spikes' && effect !== 'slick') {
      sp.float(bug.pos.add(new Vector2D(0, -bug.radius - 8)), 'MISS', '#8f86a8', 9);
    }
  }

  draw(realDt) {
    const engine = this.engine;
    const t = performance.now() / 1000;
    const b = this.renderer.beginWorld(realDt);
    this.arena.drawBackground(b, t);
    this.arena.drawRing(b, engine.arenaRadius, engine.time, engine.shrinking);
    this.arena.drawPuddles(b, engine.puddles, t);
    const order = [...engine.bugs].sort((a, c) => (c.outReason === 'ringout') - (a.outReason === 'ringout'));
    for (const bug of order) this.sprite.drawBug(b, bug, { time: t });
    this.sprite.draw(b);
    this.renderer.present();
    this.renderer.drawHUD(engine, {
      floats: this.sprite.floats,
      menu: this.menu,
      target: engine.player.control.target,
      banner: this.match.banner,
    });
  }

  finishMatch() {
    cancelAnimationFrame(this.raf);
    const engine = this.engine;
    const { challenger, tournament, stake, bet, player } = this.match;
    const res = engine.result;
    this.engine = null;
    this.input.disable();

    const report = this.economy.settleMatch({
      result: res.result,
      reason: res.reason,
      challenger,
      opponentBug: engine.opponent,
      playerBug: player,
      tournament,
      stake,
      bet,
    });
    report.moneyBefore = this.match.moneyBefore;
    this.state.commit();
    this.showResults(report, engine);
  }

  showResults(report, engine) {
    const root = $('#overlay-root');
    const title = report.champion ? 'CHAMPION OF THE GALAXY' : report.result === 'win' ? 'VICTORY' : report.result === 'loss' ? 'DEFEAT' : 'DRAW';
    const close = () => {
      root.classList.remove('open');
      root.replaceChildren();
      if (report.champion) {
        this.showChampion();
        return;
      }
      if (report.gameOver) {
        this.showGameOver();
        return;
      }
      if (!this.state.vehicles.length) {
        this.terminal.marketCat = 'chassis';
        this.terminal.setTab('market');
      } else if (report.captured) {
        this.terminal.setTab('hangar'); // the capture is waiting on the hoist
      }
      this.showWorkshop();
    };
    const buttonText = report.gameOver || report.champion ? 'Continue'
      : report.captured ? 'See it on the hoist'
        : !this.state.vehicles.length ? 'Find a replacement'
          : 'Back to the Workshop';
    const player = engine.player;
    root.replaceChildren(el('div', { class: `result-card result-${report.result}${report.champion ? ' champion' : ''}` },
      el('h1', {}, title),
      el('p', { class: 'result-reason' }, report.reason, ` · ${Math.floor(engine.time / 60)}:${String(Math.floor(engine.time % 60)).padStart(2, '0')}`),
      report.champion ? el('p', { class: 'champion-text' }, 'You have conquered the Inter-Planetary Tournament. The galaxy bows to your bug. Game complete!') : null,
      report.captured ? el('div', { class: 'captured' }, this.sprite.renderThumbnail(report.captured, 96), el('div', {}, el('small', {}, 'Captured'), el('strong', {}, report.captured.name))) : null,
      report.lostVehicle ? el('div', { class: 'captured lost' }, this.sprite.renderThumbnail(report.lostVehicle, 96), el('div', {}, el('small', {}, 'Title lost'), el('strong', {}, report.lostVehicle.name))) : null,
      el('ul', { class: 'report' }, report.lines.map((l) => el('li', {}, l))),
      report.moneyBefore != null ? el('p', { class: 'cash-change' }, `Cash ${formatMoney(report.moneyBefore)} → ${formatMoney(this.state.money)} (${this.state.money >= report.moneyBefore ? '+' : '−'}${formatMoney(Math.abs(this.state.money - report.moneyBefore))})`) : null,
      el('div', { class: 'result-status' },
        el('span', {}, `${player.name}: hull ${Math.round(player.chassis.hpRatio * 100)}% · condition ${Math.round(player.condition * 100)}%`),
        el('strong', {}, formatMoney(this.state.money))),
      el('button', { class: 'btn btn-primary btn-big', onclick: close }, buttonText),
    ));
    root.classList.add('open');
  }

  showGameOver() {
    const root = $('#overlay-root');
    root.replaceChildren(el('div', { class: 'result-card result-loss game-over' },
      el('h1', {}, 'GAME OVER'),
      el('p', {}, this.state.gameOver),
      el('p', { class: 'muted' }, `Final record ${this.state.record.wins}W · ${this.state.record.losses}L · ${this.state.record.ties}D`),
      el('button', { class: 'btn btn-primary btn-big', onclick: () => this.newGame() }, 'Start a new game')));
    root.classList.add('open');
  }

  // ───────────── Battle controls & input ─────────────
  buildBattleControls() {
    const bar = $('#battle-controls');
    const player = this.engine.player;
    this.weaponButtons = player.weapons.map((w, i) => {
      const cls = WEAPON_CLASSES[w.stats.class];
      const btn = el('button', {
        class: 'btn weapon-btn',
        style: { borderColor: cls.color },
        title: `${w.name} — ${cls.label} (key ${i + 1})`,
        onclick: () => this.engine?.fireWeapon(player, i),
      }, el('span', { class: 'weapon-key' }, String(i + 1)), el('span', {}, w.name), el('small', {}, `${w.stats.cost} stamina`), el('div', { class: 'cooldown' }));
      return { btn, w };
    });
    bar.replaceChildren(
      el('div', { class: 'weapon-row' }, this.weaponButtons.map((b) => b.btn)),
      el('div', { class: 'battle-help' }, 'On the ring: touch & drag to steer (behind you = reverse) · Off the ring: swipe for a handbrake turn · Tap foe: ram · Double-tap: shove · Hold your bug: weapons'),
      el('button', { class: 'btn btn-small btn-danger forfeit', onclick: () => this.engine?.forfeit() }, 'Forfeit'),
    );
  }

  updateBattleControls() {
    const player = this.engine?.player;
    if (!player) return;
    for (const { btn, w } of this.weaponButtons) {
      const cd = player.cooldowns[w.uid] || 0;
      const ready = !w.isBroken && cd <= 0 && !player.stalled && player.stamina >= w.stats.cost;
      btn.classList.toggle('not-ready', !ready);
      btn.querySelector('.cooldown').style.width = `${(cd / w.stats.cooldown) * 100}%`;
    }
  }

  hitTest(world) {
    const e = this.engine;
    if (!e) return null;
    let best = null;
    let bestD = Infinity;
    for (const [key, bug] of [['player', e.player], ['opponent', e.opponent]]) {
      if (bug.out) continue;
      const d = bug.pos.distanceTo(world);
      if (d < bug.radius + INPUT.HIT_PADDING && d < bestD) {
        best = key;
        bestD = d;
      }
    }
    return best;
  }

  bindInput() {
    const on = (ev, fn) => this.input.on(ev, (p) => { if (this.engine?.live) fn(p); });
    on('steer', ({ world }) => this.engine.moveTo(this.engine.player, world));
    on('ram', () => this.engine.ram(this.engine.player, false));
    on('shove', () => this.engine.ram(this.engine.player, true));
    on('dash', ({ dir }) => this.engine.dash(this.engine.player, dir));
    on('stop', () => this.engine.stop(this.engine.player));
    on('fireWeapon', ({ index }) => this.engine.fireWeapon(this.engine.player, index));
    on('menuOpen', () => this.openMenu());
    this.input.on('menuMove', ({ screen }) => this.hoverMenu(screen));
    this.input.on('menuRelease', ({ screen }) => {
      if (!this.menu) return;
      this.hoverMenu(screen);
      const item = this.menu.hover !== null ? this.menu.items[this.menu.hover] : null;
      this.menu = null;
      if (item && this.engine?.live) this.engine.fireWeapon(this.engine.player, item.index);
    });
    this.input.on('menuCancel', () => { this.menu = null; });
  }

  openMenu() {
    const player = this.engine.player;
    if (!player.weapons.length) {
      this.sprite.float(player.pos.add(new Vector2D(0, -player.radius - 8)), 'NO WEAPONS', '#8f86a8', 8);
      return;
    }
    const n = player.weapons.length;
    const spread = Math.PI / 2.2;
    const items = player.weapons.map((w, i) => {
      const angle = -Math.PI / 2 + (n === 1 ? 0 : (i / (n - 1) - 0.5) * spread * 2);
      const words = w.name.split(' ');
      const cd = player.cooldowns[w.uid] || 0;
      return {
        index: i,
        angle,
        color: WEAPON_CLASSES[w.stats.class].color,
        lines: [words[0].slice(0, 7).toUpperCase(), cd > 0 ? `${cd.toFixed(1)}s` : `${w.stats.cost}⚡`],
        disabled: w.isBroken || cd > 0 || player.stamina < w.stats.cost,
      };
    });
    this.menu = { items, hover: null, radius: INPUT.MENU_RADIUS };
  }

  hoverMenu(screen) {
    if (!this.menu || !this.engine) return;
    const c = this.renderer.worldToScreen(this.engine.player.pos);
    const d = screen.sub(c);
    if (d.length() < INPUT.MENU_DEADZONE) {
      this.menu.hover = null;
      return;
    }
    const a = d.angle();
    let best = null;
    let bestDiff = Math.PI / 3;
    this.menu.items.forEach((item, i) => {
      const diff = Math.abs(Math.atan2(Math.sin(a - item.angle), Math.cos(a - item.angle)));
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    });
    this.menu.hover = best;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.battleBugs = new App();
});
