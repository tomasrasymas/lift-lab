import type { ControlInputs, Telemetry } from '../sim/aircraft';
import type { Settings, ViewMode } from '../settings';

const VIEW_LABEL: Record<ViewMode, string> = { los: 'LINE OF SIGHT', chase: 'CHASE', fpv: 'FPV' };

export interface HudState {
  name: string;
  kind: 'plane' | 'quad';
  tm: Telemetry;
  input: ControlInputs;
  view: ViewMode;
  message: string;
  messageLevel: 'info' | 'warn' | 'bad';
  wind: { speed: number; fromDeg: number };
  fps: number;
  controller: string;
  paused: boolean;
  flightTime: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

class Gimbal {
  root = el('div', 'gimbal');
  dot = el('div', 'gimbal-dot');
  constructor(label: string) {
    this.root.append(el('div', 'gimbal-cross'), this.dot, el('div', 'gimbal-label', label));
  }
  set(x: number, y: number) {
    this.dot.style.transform = `translate(${x * 34}px, ${-y * 34}px)`;
  }
}

export class Hud {
  root = el('div', 'hud');
  private tl = el('div', 'hud-panel hud-tl');
  private tr = el('div', 'hud-panel hud-tr');
  private center = el('div', 'hud-center');
  private bl = el('div', 'hud-bl');
  private br = el('div', 'hud-br');
  private osd = el('div', 'fpv-osd');
  private left = new Gimbal('L');
  private right = new Gimbal('R');
  private thrBar = el('div', 'thr-fill');
  private acc = 0;
  private fields: Record<string, HTMLElement> = {};

  constructor(private settings: Settings) {
    const row = (k: string, label: string) => {
      const r = el('div', 'tm-row');
      const v = el('span', 'tm-val', '-');
      r.append(el('span', 'tm-lbl', label), v);
      this.fields[k] = v;
      return r;
    };
    this.tl.append(
      (this.fields.name = el('div', 'hud-title')),
      el('div', 'chips', ''),
    );
    const chips = this.tl.querySelector('.chips')!;
    chips.append((this.fields.mode = el('span', 'chip')), (this.fields.armed = el('span', 'chip')), (this.fields.view = el('span', 'chip chip-dim')), (this.fields.rate = el('span', 'chip chip-dim')));
    this.tr.append(row('spd', 'SPD'), row('alt', 'ALT'), row('vs', 'V/S'), row('g', 'G'), row('thr', 'THR'), row('bat', 'BAT'), row('mah', 'USED'), row('wind', 'WIND'), row('time', 'TIME'));
    const thr = el('div', 'thr');
    thr.append(this.thrBar);
    const sticks = el('div', 'sticks');
    sticks.append(this.left.root, thr, this.right.root);
    this.bl.append(sticks);
    this.br.append((this.fields.hint = el('div', 'hint')), (this.fields.fps = el('div', 'fps')));
    this.osd.innerHTML = '<div class="osd-cross"></div>';
    this.root.append(this.osd, this.tl, this.tr, this.center, this.bl, this.br);
    document.body.append(this.root);
  }

  private np = el('div', 'now-playing');
  private npTimer = 0;

  setVisible(v: boolean) { this.root.style.display = v ? '' : 'none'; }

  setFpvMode(on: boolean) { this.root.classList.toggle('hud-fpv', on); }

  showTrack(name: string) {
    if (!this.np.parentElement) this.root.append(this.np);
    this.np.textContent = `♪ ${name}`;
    this.np.classList.add('show');
    clearTimeout(this.npTimer);
    this.npTimer = window.setTimeout(() => this.np.classList.remove('show'), 6000);
  }

  update(dt: number, s: HudState) {
    const i = s.input;
    // sticks every frame (cheap)
    const thrY = i.throttle * 2 - 1;
    if (this.settings.stickMode === 2) { this.left.set(i.yaw, thrY); this.right.set(i.roll, i.pitch); }
    else { this.left.set(i.yaw, i.pitch); this.right.set(i.roll, thrY); }
    this.thrBar.style.transform = `scaleY(${i.throttle})`;
    this.bl.style.display = this.settings.showSticks ? '' : 'none';
    this.osd.style.display = s.view === 'fpv' ? '' : 'none';

    this.acc += dt;
    if (this.acc < 0.08) return;
    this.acc = 0;
    const tm = s.tm;
    const imp = this.settings.imperial;
    const spd = imp ? `${(tm.airspeed * 2.237).toFixed(0)} mph` : `${(tm.airspeed * 3.6).toFixed(0)} km/h`;
    const alt = imp ? `${(tm.altitude * 3.281).toFixed(0)} ft` : `${tm.altitude.toFixed(1)} m`;
    const vs = imp ? `${(tm.vspeed * 196.85).toFixed(0)} fpm` : `${tm.vspeed >= 0 ? '+' : ''}${tm.vspeed.toFixed(1)} m/s`;
    this.fields.name.textContent = s.name;
    this.fields.mode.textContent = tm.modeName;
    this.fields.armed.textContent = s.kind === 'quad' ? (tm.armed ? 'ARMED' : 'DISARMED') : tm.armed ? 'MOTOR ARMED' : 'MOTOR SAFE';
    this.fields.armed.className = 'chip ' + (tm.armed ? 'chip-hot' : 'chip-dim');
    this.fields.view.textContent = VIEW_LABEL[s.view];
    this.fields.rate.textContent = i.highRate ? 'HIGH RATE' : 'LOW RATE';
    this.fields.spd.textContent = spd;
    this.fields.alt.textContent = alt;
    this.fields.vs.textContent = vs;
    this.fields.g.textContent = tm.gForce.toFixed(1);
    this.fields.thr.textContent = `${Math.round(tm.throttle * 100)}%`;
    const cv = tm.cellV;
    this.fields.bat.innerHTML = `<span class="${cv < 3.45 ? 'bad' : cv < 3.6 ? 'warn' : ''}">${tm.cells}S ${(cv * tm.cells).toFixed(1)}V</span> ${Math.round(tm.batteryPct)}%`;
    this.fields.mah.textContent = `${Math.round(tm.usedMah)} mAh`;
    const arrow = `<span class="wind-arrow" style="transform:rotate(${s.wind.fromDeg + 180}deg)">↑</span>`;
    this.fields.wind.innerHTML = `${(imp ? s.wind.speed * 2.237 : s.wind.speed * 3.6).toFixed(0)} ${imp ? 'mph' : 'km/h'} ${arrow}`;
    const t = Math.floor(s.flightTime);
    this.fields.time.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    this.center.innerHTML = s.message ? `<div class="msg msg-${s.messageLevel}">${s.message}</div>` : '';
    this.fields.hint.innerHTML = `${s.controller}<br><b>Esc</b> menu · <b>R</b> reset · <b>C</b> view · <b>P</b> pause`;
    this.fields.fps.textContent = `${s.fps.toFixed(0)} fps`;
  }
}
