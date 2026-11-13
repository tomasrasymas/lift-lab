import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CITY, CITY_EXTENT, type Building, type BuildingStyle, type World } from '../sim/world';
import { mulberry32 } from '../sim/math';
import type { Quality } from '../settings';
import * as T from './textures';

const STYLE: Record<BuildingStyle, { bay: number; floor: number }> = {
  glass: { bay: 3.0, floor: 3.6 },
  office: { bay: 3.2, floor: 3.5 },
  brick: { bay: 3.6, floor: 3.2 },
  concrete: { bay: 3.4, floor: 3.0 },
  house: { bay: 3.0, floor: 2.8 },
};

class GeoBuilder {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; col: number[] = []; idx: number[] = [];
  quad(p: number[][], n: number[], uvs: number[][], color: THREE.Color) {
    const b = this.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      this.pos.push(...p[i]); this.nrm.push(...n); this.uv.push(...uvs[i]); this.col.push(color.r, color.g, color.b);
    }
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  /** Axis aligned box with world-unit UVs (scale su, sv). */
  box(min: THREE.Vector3, max: THREE.Vector3, su: number, sv: number, color: THREE.Color, top = true, bottom = false) {
    const [x0, y0, z0] = [min.x, min.y, min.z], [x1, y1, z1] = [max.x, max.y, max.z];
    const w = x1 - x0, d = z1 - z0, h = y1 - y0;
    const v0 = y0 / sv, v1 = y1 / sv;
    // +z
    this.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], [[x0 / su, v0], [x1 / su, v0], [x1 / su, v1], [x0 / su, v1]], color);
    // -z
    this.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], [[-x1 / su, v0], [-x0 / su, v0], [-x0 / su, v1], [-x1 / su, v1]], color);
    // +x
    this.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], [[-z1 / su, v0], [-z0 / su, v0], [-z0 / su, v1], [-z1 / su, v1]], color);
    // -x
    this.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], [[z0 / su, v0], [z1 / su, v0], [z1 / su, v1], [z0 / su, v1]], color);
    if (top) this.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], [[x0 / su, z1 / su], [x1 / su, z1 / su], [x1 / su, z0 / su], [x0 / su, z0 / su]], color);
    if (bottom) this.quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], [[x0 / su, z0 / su], [x1 / su, z0 / su], [x1 / su, z1 / su], [x0 / su, z1 / su]], color);
    void w; void d; void h;
  }
  /** Horizontal quad (y up). */
  flat(x0: number, z0: number, x1: number, z1: number, y: number, su: number, sv: number, color: THREE.Color, rot = false) {
    const uv = rot
      ? [[z1 / sv, x0 / su], [z1 / sv, x1 / su], [z0 / sv, x1 / su], [z0 / sv, x0 / su]]
      : [[x0 / su, z1 / sv], [x1 / su, z1 / sv], [x1 / su, z0 / sv], [x0 / su, z0 / sv]];
    this.quad([[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]], [0, 1, 0], uv, color);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Ground decals are thin coplanar layers (sidewalk, roads, lawn...). A few mm of
 * height is below depth-buffer precision a few dozen metres away, so they are
 * ordered with polygon offset, which scales with depth precision at any range.
 */
export function decal<M extends THREE.Material>(m: M, level: number): M {
  m.polygonOffset = true;
  m.polygonOffsetFactor = -1;
  m.polygonOffsetUnits = -2 * level;
  return m;
}

/* ------------------------------------------------------------------ */
/*  Static (baked) sun shadow map for the whole city                    */
/* ------------------------------------------------------------------ */
export class StaticShadow {
  depth: THREE.DepthTexture;
  matrix = new THREE.Matrix4();
  private uniforms: Record<string, THREE.IUniform>;

  constructor(renderer: THREE.WebGLRenderer, casters: THREE.Object3D[], sunDir: THREE.Vector3, quality: Quality) {
    const size = quality === 'high' ? 4096 : 2048;
    this.depth = new THREE.DepthTexture(size, size);
    this.depth.type = THREE.UnsignedIntType;
    const rt = new THREE.WebGLRenderTarget(size, size, { depthTexture: this.depth, depthBuffer: true });
    const E = CITY_EXTENT + 60;
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
    cam.position.copy(sunDir).multiplyScalar(2000);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    // fit the frustum around the city volume in light space
    const inv = cam.matrixWorldInverse;
    const mn = new THREE.Vector3(Infinity, Infinity, Infinity), mx = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const x of [-E, E]) for (const y of [0, 190]) for (const z of [-E, E]) {
      const p = new THREE.Vector3(x, y, z).applyMatrix4(inv);
      mn.min(p); mx.max(p);
    }
    cam.left = mn.x; cam.right = mx.x; cam.bottom = mn.y; cam.top = mx.y; cam.near = -mx.z - 10; cam.far = -mn.z + 10;
    cam.updateProjectionMatrix();
    const scene = new THREE.Scene();
    scene.overrideMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const parents: [THREE.Object3D, THREE.Object3D | null][] = [];
    for (const c of casters) { parents.push([c, c.parent]); scene.add(c); }
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(null);
    for (const [c, p] of parents) { if (p) p.add(c); else scene.remove(c); }
    // world -> shadow texture coordinates
    this.matrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    this.uniforms = { uStaticShadow: { value: this.depth }, uStaticShadowMatrix: { value: this.matrix }, uStaticTexel: { value: 1 / size } };
  }

  /** Patch a Lambert/Standard material so it is darkened where the city blocks the sun. */
  apply(mat: THREE.Material) {
    const prev = mat.onBeforeCompile.bind(mat);
    const U = this.uniforms;
    mat.onBeforeCompile = (sh, r) => {
      prev(sh, r);
      Object.assign(sh.uniforms, U);
      sh.vertexShader = 'varying vec3 vStaticWorld;\n' + sh.vertexShader.replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\n vStaticWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
      // make sure worldpos is available even without shadows/envmaps
      if (!sh.vertexShader.includes('vec4 worldPosition')) {
        sh.vertexShader = sh.vertexShader.replace('vStaticWorld = (modelMatrix', 'vStaticWorld = (modelMatrix');
      }
      sh.fragmentShader = `uniform sampler2D uStaticShadow;\nuniform mat4 uStaticShadowMatrix;\nuniform float uStaticTexel;\nvarying vec3 vStaticWorld;
        float staticLit() {
          vec4 sc = uStaticShadowMatrix * vec4(vStaticWorld, 1.0);
          vec3 c = sc.xyz / sc.w;
          if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0) return 1.0;
          float lit = 0.0;
          for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
            float d = texture2D(uStaticShadow, c.xy + vec2(float(i), float(j)) * uStaticTexel * 1.2).r;
            lit += (c.z - 0.0006 <= d) ? 1.0 : 0.0;
          }
          return lit / 9.0;
        }\n` + sh.fragmentShader.replace(
        '#include <opaque_fragment>',
        'outgoingLight *= mix(0.48, 1.0, staticLit());\n#include <opaque_fragment>',
      );
    };
    mat.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ */
interface Car { road: number; axis: 'x' | 'z'; pos: number; lane: number; dir: number; speed: number; }

export class CityRenderer {
  group = new THREE.Group();
  casters: THREE.Object3D[] = [];
  /** materials that should receive the baked city shadow */
  shadowReceivers: THREE.Material[] = [];
  private traffic?: THREE.InstancedMesh;
  private cars: Car[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3(1, 1, 1);
  private p = new THREE.Vector3();

  constructor(world: World, quality: Quality, envMap: THREE.Texture) {
    const shadows = quality !== 'low';
    const lam = (map: THREE.Texture | null, color = 0xffffff, vc = false) => {
      const m = new THREE.MeshLambertMaterial({ map, color, vertexColors: vc });
      this.shadowReceivers.push(m);
      return m;
    };
    const E = CITY_EXTENT;
    const { pitch, road, n } = CITY;

    // ---- ground: sidewalk concrete over the whole city ----
    const ground = new GeoBuilder();
    ground.flat(-E, -E, E, E, 0.03, 4, 4, new THREE.Color(1, 1, 1));
    const gMesh = new THREE.Mesh(ground.build(), decal(lam(T.sidewalkTexture()), 1));
    gMesh.receiveShadow = shadows;
    this.group.add(gMesh);

    // ---- roads ----
    const rx = new GeoBuilder(), rz = new GeoBuilder(), inter = new GeoBuilder(), cross = new GeoBuilder();
    const white = new THREE.Color(1, 1, 1);
    for (let k = -n - 1; k <= n; k++) {
      const c = (k + 0.5) * pitch;
      // road along X: u along x (24 m tiles), v across width (0..1)
      rx.quad([[-E, 0.06, c + road / 2], [E, 0.06, c + road / 2], [E, 0.06, c - road / 2], [-E, 0.06, c - road / 2]], [0, 1, 0],
        [[-E / 24, 0], [E / 24, 0], [E / 24, 1], [-E / 24, 1]], white);
      rz.quad([[c - road / 2, 0.065, E], [c + road / 2, 0.065, E], [c + road / 2, 0.065, -E], [c - road / 2, 0.065, -E]], [0, 1, 0],
        [[E / 24, 0], [E / 24, 1], [-E / 24, 1], [-E / 24, 0]], white);
    }
    for (let i = -n - 1; i <= n; i++) {
      for (let j = -n - 1; j <= n; j++) {
        const cx = (i + 0.5) * pitch, cz = (j + 0.5) * pitch, h = road / 2;
        inter.quad([[cx - h, 0.07, cz + h], [cx + h, 0.07, cz + h], [cx + h, 0.07, cz - h], [cx - h, 0.07, cz - h]], [0, 1, 0],
          [[0.1, 0.3], [0.2, 0.3], [0.2, 0.4], [0.1, 0.4]], white);
        // zebra crossings on the four approaches
        const w = 3.2;
        cross.quad([[cx + h, 0.075, cz + h], [cx + h + w, 0.075, cz + h], [cx + h + w, 0.075, cz - h], [cx + h, 0.075, cz - h]], [0, 1, 0], [[0, 0], [0, 1], [1, 1], [1, 0]], white);
        cross.quad([[cx - h - w, 0.075, cz + h], [cx - h, 0.075, cz + h], [cx - h, 0.075, cz - h], [cx - h - w, 0.075, cz - h]], [0, 1, 0], [[0, 0], [0, 1], [1, 1], [1, 0]], white);
        cross.quad([[cx - h, 0.075, cz + h + w], [cx + h, 0.075, cz + h + w], [cx + h, 0.075, cz + h], [cx - h, 0.075, cz + h]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]], white);
        cross.quad([[cx - h, 0.075, cz - h], [cx + h, 0.075, cz - h], [cx + h, 0.075, cz - h - w], [cx - h, 0.075, cz - h - w]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]], white);
      }
    }
    const roadTex = T.roadTexture();
    // each overlapping layer gets its own depth offset so they never fight at distance
    for (const [b, level] of [[rx, 2], [rz, 3], [inter, 4]] as const) {
      const mesh = new THREE.Mesh(b.build(), decal(lam(roadTex), level));
      mesh.receiveShadow = shadows;
      this.group.add(mesh);
    }
    const crossMat = decal(new THREE.MeshLambertMaterial({ map: T.crosswalkTexture(), transparent: true, depthWrite: false }), 5);
    this.shadowReceivers.push(crossMat);
    this.group.add(new THREE.Mesh(cross.build(), crossMat));

    // ---- parks and parking lots ----
    const lawn = new GeoBuilder(), lots = new GeoBuilder();
    for (const p of world.parks) lawn.flat(p.x0, p.z0, p.x1, p.z1, 0.08, 5, 5, white);
    for (const p of world.parking) lots.flat(p.x0, p.z0, p.x1, p.z1, 0.08, 16, 16, white);
    const lawnMat = decal(lam(T.groundGrass(512), 0xb8d890), 3);
    const lawnMesh = new THREE.Mesh(lawn.build(), lawnMat);
    lawnMesh.receiveShadow = shadows;
    this.group.add(lawnMesh);
    const lotMesh = new THREE.Mesh(lots.build(), decal(lam(T.parkingTexture()), 3));
    lotMesh.receiveShadow = shadows;
    this.group.add(lotMesh);

    // ---- buildings: merged per style, facades mapped in world units ----
    const rnd = mulberry32(9);
    const byStyle = new Map<BuildingStyle, GeoBuilder>();
    const roofs = new GeoBuilder(), roofProps = new GeoBuilder();
    for (const b of world.buildings) {
      const st = STYLE[b.style];
      let gb = byStyle.get(b.style);
      if (!gb) byStyle.set(b.style, (gb = new GeoBuilder()));
      const tint = 0.85 + rnd() * 0.3;
      const color = new THREE.Color(tint, tint * (0.97 + rnd() * 0.05), tint * (0.94 + rnd() * 0.08));
      const min = new THREE.Vector3(b.x - b.w / 2, 0, b.z - b.d / 2), max = new THREE.Vector3(b.x + b.w / 2, b.h, b.z + b.d / 2);
      gb.box(min, max, st.bay * 4, st.floor * 2, color, false);
      this.roof(b, roofs, roofProps, rnd);
    }
    for (const [style, gb] of byStyle) {
      const tex = T.facadeTexture(style, 3);
      let mat: THREE.Material;
      if (style === 'glass') {
        mat = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, metalness: 0.55, roughness: 0.12, envMap, envMapIntensity: 1.2 });
        this.shadowReceivers.push(mat);
      } else mat = lam(tex, 0xffffff, true);
      const mesh = new THREE.Mesh(gb.build(), mat);
      mesh.receiveShadow = shadows;
      this.casters.push(mesh);
      this.group.add(mesh);
    }
    const roofMesh = new THREE.Mesh(roofs.build(), lam(T.groundRock(256), 0x8a8a88, true));
    roofMesh.receiveShadow = shadows;
    const propMesh = new THREE.Mesh(roofProps.build(), lam(null, 0xb8b8b4, true));
    this.casters.push(roofMesh, propMesh);
    this.group.add(roofMesh, propMesh);

    // ---- abandoned concrete frames ("bandos") ----
    const conc = new GeoBuilder();
    for (const s of world.solids) if (s.kind === 'concrete') conc.box(s.min, s.max, 6, 6, new THREE.Color(1, 1, 1), true, true);
    if (conc.pos.length) {
      const mat = lam(T.rawConcreteTexture(true));
      (mat as THREE.MeshLambertMaterial).side = THREE.DoubleSide;
      const mesh = new THREE.Mesh(conc.build(), mat);
      mesh.receiveShadow = shadows;
      this.casters.push(mesh);
      this.group.add(mesh);
    }

    // ---- streetlights ----
    const poles = world.solids.filter((s) => s.kind === 'pole');
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.07, 0.11, 8, 8).translate(0, 4, 0),
      new THREE.BoxGeometry(1.6, 0.08, 0.1).translate(0.75, 7.9, 0),
      new THREE.BoxGeometry(0.55, 0.12, 0.28).translate(1.45, 7.82, 0),
    ])!;
    const poleMesh = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: 0x4a4d52, roughness: 0.5, metalness: 0.6, envMap }), Math.max(1, poles.length));
    poles.forEach((pl, i) => {
      const x = (pl.min.x + pl.max.x) / 2, z = (pl.min.z + pl.max.z) / 2;
      // arm points toward the nearest road
      const fx = ((x / pitch) % 1 + 1) % 1, fz = ((z / pitch) % 1 + 1) % 1;
      const toRoadX = Math.abs(fx - 0.5) < Math.abs(fz - 0.5);
      const yaw = toRoadX ? (fx > 0.5 ? 0 : Math.PI) : (fz > 0.5 ? -Math.PI / 2 : Math.PI / 2);
      this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      this.m.compose(this.p.set(x, 0, z), this.q, this.s.set(1, 1, 1));
      poleMesh.setMatrixAt(i, this.m);
    });
    poleMesh.castShadow = shadows;
    poleMesh.computeBoundingSphere();
    this.group.add(poleMesh);

    // ---- cars: parked + moving traffic ----
    const carGeo = this.carGeometry();
    const carMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.45, envMap, envMapIntensity: 0.8 });
    const palette = [0xb7b9bc, 0x1d1f22, 0xf2f2f0, 0x8c1c1c, 0x1f3f7a, 0x5a5f66, 0x2f5a3a, 0xd9c7a0, 0x7a7d82];
    const parked: THREE.Matrix4[] = [];
    for (const lot of world.parking) {
      for (let row = 0; row < 2; row++) {
        for (let x = lot.x0 + 3; x < lot.x1 - 3; x += 4) {
          if (rnd() < 0.35) continue;
          const z = row === 0 ? lot.z0 + 4 : lot.z1 - 4;
          this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 + (rnd() - 0.5) * 0.08);
          parked.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0.08, z), this.q.clone(), new THREE.Vector3(1, 1, 1)));
        }
      }
    }
    const nTraffic = quality === 'low' ? 40 : quality === 'medium' ? 90 : 160;
    const parkedMesh = new THREE.InstancedMesh(carGeo, carMat, Math.max(1, parked.length));
    const col = new THREE.Color();
    parked.forEach((m, i) => { parkedMesh.setMatrixAt(i, m); parkedMesh.setColorAt(i, col.setHex(palette[i % palette.length])); });
    parkedMesh.castShadow = shadows;
    parkedMesh.computeBoundingSphere();
    this.group.add(parkedMesh);

    this.traffic = new THREE.InstancedMesh(carGeo, carMat, nTraffic);
    for (let i = 0; i < nTraffic; i++) {
      const axis = rnd() < 0.5 ? 'x' : 'z';
      const k = Math.floor(rnd() * (2 * n + 2)) - n - 1;
      const dir = rnd() < 0.5 ? 1 : -1;
      this.cars.push({ road: (k + 0.5) * pitch, axis, pos: (rnd() * 2 - 1) * E, lane: dir * 3.4, dir, speed: 9 + rnd() * 6 });
      this.traffic.setColorAt(i, col.setHex(palette[Math.floor(rnd() * palette.length)]));
    }
    this.traffic.castShadow = shadows;
    this.traffic.frustumCulled = false;
    this.group.add(this.traffic);
    this.update(0);
  }

  private roof(b: Building, roofs: GeoBuilder, props: GeoBuilder, rnd: () => number) {
    const c = new THREE.Color(1, 1, 1);
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2, z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
    roofs.flat(x0, z0, x1, z1, b.h, 8, 8, c);
    if (b.style === 'house') return;
    // parapet
    const p = 0.35, ph = 0.9, pc = new THREE.Color(0.8, 0.8, 0.78);
    props.box(new THREE.Vector3(x0, b.h, z0), new THREE.Vector3(x1, b.h + ph, z0 + p), 1, 1, pc);
    props.box(new THREE.Vector3(x0, b.h, z1 - p), new THREE.Vector3(x1, b.h + ph, z1), 1, 1, pc);
    props.box(new THREE.Vector3(x0, b.h, z0), new THREE.Vector3(x0 + p, b.h + ph, z1), 1, 1, pc);
    props.box(new THREE.Vector3(x1 - p, b.h, z0), new THREE.Vector3(x1, b.h + ph, z1), 1, 1, pc);
    // AC units, vents, stair house, water tank
    const n = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const sx = 1.5 + rnd() * 3, sz = 1.5 + rnd() * 3, sy = 1 + rnd() * 2.2;
      const x = x0 + 2 + rnd() * Math.max(0.1, b.w - 4 - sx), z = z0 + 2 + rnd() * Math.max(0.1, b.d - 4 - sz);
      const g = 0.6 + rnd() * 0.3;
      props.box(new THREE.Vector3(x, b.h, z), new THREE.Vector3(x + sx, b.h + sy, z + sz), 1, 1, new THREE.Color(g, g, g * 0.98));
    }
  }

  private carGeometry() {
    const col = (g: THREE.BufferGeometry, r: number, gg: number, b: number) => {
      const n = g.getAttribute('position').count;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gg; c[i * 3 + 2] = b; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      return g;
    };
    const body = col(new THREE.BoxGeometry(4.3, 0.75, 1.8).translate(0, 0.6, 0), 1, 1, 1);
    const cabin = col(new THREE.BoxGeometry(2.3, 0.62, 1.62).translate(-0.25, 1.28, 0), 0.25, 0.3, 0.36);
    const parts = [body, cabin];
    for (const [x, z] of [[1.35, 0.82], [-1.35, 0.82], [1.35, -0.82], [-1.35, -0.82]]) {
      parts.push(col(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 10).rotateX(Math.PI / 2).translate(x, 0.34, z), 0.08, 0.08, 0.08));
    }
    for (const z of [0.6, -0.6]) {
      parts.push(col(new THREE.BoxGeometry(0.05, 0.14, 0.32).translate(2.16, 0.72, z), 2.5, 2.4, 2.0)); // headlights
      parts.push(col(new THREE.BoxGeometry(0.05, 0.14, 0.32).translate(-2.16, 0.72, z), 1.4, 0.1, 0.1)); // tail lights
    }
    const g = mergeGeometries(parts.map((p) => p.toNonIndexed()))!;
    g.computeVertexNormals();
    return g;
  }

  update(dt: number) {
    if (!this.traffic) return;
    const E = CITY_EXTENT;
    this.cars.forEach((c, i) => {
      c.pos += c.dir * c.speed * dt;
      if (c.pos > E) c.pos = -E;
      if (c.pos < -E) c.pos = E;
      if (c.axis === 'x') {
        this.p.set(c.pos, 0.07, c.road + c.lane);
        this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.dir > 0 ? 0 : Math.PI);
      } else {
        this.p.set(c.road - c.lane, 0.07, c.pos);
        this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.dir > 0 ? -Math.PI / 2 : Math.PI / 2);
      }
      this.m.compose(this.p, this.q, this.s.set(1, 1, 1));
      this.traffic!.setMatrixAt(i, this.m);
    });
    this.traffic.instanceMatrix.needsUpdate = true;
  }
}
