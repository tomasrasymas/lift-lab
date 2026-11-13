import { Euler, Vector3 } from 'three';
import { Aircraft, ContactPoint, ControlInputs, SpawnOptions } from './aircraft';
import { World } from './world';
import { DEG, G, RHO, clamp, noise1, smoothstep } from './math';
import { Battery, BatteryConfig } from './battery';

export interface RateProfile { center: number; max: number; expo: number; } // Betaflight "Actual" rates (deg/s)

export interface QuadConfig {
  id: string;
  name: string;
  description: string;
  type: 'fpv' | 'gps';
  mass: number;
  inertia: [number, number, number]; // pitch, yaw, roll
  arm: number;          // motor offset along x and z (m)
  motorThrust: number;  // max thrust per motor (N)
  motorTau: number;     // spool time constant (s)
  idle: number;         // idle motor command (0..1)
  kQ: number;           // yaw torque / thrust (m)
  propDiameter: number;
  pitchSpeed: number;   // prop pitch speed (m/s)
  cda: [number, number, number];
  hForce: number;       // rotor drag coefficient (1/(m/s))
  contacts: ContactPoint[];
  rates: RateProfile;
  yawRates: RateProfile;
  maxAngle: number;     // deg (angle / GPS modes)
  pid: { kp: number; ki: number; kpYaw: number; kiYaw: number; angle: number };
  maxSpeed: number;     // m/s in GPS mode
  fpvCam: [number, number, number];
  camTilt: number;      // deg
  battery: BatteryConfig;
  motorPower: number;   // electrical W per motor at full throttle
  maxRpm: number;       // for sound
  blades: number;
}

const _v = new Vector3(), _w = new Vector3(), _t = new Vector3(), _p = new Vector3(), _e = new Euler();
const _fw = new Vector3(), _rt = new Vector3(), _acc = new Vector3();

export function actualRate(x: number, r: RateProfile) {
  const ax = Math.abs(x);
  const expof = ax * (Math.pow(x, 5) * r.expo + x * (1 - r.expo));
  return (x * r.center + Math.max(0, r.max - r.center) * expof) * DEG;
}

export class Multirotor extends Aircraft {
  readonly kind = 'quad' as const;
  readonly name: string;
  readonly modeNames: [string, string, string];
  cfg: QuadConfig;
  motors: { pos: Vector3; spin: number; n: number; thrust: number }[];
  armed = false;
  rates: RateProfile;
  yawRates: RateProfile;
  camTilt: number;
  private iRate = new Vector3();
  private iVel = new Vector3();
  private iVz = 0;
  private hold = new Vector3();
  private holding = false;
  private armOnSpawn = false;

  constructor(cfg: QuadConfig) {
    super(cfg.mass, new Vector3(...cfg.inertia));
    this.cfg = cfg;
    this.name = cfg.name;
    this.modeNames = cfg.type === 'fpv' ? ['ACRO', 'ANGLE', 'HORIZON'] : ['GPS', 'ATTI', 'MANUAL'];
    this.rates = { ...cfg.rates };
    this.yawRates = { ...cfg.yawRates };
    this.camTilt = cfg.camTilt;
    this.battery = new Battery(cfg.battery);
    this.contacts = cfg.contacts.map((c) => ({ ...c, pos: c.pos.clone() }));
    const a = cfg.arm;
    // FR, RR, RL, FL  (spin +1 = CCW seen from above)
    this.motors = [
      { pos: new Vector3(a, 0.0, -a), spin: +1, n: 0, thrust: 0 },
      { pos: new Vector3(a, 0.0, a), spin: -1, n: 0, thrust: 0 },
      { pos: new Vector3(-a, 0.0, a), spin: +1, n: 0, thrust: 0 },
      { pos: new Vector3(-a, 0.0, -a), spin: -1, n: 0, thrust: 0 },
    ];
  }

  reset(world: World, opts: SpawnOptions) {
    this.baseReset();
    this.armed = false;
    this.iRate.set(0, 0, 0);
    this.iVel.set(0, 0, 0);
    this.iVz = 0;
    this.holding = false;
    for (const m of this.motors) { m.n = 0; m.thrust = 0; }
    this.placeOnGround(world, world.layout.pad.x, world.layout.pad.z, 0);
    this.armOnSpawn = !!opts.inAir;
    if (opts.inAir) {
      this.body.pos.y += 12;
      this.armed = true;
      const hoverN = Math.sqrt(this.cfg.mass * G / (4 * this.cfg.motorThrust));
      for (const m of this.motors) m.n = hoverN;
    }
  }

  protected stepForces(dt: number, input: ControlInputs, world: World) {
    const b = this.body, cfg = this.cfg, tm = this.telemetry;

    // ---- arming ----
    const armSw = input.arm;
    if (!armSw) this.armed = false;
    else if (this.armOnSpawn) this.armed = true;
    else if (!this.armed && !this.crashed) {
      // GPS drones: throttle is a climb-rate stick, centre = hold, so it may be armed at centre (it idles on the ground)
      const lowThrottle = cfg.type === 'fpv' ? input.throttle < 0.06 : input.throttle < 0.62;
      if (lowThrottle) this.armed = true;
    }
    this.armOnSpawn = false;
    if (this.crashed) this.armed = false;
    const bat = this.battery!;
    const vScale = bat.rpmScale;

    // ---- attitude ----
    _e.setFromQuaternion(b.quat, 'YXZ');
    const yaw = _e.y, theta = _e.x, phi = -_e.z;
    const w = b.angVel;

    // ---- air-relative velocity ----
    const gh = world.terrain.groundAt(b.pos.x, b.pos.z);
    world.wind.sample(b.pos, world.time, gh, _w);
    const vRelW = _v.copy(b.vel).sub(_w);
    const airspeed = vRelW.length();
    const vRelB = b.toBody(vRelW, _t);

    // ---- flight controller ----
    let pSp = 0, qSp = 0, rSp = actualRate(input.yaw, this.yawRates);
    let collective = 0; // total thrust command (N)
    const maxAng = cfg.maxAngle * DEG;
    const Tmax = cfg.motorThrust;
    const Tidle = Tmax * cfg.idle * cfg.idle;
    const tilt = Math.max(0.5, Math.cos(phi) * Math.cos(theta));

    if (cfg.type === 'fpv') {
      const acroP = actualRate(input.roll, this.rates), acroQ = -actualRate(input.pitch, this.rates);
      const angP = clamp(cfg.pid.angle * (input.roll * maxAng - phi), -6, 6);
      const angQ = clamp(cfg.pid.angle * (-input.pitch * maxAng - theta), -6, 6);
      if (input.mode === 0) { pSp = acroP; qSp = acroQ; }
      else if (input.mode === 1) { pSp = angP; qSp = angQ; }
      else {
        const h = clamp(Math.max(Math.abs(input.roll), Math.abs(input.pitch)) * 1.15, 0, 1);
        pSp = angP + (acroP - angP) * h; qSp = angQ + (acroQ - angQ) * h;
      }
      const u = cfg.idle + (1 - cfg.idle) * input.throttle;
      collective = 4 * Tmax * u * u;
    } else {
      // camera drone: GPS / ATTI / MANUAL(angle)
      let phiT = input.roll * maxAng, thT = -input.pitch * maxAng;
      if (input.mode === 0) {
        _fw.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        _rt.set(Math.cos(yaw), 0, -Math.sin(yaw));
        const sticks = Math.abs(input.roll) + Math.abs(input.pitch) > 0.04;
        const vDes = _p.copy(_fw).multiplyScalar(input.pitch * cfg.maxSpeed).addScaledVector(_rt, input.roll * cfg.maxSpeed);
        if (sticks || this.onGround) this.holding = false;
        else if (!this.holding && Math.hypot(b.vel.x, b.vel.z) < 0.6) { this.holding = true; this.hold.copy(b.pos); }
        if (this.holding) { vDes.x += (this.hold.x - b.pos.x) * 0.9; vDes.z += (this.hold.z - b.pos.z) * 0.9; }
        _acc.set(vDes.x - b.vel.x, 0, vDes.z - b.vel.z).multiplyScalar(1.6);
        if (!this.onGround) this.iVel.addScaledVector(_acc, dt * 0.5);
        this.iVel.clampLength(0, 4);
        _acc.add(this.iVel);
        const aMax = G * Math.tan(maxAng);
        _acc.clampLength(0, aMax);
        thT = -Math.atan(_acc.dot(_fw) / G);
        phiT = Math.atan(_acc.dot(_rt) / G);
      }
      pSp = clamp(cfg.pid.angle * (phiT - phi), -4, 4);
      qSp = clamp(cfg.pid.angle * (thT - theta), -4, 4);
      if (input.mode === 2) {
        const u = cfg.idle + (1 - cfg.idle) * input.throttle;
        collective = 4 * Tmax * u * u;
      } else {
        // altitude hold: stick centre = hold, up/down = climb/descend rate
        let s = (input.throttle - 0.5) * 2;
        s = Math.abs(s) < 0.12 ? 0 : (s - Math.sign(s) * 0.12) / 0.88;
        const vzSp = s > 0 ? s * 5 : s * 3;
        if (this.onGround && vzSp <= 0.05) { collective = 4 * Tidle; this.iVz = 0; }
        else {
          const ez = vzSp - b.vel.y;
          this.iVz = clamp(this.iVz + ez * dt * 2.0, -4, 4);
          collective = (cfg.mass * (G + 3.0 * ez + this.iVz)) / tilt;
        }
      }
    }

    // rate loop (three body axes: x = pitch, y = yaw(-r), z = roll(-p))
    const spX = qSp, spY = -rSp, spZ = -pSp;
    const ex = spX - w.x, ey = spY - w.y, ez = spZ - w.z;
    const airborne = !this.onGround || input.throttle > 0.15;
    if (this.armed && airborne) {
      this.iRate.x = clamp(this.iRate.x + ex * dt, -0.5, 0.5);
      this.iRate.y = clamp(this.iRate.y + ey * dt, -0.5, 0.5);
      this.iRate.z = clamp(this.iRate.z + ez * dt, -0.5, 0.5);
    } else this.iRate.multiplyScalar(0.9);
    const I = b.inertia, k = cfg.pid;
    const tx = I.x * (k.kp * ex + k.ki * this.iRate.x);
    const ty = I.y * (k.kpYaw * ey + k.kiYaw * this.iRate.y);
    const tz = I.z * (k.kp * ez + k.ki * this.iRate.z);

    // ---- mixer with airmode desaturation ----
    const a = cfg.arm;
    const base = clamp(collective / 4, Tidle, Tmax);
    const d = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const m = this.motors[i];
      d[i] = (-m.pos.z * tx) / (4 * a * a) + (m.pos.x * tz) / (4 * a * a) + (-m.spin * ty) / (4 * cfg.kQ);
    }
    // yaw has lowest authority: limit it first
    let lo = Math.min(...d), hi = Math.max(...d);
    const span = Tmax - Tidle;
    if (hi - lo > span) { const s = span / (hi - lo); for (let i = 0; i < 4; i++) d[i] *= s; lo *= s; hi *= s; }
    let shift = 0;
    if (base + hi > Tmax) shift = Tmax - (base + hi);
    if (base + lo < Tidle) shift = Tidle - (base + lo);

    // ---- motors + rotor aerodynamics ----
    let totalT = 0;
    let power = 0;
    let washSum = 0;
    const turb = world.wind.settings.turbulence;
    const hSpeed = Math.hypot(vRelB.x, vRelB.z);
    for (let i = 0; i < 4; i++) {
      const m = this.motors[i];
      let u = 0;
      if (this.armed) u = Math.sqrt(clamp((base + d[i] + shift) / Tmax, 0, 1)) * vScale;
      // motors spin up faster than they brake down
      const tauM = u > m.n ? cfg.motorTau * (1.25 - 0.5 * m.n) : cfg.motorTau * 1.5;
      m.n += (u - m.n) * clamp(dt / tauM, 0, 1);
      power += cfg.motorPower * (0.12 * m.n + 0.88 * m.n * m.n * m.n); // prop power ~ n^3 plus motor/ESC losses
      // axial inflow through this rotor (positive = air coming from above = climbing)
      b.pointVelocityBody(m.pos, _p);
      _p.sub(b.toBody(_w, _acc));
      const vAx = _p.y;
      let T = Tmax * m.n * m.n * clamp(1 - vAx / (cfg.pitchSpeed * Math.max(m.n, 0.2)), 0, 1.25);
      // translational lift: clean air improves efficiency a bit
      T *= 1 + 0.08 * smoothstep(2, 9, hSpeed);
      // vortex ring state when descending vertically into own downwash
      const vrs = smoothstep(2.0, 5.0, -vAx) * (1 - smoothstep(2.5, 6, hSpeed));
      if (vrs > 0) T *= 1 - vrs * (0.25 + 0.25 * noise1(world.time * 6 + i * 3.1, 90 + i));
      // propwash: rotor flying through its own dirty air (descending / after flips) -> wobble
      washSum += smoothstep(0.5, 4, -vAx) * m.n;
      // ground effect
      const hAgl = b.pos.y - gh;
      T *= 1 + 0.12 * (1 - smoothstep(0.05, cfg.propDiameter * 2.5, hAgl));
      m.thrust = T;
      totalT += T;
      _p.set(0, T, 0);
      b.addForceBodyAt(_p, m.pos);
      _p.set(0, -m.spin * cfg.kQ * T, 0);
      b.addTorqueBody(_p);
    }

    // rotor drag (H-force) + body drag
    const pd = 0.5 * RHO;
    _p.set(
      -cfg.hForce * totalT * vRelB.x - pd * cfg.cda[0] * vRelB.x * Math.abs(vRelB.x),
      -pd * cfg.cda[1] * vRelB.y * Math.abs(vRelB.y),
      -cfg.hForce * totalT * vRelB.z - pd * cfg.cda[2] * vRelB.z * Math.abs(vRelB.z),
    );
    b.addForceBodyAt(_p, _acc.set(0, 0.01, 0));
    // small aerodynamic rotational damping
    _p.copy(w).multiplyScalar(-0.0004 * (1 + airspeed * 0.05));
    b.addTorqueBody(_p);
    bat.update(power + 2, dt);
    // propwash oscillation (the classic FPV wobble when dropping into your own wash)
    const pw = (washSum / 4) * (cfg.type === 'fpv' ? 1 : 0.4);
    if (pw > 0.02) {
      const amp = pw * cfg.mass * 0.05;
      _p.set(noise1(world.time * 17, 301) * amp, 0, noise1(world.time * 19, 307) * amp);
      b.addTorqueBody(_p);
    }
    // turbulence torque (differential gusts across rotors)
    if (turb > 0 && !this.onGround) {
      const ws = world.wind.settings.speed;
      const amp = turb * (0.02 + 0.006 * ws) * cfg.mass;
      _p.set(noise1(world.time * 3.3, 71) * amp, noise1(world.time * 2.1, 73) * amp * 0.3, noise1(world.time * 3.7, 79) * amp);
      b.addTorqueBody(_p);
    }

    tm.airspeed = airspeed;
    tm.throttle = input.throttle;
    tm.aoa = 0;
    tm.stall = false;
    tm.armed = this.armed;
    tm.modeName = this.modeNames[input.mode];
    tm.motorRpm = this.motors.map((m) => m.n);
  }
}
