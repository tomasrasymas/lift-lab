import type { Telemetry } from '../sim/aircraft';

export interface OsdState {
  style: 'betaflight' | 'dji';
  tm: Telemetry;
  armed: boolean;
  modeName: string;
  lq: number;           // 0..1
  flightTime: number;
  distance: number;     // from home/pilot (m)
  pitchDeg: number;
  rollDeg: number;
  headingDeg: number;
  warning: string;
  analog: boolean;
  frozen: boolean;
  imperial: boolean;
}

const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** On-screen display drawn like a real FPV OSD (white glyphs, black outline). */
export class Osd {
  root = document.createElement('div');
  private acc = 1;
  private horizon = document.createElement('div');

  constructor() {
    this.root.className = 'osd hidden';
    document.body.append(this.root);
  }

  setVisible(v: boolean) { this.root.classList.toggle('hidden', !v); }

  update(dt: number, s: OsdState) {
    this.acc += dt;
    // attitude line every frame (smooth), text at 12 Hz
    if (s.style === 'betaflight' && this.horizon.parentElement) {
      this.horizon.style.transform = `translate(-50%, ${s.pitchDeg * 4}px) rotate(${-s.rollDeg}deg)`;
    }
    if (this.acc < 0.083) return;
    this.acc = 0;
    this.root.classList.toggle('osd-analog', s.analog);
    const tm = s.tm;
    const imp = s.imperial;
    const alt = imp ? `${(tm.altitude * 3.281).toFixed(0)}FT` : `${tm.altitude.toFixed(1)}M`;
    const spd = imp ? `${(tm.groundspeed * 2.237).toFixed(0)}MPH` : `${(tm.groundspeed * 3.6).toFixed(0)}KM/H`;
    const t = `${pad2(s.flightTime / 60)}:${pad2(s.flightTime % 60)}`;
    const lq = Math.round(s.lq * 100);
    const rssi = Math.round(-50 - (1 - s.lq) * 55);
    const cellLow = tm.cellV < 3.5 ? ' blink' : '';
    const warn = s.frozen ? 'VIDEO SIGNAL LOST' : s.warning;
    if (s.style === 'betaflight') {
      this.root.innerHTML = `
        <div class="osd-tl"><span class="${cellLow}">${(tm.cellV * tm.cells).toFixed(1)}V</span> <span class="dim">${tm.cellV.toFixed(2)}V</span><br>${Math.round(tm.usedMah)}MAH</div>
        <div class="osd-tc">${s.modeName}</div>
        <div class="osd-tr">LQ ${lq}<br><span class="dim">${rssi}DBM</span></div>
        <div class="osd-ml">${spd}</div>
        <div class="osd-mr">${alt}</div>
        <div class="osd-cross">-+-</div>
        <div class="osd-bl">${t}</div>
        <div class="osd-bc">${Math.round(s.distance)}${imp ? 'FT' : 'M'} &#x2302;</div>
        <div class="osd-br">THR ${Math.round(tm.throttle * 100)}</div>
        ${!s.armed ? '<div class="osd-warn big">DISARMED</div>' : warn ? `<div class="osd-warn blink">${warn}</div>` : ''}`;
      this.root.prepend(this.horizon);
      this.horizon.className = 'osd-horizon';
    } else {
      // DJI Fly style: top status bar, bottom telemetry strip
      const dist = imp ? `${(s.distance * 3.281).toFixed(0)}ft` : `${s.distance.toFixed(0)}m`;
      const h = imp ? `${(tm.altitude * 3.281).toFixed(0)}ft` : `${tm.altitude.toFixed(1)}m`;
      const hs = imp ? `${(tm.groundspeed * 2.237).toFixed(1)}mph` : `${tm.groundspeed.toFixed(1)}m/s`;
      const vs = imp ? `${(tm.vspeed * 3.281).toFixed(1)}ft/s` : `${tm.vspeed.toFixed(1)}m/s`;
      const bars = '▮'.repeat(Math.max(1, Math.round(s.lq * 5))) + '▯'.repeat(5 - Math.max(1, Math.round(s.lq * 5)));
      this.root.innerHTML = `
        <div class="dji-top">
          <span class="dji-mode">${s.armed ? 'In Flight' : 'Ready to Go'} · ${s.modeName}</span>
          <span>GPS 18 ⦿</span><span>${bars}</span><span class="${tm.batteryPct < 20 ? 'blink' : ''}">🔋 ${Math.round(tm.batteryPct)}%</span>
        </div>
        <div class="dji-bottom">
          <span><b>D</b> ${dist}</span><span><b>H</b> ${h}</span><span><b>H.S</b> ${hs}</span><span><b>V.S</b> ${vs}</span><span>⏱ ${t}</span>
        </div>
        <div class="dji-rec">● REC ${t}</div>
        ${warn ? `<div class="osd-warn dji-warn">${warn}</div>` : ''}`;
    }
  }
}
