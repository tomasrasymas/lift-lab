import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../sim/math';
import type { World } from '../sim/world';
import type { Quality } from '../settings';
import { foliageAtlas, grassBlades } from './textures';

/* ------------------------------------------------------------------ */
/*  Atlas regions (see foliageAtlas)                                   */
/* ------------------------------------------------------------------ */
const R_LEAF = { u0: 0, u1: 0.5, v0: 0.5, v1: 1 };
const R_NEEDLE = { u0: 0.5, u1: 1, v0: 0.5, v1: 1 };
const R_BARK = { u0: 0, u1: 1, v0: 0.26, v1: 0.49 };
const R_BUSH = { u0: 0, u1: 0.5, v0: 0, v1: 0.25 };
type Region = typeof R_LEAF;

class Builder {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; idx: number[] = [];
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, r: Region, normal: (p: THREE.Vector3) => THREE.Vector3) {
    const base = this.pos.length / 3;
    const uvs = [[r.u0, r.v0], [r.u1, r.v0], [r.u1, r.v1], [r.u0, r.v1]];
    [a, b, c, d].forEach((p, i) => {
      this.pos.push(p.x, p.y, p.z);
      const n = normal(p);
      this.nrm.push(n.x, n.y, n.z);
      this.uv.push(uvs[i][0], uvs[i][1]);
    });
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** Tapered cylinder along y with bark UVs. */
  trunk(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r0: number, r1: number, seg = 6) {
    const base = this.pos.length / 3;
    const axis = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0).normalize();
    const t1 = new THREE.Vector3(1, 0, 0);
    if (Math.abs(axis.x) > 0.9) t1.set(0, 0, 1);
    const u = new THREE.Vector3().crossVectors(axis, t1).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u);
    for (let ring = 0; ring < 2; ring++) {
      const r = ring ? r1 : r0;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const n = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a));
        this.pos.push((ring ? x1 : x0) + n.x * r, (ring ? y1 : y0) + n.y * r, (ring ? z1 : z0) + n.z * r);
        this.nrm.push(n.x, n.y, n.z);
        this.uv.push(R_BARK.u0 + (i / seg) * 0.25, ring ? R_BARK.v1 : R_BARK.v0);
      }
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i, b = base + i + 1, c = base + seg + 1 + i, d = base + seg + 2 + i;
      this.idx.push(a, c, b, b, c, d);
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    return g;
  }
}

/** Broadleaf tree, unit height, crown radius ~1 (instance scale = r, h, r). */
function broadleaf(cards: number, seed: number, bush = false) {
  const B = new Builder();
  const rnd = mulberry32(seed);
  const cy = bush ? 0.5 : 0.64, ry = bush ? 0.45 : 0.33, rx = 0.82;
  const center = new THREE.Vector3(0, cy, 0);
  if (!bush) {
    B.trunk(0, -0.02, 0, 0.02, 0.62, -0.01, 0.06, 0.03, 7);
    for (let i = 0; i < 4; i++) {
      const a = rnd() * Math.PI * 2;
      B.trunk(0.01, 0.38 + i * 0.06, 0, Math.cos(a) * 0.45, 0.6 + rnd() * 0.15, Math.sin(a) * 0.45, 0.025, 0.008, 4);
    }
  }
  const sphereN = (p: THREE.Vector3) => p.clone().sub(center).multiply(new THREE.Vector3(1, 1.6, 1)).normalize().lerp(new THREE.Vector3(0, 1, 0), 0.25).normalize();
  for (let i = 0; i < cards; i++) {
    // points biased toward the surface of the crown ellipsoid
    const dir = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
    const rr = 0.45 + 0.55 * Math.sqrt(rnd());
    const p = new THREE.Vector3(dir.x * rx * rr, cy + dir.y * ry * rr, dir.z * rx * rr);
    const size = (bush ? 0.55 : 0.5) + rnd() * 0.25;
    // random card orientation
    const n = new THREE.Vector3(rnd() * 2 - 1, (rnd() * 2 - 1) * 0.6, rnd() * 2 - 1).normalize();
    const t = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 1, 0)).normalize();
    if (t.lengthSq() < 0.01) t.set(1, 0, 0);
    const bvec = new THREE.Vector3().crossVectors(t, n).normalize();
    const h = size / 2;
    const sx = t.multiplyScalar(h), sy = bvec.multiplyScalar(h * 0.75);
    B.quad(
      p.clone().sub(sx).sub(sy), p.clone().add(sx).sub(sy), p.clone().add(sx).add(sy), p.clone().sub(sx).add(sy),
      bush ? R_BUSH : R_LEAF, sphereN,
    );
  }
  return B.build();
}

/** Conifer: whorls of drooping needle sprays around a straight trunk. */
function conifer(levels: number, perLevel: number, seed: number) {
  const B = new Builder();
  const rnd = mulberry32(seed);
  B.trunk(0, -0.02, 0, 0, 0.95, 0, 0.045, 0.01, 6);
  for (let l = 0; l < levels; l++) {
    const f = l / (levels - 1);
    const y = 0.14 + f * 0.8;
    const len = (1 - f * 0.88) * 1.0;
    const n = Math.max(3, Math.round(perLevel * (1 - f * 0.5)));
    for (let k = 0; k < n; k++) {
      const a = ((k + rnd() * 0.5) / n) * Math.PI * 2 + l * 0.7;
      const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const side = new THREE.Vector3(-out.z, 0, out.x);
      const w = len * 0.32;
      const root = new THREE.Vector3(0, y + 0.03, 0);
      const tip = out.clone().multiplyScalar(len).add(new THREE.Vector3(0, y - len * 0.22, 0));
      const norm = (p: THREE.Vector3) => new THREE.Vector3(p.x, 0.6, p.z).normalize();
      // flat-ish spray + a vertical one for volume
      const up = new THREE.Vector3(0, w * 0.5, 0);
      B.quad(root.clone().addScaledVector(side, -w * 0.3), tip.clone().addScaledVector(side, -w), tip.clone().addScaledVector(side, w), root.clone().addScaledVector(side, w * 0.3), R_NEEDLE, norm);
      B.quad(root.clone().sub(up), tip.clone().sub(up), tip.clone().add(up), root.clone().add(up), R_NEEDLE, norm);
    }
  }
  return B.build();
}


/** Double-sided foliage: keep the authored normal on back faces (three flips it, which makes half the cards black). */
function noNormalFlip(fs: string) {
  return fs.replace('#include <normal_fragment_begin>', `
    float faceDirection = 1.0;
    vec3 normal = normalize( vNormal );
    vec3 nonPerturbedNormal = normal;`);
}

function swayMaterial(map: THREE.Texture, quality: Quality, uniforms: { uTime: { value: number } }) {
  const mat = new THREE.MeshLambertMaterial({ map, color: new THREE.Color(1.22, 1.22, 1.16), alphaTest: 0.42, side: THREE.DoubleSide });
  mat.alphaToCoverage = quality !== 'low';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
        float sw = max(0.0, position.y - 0.25);
        transformed.x += sin(uTime * 1.3 + ph) * 0.025 * sw + sin(uTime * 3.1 + ph * 2.0 + position.z * 4.0) * 0.01 * sw;
        transformed.z += cos(uTime * 1.1 + ph) * 0.02 * sw;
      #endif`,
    );
    sh.fragmentShader = noNormalFlip(sh.fragmentShader);
  };
  return mat;
}

/* ------------------------------------------------------------------ */
export class Trees {
  group = new THREE.Group();
  uniforms = { uTime: { value: 0 } };

  constructor(world: World, quality: Quality) {
    const atlas = foliageAtlas();
    const mat = swayMaterial(atlas, quality, this.uniforms);
    const cards = quality === 'low' ? 14 : quality === 'medium' ? 26 : 38;
    const farCards = quality === 'low' ? 6 : quality === 'medium' ? 9 : 12;
    // [lod][kind]: kind 0 conifer, 1-2 broadleaf variants
    const geos = [
      [conifer(quality === 'low' ? 5 : 8, quality === 'low' ? 4 : 6, 3), broadleaf(cards, 5), broadleaf(cards, 9)],
      [conifer(4, 3, 3), broadleaf(farCards, 5), broadleaf(farCards, 9)],
    ];
    const nearR = quality === 'high' ? 420 : 300;
    const trees = world.trees;
    const rnd = mulberry32(42);
    const assign = trees.map((t) => (t.type === 0 ? 0 : rnd() < 0.5 ? 1 : 2) + (Math.hypot(t.x - world.layout.pilot.x, t.z - world.layout.pilot.z) < nearR ? 0 : 3));
    const counts = [0, 0, 0, 0, 0, 0];
    assign.forEach((a) => counts[a]++);
    const meshes = counts.map((cnt, a) => new THREE.InstancedMesh(geos[a >= 3 ? 1 : 0][a % 3], mat, Math.max(1, cnt)));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
    const k = [0, 0, 0, 0, 0, 0];
    trees.forEach((t, i) => {
      const a = assign[i];
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      s.set(t.r * 1.03, t.h, t.r * 1.03);
      p.set(t.x, t.y - 0.2, t.z);
      m.compose(p, q, s);
      meshes[a].setMatrixAt(k[a], m);
      const v = 0.78 + rnd() * 0.4;
      const autumn = a % 3 > 0 && rnd() < 0.06;
      c.setRGB(v * (autumn ? 1.5 : 0.92 + rnd() * 0.12), v * (autumn ? 1.1 : 1), v * (0.8 + rnd() * 0.25));
      meshes[a].setColorAt(k[a], c);
      k[a]++;
    });
    meshes.forEach((mesh, a) => {
      mesh.count = counts[a];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    });

    // bushes / undergrowth
    const bushGeo = broadleaf(quality === 'low' ? 8 : 14, 13, true);
    const list = quality === 'low' ? world.bushes.filter((_, i) => i % 3 === 0) : world.bushes;
    const bushes = new THREE.InstancedMesh(bushGeo, mat, Math.max(1, list.length));
    list.forEach((b, i) => {
      const y = world.terrain.heightAt(b.x, b.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
      m.compose(p.set(b.x, y - 0.1, b.z), q, s.set(b.s * 1.3, b.s, b.s * 1.3));
      bushes.setMatrixAt(i, m);
      c.setRGB(1.0 + rnd() * 0.3, 1.05 + rnd() * 0.25, 0.9 + rnd() * 0.3);
      bushes.setColorAt(i, c);
    });
    bushes.count = list.length;
    bushes.instanceMatrix.needsUpdate = true;
    if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
    bushes.computeBoundingSphere();
    this.group.add(bushes);
  }

  update(time: number) { this.uniforms.uTime.value = time; }
}

/* ------------------------------------------------------------------ */
/*  GPU grass: tufts wrap around the camera, height read from a texture */
/* ------------------------------------------------------------------ */
export class Grass {
  mesh: THREE.Mesh | null = null;
  private uniforms = {
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector2() },
    uTile: { value: 60 },
    uHeight: { value: null as THREE.DataTexture | null },
    uHalf: { value: 0 },
    uCell: { value: 0 },
    uRes: { value: 0 },
    uWater: { value: 0 },
    uField: { value: new THREE.Vector4() },   // mown rect x0,z0,x1,z1
    uRunway: { value: new THREE.Vector4() },
    uNoGrass: { value: new THREE.Vector4(1, 1, -1, -1) },
    uPad: { value: new THREE.Vector3() },
  };

  constructor(world: World, quality: Quality) {
    const L = world.layout;
    const U0 = this.uniforms;
    U0.uWater.value = L.waterLevel;
    if (L.mown) U0.uField.value.set(L.mown.x0, L.mown.z0, L.mown.x1, L.mown.z1);
    const rw = L.runway;
    U0.uRunway.value.set(rw.cx - rw.halfLength, rw.cz - rw.halfWidth, rw.cx + rw.halfLength, rw.cz + rw.halfWidth);
    if (L.noGrass) U0.uNoGrass.value.set(L.noGrass.x0, L.noGrass.z0, L.noGrass.x1, L.noGrass.z1);
    U0.uPad.value.set(L.pad.x, L.pad.z, 1.8);
    if (quality === 'low') return;
    const count = quality === 'medium' ? 26000 : 70000;
    const tile = quality === 'medium' ? 48 : 70;
    const t = world.terrain;
    const n = t.res + 1;
    const ht = new THREE.DataTexture(t.heights, n, n, THREE.RedFormat, THREE.FloatType);
    ht.minFilter = ht.magFilter = THREE.NearestFilter;
    ht.needsUpdate = true;
    Object.assign(this.uniforms, {});
    this.uniforms.uHeight.value = ht;
    this.uniforms.uHalf.value = t.half;
    this.uniforms.uCell.value = t.cell;
    this.uniforms.uRes.value = n;
    this.uniforms.uTile.value = tile;

    // tuft = 3 crossed quads, unit size (normals up so it shades like the ground)
    const quads: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.PlaneGeometry(1, 1, 1, 1).translate(0, 0.5, 0).rotateY((i / 3) * Math.PI);
      quads.push(g);
    }
    const base = mergeGeometries(quads)!;
    const nrm = base.getAttribute('normal');
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('normal', base.getAttribute('normal'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    const off = new Float32Array(count * 4);
    const rnd = mulberry32(99);
    for (let i = 0; i < count; i++) { off[i * 4] = rnd(); off[i * 4 + 1] = rnd(); off[i * 4 + 2] = rnd(); off[i * 4 + 3] = rnd(); }
    geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
    geo.instanceCount = count;

    const mat = new THREE.MeshLambertMaterial({ map: grassBlades(), alphaTest: 0.4, side: THREE.DoubleSide });
    mat.alphaToCoverage = true;
    const U = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = `
        uniform float uTime, uTile, uHalf, uCell, uRes, uWater;
        uniform vec2 uCam;
        uniform vec4 uField, uRunway, uNoGrass;
        uniform vec3 uPad;
        uniform sampler2D uHeight;
        attribute vec4 aOff;
        varying float vTint;
        float hAt(float i, float j) { return texture2D(uHeight, (vec2(i, j) + 0.5) / uRes).r; }
        float terrainH(vec2 p) {
          vec2 g = (p + uHalf) / uCell;
          vec2 ij = floor(g); vec2 f = g - ij;
          float h10 = hAt(ij.x + 1.0, ij.y), h01 = hAt(ij.x, ij.y + 1.0);
          if (f.x + f.y <= 1.0) { float h00 = hAt(ij.x, ij.y); return h00 + (h10 - h00) * f.x + (h01 - h00) * f.y; }
          float h11 = hAt(ij.x + 1.0, ij.y + 1.0);
          return h11 + (h01 - h11) * (1.0 - f.x) + (h10 - h11) * (1.0 - f.y);
        }
      ` + sh.vertexShader.replace('#include <begin_vertex>', `
        // toroidal wrap of the tuft grid around the camera
        vec2 pp = aOff.xy * uTile;
        vec2 wp = uCam + mod(pp - uCam + 0.5 * uTile, uTile) - 0.5 * uTile;
        float d = length(wp - uCam) / (0.5 * uTile);
        float h = terrainH(wp);
        bool inField = wp.x > uField.x && wp.x < uField.z && wp.y > uField.y && wp.y < uField.w;
        bool onRunway = wp.x > uRunway.x && wp.x < uRunway.z && wp.y > uRunway.y && wp.y < uRunway.w;
        bool noGrass = wp.x > uNoGrass.x && wp.x < uNoGrass.z && wp.y > uNoGrass.y && wp.y < uNoGrass.w;
        bool onPad = length(wp - uPad.xy) < uPad.z;
        float height = inField ? 0.045 + aOff.z * 0.04 : 0.16 + aOff.z * 0.26;
        float width = inField ? 0.12 : 0.28 + aOff.w * 0.22;
        float s = (inField || onRunway || onPad || noGrass || h < uWater + 0.2) ? 0.0 : 1.0;
        s *= 1.0 - smoothstep(0.65, 1.0, d);
        float a = aOff.w * 6.2831;
        float ca = cos(a), sa = sin(a);
        vec3 lp = position;
        lp.xz = mat2(ca, -sa, sa, ca) * lp.xz;
        vec3 transformed = vec3(lp.x * width * s, lp.y * height * s, lp.z * width * s);
        float tip = position.y;
        transformed.x += sin(uTime * 2.1 + wp.x * 0.35 + wp.y * 0.21) * 0.06 * tip * height * 3.0;
        transformed.z += cos(uTime * 1.7 + wp.y * 0.3) * 0.04 * tip * height * 3.0;
        transformed += vec3(wp.x, h + 0.01, wp.y);
        vTint = 0.82 + aOff.z * 0.3;
      `);
      sh.fragmentShader = 'varying float vTint;\n' + noNormalFlip(sh.fragmentShader).replace(
        '#include <map_fragment>',
        '#include <map_fragment>\n diffuseColor.rgb *= vTint;',
      );
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    this.mesh = mesh;
  }

  update(time: number, camera: THREE.Vector3, groundH: number) {
    if (!this.mesh) return;
    this.uniforms.uTime.value = time;
    this.uniforms.uCam.value.set(camera.x, camera.z);
    this.mesh.visible = camera.y - groundH < 45;
  }
}
