import type { AxisCal, Binding, ControllerMapping, Fn, Settings } from '../settings';
import type { InputManager } from '../input/input';

interface Step {
  fn?: Fn;
  title: string;
  text: string;
  optional?: boolean;
  kind: 'intro' | 'cal' | 'stick' | 'throttle' | 'switch' | 'done';
}

const STEPS: Step[] = [
  { kind: 'intro', title: 'Controller setup', text: 'This wizard learns which stick and switch on your radio does what. It takes about a minute.' },
  { kind: 'cal', title: 'Calibrate', text: 'Move <b>both sticks</b> slowly around their full range (all corners) a couple of times and flip every switch you plan to use. Then <b>centre the sticks</b>, put the <b>throttle fully DOWN</b> and press Next.' },
  { kind: 'throttle', fn: 'throttle', title: 'Throttle', text: 'Push the <b>THROTTLE</b> stick to <b>FULL (up)</b> and hold it there.' },
  { kind: 'stick', fn: 'yaw', title: 'Rudder / Yaw', text: 'Lower the throttle again. Then push the <b>RUDDER / YAW</b> stick fully <b>RIGHT</b> and hold.' },
  { kind: 'stick', fn: 'pitch', title: 'Elevator / Pitch', text: 'Push the <b>ELEVATOR / PITCH</b> stick fully <b>UP (forward, away from you)</b> and hold.' },
  { kind: 'stick', fn: 'roll', title: 'Aileron / Roll', text: 'Push the <b>AILERON / ROLL</b> stick fully <b>RIGHT</b> and hold.' },
  { kind: 'switch', fn: 'arm', optional: true, title: 'Arm switch (quads)', text: 'Flip the switch you want to use to <b>ARM</b> the quad into the <b>ARMED</b> position. Skip if you have none — quads then arm automatically with low throttle.' },
  { kind: 'switch', fn: 'mode', optional: true, title: 'Flight mode switch', text: 'Use a <b>3-position switch</b>. Move it to the position for <b>mode 1</b> (Manual / Acro / GPS) — usually <b>up / away from you</b>. If it was already there, flip it through the other positions and back.' },
  { kind: 'switch', fn: 'rate', optional: true, title: 'Rates switch', text: 'Flip the switch you want for <b>HIGH rates</b> into the high-rate position.' },
  { kind: 'switch', fn: 'reset', optional: true, title: 'Reset button', text: 'Press and <b>hold</b> the button or momentary switch you want to use to <b>reset</b> the aircraft.' },
  { kind: 'done', title: 'All done', text: 'Your mapping is saved for this controller. Check the live channels on the Controller tab: each one should move the right way.' },
];

export class ControllerWizard {
  private root = document.createElement('div');
  private i = 0;
  private pad!: Gamepad;
  private mapping!: ControllerMapping;
  private snapAxes: number[] = [];
  private snapBtns: number[] = [];
  private detected: Binding | null = null;
  private raf = 0;
  private used = new Set<string>();

  constructor(private s: Settings, private input: InputManager, private onDone: () => void) {
    this.root.className = 'wizard hidden';
    document.body.append(this.root);
  }

  start(pad: Gamepad) {
    this.pad = pad;
    this.mapping = { bindings: {}, cal: pad.axes.map((v) => ({ min: v, max: v, center: v })) };
    this.used.clear();
    this.i = 0;
    this.root.classList.remove('hidden');
    this.enter();
    cancelAnimationFrame(this.raf);
    const loop = () => { this.tick(); this.raf = requestAnimationFrame(loop); };
    loop();
  }

  private close() {
    cancelAnimationFrame(this.raf);
    this.root.classList.add('hidden');
  }

  private live(): Gamepad | null {
    return this.input.getPads().find((p) => p.id === this.pad.id) ?? null;
  }

  private enter() {
    const st = STEPS[this.i];
    const p = this.live();
    if (p) { this.snapAxes = Array.from(p.axes); this.snapBtns = p.buttons.map((b) => b.value); }
    this.detected = null;
    this.root.innerHTML = `
      <div class="wiz-panel">
        <div class="wiz-prog">Step ${this.i + 1} / ${STEPS.length}</div>
        <h2>${st.title}</h2>
        <p>${st.text}</p>
        <div class="wiz-live" id="wl"></div>
        <div class="wiz-btns">
          <button class="btn ghost" id="wcancel">${st.kind === 'done' ? 'Close' : 'Cancel'}</button>
          ${st.optional ? '<button class="btn ghost" id="wskip">Skip</button>' : ''}
          ${st.kind !== 'done' ? '<button class="btn primary" id="wnext">Next</button>' : '<button class="btn primary" id="wfinish">Finish</button>'}
        </div>
      </div>`;
    this.root.querySelector('#wcancel')!.addEventListener('click', () => this.close());
    this.root.querySelector('#wskip')?.addEventListener('click', () => this.next(true));
    this.root.querySelector('#wnext')?.addEventListener('click', () => this.next(false));
    this.root.querySelector('#wfinish')?.addEventListener('click', () => this.close());
  }

  private next(skip: boolean) {
    const st = STEPS[this.i];
    const p = this.live();
    if (st.kind === 'cal' && p) {
      p.axes.forEach((v, k) => { this.mapping.cal[k].center = v; });
    }
    if (!skip && st.fn) {
      if (!this.detected) return;
      if (st.kind === 'switch' && p) {
        // decide polarity from where the switch is NOW (it may have been flipped back and forth)
        const d = this.detected;
        if (d.type === 'axis') {
          const c = this.mapping.cal[d.index];
          const mid = (c.min + c.max) / 2;
          const raw = p.axes[d.index];
          d.reverse = st.fn === 'mode' ? raw > mid : raw < mid;
        } else {
          d.reverse = st.fn === 'reset' ? false : !(p.buttons[d.index]?.pressed);
        }
      }
      this.mapping.bindings[st.fn] = this.detected;
      if (st.kind !== 'switch' || st.fn !== 'reset') this.used.add(`${this.detected.type}${this.detected.index}`);
    }
    this.i++;
    if (STEPS[this.i].kind === 'done') this.save();
    this.enter();
  }

  private save() {
    // drop calibration of axes that never moved
    this.mapping.cal = this.mapping.cal.map((c: AxisCal) => (c.max - c.min > 0.2 ? c : { min: -1, max: 1, center: 0 }));
    // switches are normalised around the middle of their travel
    for (const fn of ['arm', 'mode', 'rate', 'reset'] as Fn[]) {
      const b = this.mapping.bindings[fn];
      if (b?.type === 'axis') { const c = this.mapping.cal[b.index]; c.center = (c.min + c.max) / 2; }
    }
    this.s.mappings[this.pad.id] = this.mapping;
    this.s.preferredGamepad = this.pad.id;
    this.onDone();
  }

  private tick() {
    const p = this.live();
    const wl = this.root.querySelector('#wl');
    if (!wl) return;
    if (!p) { wl.innerHTML = '<span class="warn">Controller disconnected…</span>'; return; }
    const st = STEPS[this.i];
    const axes = Array.from(p.axes);
    // calibration accumulates through the whole wizard
    axes.forEach((v, k) => {
      const c = this.mapping.cal[k] ?? (this.mapping.cal[k] = { min: v, max: v, center: v });
      c.min = Math.min(c.min, v);
      c.max = Math.max(c.max, v);
    });
    if (st.kind === 'intro') {
      wl.innerHTML = `<span class="ok">✓ Detected: ${p.id}</span><br><span class="muted">${axes.length} axes, ${p.buttons.length} buttons</span>`;
      return;
    }
    if (st.kind === 'cal') {
      wl.innerHTML = axes.map((v, k) => {
        const c = this.mapping.cal[k];
        const l = ((c.min + 1) * 50).toFixed(1), w = ((c.max - c.min) * 50).toFixed(1);
        return `<div class="lv"><span>Axis ${k}</span><div class="lv-bar"><div class="lv-range" style="left:${l}%;width:${w}%"></div><div class="lv-pos" style="left:${((v + 1) * 50).toFixed(1)}%"></div></div></div>`;
      }).join('');
      return;
    }
    if (st.kind === 'done') { wl.innerHTML = ''; return; }

    // detection: biggest change since step start
    let best: Binding | null = null, bestD = 0;
    axes.forEach((v, k) => {
      if (this.used.has(`axis${k}`)) return;
      const ref = st.kind === 'stick' ? (this.mapping.cal[k]?.center ?? this.snapAxes[k]) : this.snapAxes[k];
      const d = v - ref;
      if (Math.abs(d) > bestD) { bestD = Math.abs(d); best = { type: 'axis', index: k, reverse: d < 0 }; }
    });
    if (st.kind === 'switch') {
      p.buttons.forEach((b, k) => {
        if (this.used.has(`button${k}`)) return;
        const d = b.value - (this.snapBtns[k] ?? 0);
        if (Math.abs(d) > 0.5 && Math.abs(d) * 2 > bestD) { bestD = Math.abs(d) * 2; best = { type: 'button', index: k, reverse: d < 0 }; }
      });
    }
    const threshold = st.kind === 'switch' ? 0.4 : 0.5;
    if (best && bestD > threshold) {
      const b = best as Binding;
      this.detected = b;
      wl.innerHTML = `<span class="ok">✓ Detected ${b.type} ${b.index}${b.reverse ? ' (reversed)' : ''}</span> — press Next`;
    } else if (!this.detected) {
      wl.innerHTML = '<span class="muted">Waiting for movement…</span>';
    }
  }
}
