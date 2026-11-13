import { AIRCRAFT_LIST, AircraftId } from '../sim/presets';
import { MAP_LIST, MapId } from '../sim/world';
import type { Settings, ViewMode, Quality, Fn } from '../settings';
import { saveSettings } from '../settings';
import { InputManager } from '../input/input';
import { ControllerWizard } from './wizard';

export interface MenuCallbacks {
  onFly(): void;
  onAircraft(id: AircraftId): void;
  onReset(): void;
  onSettingsChanged(): void;
  onNextTrack(): void;
  trackName(): string;
}

type Tab = 'fly' | 'controller' | 'settings' | 'help';

const ICONS: Record<string, string> = {
  trainer: '<svg viewBox="0 0 64 32"><path d="M4 16h40l8-3h8v6h-8l-8-3" fill="none" stroke="currentColor" stroke-width="2"/><rect x="14" y="8" width="24" height="3" fill="currentColor"/><path d="M50 10v12" stroke="currentColor" stroke-width="2"/></svg>',
  sport: '<svg viewBox="0 0 64 32"><path d="M4 16h40l10-2h6v4h-6l-10-2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="16" y="18" width="22" height="3" fill="currentColor"/><path d="M52 11v10" stroke="currentColor" stroke-width="2"/></svg>',
  wing: '<svg viewBox="0 0 64 32"><path d="M32 6 L60 24 L52 26 L32 16 L12 26 L4 24 Z" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  fpv: '<svg viewBox="0 0 64 32"><path d="M14 6 L50 26 M50 6 L14 26" stroke="currentColor" stroke-width="2.5"/><circle cx="14" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="50" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="14" cy="26" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="50" cy="26" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="26" y="12" width="12" height="8" fill="currentColor"/></svg>',
  drone: '<svg viewBox="0 0 64 32"><rect x="24" y="11" width="16" height="10" rx="4" fill="currentColor"/><path d="M24 13 L12 7 M40 13 L52 7 M24 19 L12 25 M40 19 L52 25" stroke="currentColor" stroke-width="2"/><path d="M4 7h16 M44 7h16 M4 25h16 M44 25h16" stroke="currentColor" stroke-width="1.5"/></svg>',
};

export class Menu {
  root = document.createElement('div');
  private body = document.createElement('div');
  private tab: Tab = 'fly';
  open = true;
  private liveTimer = 0;
  private wizard: ControllerWizard;

  constructor(private s: Settings, private input: InputManager, private cb: MenuCallbacks) {
    this.root.className = 'menu-overlay';
    const panel = document.createElement('div');
    panel.className = 'menu-panel';
    panel.innerHTML = `
      <div class="menu-head">
        <div class="brand"><span class="brand-mark">◢</span> LiftLab <small>RC flight simulator</small></div>
        <div class="tabs">
          <button data-tab="fly">Fly</button>
          <button data-tab="controller">Controller</button>
          <button data-tab="settings">Settings</button>
          <button data-tab="help">Help</button>
        </div>
      </div>`;
    this.body.className = 'menu-body';
    const foot = document.createElement('div');
    foot.className = 'menu-foot';
    foot.innerHTML = `<button class="btn ghost" data-act="reset">Reset aircraft</button><button class="btn primary" data-act="fly">Fly ▸</button>`;
    panel.append(this.body, foot);
    this.root.append(panel);
    document.body.append(this.root);
    panel.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => this.show(b.dataset.tab as Tab)));
    foot.querySelector('[data-act=fly]')!.addEventListener('click', () => cb.onFly());
    foot.querySelector('[data-act=reset]')!.addEventListener('click', () => { cb.onReset(); cb.onFly(); });
    this.wizard = new ControllerWizard(s, input, () => { saveSettings(s); this.render(); });
    this.show('fly');
  }

  setOpen(v: boolean) {
    this.open = v;
    this.root.classList.toggle('hidden', !v);
    if (v) this.render();
  }

  show(t: Tab) {
    this.tab = t;
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    this.render();
  }

  private save() {
    saveSettings(this.s);
    this.cb.onSettingsChanged();
  }

  render() {
    const b = this.body;
    if (this.tab === 'fly') this.renderFly(b);
    else if (this.tab === 'controller') this.renderController(b);
    else if (this.tab === 'settings') this.renderSettings(b);
    else this.renderHelp(b);
  }

  /* ------------------------------------------------------------ */
  private renderFly(b: HTMLElement) {
    const s = this.s;
    const views: [ViewMode, string][] = [['los', 'Line of sight (pilot on the field)'], ['chase', 'Chase camera'], ['fpv', 'FPV / cockpit']];
    b.innerHTML = `
      <h3>Aircraft</h3>
      <div class="cards">${AIRCRAFT_LIST.map((a) => `
        <button class="card ${a.id === s.aircraft ? 'sel' : ''}" data-ac="${a.id}">
          <div class="card-icon">${ICONS[a.id]}</div>
          <div class="card-t">${a.label}<span class="tag">${a.kind === 'plane' ? 'Airplane' : 'Multirotor'}</span></div>
          <div class="card-d">${a.desc}</div>
        </button>`).join('')}
      </div>
      <h3>Location</h3>
      <div class="cards maps">${MAP_LIST.map((m) => `
        <button class="card ${m.id === s.map ? 'sel' : ''}" data-map="${m.id}">
          <div class="card-t">${m.label}</div>
          <div class="card-d">${m.desc}</div>
        </button>`).join('')}
      </div>
      <div class="grid2">
        <div>
          <h3>Start</h3>
          <label class="radio"><input type="radio" name="spawn" value="ground" ${!s.spawnInAir ? 'checked' : ''}> On the ground (takeoff / hand launch)</label>
          <label class="radio"><input type="radio" name="spawn" value="air" ${s.spawnInAir ? 'checked' : ''}> Already flying (practice without takeoff)</label>
          <h3>Camera</h3>
          ${views.map(([v, l]) => `<label class="radio"><input type="radio" name="view" value="${v}" ${s.view[s.aircraft] === v ? 'checked' : ''}> ${l}</label>`).join('')}
        </div>
        <div>
          <h3>Wind</h3>
          ${this.slider('wspeed', 'Wind speed', s.wind.speed, 0, 12, 0.5, (v) => `${v.toFixed(1)} m/s (${(v * 3.6).toFixed(0)} km/h)`)}
          ${this.slider('wdir', 'Wind from', s.wind.fromDeg, 0, 355, 5, (v) => `${v.toFixed(0)}° ${compass(v)}${v === 90 ? ' (runway headwind)' : ''}`)}
          ${this.slider('gusts', 'Gusts', s.wind.gusts, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
          ${this.slider('turb', 'Turbulence', s.wind.turbulence, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
        </div>
      </div>`;
    b.querySelectorAll<HTMLButtonElement>('[data-ac]').forEach((el) => el.addEventListener('click', () => {
      s.aircraft = el.dataset.ac as AircraftId;
      this.save();
      this.cb.onAircraft(s.aircraft);
      this.render();
    }));
    b.querySelectorAll<HTMLButtonElement>('[data-map]').forEach((el) => el.addEventListener('click', () => {
      if (el.dataset.map === s.map) return;
      s.map = el.dataset.map as MapId;
      saveSettings(s);
      document.body.insertAdjacentHTML('beforeend', '<div id="loading"><div class="ld-brand">LiftLab</div><div class="ld-sub">Building the world…</div></div>');
      setTimeout(() => location.reload(), 50);
    }));
    b.querySelectorAll<HTMLInputElement>('input[name=spawn]').forEach((el) => el.addEventListener('change', () => { s.spawnInAir = el.value === 'air'; this.save(); this.cb.onReset(); }));
    b.querySelectorAll<HTMLInputElement>('input[name=view]').forEach((el) => el.addEventListener('change', () => { s.view[s.aircraft] = el.value as ViewMode; this.save(); }));
    this.bindSlider(b, 'wspeed', (v) => (s.wind.speed = v));
    this.bindSlider(b, 'wdir', (v) => (s.wind.fromDeg = v));
    this.bindSlider(b, 'gusts', (v) => (s.wind.gusts = v));
    this.bindSlider(b, 'turb', (v) => (s.wind.turbulence = v));
  }

  /* ------------------------------------------------------------ */
  private renderController(b: HTMLElement) {
    const pads = this.input.getPads();
    const active = this.input.pickPad();
    const mapped = active ? !!this.s.mappings[active.id] : false;
    b.innerHTML = `
      <div class="grid2">
        <div>
          <h3>Controller</h3>
          ${pads.length ? `
            <select id="padsel">${pads.map((p) => `<option value="${escapeHtml(p.id)}" ${active && p.id === active.id ? 'selected' : ''}>${escapeHtml(shortId(p.id))}</option>`).join('')}</select>
            <p class="ok">${mapped ? '✓ Configured with the setup wizard' : '✓ Using the standard Betaflight / EdgeTX layout (AETR + CH5 arm, CH6 mode, CH7 rates, CH8 reset)'}</p>`
            : `<p class="warn">No controller detected. Connect your radio over USB and <b>move a stick</b> — browsers only reveal a controller after it sends input.</p>`}
          <button class="btn primary" id="wiz" ${pads.length ? '' : 'disabled'}>Run setup wizard</button>
          ${mapped ? '<button class="btn ghost" id="clearmap">Forget mapping</button>' : ''}
          <h3>RadioMaster Pocket / EdgeTX setup</h3>
          <ol class="steps">
            <li>Turn the radio on, plug the USB-C cable into the computer.</li>
            <li>On the radio choose <b>USB Joystick (HID)</b> when the USB dialog appears.</li>
            <li>Works out of the box with the standard <b>Betaflight / EdgeTX layout</b> — no wizard needed:</li>
          </ol>
          <table class="keys">
            <tr><td>CH1–4</td><td>Aileron, Elevator, Throttle, Rudder (AETR)</td></tr>
            <tr><td>CH5 · SA</td><td>ARM (motor arm for planes too) — arm with throttle low</td></tr>
            <tr><td>CH6 · SB</td><td>Flight mode, 3 positions</td></tr>
            <tr><td>CH7 · SC</td><td>Rates (low / high)</td></tr>
            <tr><td>CH8 · SD</td><td>Reset aircraft</td></tr>
          </table>
          <ol class="steps" start="4">
            <li>A switch channel becomes active the first time it is moved to an end position, so unused channels never block arming.</li>
            <li>Different layout? Run the wizard to remap anything.</li>
          </ol>
          <p class="muted">Tip: trims on the radio work in the simulator too, because the radio sends its mixed channel outputs over USB.</p>
        </div>
        <div>
          <h3>Live channels</h3>
          <div id="live" class="live"></div>
          <h3>Raw axes</h3>
          <div id="raw" class="live raw"></div>
        </div>
      </div>`;
    b.querySelector('#wiz')?.addEventListener('click', () => { const p = this.input.pickPad(); if (p) this.wizard.start(p); });
    b.querySelector('#clearmap')?.addEventListener('click', () => { if (active) { delete this.s.mappings[active.id]; this.save(); this.render(); } });
    b.querySelector<HTMLSelectElement>('#padsel')?.addEventListener('change', (e) => { this.s.preferredGamepad = (e.target as HTMLSelectElement).value; this.save(); this.render(); });
  }

  /** Called every frame while the menu is open. */
  tick(dt: number, inputs: { throttle: number; roll: number; pitch: number; yaw: number; arm: boolean; mode: number; highRate: boolean }) {
    if (!this.open) return;
    this.liveTimer += dt;
    if (this.liveTimer < 0.05) return;
    this.liveTimer = 0;
    if (this.tab === 'controller') {
      const live = this.body.querySelector('#live');
      if (live) {
        const bar = (label: string, v: number, bip = true) => {
          const pct = bip ? (v + 1) * 50 : v * 100;
          return `<div class="lv"><span>${label}</span><div class="lv-bar"><div class="lv-fill" style="width:${pct.toFixed(1)}%"></div>${bip ? '<div class="lv-mid"></div>' : ''}</div><b>${v.toFixed(2)}</b></div>`;
        };
        live.innerHTML = bar('Throttle', inputs.throttle, false) + bar('Roll', inputs.roll) + bar('Pitch', inputs.pitch) + bar('Yaw', inputs.yaw) +
          `<div class="lv"><span>Arm</span><b>${inputs.arm ? 'ON' : 'OFF'}</b></div><div class="lv"><span>Mode</span><b>${inputs.mode + 1}</b></div><div class="lv"><span>Rates</span><b>${inputs.highRate ? 'HIGH' : 'LOW'}</b></div>`;
      }
      const raw = this.body.querySelector('#raw');
      const p = this.input.pickPad();
      if (raw && p) {
        raw.innerHTML = Array.from(p.axes).map((a, i) => `<div class="lv"><span>Axis ${i}</span><div class="lv-bar"><div class="lv-fill" style="width:${((a + 1) * 50).toFixed(1)}%"></div><div class="lv-mid"></div></div><b>${a.toFixed(2)}</b></div>`).join('') +
          `<div class="btns">${p.buttons.map((bt, i) => `<span class="${bt.pressed ? 'on' : ''}">${i}</span>`).join('')}</div>`;
      }
      if (p && !this.body.querySelector('#padsel')) this.render();
    }
  }

  /* ------------------------------------------------------------ */
  private renderSettings(b: HTMLElement) {
    const s = this.s;
    const q: [Quality, string][] = [['low', 'Low — old laptops'], ['medium', 'Medium'], ['high', 'High — gaming PCs']];
    b.innerHTML = `
      <div class="grid2">
        <div>
          <h3>Graphics</h3>
          <select id="quality">${q.map(([v, l]) => `<option value="${v}" ${s.quality === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <p class="muted small">Changing quality reloads the page.</p>
          <label class="check"><input type="checkbox" id="autoq" ${s.autoQuality ? 'checked' : ''}> Dynamic resolution (keeps frame rate smooth)</label>
          <h3>Display</h3>
          <label class="check"><input type="checkbox" id="autozoom" ${s.autoZoom ? 'checked' : ''}> Auto-zoom in line-of-sight view</label>
          <label class="check"><input type="checkbox" id="sticks" ${s.showSticks ? 'checked' : ''}> Show stick positions</label>
          <label class="check"><input type="checkbox" id="imperial" ${s.imperial ? 'checked' : ''}> Imperial units</label>
          <div class="row"><span>Stick display</span>
            <select id="stickmode"><option value="2" ${s.stickMode === 2 ? 'selected' : ''}>Mode 2 (throttle left)</option><option value="1" ${s.stickMode === 1 ? 'selected' : ''}>Mode 1 (throttle right)</option></select></div>
          ${this.slider('simspeed', 'Simulation speed', s.simSpeed, 0.25, 1, 0.25, (v) => (v === 1 ? 'Real time' : `${v}× (slow-motion training)`))}
          <h3>Sound &amp; music</h3>
          ${this.slider('vol', 'Master volume', s.volume, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
          ${this.slider('sfxvol', 'Motors &amp; effects', s.sfxVolume, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
          ${this.slider('ambvol', 'Field ambience (wind, birds)', s.ambientVolume, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
          <label class="check"><input type="checkbox" id="musicon" ${s.musicOn ? 'checked' : ''}> Music (generated lo-fi, never repeats)</label>
          ${this.slider('musvol', 'Music volume', s.musicVolume, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)}
          <div class="row"><span class="muted small" id="track">${this.cb.trackName() ? '♪ ' + this.cb.trackName() : 'Music starts when you press Fly'}</span><button class="btn ghost" id="nexttrack">Next track ⏭</button></div>
        </div>
        <div>
          <h3>Realism</h3>
          <label class="check"><input type="checkbox" id="battery" ${s.batterySim ? 'checked' : ''}> Battery drains (realistic flight time, voltage sag)</label>
          <h3>Airplane controls</h3>
          ${this.slider('expo', 'Expo (softer centre)', s.expo, 0, 0.7, 0.05, (v) => `${Math.round(v * 100)}%`)}
          <p class="muted small">If you already set expo on your radio, set this to 0.</p>
          <h3>FPV quad</h3>
          ${this.slider('rc', 'Centre sensitivity', s.fpvRates.center, 20, 300, 5, (v) => `${v.toFixed(0)} °/s`)}
          ${this.slider('rmax', 'Max rate', s.fpvRates.max, 200, 1200, 10, (v) => `${v.toFixed(0)} °/s`)}
          ${this.slider('rexpo', 'Rate expo', s.fpvRates.expo, 0, 1, 0.02, (v) => v.toFixed(2))}
          <div class="row"><span>FPV video</span>
            <select id="fpvvideo"><option value="digital" ${s.fpvVideo === 'digital' ? 'selected' : ''}>HD digital (DJI O3 / Walksnail style)</option><option value="analog" ${s.fpvVideo === 'analog' ? 'selected' : ''}>Analog 5.8 GHz (noise, breakup)</option></select></div>
          <label class="check"><input type="checkbox" id="fpvprops" ${s.fpvProps ? 'checked' : ''}> Show props in the FPV camera view</label>
          ${this.slider('tilt', 'Camera uptilt', s.camTilt, 0, 50, 1, (v) => `${v.toFixed(0)}°`)}
          ${this.slider('fov', 'FPV field of view', s.fpvFov, 70, 140, 1, (v) => `${v.toFixed(0)}°`)}
        </div>
      </div>`;
    b.querySelector<HTMLSelectElement>('#quality')!.addEventListener('change', (e) => {
      s.quality = (e.target as HTMLSelectElement).value as Quality;
      saveSettings(s);
      location.reload();
    });
    const chk = (id: string, set: (v: boolean) => void) => b.querySelector<HTMLInputElement>('#' + id)!.addEventListener('change', (e) => { set((e.target as HTMLInputElement).checked); this.save(); });
    chk('autoq', (v) => (s.autoQuality = v));
    chk('autozoom', (v) => (s.autoZoom = v));
    chk('sticks', (v) => (s.showSticks = v));
    chk('imperial', (v) => (s.imperial = v));
    b.querySelector<HTMLSelectElement>('#stickmode')!.addEventListener('change', (e) => { s.stickMode = Number((e.target as HTMLSelectElement).value) as 1 | 2; this.save(); });
    this.bindSlider(b, 'vol', (v) => (s.volume = v));
    this.bindSlider(b, 'sfxvol', (v) => (s.sfxVolume = v));
    this.bindSlider(b, 'ambvol', (v) => (s.ambientVolume = v));
    this.bindSlider(b, 'musvol', (v) => (s.musicVolume = v));
    chk('musicon', (v) => (s.musicOn = v));
    chk('battery', (v) => (s.batterySim = v));
    chk('fpvprops', (v) => (s.fpvProps = v));
    b.querySelector<HTMLSelectElement>('#fpvvideo')!.addEventListener('change', (e) => { s.fpvVideo = (e.target as HTMLSelectElement).value as 'digital' | 'analog'; this.save(); });
    b.querySelector('#nexttrack')!.addEventListener('click', () => this.cb.onNextTrack());
    this.bindSlider(b, 'simspeed', (v) => (s.simSpeed = v));
    this.bindSlider(b, 'expo', (v) => (s.expo = v));
    this.bindSlider(b, 'rc', (v) => (s.fpvRates.center = v));
    this.bindSlider(b, 'rmax', (v) => (s.fpvRates.max = v));
    this.bindSlider(b, 'rexpo', (v) => (s.fpvRates.expo = v));
    this.bindSlider(b, 'tilt', (v) => (s.camTilt = v));
    this.bindSlider(b, 'fov', (v) => (s.fpvFov = v));
  }

  private renderHelp(b: HTMLElement) {
    b.innerHTML = `
      <div class="grid2">
        <div>
          <h3>Keyboard</h3>
          <table class="keys">
            <tr><td>W / S</td><td>Throttle up / down (X = cut)</td></tr>
            <tr><td>← →</td><td>Aileron / roll</td></tr>
            <tr><td>↑ ↓</td><td>Elevator / pitch (↑ = nose down, like pushing the stick)</td></tr>
            <tr><td>A / D</td><td>Rudder / yaw</td></tr>
            <tr><td>1 2 3</td><td>Flight mode</td></tr>
            <tr><td>E</td><td>Arm / disarm (quads)</td></tr>
            <tr><td>R</td><td>Reset aircraft</td></tr>
            <tr><td>C</td><td>Change camera</td></tr>
            <tr><td>P</td><td>Pause</td></tr>
            <tr><td>H</td><td>Hide HUD</td></tr>
            <tr><td>Esc</td><td>Menu</td></tr>
          </table>
          <h3>Flight modes (3-position switch)</h3>
          <table class="keys">
            <tr><td>Airplanes</td><td>1 Manual · 2 Gyro (rate damping) · 3 Self-level trainer</td></tr>
            <tr><td>FPV quad</td><td>1 Acro · 2 Angle · 3 Horizon</td></tr>
            <tr><td>Camera drone</td><td>1 GPS (holds position) · 2 ATTI (drifts with wind) · 3 Manual</td></tr>
          </table>
        </div>
        <div>
          <h3>Learning path</h3>
          <ol class="steps">
            <li><b>Trainer, "Already flying", self-level mode.</b> Learn left/right turns and keeping altitude with throttle.</li>
            <li><b>Manual mode.</b> Turns need aileron <i>and</i> a little up elevator. Use rudder to coordinate.</li>
            <li><b>Orientation.</b> When the plane flies toward you, left/right appear reversed. Watch the nav lights: <span style="color:#ff5050">red = left wing</span>, <span style="color:#40ff70">green = right wing</span>.</li>
            <li><b>Takeoff.</b> Into the wind, full throttle smoothly, steer with rudder, gentle up elevator at speed.</li>
            <li><b>Landing.</b> Low throttle on approach, keep speed above stall, flare just above the runway.</li>
            <li><b>Wind.</b> Add wind and gusts once you are comfortable.</li>
          </ol>
          <p class="muted">Quads: start with the camera drone in GPS mode, then ATTI, then the FPV quad in Angle, then Acro.</p>
          <h3>Real-world behaviour you will notice</h3>
          <ul class="steps">
            <li><b>Arming:</b> the motor only arms with the ARM switch on <i>and</i> throttle low — planes too (throttle-cut safety).</li>
            <li><b>Battery:</b> voltage sags under full throttle and drops over the flight; land when the HUD warns. Quads need more throttle to hover as the pack empties.</li>
            <li><b>Takeoff:</b> the trainer pulls slightly left (prop torque, P-factor, slipstream) — use a touch of right rudder.</li>
            <li><b>Landing:</b> ground effect makes the plane float in the flare; the stall gives a buffet before a wing drops.</li>
            <li><b>FPV:</b> dropping into your own propwash makes the quad wobble; descending straight down fast can enter vortex ring state.</li>
            <li><b>Obstacles:</b> you bounce off posts and buildings and can get stuck in trees.</li>
            <li><b>FPV video:</b> flying behind buildings, trees or hills blocks the video signal: analog breaks up into noise, digital freezes and goes blocky. Stay in line of sight, like in real life.</li>
          </ul>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------ */
  private slider(id: string, label: string, v: number, min: number, max: number, step: number, fmt: (v: number) => string) {
    (this as unknown as Record<string, unknown>)['fmt_' + id] = fmt;
    return `<div class="slider"><div class="slider-h"><span>${label}</span><b id="${id}-v">${fmt(v)}</b></div><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}"></div>`;
  }

  private bindSlider(b: HTMLElement, id: string, set: (v: number) => void) {
    const inp = b.querySelector<HTMLInputElement>('#' + id)!;
    const out = b.querySelector<HTMLElement>('#' + id + '-v')!;
    const fmt = (this as unknown as Record<string, (v: number) => string>)['fmt_' + id];
    inp.addEventListener('input', () => {
      const v = Number(inp.value);
      set(v);
      out.textContent = fmt(v);
      this.save();
    });
  }

  static fnList: Fn[] = ['throttle', 'yaw', 'pitch', 'roll', 'arm', 'mode', 'rate', 'reset'];
}

function compass(d: number) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8];
}
function shortId(id: string) {
  return id.replace(/\(.*?Vendor.*?\)/i, '').trim() || id;
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function setTrackLabel(name: string) {
  const el = document.getElementById('track');
  if (el) el.textContent = '♪ ' + name;
}
