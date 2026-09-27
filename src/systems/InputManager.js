import { INPUT } from '../config/constants.js';
import { EventEmitter } from '../core/EventEmitter.js';

/**
 * Normalises Pointer Events into battle gestures.
 *
 *   Single tap ground     → 'moveTo'      { world }
 *   Single tap opponent   → 'ram'
 *   Double tap opponent   → 'shove'
 *   Swipe                 → 'dash'        { dir (world unit vector) }
 *   Tap player            → 'stop'
 *   Long press player     → 'menuOpen'    { screen }  then 'menuMove' / 'menuRelease'
 *   Keys 1/2 (desktop)    → 'fireWeapon'  { index }
 */
export class InputManager extends EventEmitter {
  /**
   * @param {HTMLElement} element
   * @param {{screenToWorld:(x:number,y:number)=>Vector2D, clientToCss:(x:number,y:number)=>Vector2D, hitTest:(world:Vector2D)=>('player'|'opponent'|null)}} hooks
   */
  constructor(element, hooks) {
    super();
    this.el = element;
    this.hooks = hooks;
    this.enabled = false;
    this.down = null;
    this.menuOpen = false;
    this.longPressTimer = null;
    this.pendingTap = null;

    this.onDown = this.onDown.bind(this);
    this.onMove = this.onMove.bind(this);
    this.onUp = this.onUp.bind(this);
    this.onCancel = this.onCancel.bind(this);
    this.onKey = this.onKey.bind(this);
    this.onContext = (e) => e.preventDefault();

    element.addEventListener('pointerdown', this.onDown);
    element.addEventListener('pointermove', this.onMove);
    element.addEventListener('pointerup', this.onUp);
    element.addEventListener('pointercancel', this.onCancel);
    element.addEventListener('contextmenu', this.onContext);
    window.addEventListener('keydown', this.onKey);
  }

  enable() { this.enabled = true; }

  disable() {
    this.enabled = false;
    this.reset();
  }

  reset() {
    clearTimeout(this.longPressTimer);
    clearTimeout(this.pendingTap?.timer);
    this.pendingTap = null;
    this.down = null;
    if (this.menuOpen) {
      this.menuOpen = false;
      this.emit('menuCancel');
    }
  }

  destroy() {
    this.reset();
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointercancel', this.onCancel);
    this.el.removeEventListener('contextmenu', this.onContext);
    window.removeEventListener('keydown', this.onKey);
    this.removeAllListeners();
  }

  onDown(e) {
    if (!this.enabled || (this.down && e.pointerId !== this.down.id)) return;
    e.preventDefault();
    this.el.setPointerCapture?.(e.pointerId);
    const world = this.hooks.screenToWorld(e.clientX, e.clientY);
    this.down = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      world,
      target: this.hooks.hitTest(world),
      moved: false,
    };
    if (this.down.target === 'player') {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = setTimeout(() => {
        if (!this.down || this.down.moved) return;
        this.menuOpen = true;
        this.emit('menuOpen', { screen: this.hooks.clientToCss(this.down.x, this.down.y) });
      }, INPUT.LONG_PRESS_MS);
    }
  }

  onMove(e) {
    if (!this.enabled || !this.down || e.pointerId !== this.down.id) return;
    if (this.menuOpen) {
      this.emit('menuMove', { screen: this.hooks.clientToCss(e.clientX, e.clientY) });
      return;
    }
    if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > INPUT.TAP_SLOP_PX) {
      this.down.moved = true;
      clearTimeout(this.longPressTimer);
    }
  }

  onUp(e) {
    if (!this.enabled || !this.down || e.pointerId !== this.down.id) return;
    clearTimeout(this.longPressTimer);
    const d = this.down;
    this.down = null;

    if (this.menuOpen) {
      this.menuOpen = false;
      this.emit('menuRelease', { screen: this.hooks.clientToCss(e.clientX, e.clientY) });
      return;
    }

    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const dist = Math.hypot(dx, dy);
    const dur = performance.now() - d.t;

    if (dist >= INPUT.SWIPE_MIN_PX && dur <= INPUT.SWIPE_MAX_MS) {
      const w2 = this.hooks.screenToWorld(e.clientX, e.clientY);
      this.emit('dash', { dir: w2.sub(d.world).normalize() });
      return;
    }
    if (dist > INPUT.TAP_SLOP_PX * 2) return; // slow drag — ignore

    if (d.target === 'opponent') {
      if (this.pendingTap) {
        clearTimeout(this.pendingTap.timer);
        this.pendingTap = null;
        this.emit('shove');
      } else {
        this.pendingTap = {
          timer: setTimeout(() => {
            this.pendingTap = null;
            this.emit('ram');
          }, INPUT.DOUBLE_TAP_MS),
        };
      }
    } else if (d.target === 'player') {
      this.emit('stop');
    } else {
      this.emit('moveTo', { world: d.world });
    }
  }

  onCancel() {
    this.reset();
  }

  onKey(e) {
    if (!this.enabled || e.repeat) return;
    if (e.key === '1' || e.key === '2') this.emit('fireWeapon', { index: Number(e.key) - 1 });
    else if (e.key === 'r' || e.key === 'R') this.emit('ram');
    else if (e.key === 'f' || e.key === 'F') this.emit('shove');
    else if (e.key === 's' || e.key === 'S') this.emit('stop');
  }
}
