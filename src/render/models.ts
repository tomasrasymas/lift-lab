import * as THREE from 'three';
import type { Telemetry } from '../sim/aircraft';
import { liveryTexture, carbonTexture } from './textures';
import { clamp } from '../sim/math';

/* ------------------------------------------------------------------ */
/*  Geometry helpers                                                   */
/* ------------------------------------------------------------------ */

/** Builds a closed tube through rings of equal point count, with end caps. */
function loft(rings: THREE.Vector3[][], capStart = true, capEnd = true): THREE.BufferGeometry {
  const n = rings[0].length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const r of rings) for (const p of r) pos.push(p.x, p.y, p.z);
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j, b = i * n + ((j + 1) % n), c = (i + 1) * n + j, d = (i + 1) * n + ((j + 1) % n);
      idx.push(a, c, b, b, c, d);
    }
  }
  const cap = (ring: THREE.Vector3[], base: number, flip: boolean) => {
    const cen = ring.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(ring.length);
    const ci = pos.length / 3;
    pos.push(cen.x, cen.y, cen.z);
    for (let j = 0; j < n; j++) {
      const a = base + j, b = base + ((j + 1) % n);
      if (flip) idx.push(ci, b, a); else idx.push(ci, a, b);
    }
  };
  if (capStart) cap(rings[0], 0, false);
  if (capEnd) cap(rings[rings.length - 1], (rings.length - 1) * n, true);
  // uv: u along the loft (by ring), v around the ring
  const uv: number[] = [];
  for (let i = 0; i < rings.length; i++) for (let j = 0; j < n; j++) uv.push(i / (rings.length - 1), j / n);
  while (uv.length < (pos.length / 3) * 2) uv.push(0.5, 0.5);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Flip winding if the loft came out inside-out. */
function orient(g: THREE.BufferGeometry, outward: THREE.Vector3) {
  // sample first triangle normal vs outward hint
  const p = g.getAttribute('position'), i = g.getIndex()!;
  const a = new THREE.Vector3().fromBufferAttribute(p, i.getX(0));
  const b = new THREE.Vector3().fromBufferAttribute(p, i.getX(1));
  const c = new THREE.Vector3().fromBufferAttribute(p, i.getX(2));
  const nrm = b.sub(a).cross(c.sub(a));
  const cen = a.clone();
  if (nrm.dot(cen.sub(outward)) < 0) {
    const arr = i.array as Uint16Array | Uint32Array;
    for (let k = 0; k < arr.length; k += 3) { const t = arr[k + 1]; arr[k + 1] = arr[k + 2]; arr[k + 2] = t; }
    i.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

/** Airfoil contour (chord-normalised) between x0..x1, closed. */
function airfoil(x0: number, x1: number, thick: number, camber: number, n = 10): [number, number][] {
  const m = camber, p = 0.4;
  const pts: [number, number][] = [];
  const sample = (x: number) => {
    const yt = 5 * thick * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const yc = x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x);
    return { yt: Math.max(yt, 0.002), yc };
  };
  const xs: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    xs.push(x0 + (x1 - x0) * (0.5 - 0.5 * Math.cos(Math.PI * t)));
  }
  // upper surface from x1 back to x0, then lower surface x0 -> x1
  for (let i = n; i >= 0; i--) { const { yt, yc } = sample(xs[i]); pts.push([xs[i], yc + yt]); }
  for (let i = 1; i < n; i++) { const { yt, yc } = sample(xs[i]); pts.push([xs[i], yc - yt]); }
  return pts;
}

interface WingStation { x: number; y: number; zLE: number; chord: number; }

/** Lofts a lifting surface along stations (x = span). Profile u = chord fraction. */
function liftingSurface(st: WingStation[], x0: number, x1: number, thick: number, camber: number) {
  const prof = airfoil(x0, x1, thick, camber);
  const rings = st.map((s) => prof.map(([u, v]) => new THREE.Vector3(s.x, s.y + v * s.chord, s.zLE + u * s.chord)));
  return orient(loft(rings), new THREE.Vector3(st[0].x, st[0].y, st[0].zLE + st[0].chord * (x0 + x1) / 2));
}

/** Vertical fin lofted along height (y). */
function finSurface(st: { y: number; zLE: number; chord: number }[], x0: number, x1: number, thick: number) {
  const prof = airfoil(x0, x1, thick, 0);
  const rings = st.map((s) => prof.map(([u, v]) => new THREE.Vector3(v * s.chord, s.y, s.zLE + u * s.chord)));
  return orient(loft(rings), new THREE.Vector3(0, st[0].y, st[0].zLE + st[0].chord * (x0 + x1) / 2));
}

/** Squircle fuselage sections: [z, width, height, yCentre]. */
function fuselage(sectionsIn: [number, number, number, number][], n = 24, power = 3) {
  // subdivide with smooth (Catmull-Rom style) interpolation for a rounder shape
  const sections: [number, number, number, number][] = [];
  for (let i = 0; i < sectionsIn.length - 1; i++) {
    const a = sectionsIn[Math.max(0, i - 1)], b = sectionsIn[i], c = sectionsIn[i + 1], d = sectionsIn[Math.min(sectionsIn.length - 1, i + 2)];
    for (let k = 0; k < 4; k++) {
      const t = k / 4, t2 = t * t, t3 = t2 * t;
      const cr = (p0: number, p1: number, p2: number, p3: number) => 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
      sections.push([0, 1, 2, 3].map((q) => cr(a[q], b[q], c[q], d[q])) as [number, number, number, number]);
    }
  }
  sections.push(sectionsIn[sectionsIn.length - 1]);
  const rings = sections.map(([z, w, h, y]) => {
    const r: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      r.push(new THREE.Vector3((w / 2) * Math.sign(c) * Math.abs(c) ** (2 / power), y + (h / 2) * Math.sign(s) * Math.abs(s) ** (2 / power), z));
    }
    return r;
  });
  return orient(loft(rings), new THREE.Vector3(0, sections[0][3], sections[0][0] + 1));
}

const std = (color: number, rough = 0.45, metal = 0.05) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
/** Glossy painted foam/plastic with clear coat. */
const paint = (color: number, map?: THREE.Texture, rough = 0.38) =>
  new THREE.MeshPhysicalMaterial({ color, map: map ?? null, roughness: rough, metalness: 0.0, clearcoat: 0.7, clearcoatRoughness: 0.25 });
const glass = () => new THREE.MeshStandardMaterial({ color: 0x1a2a3a, roughness: 0.05, metalness: 0.3, envMapIntensity: 1.5 });
const glow = (color: number) => new THREE.MeshBasicMaterial({ color });

/* ------------------------------------------------------------------ */
/*  Propeller                                                          */
/* ------------------------------------------------------------------ */
/** Twisted, tapered propeller blade along +X (disc in the XY plane). */
function bladeGeometry(R: number, nBlades: number) {
  const prof = airfoil(0, 1, 0.12, 0.05, 5);
  const rings: THREE.Vector3[][] = [];
  const st = 9;
  for (let k = 0; k <= st; k++) {
    const t = k / st;
    const r = R * (0.1 + 0.9 * t);
    const chord = R * (nBlades > 2 ? 0.2 : 0.17) * (0.75 + 0.6 * Math.sin(Math.PI * Math.min(1, t * 1.15)) - 0.35 * t * t) * (k === st ? 0.5 : 1);
    const pitch = (38 - 26 * t) * Math.PI / 180;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    rings.push(prof.map(([u, v]) => {
      const y = (u - 0.35) * chord, z = v * chord;
      return new THREE.Vector3(r, y * cp - z * sp, y * sp + z * cp);
    }));
  }
  return orient(loft(rings), new THREE.Vector3(R * 0.1, 0, 0));
}

class Prop {
  group = new THREE.Group();
  blades = new THREE.Group();
  disc: THREE.Mesh;
  angle = 0;
  constructor(radius: number, nBlades: number, color: number, axis: 'z' | 'y', public dir = 1, discColor = 0x222222) {
    const bladeMat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05, side: THREE.DoubleSide });
    const geo = bladeGeometry(radius, nBlades);
    for (let i = 0; i < nBlades; i++) {
      const m = new THREE.Mesh(geo, bladeMat);
      m.rotation.z = (i / nBlades) * Math.PI * 2;
      const holder = new THREE.Group();
      holder.add(m);
      this.blades.add(holder);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.09, radius * 0.09, radius * 0.12, 12).rotateX(Math.PI / 2), bladeMat);
    this.blades.add(hub);
    const discMat = new THREE.MeshBasicMaterial({ color: discColor, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    this.disc = new THREE.Mesh(new THREE.RingGeometry(radius * 0.12, radius, 32), discMat);
    this.group.add(this.blades, this.disc);
    if (axis === 'y') this.group.rotation.x = -Math.PI / 2; // disc in XZ plane
  }
  update(rpm: number, dt: number) {
    const spin = rpm * 160; // rad/s visual (aliased like a camera would see)
    this.angle += spin * dt * this.dir;
    this.blades.rotation.z = this.angle;
    const blur = clamp((rpm - 0.06) / 0.14, 0, 1);
    (this.disc.material as THREE.MeshBasicMaterial).opacity = blur * 0.075;
    this.blades.visible = blur < 0.95;
  }
}

/* ------------------------------------------------------------------ */
export interface AircraftModel {
  root: THREE.Group;
  fpvAnchor: THREE.Object3D;
  size: number; // characteristic size (span) in m
  update(tm: Telemetry, dt: number, time: number): void;
  /** In the onboard FPV camera only the props are visible (like real footage). */
  setFpvView(on: boolean, showProps: boolean): void;
}

interface Surf { obj: THREE.Object3D; key: string; axis: 'x' | 'y'; }

function finalize(root: THREE.Group) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m.material as THREE.Material).transparent && !(m.material instanceof THREE.MeshBasicMaterial)) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
}

function navLights(root: THREE.Group, left: THREE.Vector3, right: THREE.Vector3, size = 0.012) {
  const g = new THREE.SphereGeometry(size, 8, 6);
  const l = new THREE.Mesh(g, glow(0xff2020)); l.position.copy(left);
  const r = new THREE.Mesh(g, glow(0x20ff40)); r.position.copy(right);
  root.add(l, r);
  // strobes
  const sl = new THREE.Mesh(g, glow(0xffffff)); sl.position.copy(left).add(new THREE.Vector3(0, 0, 0.012));
  const sr = new THREE.Mesh(g, glow(0xffffff)); sr.position.copy(right).add(new THREE.Vector3(0, 0, 0.012));
  root.add(sl, sr);
  return [sl, sr];
}

function pilotFigure(scale: number, helmet: number) {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xe0b090, roughness: 0.7 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.5, 4, 10), new THREE.MeshStandardMaterial({ color: 0x3a4a5a, roughness: 0.8 }));
  torso.position.y = 0.15;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 10), skin);
  head.position.y = 0.85;
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: helmet, roughness: 0.4 }));
  cap.position.y = 0.88;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.2), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.1, metalness: 0.6 }));
  visor.position.set(0, 0.9, -0.22);
  g.add(torso, head, cap, visor);
  g.scale.setScalar(scale);
  return g;
}

function wheel(r: number, w: number, pos: THREE.Vector3) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 16).rotateZ(Math.PI / 2), std(0x151515, 0.9));
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r * 0.45, w * 1.05, 10).rotateZ(Math.PI / 2), std(0xd0d0d0, 0.3, 0.6));
  g.add(tire, hub);
  g.position.copy(pos);
  return g;
}

function strut(a: THREE.Vector3, b: THREE.Vector3, r = 0.004, mat = std(0x999999, 0.3, 0.8)) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

/** Wing half with optional control surface over [ctrlFrom..tip]. */
function wingHalf(o: {
  side: 1 | -1; span: number; root: number; tip: number; zQc: number; sweep: number; y: number;
  ctrlFrom: number; ctrlFrac: number; thick: number; camber: number; mat: THREE.Material; ctrlMat: THREE.Material; tipMat?: THREE.Material;
}) {
  const grp = new THREE.Group();
  const tanS = Math.tan((o.sweep * Math.PI) / 180);
  const station = (x: number): WingStation => {
    const t = x / o.span;
    const chord = o.root + (o.tip - o.root) * t;
    const qc = o.zQc + x * tanS;
    return { x: x * o.side, y: 0, zLE: qc - chord * 0.25, chord };
  };
  const tipStart = o.tipMat ? o.span * 0.85 : o.span;
  // inner (no control)
  grp.add(new THREE.Mesh(liftingSurface([station(0), station(o.ctrlFrom)], 0, 1, o.thick, o.camber), o.mat));
  // outer fixed part
  const cf = 1 - o.ctrlFrac;
  grp.add(new THREE.Mesh(liftingSurface([station(o.ctrlFrom), station(tipStart)], 0, cf, o.thick, o.camber), o.mat));
  if (o.tipMat) grp.add(new THREE.Mesh(liftingSurface([station(tipStart), station(o.span)], 0, cf, o.thick, o.camber), o.tipMat));
  // control surface on a hinge
  const s0 = station(o.ctrlFrom), s1 = station(o.span);
  const h0 = new THREE.Vector3(s0.x, 0, s0.zLE + s0.chord * cf);
  const h1 = new THREE.Vector3(s1.x, 0, s1.zLE + s1.chord * cf);
  const hinge = new THREE.Group();
  hinge.position.copy(h0);
  // orient hinge so local +X runs along hinge line
  const dir = h1.clone().sub(h0).normalize();
  if (o.side < 0) dir.negate();
  hinge.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  const ctrlGeo = liftingSurface([s0, s1], cf, 1, o.thick, o.camber);
  ctrlGeo.translate(-h0.x, -h0.y, -h0.z);
  ctrlGeo.applyQuaternion(hinge.quaternion.clone().invert());
  const ctrl = new THREE.Mesh(ctrlGeo, o.ctrlMat);
  hinge.add(ctrl);
  grp.add(hinge);
  grp.position.y = o.y;
  return { grp, hinge };
}

/* ------------------------------------------------------------------ */
/*  Fixed wing models                                                  */
/* ------------------------------------------------------------------ */
abstract class BaseModel implements AircraftModel {
  root = new THREE.Group();
  fpvAnchor = new THREE.Object3D();
  size = 1;
  protected surfaces: Surf[] = [];
  protected props: Prop[] = [];
  protected strobes: THREE.Object3D[] = [];
  private fpvState = '';
  setFpvView(on: boolean, showProps: boolean) {
    const key = `${on}${showProps}`;
    if (key === this.fpvState) return;
    this.fpvState = key;
    const propGroups = new Set(this.props.map((p) => p.group));
    for (const c of this.root.children) c.visible = !on || (showProps && propGroups.has(c as THREE.Group));
  }
  update(tm: Telemetry, dt: number, time: number) {
    for (const s of this.surfaces) {
      const v = tm.surfaces[s.key] ?? 0;
      if (s.axis === 'x') s.obj.rotation.x = v; else s.obj.rotation.y = v;
    }
    this.props.forEach((p, i) => p.update(tm.motorRpm[i] ?? tm.motorRpm[0] ?? 0, dt));
    const on = (time % 1.2) < 0.06;
    for (const s of this.strobes) s.visible = on;
  }
}

export class TrainerModel extends BaseModel {
  constructor() {
    super();
    this.size = 1.4;
    const white = paint(0xf4f4f2), red = paint(0xc8202a), dark = std(0x222428, 0.6);
    const livery = paint(0xffffff, liveryTexture('#f4f4f2', '#c8202a', '#1f4fa0', { noseTo: 0.1 }));
    const r = this.root;
    const fus = new THREE.Mesh(fuselage([
      [-0.40, 0.075, 0.085, 0.0], [-0.36, 0.11, 0.12, 0.0], [-0.28, 0.125, 0.15, 0.01], [-0.12, 0.13, 0.19, 0.025],
      [0.12, 0.12, 0.17, 0.03], [0.4, 0.08, 0.1, 0.04], [0.78, 0.03, 0.045, 0.05],
    ]), livery);
    r.add(fus);
    const pilot = pilotFigure(0.055, 0xd02020);
    pilot.position.set(0, 0.03, -0.1);
    r.add(pilot);
    // red cowl
    const cowl = new THREE.Mesh(fuselage([[-0.405, 0.078, 0.088, 0.0], [-0.36, 0.114, 0.124, 0.0], [-0.28, 0.129, 0.154, 0.01]]), red);
    r.add(cowl);
    // cabin windows
    for (const sx of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.07), glass());
      w.position.set(sx * 0.0662, 0.07, -0.08);
      w.rotation.y = (sx * Math.PI) / 2;
      r.add(w);
    }
    const wsh = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.07), glass());
    wsh.position.set(0, 0.08, -0.19);
    wsh.rotation.x = -0.9;
    wsh.rotation.y = Math.PI;
    r.add(wsh);
    // wing (dihedral 6 deg)
    for (const side of [1, -1] as const) {
      const { grp, hinge } = wingHalf({ side, span: 0.7, root: 0.21, tip: 0.21, zQc: 0.012, sweep: 0, y: 0, ctrlFrom: 0.233, ctrlFrac: 0.22,
        thick: 0.13, camber: 0.035, mat: white, ctrlMat: red, tipMat: red });
      const holder = new THREE.Group();
      holder.position.y = 0.115;
      holder.rotation.z = side * 6 * Math.PI / 180;
      holder.add(grp);
      r.add(holder);
      this.surfaces.push({ obj: hinge, key: side < 0 ? 'aileronL' : 'aileronR', axis: 'x' });
      // wing struts
      r.add(strut(new THREE.Vector3(side * 0.06, -0.05, 0.0), new THREE.Vector3(side * 0.32, 0.12 + 0.03, 0.0)));
    }
    // horizontal tail
    for (const side of [1, -1] as const) {
      const { grp, hinge } = wingHalf({ side, span: 0.23, root: 0.15, tip: 0.115, zQc: 0.72, sweep: 0, y: 0.03, ctrlFrom: 0.012, ctrlFrac: 0.4,
        thick: 0.07, camber: 0, mat: red, ctrlMat: red });
      r.add(grp);
      this.surfaces.push({ obj: hinge, key: 'elevator', axis: 'x' });
    }
    // fin + rudder
    const finSt = [{ y: 0.05, zLE: 0.66, chord: 0.21 }, { y: 0.25, zLE: 0.76, chord: 0.11 }];
    r.add(new THREE.Mesh(finSurface(finSt, 0, 0.55, 0.07), white));
    const rh = new THREE.Group();
    rh.position.set(0, 0.05, 0.66 + 0.21 * 0.55);
    const rg = finSurface(finSt, 0.55, 1, 0.07);
    rg.translate(0, -0.05, -(0.66 + 0.21 * 0.55));
    rh.add(new THREE.Mesh(rg, red));
    r.add(rh);
    this.surfaces.push({ obj: rh, key: 'rudder', axis: 'y' });
    // gear
    const nw = wheel(0.035, 0.022, new THREE.Vector3(0, -0.145, -0.33));
    const mw1 = wheel(0.038, 0.024, new THREE.Vector3(0.16, -0.142, 0.06));
    const mw2 = wheel(0.038, 0.024, new THREE.Vector3(-0.16, -0.142, 0.06));
    r.add(nw, mw1, mw2);
    r.add(strut(new THREE.Vector3(0, -0.06, -0.33), new THREE.Vector3(0, -0.145, -0.33), 0.004));
    r.add(strut(new THREE.Vector3(0.03, -0.08, 0.06), new THREE.Vector3(0.16, -0.142, 0.06), 0.005));
    r.add(strut(new THREE.Vector3(-0.03, -0.08, 0.06), new THREE.Vector3(-0.16, -0.142, 0.06), 0.005));
    // spinner + prop
    const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.06, 16).rotateX(-Math.PI / 2), std(0xe8e8e8, 0.25, 0.5));
    spinner.position.set(0, 0, -0.44);
    r.add(spinner);
    const prop = new Prop(0.127, 2, 0x111111, 'z');
    prop.group.position.set(0, 0, -0.425);
    r.add(prop.group);
    this.props.push(prop);
    void dark;
    this.strobes = navLights(r, new THREE.Vector3(-0.7, 0.115 + 0.7 * Math.sin(6 * Math.PI / 180), 0.06), new THREE.Vector3(0.7, 0.115 + 0.7 * Math.sin(6 * Math.PI / 180), 0.06));
    this.fpvAnchor.position.set(0, 0.13, -0.24);
    r.add(this.fpvAnchor);
    finalize(r);
  }
}

/* ------------------------------------------------------------------ */
/*  Multirotor models                                                  */
/* ------------------------------------------------------------------ */
export class FpvQuadModel extends BaseModel {
  constructor(public camTiltDeg = 25) {
    super();
    this.size = 0.25;
    const carbon = new THREE.MeshStandardMaterial({ color: 0xffffff, map: carbonTexture(), roughness: 0.55, metalness: 0.0, envMapIntensity: 0.4 });
    const motorMat = std(0x8a8f99, 0.25, 0.85), r = this.root;
    const bellTop = std(0xd03030, 0.3, 0.7);
    const a = 0.08;
    const motors = [[a, -a], [a, a], [-a, a], [-a, -a]];
    for (const [x, z] of motors) {
      const len = Math.hypot(x, z);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.005, len + 0.02), carbon);
      arm.position.set(x / 2, -0.004, z / 2);
      arm.rotation.y = Math.atan2(x, z);
      r.add(arm);
      const mot = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.018, 16), motorMat);
      mot.position.set(x, 0.006, z);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.0145, 0.0145, 0.004, 16), bellTop);
      top.position.set(x, 0.016, z);
      r.add(mot, top);
    }
    const plateB = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.004, 0.11), carbon);
    plateB.position.y = -0.004;
    const plateT = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.003, 0.09), carbon);
    plateT.position.y = 0.028;
    const stack = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.024, 0.032), std(0x2a6e3a, 0.6));
    stack.position.y = 0.012;
    const batt = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.03, 0.075), std(0x2d6cdf, 0.5));
    batt.position.set(0, 0.046, 0.005);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.032, 0.012), std(0x111111, 0.8));
    strap.position.set(0, 0.046, 0.005);
    const cam = new THREE.Group();
    const camBody = new THREE.Mesh(new THREE.BoxGeometry(0.019, 0.019, 0.016), std(0x0f0f0f, 0.5));
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.007, 0.01, 12).rotateX(Math.PI / 2), glass());
    lens.position.z = -0.011;
    cam.add(camBody, lens);
    cam.position.set(0, 0.014, -0.05);
    cam.rotation.x = (camTiltDeg * Math.PI) / 180;
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.002, 0.05, 6), std(0x111111));
    ant.position.set(0, 0.045, 0.06);
    ant.rotation.x = -0.6;
    const antTip = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 6), std(0xd02020));
    antTip.position.set(0, 0.065, 0.075);
    r.add(plateB, plateT, stack, batt, strap, cam, ant, antTip);
    // LEDs: front white-green, rear red (orientation aid)
    const ledF = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.004, 0.004), glow(0x40ff60));
    ledF.position.set(0, -0.008, -0.058);
    const ledR = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.004, 0.004), glow(0xff2020));
    ledR.position.set(0, -0.008, 0.058);
    r.add(ledF, ledR);
    // props: front orange, rear dark (classic orientation trick)
    motors.forEach(([x, z], i) => {
      const front = z < 0;
      const p = new Prop(0.0635, 3, front ? 0xff7a00 : 0x2a2a2a, 'y', i % 2 === 0 ? -1 : 1, front ? 0xff7a00 : 0x333333);
      p.group.position.set(x, 0.02, z);
      r.add(p.group);
      this.props.push(p);
    });
    this.fpvAnchor.position.set(0, -0.022, -0.04);
    r.add(this.fpvAnchor);
    finalize(r);
  }
}

export class DroneModel extends BaseModel {
  constructor() {
    super();
    this.size = 0.35;
    const gray = paint(0x5b5f66, undefined, 0.35), dark = std(0x2b2d31, 0.5), white = std(0xe9e9e9, 0.5), r = this.root;
    const body = new THREE.Mesh(fuselage([[-0.11, 0.05, 0.035, 0.0], [-0.08, 0.085, 0.06, 0.005], [0.04, 0.09, 0.065, 0.005], [0.1, 0.06, 0.045, 0.0]], 18, 2.6), gray);
    r.add(body);
    const a = 0.12;
    const motors = [[a, -a], [a, a], [-a, a], [-a, -a]];
    motors.forEach(([x, z]) => {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.01, Math.hypot(x, z), 8), dark);
      arm.position.set(x / 2, 0.0, z / 2);
      arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(x, 0, z).normalize());
      r.add(arm);
      const mot = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, 0.022, 14), dark);
      mot.position.set(x, 0.008, z);
      r.add(mot);
      // landing legs under front arms, LEDs under motors
      const front = z < 0;
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), glow(front ? 0xff2020 : 0x30ff50));
      led.position.set(x, -0.01, z);
      r.add(led);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.075, 0.012), dark);
      leg.position.set(x * 0.58, -0.045, z * 0.58);
      r.add(leg);
    });
    // gimbal camera
    const gimbal = new THREE.Group();
    const camBody = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.03, 0.03), dark);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.01, 14).rotateX(Math.PI / 2), glass());
    lens.position.z = -0.018;
    gimbal.add(camBody, lens);
    gimbal.position.set(0, -0.045, -0.09);
    r.add(gimbal);
    motors.forEach(([x, z], i) => {
      const p = new Prop(0.1, 2, 0xf0f0f0, 'y', i % 2 === 0 ? -1 : 1, 0xdddddd);
      p.group.position.set(x, 0.024, z);
      r.add(p.group);
      this.props.push(p);
    });
    void white;
    this.fpvAnchor.position.set(0, -0.045, -0.11);
    r.add(this.fpvAnchor);
    finalize(r);
  }
}

export function createModel(id: string, camTilt = 25): AircraftModel {
  switch (id) {
    case 'trainer': return new TrainerModel();
    case 'fpv': return new FpvQuadModel(camTilt);
    default: return new DroneModel();
  }
}
