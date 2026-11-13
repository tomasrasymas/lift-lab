/** LiPo pack: open-circuit voltage curve, internal resistance sag, capacity drain. */
export interface BatteryConfig {
  cells: number;
  capacity: number; // mAh
  rInt: number;     // pack internal resistance (ohm)
}

// per-cell open-circuit voltage vs state of charge
const OCV: [number, number][] = [
  [0, 3.27], [0.05, 3.5], [0.1, 3.62], [0.2, 3.7], [0.4, 3.77], [0.6, 3.85], [0.8, 3.98], [0.9, 4.07], [1, 4.2],
];

function ocvCell(soc: number) {
  if (soc <= 0) return OCV[0][1];
  for (let i = 1; i < OCV.length; i++) {
    if (soc <= OCV[i][0]) {
      const [s0, v0] = OCV[i - 1], [s1, v1] = OCV[i];
      return v0 + ((soc - s0) / (s1 - s0)) * (v1 - v0);
    }
  }
  return 4.2;
}

export class Battery {
  soc = 1;
  voltage: number;
  current = 0;
  usedMah = 0;
  /** false = unlimited battery (no drain, still sags under load) */
  drain = true;

  constructor(public cfg: BatteryConfig) {
    this.voltage = cfg.cells * 4.2;
  }

  reset() {
    this.soc = 1;
    this.usedMah = 0;
    this.current = 0;
    this.voltage = this.cfg.cells * 4.2;
  }

  /** Draw `power` watts for dt seconds. */
  update(power: number, dt: number) {
    const voc = this.cfg.cells * ocvCell(this.soc);
    const R = this.cfg.rInt;
    const disc = voc * voc - 4 * R * power;
    const I = disc > 0 ? (voc - Math.sqrt(disc)) / (2 * R) : voc / (2 * R);
    this.current = I;
    this.voltage = voc - I * R;
    if (this.drain) {
      this.soc = Math.max(0, this.soc - (I * dt) / (this.cfg.capacity * 3.6));
      this.usedMah += (I * dt) / 3.6;
    }
  }

  get cellVoltage() { return this.voltage / this.cfg.cells; }

  /** Motor speed multiplier from pack voltage (1 = healthy pack under light load). ESC low-voltage cutoff when empty. */
  get rpmScale() {
    let s = this.voltage / (this.cfg.cells * 3.95);
    if (this.soc < 0.03) s *= 0.55;
    return Math.min(1.06, s);
  }
}
