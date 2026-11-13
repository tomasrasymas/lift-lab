import { Quaternion, Vector3 } from 'three';
import { RigidBody } from './rigidbody';
import { World, Hit } from './world';
import { clamp } from './math';
import type { Battery } from './battery';

/** Normalised pilot inputs. Sticks follow transmitter convention. */
export interface ControlInputs {
  throttle: number; // 0..1
  roll: number;     // -1..1, + = stick right
  pitch: number;    // -1..1, + = stick forward (nose down)
  yaw: number;      // -1..1, + = stick right
  arm: boolean;
  mode: 0 | 1 | 2;  // flight-mode switch position
  highRate: boolean;
}

export const neutralInputs = (): ControlInputs => ({ throttle: 0, roll: 0, pitch: 0, yaw: 0, arm: false, mode: 0, highRate: true });

export interface ContactPoint {
  pos: Vector3;            // body frame
  wheel: boolean;
  steer?: number;          // max steer angle (rad); sign gives direction relative to yaw input
  k: number;               // spring N/m
  c: number;               // damper N/(m/s)
  mu?: number;             // sliding friction
  crashSpeed?: number;     // impact speed above which this point causes a crash
}

export interface Telemetry {
  airspeed: number;
  groundspeed: number;
  altitude: number;   // AGL
  vspeed: number;
  throttle: number;
  aoa: number;        // deg (planes)
  stall: boolean;
  armed: boolean;
  modeName: string;
  motorRpm: number[]; // 0..1 per motor/prop
  surfaces: Record<string, number>; // deflections in rad for rendering
  gForce: number;
  onGround: boolean;
  buffet: number;      // 0..1 stall buffet intensity
  cellV: number;       // average cell voltage under load
  batteryPct: number;  // 0..100
  usedMah: number;
  cells: number;
  impact: number;      // last impact speed (for sound), reset by the consumer
}

export interface SpawnOptions { inAir: boolean; }

export abstract class Aircraft {
  body: RigidBody;
  contacts: ContactPoint[] = [];
  crashed = false;
  crashReason = '';
  onGround = false;
  /** Waiting to be hand launched. */
  awaitingLaunch = false;
  abstract readonly kind: 'plane' | 'quad';
  abstract readonly name: string;
  abstract readonly modeNames: [string, string, string];
  telemetry: Telemetry = {
    airspeed: 0, groundspeed: 0, altitude: 0, vspeed: 0, throttle: 0, aoa: 0, stall: false,
    armed: false, modeName: '', motorRpm: [], surfaces: {}, gForce: 1, onGround: true,
    buffet: 0, cellV: 4.2, batteryPct: 100, usedMah: 0, cells: 0, impact: 0,
  };
  battery?: Battery;
  private hit: Hit = { kind: 'tree', normal: new Vector3(), depth: 0, soft: false };
  private stuck = false;

  protected _tmpA = new Vector3();
  protected _tmpB = new Vector3();
  protected _tmpC = new Vector3();
  protected _tmpD = new Vector3();
  private _n = new Vector3();
  private _prevVel = new Vector3();

  constructor(mass: number, inertia: Vector3) {
    this.body = new RigidBody(mass, inertia);
  }

  abstract reset(world: World, opts: SpawnOptions): void;
  protected abstract stepForces(dt: number, input: ControlInputs, world: World): void;

  /** Lowest contact point below CG when level (for spawn height). */
  protected groundClearance() {
    let m = 0;
    for (const c of this.contacts) m = Math.min(m, c.pos.y);
    return -m;
  }

  protected placeOnGround(world: World, x: number, z: number, yaw: number, pitch = 0) {
    const b = this.body;
    b.quat.setFromAxisAngle(new Vector3(0, 1, 0), yaw);
    if (pitch) b.quat.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch));
    let lowest = 0;
    const p = new Vector3();
    for (const c of this.contacts) {
      p.copy(c.pos).applyQuaternion(b.quat);
      lowest = Math.min(lowest, p.y);
    }
    b.pos.set(x, world.terrain.groundAt(x, z) - lowest + 0.002, z);
    b.vel.set(0, 0, 0);
    b.angVel.set(0, 0, 0);
  }

  protected baseReset() {
    this.crashed = false;
    this.crashReason = '';
    this.awaitingLaunch = false;
    this.stuck = false;
    this._prevVel.set(0, 0, 0);
    this.battery?.reset();
  }

  crash(reason: string) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashReason = reason;
  }

  step(dt: number, input: ControlInputs, world: World) {
    const b = this.body;
    b.clearForces();
    this._prevVel.copy(b.vel);
    this.stepForces(dt, input, world);
    if (!this.awaitingLaunch) {
      this.groundContacts(dt, input, world);
      b.integrate(dt);
    }
    // g-load (specific force along body up)
    const acc = this._tmpA.copy(b.vel).sub(this._prevVel).divideScalar(dt);
    acc.y += 9.81;
    const up = this._tmpB.set(0, 1, 0).applyQuaternion(b.quat);
    const g = acc.dot(up) / 9.81;
    this.telemetry.gForce += (g - this.telemetry.gForce) * clamp(dt * 8, 0, 1);

    // obstacle collisions: physical bounce off hard objects, branches catch you
    const radius = this.kind === 'quad' ? 0.14 : 0.3;
    const hit = world.collide(b.pos, radius, this.hit);
    if (hit) {
      const n = hit.normal;
      const speed = b.vel.length();
      if (hit.soft) {
        b.vel.multiplyScalar(Math.exp(-10 * dt));
        b.angVel.multiplyScalar(Math.exp(-6 * dt));
        if (speed > (this.kind === 'quad' ? 4.5 : 2.5)) { this.crash('Flew into a tree'); this.stuck = true; this.telemetry.impact = Math.max(this.telemetry.impact, speed); }
      } else {
        const vn = b.vel.dot(n);
        if (vn < 0) {
          const limit = this.kind === 'quad' ? 6 : 3.5;
          if (-vn > limit) this.crash(({ gate: 'Hit a gate', building: 'Hit a building', rock: 'Hit a rock', pole: 'Hit a lamp post', tree: 'Hit a tree trunk' } as const)[hit.kind]);
          this.telemetry.impact = Math.max(this.telemetry.impact, -vn);
          b.vel.addScaledVector(n, -1.35 * vn);
          const vt = this._tmpC.copy(b.vel).addScaledVector(n, -b.vel.dot(n));
          b.vel.addScaledVector(vt, -0.35);
          // tumble
          b.angVel.x += (Math.random() - 0.5) * -vn * 3;
          b.angVel.y += (Math.random() - 0.5) * -vn * 2;
          b.angVel.z += (Math.random() - 0.5) * -vn * 3;
        }
        b.pos.addScaledVector(n, hit.depth);
      }
    }
    if (this.stuck) {
      // hanging in the branches
      if (hit && hit.soft) { b.vel.set(0, 0, 0); b.angVel.multiplyScalar(0.9); }
      else this.stuck = false;
    }
    // water
    const WATER_LEVEL = world.layout.waterLevel;
    if (b.pos.y < WATER_LEVEL + 0.05 && world.terrain.surfaceAt(b.pos.x, b.pos.z) === 'water') {
      this.crash('Splashed into the lake');
      b.vel.multiplyScalar(0.9);
      b.angVel.multiplyScalar(0.9);
      if (b.pos.y < WATER_LEVEL - 0.15) { b.pos.y = WATER_LEVEL - 0.15; b.vel.y = Math.max(0, b.vel.y); }
    }
    // hard limits
    const half = world.terrain.half - 50;
    b.pos.x = clamp(b.pos.x, -half, half);
    b.pos.z = clamp(b.pos.z, -half, half);

    const tm = this.telemetry;
    tm.groundspeed = Math.hypot(b.vel.x, b.vel.z);
    tm.altitude = b.pos.y - this.groundClearance() - world.terrain.surfaceHeight(b.pos.x, b.pos.z);
    tm.vspeed = b.vel.y;
    tm.onGround = this.onGround;
    if (this.battery) {
      tm.cellV = this.battery.cellVoltage;
      tm.batteryPct = this.battery.soc * 100;
      tm.usedMah = this.battery.usedMah;
      tm.cells = this.battery.cfg.cells;
    }
  }

  /** Spring-damper ground contacts with wheel / sliding friction. */
  private groundContacts(dt: number, input: ControlInputs, world: World) {
    const b = this.body;
    const t = world.terrain;
    const pw = this._tmpA, vw = this._tmpB, f = this._tmpC, dir = this._tmpD;
    const n = this._n;
    let anyContact = false;
    for (const c of this.contacts) {
      b.pointToWorld(c.pos, pw);
      const surf = t.surfaceAt(pw.x, pw.z);
      if (surf === 'water') continue;
      const gh = t.groundAt(pw.x, pw.z);
      const pen = gh - pw.y;
      if (pen <= 0) continue;
      anyContact = true;
      t.normalAt(pw.x, pw.z, n);
      b.pointVelocityWorld(c.pos, vw);
      const vn = vw.dot(n);
      // crash detection on impact
      const limit = c.crashSpeed ?? (c.wheel ? 7 : 3.5);
      if (-vn > limit) this.crash(c.wheel ? 'Hard landing' : 'Crashed into the ground');
      if (-vn > 0.8) this.telemetry.impact = Math.max(this.telemetry.impact, -vn * (c.wheel ? 0.4 : 1));

      const penC = Math.min(pen, 0.25);
      let fn = c.k * penC - c.c * vn;
      if (fn < 0) fn = 0;
      f.copy(n).multiplyScalar(fn);

      // tangential velocity
      const vt = vw.addScaledVector(n, -vn);
      if (c.wheel) {
        // wheel rolling direction = body forward rotated by steer, projected on ground
        // (positive steer angle turns the wheel's heading toward +X / right)
        const a = c.steer ? input.yaw * c.steer : 0;
        dir.set(Math.sin(a), 0, -Math.cos(a)).applyQuaternion(b.quat);
        dir.addScaledVector(n, -dir.dot(n)).normalize();
        const side = this._n.crossVectors(n, dir); // reuse buffer (n no longer needed below)
        const vRoll = vt.dot(dir);
        const vSide = vt.dot(side);
        const rollMu = surf === 'asphalt' ? 0.025 : 0.07;
        const fRoll = -rollMu * fn * clamp(vRoll / 0.3, -1, 1);
        const fSide = -0.9 * fn * clamp(vSide / 0.4, -1, 1);
        f.addScaledVector(dir, fRoll).addScaledVector(side, fSide);
        t.normalAt(pw.x, pw.z, n); // restore normal
      } else {
        const mu = c.mu ?? 0.55;
        const vtl = vt.length();
        if (vtl > 1e-4) f.addScaledVector(vt, (-mu * fn * clamp(vtl / 0.3, 0, 1)) / vtl);
      }
      b.addForceWorldAt(f, c.pos);
    }
    this.onGround = anyContact;
  }
}
