import { Vector3 } from 'three';
import type { ContactPoint } from './aircraft';
import { FixedWing, PlaneConfig, SurfaceDef } from './fixedwing';
import { Multirotor, QuadConfig } from './multirotor';

const wheel = (x: number, y: number, z: number, steer = 0, k = 1500, c = 30): ContactPoint =>
  ({ pos: new Vector3(x, y, z), wheel: true, steer, k, c, crashSpeed: 6.5 });
const skid = (x: number, y: number, z: number, crashSpeed = 3.5, k = 3000, c = 30, mu = 0.55): ContactPoint =>
  ({ pos: new Vector3(x, y, z), wheel: false, k, c, mu, crashSpeed });

/** Builds the 6 wing panels (3 per side) of a straight or tapered wing. */
function wingPanels(o: {
  span: number; rootChord: number; tipChord: number; y: number; zQc: number; sweep?: number;
  dihedral: number; incidence: number; washout: number; cl0: number; stall: number; stallWidth: number;
  ar: number; aileronFrac: number; aileronMax: number; control: 'aileron' | 'elevon'; propwashInner: number;
}): SurfaceDef[] {
  const out: SurfaceDef[] = [];
  const half = o.span / 2, seg = half / 3;
  const tanS = Math.tan(((o.sweep ?? 0) * Math.PI) / 180);
  for (let i = 0; i < 3; i++) {
    const xc = seg * (i + 0.5);
    const t = xc / half;
    const chord = o.rootChord + (o.tipChord - o.rootChord) * t;
    const inc = o.incidence - o.washout * (i / 2);
    const z = o.zQc + xc * tanS;
    const y = o.y + xc * Math.tan((o.dihedral * Math.PI) / 180);
    for (const side of [1, -1]) {
      const ctrl = i === 0 ? undefined : o.control === 'aileron' ? (side < 0 ? 'aileronL' : 'aileronR') : (side < 0 ? 'elevonL' : 'elevonR');
      out.push({
        name: `wing${side < 0 ? 'L' : 'R'}${i}`, pos: [side * xc, y, z], area: chord * seg, ar: o.ar,
        dihedral: o.dihedral, sweep: o.sweep, incidence: inc, cl0: o.cl0, stall: o.stall - (i === 2 ? 1 : 0),
        stallWidth: o.stallWidth, cd0: 0.012, flapFrac: ctrl ? o.aileronFrac : 0, control: ctrl as SurfaceDef['control'],
        maxDefl: o.aileronMax, propwash: i === 0 ? o.propwashInner : 0, isWing: true,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
export const TRAINER: PlaneConfig = {
  id: 'trainer',
  name: 'Trainer 1400',
  description: 'High-wing trainer, 1.4 m span, tricycle gear. Stable, forgiving, gentle stall. Start here.',
  mass: 1.15,
  inertia: [0.06, 0.13, 0.08],
  surfaces: [
    ...wingPanels({ span: 1.4, rootChord: 0.21, tipChord: 0.21, y: 0.11, zQc: 0.012, dihedral: 6, incidence: 2.5, washout: 1.5,
      cl0: 0.3, stall: 14, stallWidth: 9, ar: 6.7, aileronFrac: 0.22, aileronMax: 11, control: 'aileron', propwashInner: 0.3 }),
    { name: 'htail', pos: [0, 0.03, 0.72], area: 0.062, ar: 3.4, incidence: -0.3, cl0: 0, stall: 15, stallWidth: 6, cd0: 0.012,
      flapFrac: 0.4, control: 'elevator', maxDefl: 22, propwash: 0.3, downwash: true },
    { name: 'vtail', pos: [0, 0.13, 0.74], area: 0.036, ar: 2.4, vertical: true, incidence: 0, cl0: 0, stall: 16, stallWidth: 6,
      cd0: 0.012, flapFrac: 0.45, control: 'rudder', maxDefl: 28, propwash: 0.6 },
  ],
  prop: { pos: [0, 0.0, -0.43], thrust: 7.5, pitchSpeed: 26, diameter: 0.254, torque: 0.006, spool: 0.15, downthrust: 4, rightthrust: 1.5,
    power: 260, inertia: 6e-5, maxRpm: 9500, blades: 2 },
  battery: { cells: 3, capacity: 2200, rInt: 0.045 },
  servoSpeed: 9,
  fuselage: { cda: [0.035, 0.03, 0.010], pos: [0, 0, 0.12] },
  contacts: [
    wheel(0, -0.18, -0.33, 22 * Math.PI / 180), wheel(0.17, -0.18, 0.06), wheel(-0.17, -0.18, 0.06),
    skid(0.7, 0.13, 0.04), skid(-0.7, 0.13, 0.04), skid(0, -0.06, -0.46), skid(0, -0.05, 0.75),
    skid(0, 0.27, 0.8), skid(0, 0.17, 0.0), skid(0, -0.09, 0.3), skid(0.22, 0.03, 0.73), skid(-0.22, 0.03, 0.73),
  ],
  wingAR: 6.7,
  lowRate: 0.6,
  fpvCam: [0, 0.09, -0.18],
  stallSpeed: 7.5,
};

/* ------------------------------------------------------------------ */
const quadContacts = (a: number, legY: number, legXZ: number, k: number, c: number): ContactPoint[] => [
  skid(legXZ, legY, -legXZ, 6, k, c, 0.6), skid(legXZ, legY, legXZ, 6, k, c, 0.6),
  skid(-legXZ, legY, legXZ, 6, k, c, 0.6), skid(-legXZ, legY, -legXZ, 6, k, c, 0.6),
  skid(a, 0.025, -a, 5), skid(a, 0.025, a, 5), skid(-a, 0.025, a, 5), skid(-a, 0.025, -a, 5),
  skid(0, 0.05, 0, 5), skid(0, 0.0, -0.08, 5),
];

export const FPV_QUAD: QuadConfig = {
  id: 'fpv',
  name: 'FPV 5" Freestyle',
  description: '5-inch freestyle quad, about 9:1 thrust-to-weight. Acro / Angle / Horizon modes, Betaflight-style rates.',
  type: 'fpv',
  mass: 0.65,
  inertia: [0.0026, 0.0045, 0.0024],
  arm: 0.08,
  motorThrust: 15,
  motorTau: 0.025,
  idle: 0.055,
  kQ: 0.016,
  propDiameter: 0.127,
  pitchSpeed: 48,
  cda: [0.012, 0.022, 0.009],
  hForce: 0.022,
  contacts: quadContacts(0.08, -0.025, 0.08, 2500, 22),
  rates: { center: 70, max: 670, expo: 0.54 },
  yawRates: { center: 70, max: 500, expo: 0.4 },
  maxAngle: 55,
  pid: { kp: 32, ki: 45, kpYaw: 20, kiYaw: 30, angle: 7 },
  maxSpeed: 0,
  fpvCam: [0, 0.018, -0.06],
  camTilt: 25,
  battery: { cells: 6, capacity: 1300, rInt: 0.07 },
  motorPower: 480,
  maxRpm: 26000,
  blades: 3,
};

export const CAMERA_DRONE: QuadConfig = {
  id: 'drone',
  name: 'Camera Drone',
  description: 'GPS camera drone like a DJI. GPS mode holds position when you let go; ATTI drifts with the wind; MANUAL is angle mode without altitude hold.',
  type: 'gps',
  mass: 0.9,
  inertia: [0.006, 0.011, 0.0055],
  arm: 0.12,
  motorThrust: 6,
  motorTau: 0.06,
  idle: 0.1,
  kQ: 0.02,
  propDiameter: 0.2,
  pitchSpeed: 30,
  cda: [0.02, 0.04, 0.016],
  hForce: 0.03,
  contacts: quadContacts(0.12, -0.085, 0.07, 3000, 40),
  rates: { center: 60, max: 200, expo: 0.3 },
  yawRates: { center: 50, max: 120, expo: 0.2 },
  maxAngle: 28,
  pid: { kp: 14, ki: 18, kpYaw: 9, kiYaw: 10, angle: 5 },
  maxSpeed: 14,
  fpvCam: [0, -0.06, -0.09],
  camTilt: -12,
  battery: { cells: 4, capacity: 2500, rInt: 0.06 },
  motorPower: 95,
  maxRpm: 9000,
  blades: 2,
};

export const AIRCRAFT_LIST = [
  { id: 'trainer', label: TRAINER.name, desc: TRAINER.description, kind: 'plane' },
  { id: 'fpv', label: FPV_QUAD.name, desc: FPV_QUAD.description, kind: 'quad' },
  { id: 'drone', label: CAMERA_DRONE.name, desc: CAMERA_DRONE.description, kind: 'quad' },
] as const;

export type AircraftId = (typeof AIRCRAFT_LIST)[number]['id'];

export function createAircraft(id: AircraftId) {
  switch (id) {
    case 'trainer': return new FixedWing(TRAINER);
    case 'fpv': return new Multirotor(FPV_QUAD);
    case 'drone': return new Multirotor(CAMERA_DRONE);
  }
}
