import type { ControlInputs } from '../sim/aircraft';
import { clamp, expo } from '../sim/math';
import type { Binding, ControllerMapping, Fn, Settings } from '../settings';

export interface RawPad { id: string; index: number; axes: number[]; buttons: number[]; }

/** Reasonable guess for an unmapped controller. */
export function defaultMapping(pad: Gamepad): ControllerMapping {
  const ax = (index: number, reverse = false): Binding => ({ type: 'axis', index, reverse });
  if (pad.mapping === 'standard') {
    // Xbox / PlayStation style pad, Mode 2 layout
    return {
      cal: [],
      bindings: { yaw: ax(0), throttle: ax(1, true), roll: ax(2), pitch: ax(3, true), reset: { type: 'button', index: 3, reverse: false } },
    };
  }
  // RC transmitter in USB joystick mode, Betaflight / EdgeTX standard layout:
  // CH1-4 = AETR sticks, CH5 = ARM (SA), CH6 = flight mode (SB 3-pos), CH7 = rates (SC), CH8 = reset (SD)
  return {
    cal: [],
    auto: true,
    bindings: { roll: ax(0), pitch: ax(1), throttle: ax(2), yaw: ax(3), arm: ax(4), mode: ax(5), rate: ax(6), reset: ax(7) },
  };
}

const SWITCH_FNS: Fn[] = ['arm', 'mode', 'rate', 'reset'];

export class InputManager {
  private keys = new Set<string>();
  private kb = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
  private kbArm = true;
  private prevReset = false;
  private resetSeen = false;
  private prevBtn: Record<string, boolean> = {};
  /** Switch channels of the default layout only count once they have been seen at an end position
   *  (an unused channel on the radio sits at 0 and must not block arming). */
  private liveSwitch = new Set<string>();
  /** Edge-triggered actions consumed by the game loop. */
  actions: string[] = [];
  activePad: Gamepad | null = null;
  usingKeyboard = true;

  constructor(private settings: Settings) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (!this.keys.has(e.code)) this.onKeyPress(e.code);
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private onKeyPress(code: string) {
    switch (code) {
      case 'KeyR': this.actions.push('reset'); break;
      case 'KeyC': case 'KeyV': this.actions.push('view'); break;
      case 'KeyP': this.actions.push('pause'); break;
      case 'Escape': case 'KeyM': this.actions.push('menu'); break;
      case 'KeyH': this.actions.push('hud'); break;
      case 'KeyE': this.kbArm = !this.kbArm; break;
      case 'Digit1': this.settings.keyboardMode = 0; break;
      case 'Digit2': this.settings.keyboardMode = 1; break;
      case 'Digit3': this.settings.keyboardMode = 2; break;
    }
  }

  getPads(): Gamepad[] {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return Array.from(pads).filter((p): p is Gamepad => !!p && p.connected);
  }

  pickPad(): Gamepad | null {
    const pads = this.getPads();
    if (!pads.length) return null;
    const pref = this.settings.preferredGamepad;
    return pads.find((p) => p.id === pref) ?? pads.find((p) => this.settings.mappings[p.id]) ?? pads[0];
  }

  raw(pad: Gamepad): RawPad {
    return { id: pad.id, index: pad.index, axes: Array.from(pad.axes), buttons: pad.buttons.map((b) => b.value) };
  }

  mappingFor(pad: Gamepad): ControllerMapping {
    return this.settings.mappings[pad.id] ?? defaultMapping(pad);
  }

  /** Is this function currently driven by the controller (bound and active)? */
  hasLive(fn: Fn): boolean {
    const pad = this.activePad;
    if (!pad) return false;
    const m = this.mappingFor(pad);
    if (!m.bindings[fn]) return false;
    return !m.auto || !SWITCH_FNS.includes(fn) || this.liveSwitch.has(pad.id + fn);
  }

  /** Normalised bipolar value -1..1 for an axis using calibration. */
  private axisValue(pad: Gamepad, m: ControllerMapping, b: Binding): number {
    let v: number;
    if (b.type === 'button') v = (pad.buttons[b.index]?.value ?? 0) * 2 - 1;
    else {
      const raw = pad.axes[b.index] ?? 0;
      const c = m.cal[b.index];
      if (c && c.max - c.min > 0.2) {
        v = raw >= c.center ? (raw - c.center) / Math.max(1e-3, c.max - c.center) : (raw - c.center) / Math.max(1e-3, c.center - c.min);
      } else v = raw;
    }
    v = clamp(v, -1, 1);
    return b.reverse ? -v : v;
  }

  private throttleValue(pad: Gamepad, m: ControllerMapping, b: Binding): number {
    if (b.type === 'button') return pad.buttons[b.index]?.value ?? 0;
    const raw = pad.axes[b.index] ?? 0;
    const c = m.cal[b.index];
    let t = c && c.max - c.min > 0.2 ? (raw - c.min) / (c.max - c.min) : (raw + 1) / 2;
    if (b.reverse) t = 1 - t;
    // low-end deadband: uncalibrated radios often report a few % at stick-bottom
    if (!c) t = (t - 0.08) / 0.92;
    return clamp(t, 0, 1);
  }

  poll(dt: number, kind: 'plane' | 'quad'): ControlInputs {
    const out: ControlInputs = { throttle: 0, roll: 0, pitch: 0, yaw: 0, arm: this.kbArm, mode: this.settings.keyboardMode, highRate: true };
    const pad = this.pickPad();
    this.activePad = pad;
    let padSticks = false;
    if (pad) {
      const m = this.mappingFor(pad);
      const B = { ...m.bindings };
      if (m.auto) {
        for (const fn of SWITCH_FNS) {
          const b = B[fn];
          if (!b) continue;
          const key = pad.id + fn;
          if (!this.liveSwitch.has(key)) {
            const raw = b.type === 'axis' ? pad.axes[b.index] ?? 0 : pad.buttons[b.index]?.value ?? 0;
            if (b.type === 'axis' && b.index < pad.axes.length && Math.abs(raw) > 0.85) this.liveSwitch.add(key);
            else delete B[fn];
          }
        }
      }
      const dz = (v: number) => (Math.abs(v) < 0.02 ? 0 : v);
      if (B.throttle) { out.throttle = this.throttleValue(pad, m, B.throttle); padSticks = true; }
      if (B.roll) out.roll = dz(this.axisValue(pad, m, B.roll));
      if (B.pitch) out.pitch = dz(this.axisValue(pad, m, B.pitch));
      if (B.yaw) out.yaw = dz(this.axisValue(pad, m, B.yaw));
      if (B.arm) out.arm = this.axisValue(pad, m, B.arm) > 0.3;
      if (B.mode) {
        const v = this.axisValue(pad, m, B.mode);
        out.mode = B.mode.type === 'button' ? (v > 0 ? 1 : 0) : v < -0.33 ? 0 : v > 0.33 ? 2 : 1;
      }
      if (B.rate) out.highRate = this.axisValue(pad, m, B.rate) > -0.3;
      if (B.reset) {
        const pressed = this.axisValue(pad, m, B.reset) > 0.3;
        // first time we see the reset channel: just record its state (no reset at startup)
        if (pressed && !this.prevReset && this.resetSeen) this.actions.push('reset');
        this.prevReset = pressed;
        this.resetSeen = true;
      }
      // gamepad face buttons for view/menu on standard pads
      if (pad.mapping === 'standard') {
        this.edgeButton(pad, 2, 'view');
        this.edgeButton(pad, 9, 'menu');
      }
    }
    this.usingKeyboard = !padSticks;

    // keyboard (always available, smooth ramps)
    const k = this.keys;
    const ramp = (cur: number, target: number, rate: number) => {
      const d = target - cur;
      const step = rate * dt;
      return Math.abs(d) <= step ? target : cur + Math.sign(d) * step;
    };
    const axis = (neg: string[], pos: string[]) => (pos.some((c) => k.has(c)) ? 1 : 0) - (neg.some((c) => k.has(c)) ? 1 : 0);
    const tr = axis(['ArrowLeft'], ['ArrowRight']);
    const tp = axis(['ArrowDown'], ['ArrowUp']);
    const ty = axis(['KeyA', 'KeyQ'], ['KeyD']);
    this.kb.roll = ramp(this.kb.roll, tr * 0.8, tr === 0 ? 6 : 3);
    this.kb.pitch = ramp(this.kb.pitch, tp * 0.7, tp === 0 ? 6 : 3);
    this.kb.yaw = ramp(this.kb.yaw, ty * 0.8, ty === 0 ? 6 : 3);
    const tu = axis(['KeyS', 'ControlLeft'], ['KeyW', 'ShiftLeft']);
    this.kb.throttle = clamp(this.kb.throttle + tu * dt * 0.6, 0, 1);
    if (k.has('KeyX')) this.kb.throttle = 0;
    out.roll = clamp(out.roll + this.kb.roll, -1, 1);
    out.pitch = clamp(out.pitch + this.kb.pitch, -1, 1);
    out.yaw = clamp(out.yaw + this.kb.yaw, -1, 1);
    if (!padSticks) out.throttle = this.kb.throttle;

    if (kind === 'plane' && this.settings.expo > 0) {
      out.roll = expo(out.roll, this.settings.expo);
      out.pitch = expo(out.pitch, this.settings.expo);
      out.yaw = expo(out.yaw, this.settings.expo * 0.7);
    }
    return out;
  }

  private edgeButton(pad: Gamepad, idx: number, action: string) {
    const key = pad.id + idx;
    const p = !!pad.buttons[idx]?.pressed;
    if (p && !this.prevBtn[key]) this.actions.push(action);
    this.prevBtn[key] = p;
  }

  resetKeyboardThrottle(v = 0) { this.kb.throttle = v; }

  consume(): string[] {
    const a = this.actions;
    this.actions = [];
    return a;
  }

  static fnLabel(fn: Fn) {
    return ({ throttle: 'Throttle', roll: 'Aileron / Roll', pitch: 'Elevator / Pitch', yaw: 'Rudder / Yaw', arm: 'Arm switch', mode: 'Flight mode switch', rate: 'Rates switch', reset: 'Reset button' } as const)[fn];
  }
}
