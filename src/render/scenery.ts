import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { World } from '../sim/world';
import { clamp, fbm2, mulberry32, smoothstep } from '../sim/math';
import type { Quality } from '../settings';
import * as T from './textures';
import { Trees, Grass } from './vegetation';
import { CityRenderer, StaticShadow, decal } from './city';

export const SUN_DIR = new THREE.Vector3(0.38, 0.62, 0.69).normalize();
// light-space axes matching the shadow camera's lookAt basis (up = +Y)
const LIGHT_X = new THREE.Vector3(0, 1, 0).cross(SUN_DIR).normalize();
const LIGHT_Y = SUN_DIR.clone().cross(LIGHT_X).normalize();
export const FOG_COLOR = new THREE.Color(0xc5d6e6);

const lin = (hex: number) => new THREE.Color(hex);

export class Scenery {
  scene = new THREE.Scene();
  sun: THREE.DirectionalLight;
  sky: Sky;
  private water?: THREE.Mesh;
  private windsock = new THREE.Group();
  private sockCone!: THREE.Mesh;
  private clouds = new THREE.Group();
  private sunTarget = new THREE.Object3D();
  private snapped = new THREE.Vector3();
  private trees!: Trees;
  city?: CityRenderer;
  envMap!: THREE.Texture;
  private grass!: Grass;

  constructor(renderer: THREE.WebGLRenderer, private world: World, private quality: Quality) {
    const s = this.scene;
    s.fog = new THREE.Fog(FOG_COLOR, 400, quality === 'low' ? 3200 : 5200);
    s.background = FOG_COLOR;

    // ---- sky ----
    this.sky = new Sky();
    this.sky.scale.setScalar(8000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 3.2;
    u.rayleigh.value = 1.1;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    u.sunPosition.value.copy(SUN_DIR).multiplyScalar(1000);
    // light scattered clouds: keep most of the sky blue so the aircraft stays easy to see
    if (u.cloudCoverage) { u.cloudCoverage.value = 0.18; u.cloudDensity.value = 0.3; u.cloudElevation.value = 0.6; }
    s.add(this.sky);

    // environment map from the sky (for shiny aircraft paint & water)
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const sky2 = new Sky();
    sky2.scale.setScalar(1000);
    Object.assign(sky2.material.uniforms.turbidity, { value: 3.2 });
    sky2.material.uniforms.rayleigh.value = 1.1;
    sky2.material.uniforms.mieCoefficient.value = 0.004;
    sky2.material.uniforms.sunPosition.value.copy(SUN_DIR).multiplyScalar(1000);
    if (sky2.material.uniforms.cloudCoverage) sky2.material.uniforms.cloudCoverage.value = 0.18;
    envScene.add(sky2);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(900, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4d5a35 }));
    ground.position.y = -20;
    envScene.add(ground);
    // NOTE: not scene.environment - in three r18x that also tints every Lambert material and kills shadow contrast.
    this.envMap = pmrem.fromScene(envScene, 0.02).texture;
    pmrem.dispose();

    // ---- lights ----
    const hemi = new THREE.HemisphereLight(0xc4dcff, 0x5c5a3c, 1.7);
    s.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 3.0);
    this.sun.position.copy(SUN_DIR).multiplyScalar(200);
    s.add(this.sun, this.sunTarget);
    this.sun.target = this.sunTarget;
    if (quality !== 'low') {
      this.sun.castShadow = true;
      const sz = quality === 'high' ? 2048 : 1024;
      this.sun.shadow.mapSize.set(sz, sz);
      const cam = this.sun.shadow.camera;
      // tight box around the aircraft; bias is in normalised depth, so keep the depth range small
      cam.left = -22; cam.right = 22; cam.top = 22; cam.bottom = -22; cam.near = 80; cam.far = 230;
      cam.updateProjectionMatrix();
      this.sun.shadow.bias = -0.00006;
      this.sun.shadow.normalBias = 0.012;
    }

    const map = world.map;
    this.buildTerrain();
    if (map !== 'city') this.buildWater();
    this.buildTrees();
    if (map === 'city') {
      this.city = new CityRenderer(world, quality, this.envMap);
      s.add(this.city.group);
      if (quality !== 'low') {
        const sh = new StaticShadow(renderer, this.city.casters, SUN_DIR, quality);
        for (const m of this.city.shadowReceivers) sh.apply(m);
      }
    }
    this.buildMown();
    if (map === 'field') { this.buildRunwayProps(); this.buildStructures(); this.buildGates(); }
    if (map === 'forest') { this.buildTrails(); this.buildForestProps(); this.buildFarmhouses(); }
    this.buildPad();
    this.buildClouds();
    this.buildWindsock();
  }

  /* ---------------------------------------------------------------- */
  private buildTerrain() {
    const t = this.world.terrain;
    const n = t.res + 1;
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    const splat = new Float32Array(n * n * 3); // rock, dirt, snow
    const c = new THREE.Color();
    const lush = lin(0xffffff), dryT = lin(0xe8dcb0), forestT = lin(0x9fb08a), wetT = lin(0xc8d0b0);
    const nrm = new THREE.Vector3();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = -t.half + i * t.cell, z = -t.half + j * t.cell;
        const h = t.heights[k];
        pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
        uv[k * 2] = x / 6; uv[k * 2 + 1] = z / 6;
        t.normalAt(x, z, nrm);
        const m1 = fbm2(x * 0.004, z * 0.004, 3, 101) * 0.5 + 0.5;
        const m2 = fbm2(x * 0.0015, z * 0.0015, 2, 103) * 0.5 + 0.5;
        // tint (multiplied with the detail textures)
        c.copy(lush).multiplyScalar(0.92 + m1 * 0.16).lerp(dryT, smoothstep(0.55, 0.85, m2) * 0.7);
        const fo = fbm2(x * 0.0022, z * 0.0022, 4, 77);
        c.lerp(forestT, smoothstep(0.05, 0.4, fo) * 0.5);
        const slope = 1 - nrm.y;
        const WL = this.world.layout.waterLevel;
        const shore = 1 - smoothstep(WL + 0.05, WL + 0.45, h);
        c.lerp(wetT, shore * 0.5);
        const snowW = smoothstep(470, 560, h + fbm2(x * 0.01, z * 0.01, 2, 5) * 40) * (1 - smoothstep(0.35, 0.55, slope));
        if (snowW > 0) c.lerp(lush, snowW);
        col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
        const rockW = clamp(smoothstep(0.1, 0.28, slope) + smoothstep(240, 380, h) * 0.6, 0, 1);
        const forestFloor = this.world.map === 'forest' ? 0.55 : 0.35;
        const dirtW = clamp(Math.max(shore, smoothstep(0.6, 0.85, fbm2(x * 0.02, z * 0.02, 3, 111) * 0.5 + 0.5) * 0.7, smoothstep(0.2, 0.45, fo) * forestFloor), 0, 1);
        splat[k * 3] = rockW; splat[k * 3 + 1] = dirtW; splat[k * 3 + 2] = snowW;
      }
    }
    const idx = new Uint32Array(t.res * t.res * 6);
    let p = 0;
    for (let j = 0; j < t.res; j++) {
      for (let i = 0; i < t.res; i++) {
        const v00 = j * n + i, v10 = v00 + 1, v01 = v00 + n, v11 = v01 + 1;
        idx[p++] = v00; idx[p++] = v01; idx[p++] = v10;
        idx[p++] = v10; idx[p++] = v01; idx[p++] = v11;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('splat', new THREE.BufferAttribute(splat, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const ts = this.quality === 'low' ? 256 : 512;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: T.groundGrass(ts) });
    splatMaterial(mat, T.groundRock(ts), T.groundDirt(ts));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = this.quality !== 'low';
    mesh.matrixAutoUpdate = false;
    this.scene.add(mesh);
  }

  /** Mown grass area with mowing stripes (field, forest strip, city park). */
  private buildMown() {
    const L = this.world.layout;
    const r = L.mown;
    if (!r) return;
    const s = this.scene;
    const fw = r.x1 - r.x0, fd = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
    const y = this.world.map === 'city' ? 0.09 : 0.01;
    if (this.world.map !== 'city') {
      const fieldTex = T.groundGrass(512);
      fieldTex.repeat.set(fw / 5, fd / 5);
      const field = new THREE.Mesh(
        new THREE.PlaneGeometry(fw, fd).rotateX(-Math.PI / 2),
        decal(new THREE.MeshLambertMaterial({ color: 0xc8e0a0, map: fieldTex }), 1),
      );
      field.position.set(cx, y, cz);
      field.receiveShadow = this.quality !== 'low';
      s.add(field);
    }
    const stripes = T.mownStripes();
    stripes.repeat.set(1, fd / 64);
    const st = new THREE.Mesh(
      new THREE.PlaneGeometry(fw, fd).rotateX(-Math.PI / 2),
      decal(new THREE.MeshBasicMaterial({ map: stripes, transparent: true, depthWrite: false }), this.world.map === 'city' ? 4 : 2),
    );
    st.position.set(cx, y + 0.003, cz);
    s.add(st);
  }

  private buildRunwayProps() {
    const s = this.scene;
    const R = this.world.layout.runway;
    const L = R.halfLength * 2, W = R.halfWidth * 2;
    const rw = new THREE.Mesh(
      new THREE.PlaneGeometry(L, W).rotateX(-Math.PI / 2),
      decal(new THREE.MeshLambertMaterial({ map: T.runwayTexture(L, W) }), 3),
    );
    rw.position.set(R.cx, 0.02, R.cz);
    rw.receiveShadow = this.quality !== 'low';
    s.add(rw);
    const coneGeo = new THREE.ConeGeometry(0.18, 0.45, 10).translate(0, 0.225, 0);
    const cones = new THREE.InstancedMesh(coneGeo, new THREE.MeshLambertMaterial({ color: 0xff6a00 }), 12);
    const m = new THREE.Matrix4();
    let ci = 0;
    for (const x of [-R.halfLength, -R.halfLength / 2, 0, R.halfLength / 2, R.halfLength, -R.halfLength - 15]) {
      for (const z of [-R.halfWidth - 0.8, R.halfWidth + 0.8]) { m.makeTranslation(R.cx + x, 0, R.cz + z); cones.setMatrixAt(ci++, m); }
    }
    cones.castShadow = true;
    s.add(cones);
    const rail = new THREE.MeshLambertMaterial({ color: 0xf0f0f0 });
    const fenceGeo: THREE.BufferGeometry[] = [];
    const fz = this.world.layout.pilot.z - 9;
    // fence with an opening in front of the pilot station (clear view to the pad)
    for (let x = -40; x <= 40; x += 4) if (Math.abs(x) >= 6) fenceGeo.push(new THREE.BoxGeometry(0.07, 0.8, 0.07).translate(x, 0.4, fz));
    for (const sx of [-1, 1]) {
      fenceGeo.push(new THREE.BoxGeometry(34, 0.06, 0.05).translate(sx * 23, 0.78, fz));
      fenceGeo.push(new THREE.BoxGeometry(34, 0.05, 0.04).translate(sx * 23, 0.4, fz));
    }
    const fence = new THREE.Mesh(mergeGeometries(fenceGeo), rail);
    fence.castShadow = this.quality === 'high';
    s.add(fence);
  }

  private buildPad() {
    const P = this.world.layout.pad;
    const y = this.world.terrain.heightAt(P.x, P.z) + this.world.terrain.pad.h;
    const padTex = T.labelTexture('H', '#f4f4f4', '#2b2f36');
    const pad = new THREE.Mesh(new THREE.CircleGeometry(1.6, 32).rotateX(-Math.PI / 2), decal(new THREE.MeshLambertMaterial({ map: padTex }), 6));
    pad.position.set(P.x, y, P.z);
    pad.receiveShadow = this.quality !== 'low';
    this.scene.add(pad);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 1.75, 40).rotateX(-Math.PI / 2), decal(new THREE.MeshLambertMaterial({ color: 0xffc400 }), 6));
    ring.position.copy(pad.position);
    this.scene.add(ring);
  }

  /** Dirt trails draped on the terrain. */
  private buildTrails() {
    const t = this.world.terrain;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (const trail of this.world.trails) {
      const pts: { x: number; z: number }[] = [];
      for (let i = 0; i < trail.length - 1; i++) {
        const a = trail[i], b = trail[i + 1];
        for (let k = 0; k < 4; k++) pts.push({ x: a.x + (b.x - a.x) * (k / 4), z: a.z + (b.z - a.z) * (k / 4) });
      }
      let dist = 0;
      const base = pos.length / 3;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
        let dx = q.x - o.x, dz = q.z - o.z;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l; dz /= l;
        const w = 1.4 + 0.3 * Math.sin(i * 0.7);
        for (const sd of [-1, 1]) {
          const x = p.x - dz * w * sd, z = p.z + dx * w * sd;
          pos.push(x, t.heightAt(x, z) + 0.06, z);
          uv.push(sd < 0 ? 0 : 1, dist / 4);
        }
        if (i > 0) dist += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
        if (i < pts.length - 1) { const v = base + i * 2; idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const dirt = T.groundDirt(256);
    const mat = decal(new THREE.MeshLambertMaterial({ map: dirt, color: 0xb8a890 }), 2);
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = this.quality !== 'low';
    this.scene.add(mesh);
  }

  /** Boulders, fallen logs and the wooden hunting tower. */
  private buildForestProps() {
    const shadow = this.quality !== 'low';
    const rocks = this.world.solids.filter((s) => s.kind === 'rock');
    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    const rp = rockGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < rp.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(rp, i);
      const n = 0.8 + 0.35 * Math.sin(v.x * 5.1 + v.z * 3.3) * Math.cos(v.y * 4.2);
      rp.setXYZ(i, v.x * n, v.y * n * 0.75, v.z * n);
    }
    rockGeo.computeVertexNormals();
    const rockTex = T.groundRock(256);
    const rockMesh = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ map: rockTex, color: 0xb8b4aa }), Math.max(1, rocks.length));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const rnd = mulberry32(5);
    rocks.forEach((r, i) => {
      p.set((r.min.x + r.max.x) / 2, r.min.y + 0.4, (r.min.z + r.max.z) / 2);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
      sc.set((r.max.x - r.min.x) / 2, (r.max.y - r.min.y) / 1.6, (r.max.z - r.min.z) / 2);
      m.compose(p, q, sc);
      rockMesh.setMatrixAt(i, m);
    });
    rockMesh.castShadow = shadow;
    rockMesh.receiveShadow = shadow;
    rockMesh.computeBoundingSphere();
    this.scene.add(rockMesh);
    const logs = this.world.solids.filter((s) => s.kind === 'log');
    const logGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1).rotateZ(Math.PI / 2);
    const bark = T.barkTexture();
    bark.repeat.set(3, 1);
    const logMesh = new THREE.InstancedMesh(logGeo, new THREE.MeshLambertMaterial({ map: bark }), Math.max(1, logs.length));
    logs.forEach((l, i) => {
      const lx = l.max.x - l.min.x, lz = l.max.z - l.min.z;
      const alongX = lx > lz;
      const rr = (alongX ? lz : lx) / 2;
      p.set((l.min.x + l.max.x) / 2, l.min.y + 0.1 + rr, (l.min.z + l.max.z) / 2);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), alongX ? 0 : Math.PI / 2);
      m.compose(p, q, sc.set(alongX ? lx : lz, rr, rr));
      logMesh.setMatrixAt(i, m);
    });
    logMesh.castShadow = shadow;
    logMesh.computeBoundingSphere();
    this.scene.add(logMesh);
    // wooden structures (box solids)
    const woodGeos: THREE.BufferGeometry[] = [];
    for (const w of this.world.solids.filter((s) => s.kind === 'wood')) {
      const g = new THREE.BoxGeometry(w.max.x - w.min.x, w.max.y - w.min.y, w.max.z - w.min.z);
      g.translate((w.min.x + w.max.x) / 2, (w.min.y + w.max.y) / 2, (w.min.z + w.max.z) / 2);
      woodGeos.push(g);
    }
    if (woodGeos.length) {
      const wood = new THREE.Mesh(mergeGeometries(woodGeos), new THREE.MeshLambertMaterial({ color: 0x8a6a48, map: T.barkTexture() }));
      wood.castShadow = shadow;
      this.scene.add(wood);
    }
  }

  private buildWater() {
    const tex = T.waterNormal();
    tex.repeat.set(30, 30);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1a3a40, roughness: 0.16, metalness: 0.0, normalMap: tex, normalScale: new THREE.Vector2(0.35, 0.35),
      transparent: true, opacity: 0.95, envMapIntensity: 0.32, envMap: this.envMap,
    });
    tex.repeat.set(400, 400);
    const w = new THREE.Mesh(new THREE.PlaneGeometry(5800, 5800).rotateX(-Math.PI / 2), mat);
    w.position.set(0, this.world.layout.waterLevel, 0);
    this.water = w;
    this.scene.add(w);
  }

  private buildTrees() {
    this.trees = new Trees(this.world, this.quality);
    this.scene.add(this.trees.group);
    this.grass = new Grass(this.world, this.quality);
    if (this.grass.mesh) this.scene.add(this.grass.mesh);
    // soft ambient-occlusion blobs under trees
    const trees = this.world.trees;
    const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const blobMat = decal(new THREE.MeshBasicMaterial({ map: T.radialBlob('rgba(10,25,5,0.45)'), transparent: true, depthWrite: false }), 4);
    const blobs = new THREE.InstancedMesh(blobGeo, blobMat, trees.length);
    const m = new THREE.Matrix4(), qn = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    trees.forEach((t, i) => {
      p.set(t.x - SUN_DIR.x * t.h * 0.3, t.y + (this.world.map === 'city' ? 0.11 : 0.06), t.z - SUN_DIR.z * t.h * 0.3);
      sc.set(t.r * 2.8, 1, t.r * 2.8);
      m.compose(p, qn, sc);
      blobs.setMatrixAt(i, m);
    });
    blobs.computeBoundingSphere();
    this.scene.add(blobs);
  }

  private buildStructures() {
    const s = this.scene;
    const shadow = this.quality !== 'low';
    const add = (mesh: THREE.Object3D) => {
      mesh.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = shadow; o.receiveShadow = shadow; } });
      s.add(mesh);
      return mesh;
    };
    const lam = (color: number, map?: THREE.Texture) => (map ? new THREE.MeshLambertMaterial({ color, map }) : new THREE.MeshLambertMaterial({ color }));

    // hangar with gable roof
    const hangar = new THREE.Group();
    const corr = T.stripeTexture('#d9dde2', '#bfc5cc', 64);
    corr.repeat.set(1, 1);
    const walls = new THREE.Mesh(new THREE.BoxGeometry(14, 4.2, 9), lam(0xffffff, corr));
    walls.position.y = 2.1;
    const roofShape = new THREE.Shape();
    roofShape.moveTo(-7.4, 0); roofShape.lineTo(0, 2.2); roofShape.lineTo(7.4, 0); roofShape.lineTo(-7.4, 0);
    const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(roofShape, { depth: 9.6, bevelEnabled: false }), lam(0x8e2f25));
    roof.position.set(0, 4.2, -4.8);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(8, 3.6), lam(0x5d6670));
    door.position.set(0, 1.8, -4.51);
    door.rotation.y = Math.PI;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(5, 1.2), new THREE.MeshLambertMaterial({ map: T.labelTexture('LIFTLAB RC', '#1d2b44', '#ffffff') }));
    sign.position.set(0, 3.7, -4.52);
    sign.rotation.y = Math.PI;
    hangar.add(walls, roof, door, sign);
    hangar.position.set(-70, 0, 52);
    add(hangar);

    // container
    const ctex = T.stripeTexture('#2f6e8c', '#285f79', 40);
    ctex.rotation = Math.PI / 2;
    const container = new THREE.Mesh(new THREE.BoxGeometry(6, 2.6, 2.5), lam(0xffffff, ctex));
    container.position.set(-48, 1.3, 50);
    add(container);

    // pilot shelter
    const shelter = new THREE.Group();
    const wood = lam(0x8a6a48);
    for (const [x, z] of [[-2.8, -1.8], [2.8, -1.8], [-2.8, 1.8], [2.8, 1.8]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.8, 0.15), wood);
      post.position.set(x, 1.4, z);
      shelter.add(post);
    }
    const sroof = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.15, 4.4), lam(0x3b4a3a));
    sroof.position.y = 2.9;
    sroof.rotation.x = 0.08;
    const table = new THREE.Mesh(new THREE.BoxGeometry(4, 0.08, 1.2), wood);
    table.position.set(0, 0.8, 0);
    shelter.add(sroof, table);
    shelter.position.set(28, 0, 48);
    add(shelter);

    // cars in the parking lot
    const carColors = [0xb22222, 0x1f4e9a, 0xe8e8e8, 0x303030, 0x6b8e23];
    carColors.forEach((cc, i) => {
      const car = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.8, 1.8), new THREE.MeshStandardMaterial({ color: cc, roughness: 0.35, metalness: 0.5, envMap: this.envMap }));
      body.position.y = 0.65;
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.65, 1.6), new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.1, metalness: 0.6, envMap: this.envMap }));
      cab.position.set(-0.2, 1.35, 0);
      car.add(body, cab);
      car.position.set(-30 + i * 3.2, 0, 62);
      car.rotation.y = Math.PI / 2;
      add(car);
    });

    this.buildFarmhouses();
  }

  private buildFarmhouses() {
    const s = this.scene;
    const shadow = this.quality !== 'low';
    const lam = (color: number) => new THREE.MeshLambertMaterial({ color });
    const add = (mesh: THREE.Object3D) => { mesh.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = shadow; o.receiveShadow = shadow; } }); s.add(mesh); };
    const rnd = mulberry32(77);
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2, d = 420 + rnd() * 900;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const y = this.world.terrain.heightAt(x, z);
      if (y < this.world.layout.waterLevel + 1 || y > 120 || this.world.collide(new THREE.Vector3(x, y + 3, z), 6, { kind: 'tree', normal: new THREE.Vector3(), depth: 0, soft: false })) continue;
      const house = new THREE.Group();
      const w = 7 + rnd() * 5, dd = 6 + rnd() * 3, hh = 3 + rnd() * 2;
      const base = new THREE.Mesh(new THREE.BoxGeometry(w, hh, dd), lam([0xf2e8d5, 0xe0d2bc, 0xc9b08a, 0xffffff][i % 4]));
      base.position.y = hh / 2;
      const rs = new THREE.Shape();
      rs.moveTo(-w / 2 - 0.3, 0); rs.lineTo(0, 2.4); rs.lineTo(w / 2 + 0.3, 0); rs.lineTo(-w / 2 - 0.3, 0);
      const r = new THREE.Mesh(new THREE.ExtrudeGeometry(rs, { depth: dd + 0.6, bevelEnabled: false }), lam([0x7b2d26, 0x4a4a4a, 0x8c4a2f][i % 3]));
      r.position.set(0, hh, -dd / 2 - 0.3);
      house.add(base, r);
      house.position.set(x, y - 0.2, z);
      house.rotation.y = rnd() * Math.PI;
      add(house);
    }
    }

  private buildGates() {
    const tex = T.stripeTexture('#ff6a00', '#1a1a1a', 10);
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const barTex = tex.clone();
    barTex.rotation = Math.PI / 2;
    barTex.center.set(0.5, 0.5);
    const barMat = new THREE.MeshLambertMaterial({ map: barTex });
    for (const g of this.world.gates) {
      const grp = new THREE.Group();
      const post = new THREE.CylinderGeometry(0.1, 0.1, g.h + 0.1, 8);
      for (const sx of [-1, 1]) {
        const p = new THREE.Mesh(post, mat);
        p.position.set((sx * g.w) / 2, (g.h + 0.1) / 2, 0);
        grp.add(p);
      }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, g.w + 0.2, 8).rotateZ(Math.PI / 2), barMat);
      bar.position.y = g.h;
      grp.add(bar);
      grp.position.set(g.x, this.world.terrain.heightAt(g.x, g.z), g.z);
      grp.rotation.y = g.yaw;
      grp.traverse((o) => { o.castShadow = this.quality !== 'low'; });
      this.scene.add(grp);
    }
  }

  private buildClouds() {
    const n = this.quality === 'low' ? 10 : this.quality === 'medium' ? 20 : 32;
    const texs = [1, 2, 3, 4].map((s) => T.cloudTexture(s));
    const rnd = mulberry32(3);
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteMaterial({ map: texs[i % 4], transparent: true, depthWrite: false, fog: false, opacity: 0.55 });
      const sp = new THREE.Sprite(mat);
      // clouds sit low on the horizon: the sky where you watch the aircraft stays clear blue (contrast!)
      const a = rnd() * Math.PI * 2, d = 4300 + rnd() * 1400;
      sp.position.set(Math.cos(a) * d, 560 + rnd() * 380, Math.sin(a) * d);
      const w = 700 + rnd() * 900;
      sp.scale.set(w, w * 0.42, 1);
      this.clouds.add(sp);
    }
    this.scene.add(this.clouds);
  }

  private buildWindsock() {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 6, 8), new THREE.MeshLambertMaterial({ color: 0xdddddd }));
    pole.position.y = 3;
    this.windsock.add(pole);
    const pivot = new THREE.Group();
    pivot.position.y = 5.9;
    // cone along +X from pivot
    const coneGeo = new THREE.CylinderGeometry(0.3, 0.12, 2.2, 14, 1, true).rotateZ(-Math.PI / 2).translate(1.1, 0, 0);
    this.sockCone = new THREE.Mesh(coneGeo, new THREE.MeshLambertMaterial({ map: T.windsockTexture(), side: THREE.DoubleSide }));
    pivot.add(this.sockCone);
    this.windsock.add(pivot);
    this.windsock.position.copy(this.world.layout.windsock);
    this.windsock.position.y = this.world.terrain.heightAt(this.windsock.position.x, this.windsock.position.z) + (this.world.map === 'city' ? 0.1 : 0);
    this.windsock.traverse((o) => { o.castShadow = this.quality !== 'low'; });
    this.scene.add(this.windsock);
  }

  /* ---------------------------------------------------------------- */
  update(dt: number, cameraPos: THREE.Vector3, focus: THREE.Vector3, time: number) {
    this.sky.position.copy(cameraPos);
    this.trees.update(time);
    this.city?.update(dt);
    this.grass.update(time, cameraPos, this.world.terrain.heightAt(cameraPos.x, cameraPos.z));
    const su = this.sky.material.uniforms;
    if (su.time) su.time.value = time;
    // shadow box follows the aircraft, snapped to whole shadow-map texels in light
    // space so shadow edges stay put instead of shimmering as the aircraft moves
    const sc = this.sun.shadow.camera;
    const texel = (sc.right - sc.left) / this.sun.shadow.mapSize.x;
    const a = Math.round(focus.dot(LIGHT_X) / texel) * texel;
    const b = Math.round(focus.dot(LIGHT_Y) / texel) * texel;
    const snapped = this.snapped.copy(LIGHT_X).multiplyScalar(a).addScaledVector(LIGHT_Y, b).addScaledVector(SUN_DIR, focus.dot(SUN_DIR));
    this.sunTarget.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(SUN_DIR, 150);
    if (this.water) {
      const m = this.water.material as THREE.MeshStandardMaterial;
      if (m.normalMap) m.normalMap.offset.set(time * 0.004, time * 0.0025);
    }
    // windsock
    const w = this.world.wind.mean;
    const spd = Math.hypot(w.x, w.z);
    const pivot = this.sockCone.parent!;
    const yaw = Math.atan2(-w.z, w.x);
    const droop = (1 - clamp(spd / 7, 0, 1)) * 1.25;
    const flutter = Math.sin(time * 7.3) * 0.04 * clamp(spd / 3, 0, 1);
    pivot.rotation.set(0, yaw + flutter, -droop);
    void dt;
  }
}

/** Terrain shader: blends grass / dirt / rock / snow by per-vertex weights, with anti-tiling. */
function splatMaterial(mat: THREE.MeshLambertMaterial, rock: THREE.Texture, dirt: THREE.Texture) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.rockMap = { value: rock };
    sh.uniforms.dirtMap = { value: dirt };
    sh.vertexShader = 'attribute vec3 splat;\nvarying vec3 vSplat;\n' + sh.vertexShader.replace(
      '#include <uv_vertex>', '#include <uv_vertex>\n vSplat = splat;');
    sh.fragmentShader = 'uniform sampler2D rockMap;\nuniform sampler2D dirtMap;\nvarying vec3 vSplat;\n' + sh.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec2 uvA = vMapUv;
        vec2 uvB = mat2(0.8, -0.6, 0.6, 0.8) * vMapUv * 0.31 + vec2(0.31, 0.17);
        vec3 gA = texture2D(map, uvA).rgb, gB = texture2D(map, uvB).rgb;
        vec3 grass = mix(gA, gB, 0.45);
        vec3 rock = mix(texture2D(rockMap, uvA * 0.6).rgb, texture2D(rockMap, uvB * 0.5).rgb, 0.5);
        vec3 dirt = mix(texture2D(dirtMap, uvA).rgb, texture2D(dirtMap, uvB * 1.4).rgb, 0.45);
        float macro = texture2D(map, vMapUv * 0.021).g * 2.6;
        vec3 col = grass * (0.78 + 0.44 * macro);
        // dirt shows up in patches (noise-modulated edge)
        float dEdge = smoothstep(0.35, 0.65, vSplat.y + (gB.g - 0.35) * 0.8);
        col = mix(col, dirt, dEdge);
        col = mix(col, rock, smoothstep(0.3, 0.7, vSplat.x + (rock.r - 0.45) * 0.6));
        col = mix(col, vec3(0.9, 0.92, 0.96) * (0.9 + rock.r * 0.2), smoothstep(0.3, 0.7, vSplat.z));
        diffuseColor.rgb *= col * 1.05;
      #endif`,
    );
  };
}
