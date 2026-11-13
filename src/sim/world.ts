import { Vector3 } from 'three';
import { clamp, fbm2, lerp, mulberry32, noise1, smoothstep, DEG } from './math';

/* ------------------------------------------------------------------ */
/*  Common types                                                       */
/* ------------------------------------------------------------------ */
export const TERRAIN_SIZE = 6000;
export const TERRAIN_RES = 256; // cells per side

export type MapId = 'field' | 'forest' | 'city';
export const MAP_LIST: { id: MapId; label: string; desc: string }[] = [
  { id: 'field', label: 'Airfield', desc: 'RC club field: asphalt runway, mown grass, race gates, a lake. Best for learning.' },
  { id: 'forest', label: 'Forest', desc: 'Hilly forest with a grass strip in a clearing, tall pines, trails, a river ravine, rocks and fallen logs.' },
  { id: 'city', label: 'City', desc: 'Downtown towers, streets with traffic, parks and abandoned concrete buildings to fly through.' },
];

export type Surface = 'asphalt' | 'grass' | 'water' | 'concrete';

export interface TreeData { x: number; y: number; z: number; h: number; r: number; type: number; }
export interface BoxCollider { min: Vector3; max: Vector3; kind: Hit['kind']; }
export interface GateData { x: number; z: number; yaw: number; w: number; h: number; }
export interface Hit { kind: 'tree' | 'building' | 'gate' | 'rock' | 'pole'; normal: Vector3; depth: number; soft: boolean; }
export type BuildingStyle = 'glass' | 'office' | 'brick' | 'concrete' | 'house';
export interface Building { x: number; z: number; w: number; d: number; h: number; style: BuildingStyle; y: number; }
export interface Solid { min: Vector3; max: Vector3; kind: 'concrete' | 'log' | 'rock' | 'pole' | 'wood'; }
export interface Road { x0: number; z0: number; x1: number; z1: number; w: number; }
export interface Rect { x0: number; z0: number; x1: number; z1: number; }

export interface Layout {
  id: MapId;
  pilot: Vector3;                 // eye position of the pilot (LOS camera)
  pad: Vector3;                   // quad takeoff pad
  runway: { cx: number; cz: number; halfLength: number; halfWidth: number; surface: 'asphalt' | 'grass' };
  mown: Rect | null;              // mown grass area (short grass, no tall grass)
  noGrass: Rect | null;           // no tall grass inside (city)
  waterLevel: number;
  airSpawn: Vector3;
  windsock: Vector3;
}

const map3 = (m: MapId, field: number, forest: number, city: number) => (m === 'field' ? field : m === 'forest' ? forest : city);
const inRect = (r: Rect | null, x: number, z: number, m = 0) => !!r && x > r.x0 - m && x < r.x1 + m && z > r.z0 - m && z < r.z1 + m;
const rectDist = (r: Rect, x: number, z: number) => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));

function mountains(x: number, z: number, start: number) {
  const d = Math.hypot(x, z);
  return smoothstep(start, 2900, d) * (fbm2(x * 0.0011 + 5, z * 0.0011, 6, 21) * 0.55 + 0.6) * 420;
}

/* ------------------------------------------------------------------ */
/*  Map definitions                                                    */
/* ------------------------------------------------------------------ */
const FIELD_RECT: Rect = { x0: -200, z0: -110, x1: 200, z1: 110 };
const FIELD_LAKE = { x: -260, z: -560, r: 210 };

function fieldHeight(x: number, z: number) {
  let h = fbm2(x * 0.0016 + 11.3, z * 0.0016 - 4.1, 5, 7) * 32 + fbm2(x * 0.007, z * 0.007, 3, 3) * 3.5;
  h += mountains(x, z, 1100);
  h = lerp(0, h, smoothstep(0, 220, rectDist(FIELD_RECT, x, z)));
  const ld = Math.hypot(x - FIELD_LAKE.x, z - FIELD_LAKE.z) + fbm2(x * 0.01, z * 0.01, 2, 9) * 40;
  h = lerp(h, -7, 1 - smoothstep(FIELD_LAKE.r * 0.45, FIELD_LAKE.r * 1.15, ld));
  return h;
}

const FOREST_CLEARING: Rect = { x0: -185, z0: -48, x1: 185, z1: 48 };
export const riverZ = (x: number) => -270 + 95 * Math.sin(x * 0.0035) + 35 * Math.sin(x * 0.011 + 1);

function forestHeight(x: number, z: number) {
  let h = fbm2(x * 0.0021 + 3, z * 0.0021 - 7, 5, 13) * 58 + fbm2(x * 0.009, z * 0.009, 3, 17) * 5 + 8;
  h += mountains(x, z, 1500);
  h = lerp(0, h, smoothstep(0, 170, rectDist(FOREST_CLEARING, x, z)));
  // river ravine
  const dr = Math.abs(z - riverZ(x));
  const bank = smoothstep(7, 55, dr);
  h = -4.5 + (h + 4.5) * Math.pow(bank, 1.25);
  return h;
}

// city grid
export const CITY = { pitch: 84, block: 70, road: 14, n: 8 };
export const CITY_EXTENT = (CITY.n + 0.5) * CITY.pitch; // 714 m
const CITY_PARK: Rect = { x0: -123, z0: -37, x1: 123, z1: 37 };

function cityHeight(x: number, z: number) {
  const out = Math.max(Math.abs(x), Math.abs(z));
  let h = (fbm2(x * 0.0018, z * 0.0018, 5, 29) * 35 + 12) * smoothstep(CITY_EXTENT + 30, CITY_EXTENT + 450, out);
  h += mountains(x, z, 1600);
  return h;
}

const LAYOUTS: Record<MapId, Layout> = {
  field: {
    id: 'field', pilot: new Vector3(0, 1.7, 26), pad: new Vector3(0, 0, 14),
    runway: { cx: 0, cz: 0, halfLength: 60, halfWidth: 5, surface: 'asphalt' },
    mown: { x0: -180, z0: -95, x1: 180, z1: 95 }, noGrass: null, waterLevel: -2.2,
    airSpawn: new Vector3(-160, 45, 0), windsock: new Vector3(-18, 0, 40),
  },
  forest: {
    id: 'forest', pilot: new Vector3(0, 1.7, 24), pad: new Vector3(14, 0, 15),
    runway: { cx: 0, cz: 0, halfLength: 85, halfWidth: 9, surface: 'grass' },
    mown: { x0: -110, z0: -12, x1: 110, z1: 32 }, noGrass: null, waterLevel: -1.8,
    airSpawn: new Vector3(-160, 70, 0), windsock: new Vector3(-30, 0, 30),
  },
  city: {
    id: 'city', pilot: new Vector3(0, 1.7, 26), pad: new Vector3(16, 0, 16),
    runway: { cx: 0, cz: 0, halfLength: 95, halfWidth: 8, surface: 'grass' },
    mown: { x0: -118, z0: -32, x1: 118, z1: 32 }, noGrass: { x0: -CITY_EXTENT - 20, z0: -CITY_EXTENT - 20, x1: CITY_EXTENT + 20, z1: CITY_EXTENT + 20 },
    waterLevel: -50, airSpawn: new Vector3(-200, 95, 0), windsock: new Vector3(-40, 0, 30),
  },
};

const HEIGHTS: Record<MapId, (x: number, z: number) => number> = { field: fieldHeight, forest: forestHeight, city: cityHeight };

/* ------------------------------------------------------------------ */
/*  Heightfield                                                        */
/* ------------------------------------------------------------------ */
export class Terrain {
  readonly res = TERRAIN_RES;
  readonly size = TERRAIN_SIZE;
  readonly cell = TERRAIN_SIZE / TERRAIN_RES;
  readonly half = TERRAIN_SIZE / 2;
  readonly heights: Float32Array;
  asphalt: Rect[] = [];
  concrete: Rect[] = [];
  grassRects: Rect[] = []; // grass inside concrete areas (parks)
  /** Thin visual ground layers drawn above the terrain (runway, lawn, roads, pad). Physics rests on them. */
  layers: { r: Rect; h: number }[] = [];
  pad = { x: 0, z: 0, r: 1.75, h: 0.025 };

  constructor(readonly layout: Layout, fn: (x: number, z: number) => number) {
    const n = this.res + 1;
    this.heights = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        this.heights[j * n + i] = fn(-this.half + i * this.cell, -this.half + j * this.cell);
      }
    }
  }

  private h(i: number, j: number) {
    const n = this.res + 1;
    i = clamp(i, 0, this.res);
    j = clamp(j, 0, this.res);
    return this.heights[j * n + i];
  }

  /** Height exactly matching the rendered triangle mesh. */
  heightAt(x: number, z: number) {
    const gx = (x + this.half) / this.cell;
    const gz = (z + this.half) / this.cell;
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    if (fx + fz <= 1) {
      const h00 = this.h(i, j), h10 = this.h(i + 1, j), h01 = this.h(i, j + 1);
      return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    }
    const h11 = this.h(i + 1, j + 1), h10 = this.h(i + 1, j), h01 = this.h(i, j + 1);
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  normalAt(x: number, z: number, out: Vector3) {
    const e = 0.5;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  surfaceAt(x: number, z: number): Surface {
    const r = this.layout.runway;
    if (Math.abs(x - r.cx) < r.halfLength && Math.abs(z - r.cz) < r.halfWidth) return r.surface;
    for (const g of this.grassRects) if (inRect(g, x, z)) return 'grass';
    for (const a of this.asphalt) if (inRect(a, x, z)) return 'asphalt';
    for (const c of this.concrete) if (inRect(c, x, z)) return 'concrete';
    if (this.heightAt(x, z) < this.layout.waterLevel) return 'water';
    return 'grass';
  }

  /** Height of the visible ground surface (terrain + decal layers like the pad, runway, roads, lawn). */
  groundAt(x: number, z: number) {
    const h = this.heightAt(x, z);
    const p = this.pad;
    if ((x - p.x) * (x - p.x) + (z - p.z) * (z - p.z) < p.r * p.r) return h + p.h;
    let top = 0;
    for (const l of this.layers) if (l.h > top && inRect(l.r, x, z)) top = l.h;
    return h + top;
  }

  /** Ground or water surface height (used for AGL readouts). */
  surfaceHeight(x: number, z: number) {
    return Math.max(this.groundAt(x, z), this.layout.waterLevel);
  }
}

/* ------------------------------------------------------------------ */
/*  Wind / atmosphere                                                  */
/* ------------------------------------------------------------------ */
export interface WindSettings {
  speed: number;      // m/s at 10 m height
  fromDeg: number;    // direction the wind comes FROM (0 = north/-Z, 90 = east/+X)
  gusts: number;      // 0..1
  turbulence: number; // 0..1
}

export class Wind {
  settings: WindSettings = { speed: 2, fromDeg: 90, gusts: 0.3, turbulence: 0.3 };
  private base = new Vector3();
  private gustScalar = 1;
  private gustDir = 0;
  /** extra mechanical turbulence (city canyons, forest canopy) */
  roughness = 1;

  update(t: number) {
    const s = this.settings;
    this.gustScalar = 1 + s.gusts * (0.55 * noise1(t * 0.18, 1) + 0.3 * noise1(t * 0.7, 2));
    this.gustDir = s.gusts * 18 * DEG * noise1(t * 0.05, 3);
    const dir = s.fromDeg * DEG + Math.PI + this.gustDir; // blowing TO
    this.base.set(Math.sin(dir), 0, -Math.cos(dir)).multiplyScalar(s.speed * Math.max(0, this.gustScalar));
  }

  /** Wind velocity (air motion) at a world position. */
  sample(p: Vector3, t: number, groundH: number, out: Vector3) {
    const h = Math.max(0.15, p.y - groundH);
    const z0 = 0.05 * this.roughness * this.roughness;
    const prof = clamp(Math.log(h / z0) / Math.log(10 / z0), 0, 1.35);
    out.copy(this.base).multiplyScalar(prof);
    const tb = this.settings.turbulence * this.roughness;
    if (tb > 0) {
      const amp = tb * (0.6 + 0.35 * this.settings.speed) * (0.4 + 0.6 * Math.min(1, h / 15));
      const sx = p.x * 0.06, sy = p.y * 0.06, sz = p.z * 0.06, tt = t * 0.9;
      out.x += amp * (fbm2(sx + tt, sz - sy, 3, 31) * 1.4);
      out.y += amp * 0.7 * (fbm2(sz + tt * 1.1, sx + sy, 3, 37) * 1.4);
      out.z += amp * (fbm2(sy - tt, sx + sz, 3, 41) * 1.4);
      const fx = p.x * 0.45, fz = p.z * 0.45, fy = p.y * 0.45, ft = t * 2.2;
      out.y += amp * 0.45 * fbm2(fx + ft, fz + fy, 2, 53);
      out.x += amp * 0.25 * fbm2(fz - ft, fy + fx, 2, 59);
    }
    return out;
  }

  get mean() { return this.base; }
}

/* ------------------------------------------------------------------ */
/*  World                                                              */
/* ------------------------------------------------------------------ */
export class World {
  terrain: Terrain;
  layout: Layout;
  wind = new Wind();
  trees: TreeData[] = [];
  boxes: BoxCollider[] = [];
  gates: GateData[] = [];
  buildings: Building[] = [];
  solids: Solid[] = [];
  roads: Road[] = [];
  bushes: { x: number; z: number; s: number }[] = [];
  trails: { x: number; z: number }[][] = [];
  parks: Rect[] = [];
  parking: Rect[] = [];
  time = 0;

  private grid = new Map<number, number[]>();
  private gridCell = 40;
  private boxGrid = new Map<number, number[]>();
  private boxCell = 32;

  /** @param treeLimit keep only the N trees nearest the start (matches what is rendered) */
  constructor(readonly map: MapId = 'field', treeLimit = 9500) {
    this.layout = LAYOUTS[map];
    this.terrain = new Terrain(this.layout, HEIGHTS[map]);
    if (map === 'field') this.buildField();
    else if (map === 'forest') this.buildForest();
    else this.buildCity();
    if (this.trees.length > treeLimit) {
      const keep = [...this.trees].sort((a, b) => a.x * a.x + a.z * a.z - (b.x * b.x + b.z * b.z)).slice(0, treeLimit);
      this.trees = [];
      this.grid.clear();
      for (const tr of keep) this.addTree(tr);
    }
    this.wind.roughness = map === 'city' ? 1.7 : map === 'forest' ? 1.35 : 1;
    this.setupLayers();
  }

  /** Must match the heights used by the renderer for its ground decals. */
  private setupLayers() {
    const t = this.terrain, L = this.layout, r = L.runway;
    t.pad = { x: L.pad.x, z: L.pad.z, r: 1.75, h: map3(this.map, 0.025, 0.025, 0.1) };
    if (L.mown) t.layers.push({ r: L.mown, h: this.map === 'city' ? 0.093 : 0.01 });
    if (this.map === 'field') t.layers.push({ r: { x0: r.cx - r.halfLength, z0: r.cz - r.halfWidth, x1: r.cx + r.halfLength, z1: r.cz + r.halfWidth }, h: 0.02 });
    if (this.map === 'city') {
      t.layers.push({ r: { x0: -CITY_EXTENT, z0: -CITY_EXTENT, x1: CITY_EXTENT, z1: CITY_EXTENT }, h: 0.03 });
      for (const rd of this.roads) t.layers.push({ r: rd, h: 0.07 });
      for (const p of this.parks) t.layers.push({ r: p, h: 0.08 });
      for (const p of this.parking) t.layers.push({ r: p, h: 0.08 });
    }
  }

  private key(ix: number, iz: number) { return ix * 100003 + iz; }

  private addTree(tr: TreeData) {
    const idx = this.trees.length;
    this.trees.push(tr);
    const k = this.key(Math.floor(tr.x / this.gridCell), Math.floor(tr.z / this.gridCell));
    let arr = this.grid.get(k);
    if (!arr) this.grid.set(k, (arr = []));
    arr.push(idx);
  }

  private addBox(min: Vector3, max: Vector3, kind: Hit['kind']) {
    const idx = this.boxes.length;
    this.boxes.push({ min, max, kind });
    const c = this.boxCell;
    for (let ix = Math.floor(min.x / c); ix <= Math.floor(max.x / c); ix++) {
      for (let iz = Math.floor(min.z / c); iz <= Math.floor(max.z / c); iz++) {
        const k = this.key(ix, iz);
        let arr = this.boxGrid.get(k);
        if (!arr) this.boxGrid.set(k, (arr = []));
        arr.push(idx);
      }
    }
  }

  private addSolid(min: Vector3, max: Vector3, kind: Solid['kind']) {
    this.solids.push({ min, max, kind });
    this.addBox(min, max, kind === 'rock' || kind === 'log' ? 'rock' : kind === 'pole' ? 'pole' : 'building');
  }

  /** Scatter trees by a density function. */
  private scatterTrees(count: number, extent: number, seed: number, density: (x: number, z: number, f: number) => number,
    shape: (rnd: () => number, f: number) => { h: number; type: number }) {
    const rnd = mulberry32(seed);
    const t = this.terrain;
    const n = new Vector3();
    let tries = 0;
    const start = this.trees.length;
    while (this.trees.length - start < count && tries < count * 25) {
      tries++;
      const x = (rnd() * 2 - 1) * extent, z = (rnd() * 2 - 1) * extent;
      const f = fbm2(x * 0.0022, z * 0.0022, 4, 77);
      if (rnd() > density(x, z, f)) continue;
      const y = t.heightAt(x, z);
      if (y < this.layout.waterLevel + 0.8 || y > 300) continue;
      t.normalAt(x, z, n);
      if (n.y < 0.78) continue;
      const { h, type } = shape(rnd, f);
      this.addTree({ x, y, z, h, r: type === 0 ? h * 0.22 : h * 0.34, type });
    }
  }

  /* --------------------------- Airfield ---------------------------- */
  private buildField() {
    this.scatterTrees(9000, 2600, 1234, (x, z, f) => {
      if (inRect(FIELD_RECT, x, z, 35)) return 0;
      if (Math.abs(z) < 60 && Math.abs(x) < 420) return 0;
      return smoothstep(-0.05, 0.3, f) * 0.95 + 0.02;
    }, (rnd, f) => {
      const type = f > 0.25 ? (rnd() < 0.75 ? 0 : 1) : rnd() < 0.3 ? 0 : 1;
      return { type, h: (type === 0 ? 11 : 9) + rnd() * 9 };
    });
    const rnd = mulberry32(7);
    for (let k = 0; k < 26; k++) {
      const side = k % 4, along = rnd() * 2 - 1;
      const x = side < 2 ? along * 260 : (side === 2 ? -1 : 1) * (250 + rnd() * 40);
      const z = side < 2 ? (side === 0 ? -1 : 1) * (155 + rnd() * 30) : along * 170;
      const h = 10 + rnd() * 8;
      this.addTree({ x, y: this.terrain.heightAt(x, z), z, h, r: h * 0.36, type: 1 });
    }
    for (let i = 0; i < 400; i++) {
      const side = Math.floor(rnd() * 4), t = rnd() * 2 - 1;
      const x = side < 2 ? t * 225 : (side === 2 ? -1 : 1) * (222 + rnd() * 15);
      const z = side < 2 ? (side === 0 ? -1 : 1) * (130 + rnd() * 15) : t * 135;
      if (Math.abs(z) < 60 && Math.abs(x) > 200) continue;
      this.bushes.push({ x, z, s: 0.9 + rnd() * 1.6 });
    }
    const box = (cx: number, cz: number, sx: number, sy: number, sz: number) => {
      const y = this.terrain.heightAt(cx, cz);
      this.addBox(new Vector3(cx - sx / 2, y - 1, cz - sz / 2), new Vector3(cx + sx / 2, y + sy, cz + sz / 2), 'building');
    };
    box(-70, 52, 14, 5.5, 9);
    box(-48, 50, 6, 2.6, 2.5);
    box(28, 48, 6, 3, 4);
    const gates: [number, number, number][] = [[40, -45, 0], [100, -70, 40], [120, -20, 100], [70, 20, 180], [-20, -35, 200], [-90, -60, 240], [-110, -10, 300]];
    for (const [x, z, yaw] of gates) this.gates.push({ x, z, yaw: yaw * DEG, w: 3, h: 2.2 });
  }

  /* ---------------------------- Forest ----------------------------- */
  private buildForest() {
    const rnd = mulberry32(55);
    for (const [sx, sz, dir] of [[185, 10, 0.1], [-185, -10, Math.PI - 0.2], [40, -48, -Math.PI / 2 - 0.2], [-60, 48, Math.PI / 2]] as [number, number, number][]) {
      const pts: { x: number; z: number }[] = [];
      let x = sx, z = sz, a = dir;
      for (let i = 0; i < 70; i++) {
        pts.push({ x, z });
        a += (rnd() - 0.5) * 0.5;
        x += Math.cos(a) * 14;
        z += Math.sin(a) * 14;
      }
      this.trails.push(pts);
    }
    this.scatterTrees(16000, 1700, 4321, (x, z, f) => {
      if (inRect(FOREST_CLEARING, x, z, 8 + 10 * fbm2(x * 0.05, z * 0.05, 2, 3))) return 0;
      if (Math.abs(z - riverZ(x)) < 9) return 0;
      if (this.nearTrail(x, z, 3.5)) return 0;
      const glade = fbm2(x * 0.006, z * 0.006, 3, 91);
      if (glade > 0.42) return 0.05;
      return 0.55 + smoothstep(-0.3, 0.3, f) * 0.45;
    }, (r, f) => {
      const type = f > 0.05 ? (r() < 0.8 ? 0 : 1) : r() < 0.35 ? 0 : 1;
      return { type, h: (type === 0 ? 16 : 12) + r() * (type === 0 ? 14 : 10) };
    });
    for (let i = 0; i < 10; i++) {
      const x = (rnd() * 2 - 1) * 170, z = (rnd() < 0.5 ? -1 : 1) * (38 + rnd() * 8);
      const h = 14 + rnd() * 6;
      this.addTree({ x, y: this.terrain.heightAt(x, z), z, h, r: h * 0.35, type: 1 });
    }
    for (let i = 0; i < 2600; i++) {
      const x = (rnd() * 2 - 1) * 700, z = (rnd() * 2 - 1) * 700;
      if (inRect(FOREST_CLEARING, x, z, -4) || this.terrain.heightAt(x, z) < this.layout.waterLevel + 0.4) continue;
      this.bushes.push({ x, z, s: 0.6 + rnd() * 1.2 });
    }
    for (let i = 0; i < 260; i++) {
      const x = (rnd() * 2 - 1) * 650, z = (rnd() * 2 - 1) * 650;
      if (inRect(FOREST_CLEARING, x, z, 2)) continue;
      const y = this.terrain.heightAt(x, z);
      if (y < this.layout.waterLevel) continue;
      if (i % 3 === 0) {
        const len = 6 + rnd() * 9, rr = 0.25 + rnd() * 0.25;
        const alongX = rnd() < 0.5;
        this.addSolid(
          new Vector3(x - (alongX ? len / 2 : rr), y - 0.1, z - (alongX ? rr : len / 2)),
          new Vector3(x + (alongX ? len / 2 : rr), y + rr * 2, z + (alongX ? rr : len / 2)), 'log');
      } else {
        const s = 0.6 + rnd() * rnd() * 3;
        this.addSolid(new Vector3(x - s, y - 0.5, z - s * 0.8), new Vector3(x + s, y + s * 1.1, z + s * 0.8), 'rock');
      }
    }
    // wooden hunting tower (high seat) at the clearing edge
    const hx = 130, hz = -44, hy = this.terrain.heightAt(hx, hz);
    for (const [ox, oz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) {
      this.addSolid(new Vector3(hx + ox - 0.12, hy, hz + oz - 0.12), new Vector3(hx + ox + 0.12, hy + 6, hz + oz + 0.12), 'wood');
    }
    this.addSolid(new Vector3(hx - 1.5, hy + 6, hz - 1.5), new Vector3(hx + 1.5, hy + 6.25, hz + 1.5), 'wood');
    this.addSolid(new Vector3(hx - 1.5, hy + 8.2, hz - 1.6), new Vector3(hx + 1.5, hy + 8.4, hz + 1.6), 'wood');
    this.addSolid(new Vector3(hx - 1.5, hy + 6.25, hz - 1.5), new Vector3(hx + 1.5, hy + 7.2, hz - 1.35), 'wood');
  }

  /** Distance test against forest trails. */
  nearTrail(x: number, z: number, d: number) {
    for (const tr of this.trails) for (const p of tr) if (Math.abs(p.x - x) < d + 8 && Math.abs(p.z - z) < d + 8 && Math.hypot(p.x - x, p.z - z) < d) return true;
    return false;
  }

  /* ----------------------------- City ------------------------------ */
  private buildCity() {
    const { pitch, block, road, n } = CITY;
    const E = CITY_EXTENT;
    const t = this.terrain;
    const rnd = mulberry32(2024);
    for (let k = -n - 1; k <= n; k++) {
      const c = (k + 0.5) * pitch;
      this.roads.push({ x0: -E, z0: c - road / 2, x1: E, z1: c + road / 2, w: road });
      this.roads.push({ x0: c - road / 2, z0: -E, x1: c + road / 2, z1: E, w: road });
    }
    for (const r of this.roads) t.asphalt.push({ x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1 });
    t.concrete.push({ x0: -E, z0: -E, x1: E, z1: E });
    this.parks.push(CITY_PARK);
    t.grassRects.push(CITY_PARK);

    const downtown = { x: 0, z: -340 };
    const bandos = new Set(['3,-2', '-4,3']);
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const cx = i * pitch, cz = j * pitch;
        const half = block / 2;
        const rect = { x0: cx - half, z0: cz - half, x1: cx + half, z1: cz + half };
        if (j === 0 && Math.abs(i) <= 1) continue; // central park with the flying strip
        this.streetFurniture(cx, cz, half, rnd);
        if (j === 0 && Math.abs(i) <= 3) { this.parking.push(rect); continue; } // open climb-out corridor
        if (bandos.has(`${i},${j}`)) { this.bando(cx, cz, rnd); continue; }
        const r = rnd();
        if (r < 0.06) { this.cityPark(rect, rnd); continue; }
        if (r < 0.1) { this.parking.push(rect); continue; }
        const d = Math.hypot(cx - downtown.x, cz - downtown.z);
        const zone = d < 230 ? 0 : d < 450 ? 1 : 2;
        const nx = zone === 0 ? 1 + Math.floor(rnd() * 2) : 2 + Math.floor(rnd() * 2);
        const nz = zone === 0 ? 1 + Math.floor(rnd() * 2) : 2 + Math.floor(rnd() * 2);
        const gap = zone === 2 ? 5 : 3;
        const lw = (block - gap * (nx - 1)) / nx, ld = (block - gap * (nz - 1)) / nz;
        for (let a = 0; a < nx; a++) {
          for (let b = 0; b < nz; b++) {
            const lx = rect.x0 + a * (lw + gap) + lw / 2, lz = rect.z0 + b * (ld + gap) + ld / 2;
            const set = zone === 2 ? 3 + rnd() * 4 : 1 + rnd() * 2;
            let w = lw - set, dd = ld - set;
            let h: number, style: BuildingStyle;
            if (zone === 0) { h = 45 + rnd() * rnd() * 110; style = rnd() < 0.55 ? 'glass' : 'office'; }
            else if (zone === 1) { h = 14 + rnd() * 30; style = (['brick', 'concrete', 'office', 'brick'] as BuildingStyle[])[Math.floor(rnd() * 4)]; }
            else { h = 6 + rnd() * 8; style = rnd() < 0.6 ? 'house' : 'brick'; w = Math.min(w, 18); dd = Math.min(dd, 16); }
            this.addBuilding({ x: lx, z: lz, w, d: dd, h, style, y: 0 });
            if (zone === 0 && h > 80 && rnd() < 0.6) this.addBuilding({ x: lx, z: lz, w: w * 0.62, d: dd * 0.62, h: h + 12 + rnd() * 25, style, y: 0 });
          }
        }
      }
    }
    this.scatterTrees(7000, 2600, 99, (x, z, f) => {
      if (Math.max(Math.abs(x), Math.abs(z)) < E + 40) return 0;
      return smoothstep(-0.1, 0.3, f) * 0.9 + 0.05;
    }, (r, f) => {
      const type = f > 0.25 ? (r() < 0.7 ? 0 : 1) : r() < 0.3 ? 0 : 1;
      return { type, h: (type === 0 ? 12 : 9) + r() * 9 };
    });
    for (let k = 0; k < 40; k++) {
      const x = (rnd() * 2 - 1) * 118;
      const z = (rnd() < 0.5 ? -1 : 1) * (33 + rnd() * 3);
      const h = 9 + rnd() * 5;
      this.addTree({ x, y: 0, z, h, r: h * 0.36, type: 1 });
    }
  }

  private addBuilding(b: Building) {
    this.buildings.push(b);
    this.addBox(new Vector3(b.x - b.w / 2, -1, b.z - b.d / 2), new Vector3(b.x + b.w / 2, b.h, b.z + b.d / 2), 'building');
  }

  private streetFurniture(cx: number, cz: number, half: number, rnd: () => number) {
    const off = half + 2.2;
    for (let s = -half + 6; s <= half - 6; s += 16) {
      if (rnd() < 0.75) { const h = 7 + rnd() * 3; this.addTree({ x: cx + s, y: 0, z: cz + off, h, r: h * 0.3, type: 1 }); }
      if (rnd() < 0.75) { const h = 7 + rnd() * 3; this.addTree({ x: cx + off, y: 0, z: cz + s, h, r: h * 0.3, type: 1 }); }
    }
    for (const [px, pz] of [[cx - half + 2, cz + off - 0.5], [cx + 6, cz + off - 0.5], [cx + off - 0.5, cz - half + 2], [cx + off - 0.5, cz + 6]]) {
      this.addSolid(new Vector3(px - 0.12, 0, pz - 0.12), new Vector3(px + 0.12, 8, pz + 0.12), 'pole');
    }
  }

  private cityPark(rect: Rect, rnd: () => number) {
    this.parks.push(rect);
    this.terrain.grassRects.push(rect);
    for (let k = 0; k < 14; k++) {
      const x = rect.x0 + 5 + rnd() * (rect.x1 - rect.x0 - 10), z = rect.z0 + 5 + rnd() * (rect.z1 - rect.z0 - 10);
      const h = 8 + rnd() * 7;
      this.addTree({ x, y: 0, z, h, r: h * 0.36, type: rnd() < 0.25 ? 0 : 1 });
    }
  }

  /** Abandoned concrete frame building ("bando"): slabs, columns, some walls. */
  private bando(cx: number, cz: number, rnd: () => number) {
    const W = 36, D = 24, floors = 4 + Math.floor(rnd() * 3), fh = 3.6;
    const x0 = cx - W / 2, z0 = cz - D / 2;
    for (let f = 1; f <= floors; f++) {
      const y = f * fh;
      const holeX = x0 + 6 + rnd() * (W - 16);
      this.addSolid(new Vector3(x0, y - 0.3, z0), new Vector3(holeX, y, z0 + D), 'concrete');
      this.addSolid(new Vector3(holeX + 5, y - 0.3, z0), new Vector3(x0 + W, y, z0 + D), 'concrete');
      this.addSolid(new Vector3(holeX, y - 0.3, z0), new Vector3(holeX + 5, y, z0 + D * 0.4), 'concrete');
    }
    for (let a = 0; a <= 6; a++) {
      for (let b = 0; b <= 4; b++) {
        if ((a + b) % 2 === 1 && a > 0 && a < 6 && b > 0 && b < 4) continue;
        const x = x0 + (a / 6) * (W - 0.6) + 0.3, z = z0 + (b / 4) * (D - 0.6) + 0.3;
        this.addSolid(new Vector3(x - 0.3, 0, z - 0.3), new Vector3(x + 0.3, floors * fh - 0.3, z + 0.3), 'concrete');
      }
    }
    for (let k = 0; k < 6; k++) {
      const f = Math.floor(rnd() * floors);
      const along = rnd() < 0.5;
      const y = f * fh;
      if (along) {
        const x = x0 + rnd() * (W - 8), z = rnd() < 0.5 ? z0 : z0 + D - 0.25;
        this.addSolid(new Vector3(x, y, z), new Vector3(x + 6, y + fh - 0.3, z + 0.25), 'concrete');
      } else {
        const z = z0 + rnd() * (D - 6), x = rnd() < 0.5 ? x0 : x0 + W - 0.25;
        this.addSolid(new Vector3(x, y, z), new Vector3(x + 0.25, y + fh - 0.3, z + 6), 'concrete');
      }
    }
  }

  /* --------------------------- Queries ----------------------------- */
  /** Collision query against trees, buildings, solids and gates. Fills `out` and returns it, or null. */
  collide(p: Vector3, radius: number, out: Hit): Hit | null {
    let best: Hit | null = null;
    const consider = (kind: Hit['kind'], nx: number, ny: number, nz: number, depth: number, soft: boolean) => {
      if (best && (!best.soft || soft) && best.depth >= depth) return;
      out.kind = kind; out.normal.set(nx, ny, nz).normalize(); out.depth = depth; out.soft = soft;
      best = out;
    };
    const ix = Math.floor(p.x / this.gridCell), iz = Math.floor(p.z / this.gridCell);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const arr = this.grid.get(this.key(ix + a, iz + b));
        if (!arr) continue;
        for (const i of arr) {
          const t = this.trees[i];
          const rel = p.y - t.y;
          if (rel < -radius || rel > t.h + radius) continue;
          const dx = p.x - t.x, dz = p.z - t.z;
          const d = Math.hypot(dx, dz) || 1e-4;
          const trunkR = 0.12 + t.h * 0.012;
          const crownStart = t.type === 0 ? 0.12 : 0.3;
          if (rel < t.h * 0.85 && d < trunkR + radius) consider('tree', dx / d, 0, dz / d, trunkR + radius - d, false);
          const f = clamp(rel / t.h, 0, 1);
          if (f < crownStart) continue;
          const cf = (f - crownStart) / (1 - crownStart);
          const rr = t.r * (t.type === 0 ? Math.max(0.1, 1 - cf) : Math.sin(Math.PI * Math.min(1, cf * 0.95 + 0.05))) * 0.75;
          if (d < rr + radius) consider('tree', dx / d, 0.2, dz / d, rr + radius - d, true);
        }
      }
    }
    const bc = this.boxCell;
    const arr = this.boxGrid.get(this.key(Math.floor(p.x / bc), Math.floor(p.z / bc)));
    if (arr) {
      for (const i of arr) {
        const bx = this.boxes[i];
        if (p.x > bx.min.x - radius && p.x < bx.max.x + radius && p.y > bx.min.y - radius && p.y < bx.max.y + radius &&
            p.z > bx.min.z - radius && p.z < bx.max.z + radius) {
          const pen = [
            [p.x - (bx.min.x - radius), -1, 0, 0], [bx.max.x + radius - p.x, 1, 0, 0],
            [p.y - (bx.min.y - radius), 0, -1, 0], [bx.max.y + radius - p.y, 0, 1, 0],
            [p.z - (bx.min.z - radius), 0, 0, -1], [bx.max.z + radius - p.z, 0, 0, 1],
          ].sort((u, v) => u[0] - v[0])[0];
          consider(bx.kind, pen[1], pen[2], pen[3], pen[0], false);
        }
      }
    }
    for (const g of this.gates) {
      const dx = p.x - g.x, dz = p.z - g.z;
      const c = Math.cos(g.yaw), sn = Math.sin(g.yaw);
      const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
      if (Math.abs(lz) > 0.2 + radius) continue;
      const ly = p.y - this.terrain.heightAt(g.x, g.z);
      const hw = g.w / 2, pr = 0.1;
      const toW = (ux: number, uz: number): [number, number] => [ux * c + uz * sn, -ux * sn + uz * c];
      for (const px of [-hw, hw]) {
        const ex = lx - px, d = Math.hypot(ex, lz) || 1e-4;
        if (ly < g.h + pr && d < pr + radius) { const [wx, wz] = toW(ex / d, lz / d); consider('gate', wx, 0, wz, pr + radius - d, false); }
      }
      const ey = ly - g.h, d = Math.hypot(ey, lz) || 1e-4;
      if (Math.abs(lx) < hw + pr && d < pr + radius) { const [wx, wz] = toW(0, lz / d); consider('gate', wx, ey / d, wz, pr + radius - d, false); }
    }
    return best;
  }

  /**
   * Radio / video link quality 0..1 between the pilot and the aircraft:
   * distance plus obstruction by terrain, buildings and trees.
   */
  linkQuality(p: Vector3, tmp: Hit) {
    const from = this.layout.pilot;
    const d = from.distanceTo(p);
    let block = 0;
    const N = 14;
    const q = new Vector3();
    for (let i = 1; i < N; i++) {
      q.lerpVectors(from, p, i / N);
      if (this.terrain.heightAt(q.x, q.z) > q.y + 0.5) block += 0.22;
      const h = this.collide(q, 0, tmp);
      if (h) block += h.soft ? 0.035 : h.kind === 'building' ? 0.12 : 0.02;
    }
    return clamp(1 - Math.pow(d / 2200, 2) - block, 0, 1);
  }
}
