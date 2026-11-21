import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { World } from '../sim/world';
import { mulberry32 } from '../sim/math';
import type { Quality } from '../settings';
import * as T from './textures';

/**
 * Candy land visuals: static sweets-shop props (merged into a few meshes), walking cats and
 * unicorns, and the collectible sweets. Positions of everything solid come from world.candy,
 * so what is drawn is what the physics collides with. The animals have no collision.
 */

const PALETTE = [0xff5fa2, 0x54d8b4, 0xffd23f, 0xa97bff, 0x4fb8ff, 0xff5a4d];
const RAINBOW = [0xff3b30, 0xff9500, 0xffd60a, 0x34c759, 0x32ade6, 0xaf52de]; // outside to inside
const WHITE = 0xffffff;
const css = (n: number) => '#' + n.toString(16).padStart(6, '0');
const pal = (i: number) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];

type V3 = [number, number, number];
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _c = new THREE.Color();

/** Bake a flat colour into the geometry so differently coloured parts can share one mesh. */
function paint(g: THREE.BufferGeometry, color: number) {
  _c.set(color);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function place(g: THREE.BufferGeometry, pos: V3, rot: V3 = [0, 0, 0], scale: V3 | number = 1) {
  if (typeof scale === 'number') _s.setScalar(scale); else _s.set(...scale);
  return g.applyMatrix4(_m.compose(_p.set(...pos), _q.setFromEuler(_e.set(...rot)), _s));
}

const part = (g: THREE.BufferGeometry, color: number, pos: V3, rot?: V3, scale?: V3 | number) => paint(place(g, pos, rot, scale), color);

const sphere = (r: number) => new THREE.SphereGeometry(r, 12, 9);
const cyl = (r0: number, r1: number, h: number, seg = 10) => new THREE.CylinderGeometry(r0, r1, h, seg);
const cone = (r: number, h: number, seg = 8) => new THREE.ConeGeometry(r, h, seg);
const capsule = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 4, 10);

interface Walker {
  root: THREE.Group;
  legs: THREE.Object3D[];
  tail: THREE.Object3D;
  wings: THREE.Object3D[];
  cx: number; cz: number; R: number; a0: number;
  speed: number;   // m/s along the circle, sign = direction
  stride: number;  // leg swing phase per metre
  swing: number;   // leg swing amplitude (rad)
  fly: number;     // height above ground, 0 = walking
}

export class CandyLand {
  group = new THREE.Group();
  total = 0;
  collected = 0;
  /** Set when sweets were taken this frame; the caller clears it after playing the sound. */
  justCollected = 0;

  private mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private walkers: Walker[] = [];
  private sweets: { mesh: THREE.Mesh; x: number; y: number; z: number; pop: number; gone: boolean }[] = [];
  private respawn = 0;
  private shadows: boolean;

  constructor(private world: World, quality: Quality) {
    this.shadows = quality !== 'low';
    this.buildProps();
    this.buildSweets();
    this.buildAnimals();
  }

  private add(mesh: THREE.Mesh, receive = false) {
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = receive && this.shadows;
    this.group.add(mesh);
    return mesh;
  }

  /* ------------------------------ props ------------------------------ */
  private buildProps() {
    const c = this.world.candy;
    if (!c) return;
    const gy = (x: number, z: number) => this.world.terrain.heightAt(x, z);
    const flat: THREE.BufferGeometry[] = [];            // everything plain-coloured
    const heads: THREE.BufferGeometry[][] = PALETTE.map(() => []); // striped lollipop heads, per colour
    const canes: THREE.BufferGeometry[] = [];
    const rnd = mulberry32(99);
    const turn = (axis: 'x' | 'z'): V3 => [0, axis === 'x' ? Math.PI / 2 : 0, 0];

    for (const l of c.lollipops) {
      const y = gy(l.x, l.z);
      flat.push(part(cyl(0.16, 0.16, l.h), WHITE, [l.x, y + l.h / 2, l.z]));
      heads[l.c % PALETTE.length].push(place(new THREE.SphereGeometry(l.r, 20, 14), [l.x, y + l.h + l.r * 0.7, l.z], [rnd() * 1.2 - 0.6, rnd() * 6.28, rnd() * 1.2 - 0.6]));
    }

    for (const g of c.gumdrops) {
      flat.push(part(new THREE.SphereGeometry(g.r, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), pal(g.c), [g.x, gy(g.x, g.z), g.z], [0, 0, 0], [1, 1.2, 1]));
    }

    for (const k of c.cupcakes) {
      const y = gy(k.x, k.z), s = k.s;
      flat.push(
        part(cyl(0.8 * s, 0.6 * s, 0.9 * s, 14), pal(k.c), [k.x, y + 0.45 * s, k.z]),
        part(sphere(0.88 * s), 0xfff3f8, [k.x, y + 1.05 * s, k.z], [0, 0, 0], [1, 0.55, 1]),
        part(sphere(0.66 * s), pal(k.c + 3), [k.x, y + 1.45 * s, k.z], [0, 0, 0], [1, 0.6, 1]),
        part(sphere(0.42 * s), 0xfff3f8, [k.x, y + 1.8 * s, k.z], [0, 0, 0], [1, 0.7, 1]),
        part(sphere(0.2 * s), 0xe8112d, [k.x, y + 2.12 * s, k.z]),
      );
    }

    for (const d of c.donuts) {
      const ice = d.r * 0.24, ax = d.axis === 'x';
      flat.push(
        part(new THREE.TorusGeometry(d.R, d.r, 12, 30), 0xd99a5b, [d.x, d.y, d.z], turn(d.axis)),
        part(new THREE.TorusGeometry(d.R, d.r * 0.93, 12, 30), pal(d.c), [d.x + (ax ? ice : 0), d.y, d.z + (ax ? 0 : ice)], turn(d.axis)),
      );
      // sprinkles on the icing side
      for (let i = 0; i < 18; i++) {
        const a = rnd() * Math.PI * 2, rr = d.R + (rnd() * 2 - 1) * d.r * 0.55;
        const u = Math.cos(a) * rr, v = Math.sin(a) * rr, off = d.r * 1.12;
        flat.push(part(new THREE.BoxGeometry(0.12, 0.38, 0.12), pal(i + d.c + 1), [d.x + (ax ? off : u), d.y + v, d.z + (ax ? u : off)], [rnd() * 3, rnd() * 3, rnd() * 3]));
      }
    }

    for (const k of c.canes) canes.push(place(new THREE.TorusGeometry(k.R, k.r, 10, 36, Math.PI), [k.x, gy(k.x, k.z), k.z], turn(k.axis)));

    // rainbow with a cloud at each foot
    const rb = c.rainbow, ry = gy(rb.x, rb.z), step = rb.band / RAINBOW.length;
    RAINBOW.forEach((col, i) => {
      flat.push(part(new THREE.TorusGeometry(rb.R + rb.band - step * (i + 0.5), step * 0.56, 8, 64, Math.PI), col, [rb.x, ry, rb.z]));
    });
    for (const sx of [-1, 1]) {
      const fx = rb.x + sx * (rb.R + rb.band / 2);
      const puffs: [number, number, number, number][] = [[0, 1.3, 0, 2.3], [-2, 0.9, 0.6, 1.6], [2, 0.9, -0.5, 1.7], [0.6, 1.1, 1.6, 1.5], [-0.7, 1.1, -1.6, 1.5], [0, 2.6, 0, 1.5]];
      for (const [x, y, z, r] of puffs) flat.push(part(sphere(r), WHITE, [fx + x, ry + y, rb.z + z]));
    }

    // gingerbread house
    const H = c.house, hy = gy(H.x, H.z);
    const roofH = 2.8, k = Math.SQRT2;
    flat.push(
      part(new THREE.BoxGeometry(H.w, H.h, H.d), 0x9b5a2a, [H.x, hy + H.h / 2, H.z]),
      part(cyl(0, 1, roofH, 4), 0xfff3f8, [H.x, hy + H.h + roofH / 2, H.z], [0, Math.PI / 4, 0], [(H.w / 2 + 0.5) * k, 1, (H.d / 2 + 0.5) * k]),
      part(new THREE.BoxGeometry(1.5, 2.6, 0.2), 0xff5fa2, [H.x, hy + 1.3, H.z - H.d / 2 - 0.05]),
      part(new THREE.BoxGeometry(1.3, 1.3, 0.2), 0xffe27a, [H.x - 2.8, hy + 2.6, H.z - H.d / 2 - 0.05]),
      part(new THREE.BoxGeometry(1.3, 1.3, 0.2), 0xffe27a, [H.x + 2.8, hy + 2.6, H.z - H.d / 2 - 0.05]),
      part(new THREE.BoxGeometry(0.9, 2.2, 0.9), 0x9b5a2a, [H.x + 2.2, hy + H.h + 1.6, H.z + 1]),
      part(new THREE.BoxGeometry(1.1, 0.3, 1.1), WHITE, [H.x + 2.2, hy + H.h + 2.8, H.z + 1]),
    );
    for (let i = 0; i < 4; i++) {
      const sx = i % 2 ? 1 : -1, sz = i < 2 ? 1 : -1;
      flat.push(part(sphere(0.45), pal(i), [H.x + sx * (H.w / 2 + 0.1), hy + H.h + 0.25, H.z + sz * (H.d / 2 + 0.1)]));
    }
    // icing dots along the front wall
    for (let i = 0; i < 9; i++) flat.push(part(sphere(0.22), i % 2 ? WHITE : pal(i), [H.x - H.w / 2 + 0.5 + i * ((H.w - 1) / 8), hy + H.h - 0.3, H.z - H.d / 2 - 0.05]));

    this.add(new THREE.Mesh(mergeGeometries(flat), this.mat), true);
    heads.forEach((list, i) => {
      if (!list.length) return;
      const tex = T.stripeTexture(css(PALETTE[i]), '#ffffff', 10);
      this.add(new THREE.Mesh(mergeGeometries(list), new THREE.MeshLambertMaterial({ map: tex })));
    });
    if (canes.length) {
      const tex = T.stripeTexture('#e8112d', '#ffffff', 18);
      tex.rotation = Math.PI / 2;
      tex.center.set(0.5, 0.5);
      this.add(new THREE.Mesh(mergeGeometries(canes), new THREE.MeshLambertMaterial({ map: tex })));
    }
  }

  /* --------------------------- collectibles -------------------------- */
  private buildSweets() {
    const list = this.world.candy?.sweets ?? [];
    list.forEach((s, i) => {
      const col = pal(i), wrap = pal(i + 2);
      const geo = mergeGeometries([
        part(sphere(0.55), col, [0, 0, 0], [0, 0, 0], [1.25, 1, 1]),
        part(cone(0.42, 0.6), wrap, [0.95, 0, 0], [0, 0, Math.PI / 2]),
        part(cone(0.42, 0.6), wrap, [-0.95, 0, 0], [0, 0, -Math.PI / 2]),
        part(new THREE.TorusGeometry(1.35, 0.06, 6, 24), 0xfff27a, [0, 0, 0]),
      ]);
      const mesh = new THREE.Mesh(geo, this.mat);
      mesh.position.set(s.x, s.y, s.z);
      this.group.add(mesh);
      this.sweets.push({ mesh, x: s.x, y: s.y, z: s.z, pop: 0, gone: false });
    });
    this.total = this.sweets.length;
  }

  /* ----------------------------- animals ----------------------------- */
  private limb(g: THREE.BufferGeometry, x: number, y: number, z: number, parent: THREE.Group) {
    const m = new THREE.Mesh(g, this.mat);
    m.position.set(x, y, z);
    m.castShadow = this.shadows;
    parent.add(m);
    return m;
  }

  /** Giant kitten. Local +X is forward. */
  private makeCat(fur: number, paws: number) {
    const root = new THREE.Group();
    const body = mergeGeometries([
      part(capsule(0.38, 0.9), fur, [0, 0.85, 0], [0, 0, Math.PI / 2]),
      part(sphere(0.37), fur, [0.85, 1.2, 0]),
      part(cone(0.14, 0.3, 4), fur, [0.83, 1.6, 0.2]),
      part(cone(0.14, 0.3, 4), fur, [0.83, 1.6, -0.2]),
      part(sphere(0.16), paws, [1.13, 1.12, 0]),
      part(sphere(0.05), 0xff8fb0, [1.29, 1.16, 0]),
      part(sphere(0.065), 0x1c1c1c, [1.14, 1.31, 0.15]),
      part(sphere(0.065), 0x1c1c1c, [1.14, 1.31, -0.15]),
    ]);
    this.limb(body, 0, 0, 0, root);
    const leg = () => mergeGeometries([part(cyl(0.1, 0.09, 0.6), fur, [0, -0.3, 0]), part(sphere(0.12), paws, [0.03, -0.58, 0])]);
    const legs = [[0.42, 0.2], [0.42, -0.2], [-0.42, 0.2], [-0.42, -0.2]].map(([x, z]) => this.limb(leg(), x, 0.68, z, root));
    const tail = this.limb(mergeGeometries([part(cyl(0.05, 0.075, 0.95), fur, [0, 0.47, 0]), part(sphere(0.08), paws, [0, 0.95, 0])]), -0.78, 0.95, 0, root);
    tail.rotation.z = 0.55;
    root.scale.setScalar(1.7);
    return { root, legs, tail, wings: [] as THREE.Object3D[] };
  }

  /** Unicorn with a rainbow mane. Local +X is forward. */
  private makeUnicorn(winged: boolean, seed: number) {
    const root = new THREE.Group();
    const coat = 0xfdfdff;
    const parts = [
      part(capsule(0.55, 1.3), coat, [0, 1.85, 0], [0, 0, Math.PI / 2]),
      part(cyl(0.27, 0.36, 1.25), coat, [0.98, 2.55, 0], [0, 0, -0.6]),
      part(sphere(0.34), coat, [1.5, 3.05, 0], [0, 0, -0.4], [1.5, 1, 1]),
      part(sphere(0.2), 0xffc9dc, [1.88, 2.88, 0]),
      part(cone(0.09, 0.8), 0xffc928, [1.52, 3.68, 0], [0, 0, -0.35]),
      part(cone(0.09, 0.26, 4), coat, [1.28, 3.42, 0.2]),
      part(cone(0.09, 0.26, 4), coat, [1.28, 3.42, -0.2]),
      part(sphere(0.065), 0x1c1c1c, [1.68, 3.16, 0.26]),
      part(sphere(0.065), 0x1c1c1c, [1.68, 3.16, -0.26]),
    ];
    for (let i = 0; i < 6; i++) parts.push(part(sphere(0.21), pal(i + seed), [0.42 + i * 0.16, 2.42 + i * 0.2, 0]));
    this.limb(mergeGeometries(parts), 0, 0, 0, root);
    const leg = () => mergeGeometries([part(cyl(0.14, 0.11, 1.45), coat, [0, -0.72, 0]), part(cyl(0.14, 0.15, 0.2), 0xffc928, [0, -1.4, 0])]);
    const legs = [[0.75, 0.3], [0.75, -0.3], [-0.75, 0.3], [-0.75, -0.3]].map(([x, z]) => this.limb(leg(), x, 1.5, z, root));
    const tailParts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 5; i++) tailParts.push(part(sphere(0.24 - i * 0.025), pal(i + seed), [-0.1 - i * 0.14, -0.05 - i * 0.3, 0]));
    const tail = this.limb(mergeGeometries(tailParts), -1.2, 2.05, 0, root);
    const wings: THREE.Object3D[] = [];
    if (winged) {
      for (const sz of [1, -1]) {
        const g = mergeGeometries([
          part(new THREE.BoxGeometry(1.0, 0.07, 1.9), 0xffd9ec, [0, 0, sz * 0.95]),
          part(new THREE.BoxGeometry(0.6, 0.07, 1.2), 0xd9c4ff, [-0.55, 0, sz * 0.75]),
        ]);
        wings.push(this.limb(g, 0.1, 2.35, sz * 0.35, root));
      }
    }
    root.scale.setScalar(1.25);
    return { root, legs, tail, wings };
  }

  private buildAnimals() {
    const rnd = mulberry32(31);
    const pilot = this.world.layout.pilot;
    /** A circle to walk around that never passes right through the pilot's eyes. */
    const circle = (x0: number, x1: number, z0: number, z1: number, r0: number, r1: number) => {
      for (;;) {
        const cx = x0 + rnd() * (x1 - x0), cz = z0 + rnd() * (z1 - z0), R = r0 + rnd() * (r1 - r0);
        if (Math.abs(Math.hypot(cx - pilot.x, cz - pilot.z) - R) > 7) return { cx, cz, R, a0: rnd() * Math.PI * 2 };
      }
    };
    const dir = () => (rnd() < 0.5 ? -1 : 1);
    const furs: [number, number][] = [[0xf08a2c, 0xffffff], [0x8d8f96, 0xffffff], [0x2b2b30, 0xffffff], [0xf4f1ea, 0xf4c6a0], [0xc98a4b, 0x3a2a1c], [0xff9ecb, 0xffffff]];
    for (let i = 0; i < 10; i++) {
      const near = i < 6; // most cats stroll around the pilot and the runway
      const c = near ? circle(-110, 110, -34, 46, 5, 12) : circle(-170, 170, -95, 95, 6, 16);
      const [fur, paws] = furs[i % furs.length];
      this.walkers.push({ ...this.makeCat(fur, paws), ...c, speed: dir() * (1.4 + rnd() * 1.2), stride: 2.4, swing: 0.55, fly: 0 });
    }
    for (let i = 0; i < 5; i++) {
      const c = circle(-160, 160, i % 2 ? 55 : -100, i % 2 ? 100 : -55, 10, 22);
      this.walkers.push({ ...this.makeUnicorn(false, i), ...c, speed: dir() * (2.6 + rnd() * 1.4), stride: 1.3, swing: 0.5, fly: 0 });
    }
    this.walkers.push({ ...this.makeUnicorn(true, 1), cx: 0, cz: -30, R: 75, a0: 0, speed: 9, stride: 0.5, swing: 0.7, fly: 24 });
    this.walkers.push({ ...this.makeUnicorn(true, 4), cx: 30, cz: 15, R: 115, a0: 2, speed: -10, stride: 0.5, swing: 0.7, fly: 36 });
    for (const w of this.walkers) this.group.add(w.root);
  }

  /* ------------------------------ update ----------------------------- */
  update(dt: number, time: number, focus: THREE.Vector3) {
    const terrain = this.world.terrain;
    for (const w of this.walkers) {
      const sgn = Math.sign(w.speed);
      const a = w.a0 + (w.speed * time) / w.R;
      const x = w.cx + Math.cos(a) * w.R, z = w.cz + Math.sin(a) * w.R;
      const dx = -Math.sin(a) * sgn, dz = Math.cos(a) * sgn;
      const ph = Math.abs(w.speed) * time * w.stride + w.a0;
      const bob = w.fly ? Math.sin(time * 0.6 + w.a0) * 2.5 : Math.abs(Math.sin(ph)) * 0.06;
      w.root.position.set(x, terrain.heightAt(x, z) + w.fly + bob, z);
      w.root.rotation.y = Math.atan2(-dz, dx);
      const sw = Math.sin(ph) * w.swing;
      w.legs[0].rotation.z = sw; w.legs[3].rotation.z = sw;
      w.legs[1].rotation.z = -sw; w.legs[2].rotation.z = -sw;
      w.tail.rotation.x = Math.sin(time * 3 + w.a0) * 0.45;
      if (w.wings.length) {
        const flap = Math.sin(time * 7 + w.a0) * 0.55 - 0.15;
        w.wings[0].rotation.x = flap;
        w.wings[1].rotation.x = -flap;
      }
    }

    let left = 0;
    this.sweets.forEach((s, i) => {
      if (s.gone) return;
      if (s.pop > 0) {
        s.pop += dt * 3.5;
        s.mesh.scale.setScalar(1 + s.pop * 2.2);
        s.mesh.rotation.y += dt * 18;
        if (s.pop >= 1) { s.gone = true; s.mesh.visible = false; }
        return;
      }
      left++;
      s.mesh.rotation.y = time * 1.8 + i;
      s.mesh.rotation.z = Math.sin(time * 1.3 + i) * 0.25;
      s.mesh.position.y = s.y + Math.sin(time * 2 + i * 1.7) * 0.3;
      const ddx = focus.x - s.x, ddy = focus.y - s.mesh.position.y, ddz = focus.z - s.z;
      if (ddx * ddx + ddy * ddy + ddz * ddz < 2.2 * 2.2) {
        s.pop = 0.001;
        left--;
        this.collected++;
        this.justCollected++;
      }
    });

    // all taken: celebrate for a moment, then put every sweet back
    if (this.total && left === 0 && this.collected >= this.total) {
      this.respawn += dt;
      if (this.respawn > 6) {
        this.respawn = 0;
        this.collected = 0;
        for (const s of this.sweets) { s.gone = false; s.pop = 0; s.mesh.visible = true; s.mesh.scale.setScalar(1); }
      }
    }
  }
}
