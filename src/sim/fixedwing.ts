import { Euler, Quaternion, Vector3 } from 'three';
import { Aircraft, ContactPoint, ControlInputs, SpawnOptions } from './aircraft';
import { World } from './world';
import { DEG, RHO, clamp, lerp, noise1, smoothstep } from './math';
import { Battery, BatteryConfig } from './battery';

export type ControlChannel = 'aileronL' | 'aileronR' | 'elevator' | 'rudder' | 'elevonL' | 'elevonR';

export interface SurfaceDef {
  name: string;
  pos: [number, number, number];
  area: number;
  ar: number;            // aspect ratio used for lift slope + induced drag
  dihedral?: number;     // deg (tip up)
  vertical?: boolean;
  sweep?: number;        // deg
  incidence: number;     // deg
  cl0: number;           // camber lift at zero AoA
  stall: number;         // deg
  stallWidth: number;    // deg, transition into post-stall (larger = gentler)
  cd0: number;
  flapFrac?: number;     // control surface chord fraction
  control?: ControlChannel;
  maxDefl?: number;      // deg
  propwash?: number;     // fraction of prop slipstream seen
  downwash?: boolean;
  isWing?: boolean;
}

export interface PlaneConfig {
  id: string;
  name: string;
  description: string;
  mass: number;
  inertia: [number, number, number]; // pitch, yaw, roll
  surfaces: SurfaceDef[];
  prop: {
    pos: [number, number, number]; thrust: number; pitchSpeed: number; diameter: number; torque: number; spool: number;
    downthrust?: number; rightthrust?: number;
    power: number;      // electrical power at full throttle (W)
    inertia: number;    // prop + motor bell rotational inertia (kg m^2)
    maxRpm: number;     // for sound + gyroscopic effect
    blades: number;
  };
  battery: BatteryConfig;
  fuselage: { cda: [number, number, number]; pos: [number, number, number] };
  contacts: ContactPoint[];
  wingAR: number;
  lowRate: number;
  elevonMix?: { pitch: number; roll: number };
  handLaunch?: boolean;
  restPitch?: number; // deg, for taildraggers
  fpvCam: [number, number, number];
  stallSpeed: number; // approx, for in-air spawn
  servoSpeed: number; // rad/s max surface rate
}

interface SurfaceRT {
  def: SurfaceDef;
  pos: Vector3;
  n: Vector3; // normal (lift dir at alpha 0)
  c: Vector3; // chord dir (forward)
  s: Vector3; // span axis
  clAlpha: number;
  tau: number; // flap effectiveness
  alpha: number; // last effective alpha (rad)
  cl: number;
  idx: number;
}

const _v = new Vector3(), _w = new Vector3(), _f = new Vector3(), _l = new Vector3(), _F = new Vector3();
const _wp = new Vector3(), _e = new Euler(), _H = new Vector3();

export class FixedWing extends Aircraft {
  readonly kind = 'plane' as const;
  readonly name: string;
  readonly modeNames: [string, string, string] = ['MANUAL', 'GYRO', 'SELF-LEVEL'];
  cfg: PlaneConfig;
  surfaces: SurfaceRT[];
  propDir = new Vector3(0, 0, -1);
  propPos: Vector3;
  rpm = 0; // 0..1 (actual, includes battery sag)
  thrust = 0;
  motorArmed = false;
  private armOnSpawn = false;
  private wingCL = 0;
  private iPitch = 0;
  private propArea: number;
  private windBody = new Vector3();
  private span: number;
  /** commanded and actual (servo-limited) control deflections, rad */
  private target: Record<string, number> = {};

  constructor(cfg: PlaneConfig) {
    super(cfg.mass, new Vector3(cfg.inertia[0], cfg.inertia[1], cfg.inertia[2]));
    this.cfg = cfg;
    this.name = cfg.name;
    this.battery = new Battery(cfg.battery);
    this.contacts = cfg.contacts.map((c) => ({ ...c, pos: c.pos.clone() }));
    this.propPos = new Vector3(...cfg.prop.pos);
    const dn = (cfg.prop.downthrust ?? 0) * DEG, rt = (cfg.prop.rightthrust ?? 0) * DEG;
    this.propDir.set(Math.sin(rt), -Math.sin(dn), -Math.cos(dn) * Math.cos(rt)).normalize();
    this.propArea = Math.PI * (cfg.prop.diameter / 2) ** 2;
    this.span = 2 * Math.max(...cfg.surfaces.filter((s) => s.isWing).map((s) => Math.abs(s.pos[0]))) * 1.2;
    this.surfaces = cfg.surfaces.map((d, idx) => {
      // chord axis is swept with the panel (simple sweep theory: only the flow normal
      // to the leading edge makes lift -> gives sweep its dihedral effect)
      const side = d.pos[0] >= 0 ? 1 : -1;
      const sw = d.vertical ? 0 : (d.sweep ?? 0) * DEG * side;
      const c = new Vector3(Math.sin(sw), 0, -Math.cos(sw));
      let n: Vector3;
      if (d.vertical) n = new Vector3(-1, 0, 0);
      else n = new Vector3(0, 1, 0).applyAxisAngle(c, -side * (d.dihedral ?? 0) * DEG);
      const s = new Vector3().crossVectors(n, _v.copy(c).negate()).normalize();
      const ar = d.ar;
      const clAlpha = ((2 * Math.PI * ar) / (ar + 2)) * 0.95;
      const cf = d.flapFrac ?? 0;
      const th = Math.acos(2 * cf - 1);
      const tau = cf > 0 ? 1 - (th - Math.sin(th)) / Math.PI : 0;
      return { def: d, pos: new Vector3(...d.pos), n, c, s, clAlpha, tau, alpha: 0, cl: 0, idx };
    });
  }

  reset(world: World, opts: SpawnOptions) {
    this.baseReset();
    this.rpm = 0;
    this.iPitch = 0;
    this.motorArmed = false;
    this.armOnSpawn = !!opts.inAir;
    for (const k of Object.keys(this.target)) { this.target[k] = 0; this.telemetry.surfaces[k] = 0; }
    const yaw = -Math.PI / 2; // face +X (east) - runway heading
    const b = this.body;
    if (opts.inAir) {
      b.quat.setFromAxisAngle(new Vector3(0, 1, 0), yaw);
      b.pos.copy(world.layout.airSpawn);
      const v = this.cfg.stallSpeed * 1.6;
      b.vel.set(v, 0, 0);
      b.angVel.set(0, 0, 0);
      this.rpm = 0.5;
    } else if (this.cfg.handLaunch) {
      b.quat.setFromAxisAngle(new Vector3(0, 1, 0), yaw);
      b.pos.copy(world.layout.pilot).add(new Vector3(-4, 0.1, -5));
      b.vel.set(0, 0, 0);
      b.angVel.set(0, 0, 0);
      this.awaitingLaunch = true;
    } else {
      const rw = world.layout.runway;
      this.placeOnGround(world, rw.cx - rw.halfLength + 12, rw.cz, yaw, (this.cfg.restPitch ?? 0) * DEG);
    }
  }

  private launch() {
    const b = this.body;
    this.awaitingLaunch = false;
    const fwd = _v.set(0, 0, -1).applyQuaternion(b.quat);
    b.vel.copy(fwd).multiplyScalar(this.cfg.stallSpeed * 1.25);
    b.vel.y += 1.2;
    b.quat.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 8 * DEG));
  }

  protected stepForces(dt: number, input: ControlInputs, world: World) {
    const b = this.body;
    const cfg = this.cfg;
    const tm = this.telemetry;
    const bat = this.battery!;

    // ---- motor arming (throttle-cut safety like a real ELRS/INAV setup) ----
    if (!input.arm || this.crashed) this.motorArmed = false;
    else if (!this.motorArmed && (input.throttle < 0.06 || this.armOnSpawn)) this.motorArmed = true;
    this.armOnSpawn = false;

    // ---- throttle / motor / battery ----
    const thrCmd = this.motorArmed ? clamp(input.throttle, 0, 1) : 0;
    const nTarget = thrCmd * bat.rpmScale;
    // electric motors spin up faster than they coast down
    const tau = nTarget > this.rpm ? cfg.prop.spool : cfg.prop.spool * 1.6;
    this.rpm += (nTarget - this.rpm) * clamp(dt / tau, 0, 1);
    bat.update(cfg.prop.power * (0.12 * this.rpm + 0.88 * this.rpm ** 3) + 0.5, dt);
    if (this.awaitingLaunch) {
      tm.throttle = thrCmd;
      tm.motorRpm = [this.rpm];
      tm.armed = this.motorArmed;
      if (thrCmd > 0.45 && !this.crashed) this.launch();
      this.fillSurfaces(input, dt);
      return;
    }

    // ---- stick shaping: dual rates + assist modes ----
    const rate = input.highRate ? 1 : cfg.lowRate;
    let ail = input.roll * rate;
    let ele = input.pitch * rate;
    let rud = input.yaw * rate;
    const p = b.p, q = b.q, r = b.r;
    if (input.mode === 1) {
      // rate damping (gyro)
      ail = clamp(ail - 0.09 * p, -1, 1);
      ele = clamp(ele + 0.12 * q, -1, 1);
      rud = clamp(rud - 0.25 * r, -1, 1);
      this.iPitch = 0;
    } else if (input.mode === 2) {
      // self-levelling trainer mode
      _e.setFromQuaternion(b.quat, 'YXZ');
      const theta = _e.x, phi = -_e.z;
      const phiT = input.roll * 55 * DEG;
      const thT = -input.pitch * 30 * DEG + 2 * DEG;
      ail = clamp(1.4 * (phiT - phi) - 0.12 * p, -1, 1);
      this.iPitch = clamp(this.iPitch + (thT - theta) * dt * 0.8, -0.3, 0.3);
      ele = clamp(-(1.6 * (thT - theta) + this.iPitch) + 0.14 * q - Math.abs(Math.sin(phi)) * 0.12, -1, 1);
      rud = clamp(rud - 0.2 * r, -1, 1);
    } else this.iPitch = 0;
    this.applyControls(ail, ele, rud, dt);

    // ---- air-relative velocity at CG ----
    const ground = world.terrain.groundAt(b.pos.x, b.pos.z);
    world.wind.sample(b.pos, world.time, ground, _w);
    const windBody = b.toBody(_w, this.windBody);
    const vCg = b.toBody(b.vel, _v).sub(windBody);
    const airspeed = vCg.length();
    const va = Math.max(0, vCg.dot(this.propDir));
    const alphaBody = Math.atan2(-vCg.y, Math.max(0.5, -vCg.z));

    // ---- propeller ----
    const n = this.rpm;
    let T = cfg.prop.thrust * n * (n - va / cfg.prop.pitchSpeed);
    T = Math.max(T, -0.04 * cfg.prop.thrust);
    this.thrust = T;
    _F.copy(this.propDir).multiplyScalar(T);
    b.addForceBodyAt(_F, this.propPos);
    // torque reaction rolls the plane left
    _F.copy(this.propDir).multiplyScalar(-cfg.prop.torque * Math.max(T, 0));
    b.addTorqueBody(_F);
    // P-factor: at high angle of attack the descending (right) blade bites more -> yaw left
    _F.set(0, Math.max(T, 0) * 0.35 * (cfg.prop.diameter / 2) * Math.sin(clamp(alphaBody, -0.5, 0.5)), 0);
    b.addTorqueBody(_F);
    // gyroscopic precession of the spinning prop: torque = -w x H
    const omegaProp = (n * cfg.prop.maxRpm * 2 * Math.PI) / 60;
    _H.copy(this.propDir).multiplyScalar(cfg.prop.inertia * omegaProp);
    _F.crossVectors(b.angVel, _H).negate();
    b.addTorqueBody(_F);
    const wash = T > 0 ? Math.sqrt(va * va + (2 * T) / (RHO * this.propArea)) - va : 0;
    // slipstream swirl (clockwise seen from behind): hits the left side of the fin -> yaw left
    const swirl = wash * 0.06 * (cfg.prop.pos[2] < 0 ? 1 : 0);

    // ---- ground effect (less induced drag + downwash close to the ground: the "float" in the flare) ----
    const hAgl = Math.max(0.05, b.pos.y - ground);
    const hb = (16 * hAgl) / this.span;
    const kge = (hb * hb) / (1 + hb * hb);

    // ---- aerodynamic surfaces ----
    const eps = ((2 * this.wingCL) / (Math.PI * cfg.wingAR)) * 0.85 * kge;
    let clSum = 0, areaSum = 0, aoaSum = 0, aoaArea = 0;
    let stall = false, buffet = 0;
    for (const s of this.surfaces) {
      const d = s.def;
      // local air velocity (surface velocity relative to air), body frame
      b.pointVelocityBody(s.pos, _v);
      if (world.wind.settings.turbulence > 0) {
        b.pointToWorld(s.pos, _wp);
        world.wind.sample(_wp, world.time, ground, _w);
        b.toBody(_w, _l);
        _v.sub(_l);
      } else _v.sub(windBody);
      if (d.propwash) {
        _v.addScaledVector(this.propDir, wash * d.propwash);
        if (d.vertical && s.pos.y > 0) _v.x -= swirl * d.propwash;
      }
      // strip spanwise flow
      _v.addScaledVector(s.s, -_v.dot(s.s));
      const V2 = _v.lengthSq();
      if (V2 < 1e-4) { s.alpha = 0; s.cl = 0; continue; }
      const V = Math.sqrt(V2);
      let alpha = Math.atan2(-_v.dot(s.n), _v.dot(s.c)) + d.incidence * DEG;
      if (d.downwash) alpha -= eps;
      const defl = this.telemetry.surfaces[d.control ?? ''] ?? 0;
      const ae = alpha + s.tau * 0.85 * defl;
      const { cl, cd, k } = this.coeffs(s, ae, d.isWing ? kge : 1);
      s.alpha = ae;
      s.cl = cl;
      const qS = 0.5 * RHO * V2 * d.area;
      _f.copy(_v).multiplyScalar(-1 / V);                // air flow direction
      _l.crossVectors(_f, s.s).normalize();               // lift direction
      // stall buffet: separated flow shakes the panel
      const shake = d.isWing && k > 0.05 ? qS * 0.12 * k * noise1(world.time * 23 + s.idx * 7.3, 200 + s.idx) : 0;
      _F.copy(_l).multiplyScalar(qS * cl + shake).addScaledVector(_f, qS * cd);
      b.addForceBodyAt(_F, s.pos);
      if (d.isWing) {
        clSum += cl * d.area;
        areaSum += d.area;
        buffet = Math.max(buffet, k);
        if (!d.control || d.control.startsWith('elevon')) { aoaSum += alpha * d.area; aoaArea += d.area; }
        if (Math.abs(ae) > (d.stall + 1) * DEG && airspeed > 2) stall = true;
      }
    }
    this.wingCL = areaSum > 0 ? clSum / areaSum : 0;

    // ---- fuselage parasitic drag ----
    const fd = cfg.fuselage.cda;
    b.pointVelocityBody(_l.set(...cfg.fuselage.pos), _v).sub(windBody);
    _F.set(
      -0.5 * RHO * fd[0] * _v.x * Math.abs(_v.x),
      -0.5 * RHO * fd[1] * _v.y * Math.abs(_v.y),
      -0.5 * RHO * fd[2] * _v.z * Math.abs(_v.z),
    );
    b.addForceBodyAt(_F, _l);

    // ---- telemetry ----
    tm.airspeed = airspeed;
    tm.throttle = thrCmd;
    tm.aoa = aoaArea > 0 ? (aoaSum / aoaArea) / DEG : 0;
    tm.stall = stall && !this.onGround;
    tm.armed = this.motorArmed;
    tm.modeName = this.modeNames[input.mode];
    tm.motorRpm = [this.rpm];
    tm.buffet = buffet;
  }

  private coeffs(s: SurfaceRT, ae: number, kge: number) {
    const d = s.def;
    const clLin = (s.clAlpha * ae + d.cl0) * (1 + 0.08 * (1 - kge));
    const sPos = d.stall * DEG, sNeg = d.stall * 0.85 * DEG, w = d.stallWidth * DEG;
    const k = ae >= 0 ? smoothstep(sPos, sPos + w, ae) : smoothstep(sNeg, sNeg + w, -ae);
    const sinA = Math.sin(ae);
    const clPost = Math.sin(2 * ae) * 1.0;
    const cdPost = d.cd0 + 1.9 * sinA * sinA;
    const cdLin = d.cd0 + ((clLin * clLin) / (Math.PI * 0.8 * d.ar)) * kge;
    return { cl: lerp(clLin, clPost, k), cd: lerp(cdLin, cdPost, k), k };
  }

  /** Sets servo targets and moves surfaces at the servo's speed limit. */
  private applyControls(ail: number, ele: number, rud: number, dt: number) {
    const srf = this.telemetry.surfaces;
    const mix = this.cfg.elevonMix;
    const maxStep = this.cfg.servoSpeed * dt;
    for (const s of this.surfaces) {
      const d = s.def;
      if (!d.control) continue;
      const m = (d.maxDefl ?? 0) * DEG;
      let v = 0;
      switch (d.control) {
        case 'aileronL': v = ail; break;
        case 'aileronR': v = -ail; break;
        case 'elevator': v = ele; break;
        case 'rudder': v = rud; break;
        case 'elevonL': v = clamp(ail * (mix?.roll ?? 1) + ele * (mix?.pitch ?? 1), -1, 1); break;
        case 'elevonR': v = clamp(-ail * (mix?.roll ?? 1) + ele * (mix?.pitch ?? 1), -1, 1); break;
      }
      this.target[d.control] = v * m;
    }
    for (const k of Object.keys(this.target)) {
      const cur = srf[k] ?? 0;
      srf[k] = cur + clamp(this.target[k] - cur, -maxStep, maxStep);
    }
  }

  private fillSurfaces(input: ControlInputs, dt: number) {
    const r = input.highRate ? 1 : this.cfg.lowRate;
    this.applyControls(input.roll * r, input.pitch * r, input.yaw * r, dt);
  }
}
