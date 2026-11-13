import * as THREE from 'three';
import { mulberry32, valueNoise2 } from '../sim/math';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
}

function tex(c: HTMLCanvasElement, repeat = true, srgb = true, aniso = 4) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Canvas with transparency -> texture whose transparent texels carry a fill colour (no dark mip fringes). */
function alphaTexture(c: HTMLCanvasElement, fill: [number, number, number]) {
  const g = c.getContext('2d')!;
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const out = new Uint8Array(d.length);
  const W = c.width, H = c.height;
  for (let y = 0; y < H; y++) {
    const sy = H - 1 - y; // flip so canvas top = v 1
    for (let x = 0; x < W; x++) {
      const i = (sy * W + x) * 4, o = (y * W + x) * 4;
      const a = d[i + 3];
      if (a < 250) {
        const t = a / 255;
        out[o] = d[i] * t + fill[0] * (1 - t);
        out[o + 1] = d[i + 1] * t + fill[1] * (1 - t);
        out[o + 2] = d[i + 2] * t + fill[2] * (1 - t);
      } else { out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]; }
      out[o + 3] = a;
    }
  }
  const t = new THREE.DataTexture(out, W, H, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Neutral-ish grass detail (multiplied with terrain vertex colours). */
export function grassDetail(size = 512) {
  const { c, g } = canvas(size, size);
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // tileable noise via wrapping coordinates on a torus-like sampling
      const n1 = tileNoise(x, y, size, 16, 1);
      const n2 = tileNoise(x, y, size, 64, 2);
      const n3 = tileNoise(x, y, size, 128, 3);
      const v = 0.78 + n1 * 0.12 + n2 * 0.12 + n3 * 0.1;
      const i = (y * size + x) * 4;
      img.data[i] = 255 * Math.min(1, v * 0.97);
      img.data[i + 1] = 255 * Math.min(1, v);
      img.data[i + 2] = 255 * Math.min(1, v * 0.9);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // grass blade strokes
  const rnd = mulberry32(5);
  for (let i = 0; i < size * 14; i++) {
    const x = rnd() * size, y = rnd() * size;
    const l = 2 + rnd() * 5;
    const a = -Math.PI / 2 + (rnd() - 0.5) * 1.2;
    const b = 150 + rnd() * 105;
    g.strokeStyle = `rgba(${b * 0.92 | 0},${b | 0},${b * 0.78 | 0},${0.25 + rnd() * 0.25})`;
    g.lineWidth = 0.6 + rnd() * 0.8;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    g.stroke();
  }
  return tex(c, true, true, 8);
}

function tileNoise(x: number, y: number, size: number, period: number, seed: number) {
  // periodic value noise: sample with wrap
  const fx = (x / size) * period, fy = (y / size) * period;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const tx = fx - ix, ty = fy - iy;
  const h = (a: number, b: number) => valueNoise2(((a % period) + period) % period, ((b % period) + period) % period, seed);
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = h(ix, iy), b = h(ix + 1, iy), cc = h(ix, iy + 1), d = h(ix + 1, iy + 1);
  return (a + (b - a) * sx) * (1 - sy) + (cc + (d - cc) * sx) * sy - 0.5;
}

/** Mown-field stripes (alpha overlay). */
export function mownStripes() {
  const { c, g } = canvas(256, 256);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? 'rgba(255,255,240,0.10)' : 'rgba(0,30,0,0.08)';
    g.fillRect(0, i * 32, 256, 32);
  }
  return tex(c);
}

/** Asphalt runway with markings. u along runway length. */
export function runwayTexture(lengthM: number, widthM: number) {
  const ppm = 16;
  const w = Math.min(2048, Math.round(lengthM * ppm)), h = Math.round(widthM * ppm * 2) ;
  const { c, g } = canvas(w, h);
  const img = g.createImageData(w, h);
  const rnd = mulberry32(9);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    const n = valueNoise2(x * 0.05, y * 0.05, 4) * 0.5 + valueNoise2(x * 0.4, y * 0.4, 6) * 0.3 + rnd() * 0.2;
    const v = 62 + n * 38;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 1.03; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const sx = w / lengthM, sy = h / widthM;
  g.fillStyle = 'rgba(235,235,230,0.85)';
  // edge lines
  g.fillRect(0, 0.3 * sy, w, 0.15 * sy);
  g.fillRect(0, h - 0.45 * sy, w, 0.15 * sy);
  // centreline dashes
  for (let x = 8; x < lengthM - 8; x += 6) g.fillRect(x * sx, h / 2 - 0.08 * sy, 3 * sx, 0.16 * sy);
  // thresholds (piano keys)
  for (const end of [0, 1]) {
    for (let k = 0; k < 6; k++) {
      const yy = (0.9 + k * 1.4) * sy;
      const x0 = end === 0 ? 1.2 * sx : w - 4.2 * sx;
      g.fillRect(x0, yy, 3 * sx, 0.7 * sy);
    }
  }
  // tyre marks
  g.fillStyle = 'rgba(20,20,20,0.18)';
  for (let i = 0; i < 60; i++) {
    const x = (8 + rnd() * 25) * sx, y = h / 2 + (rnd() - 0.5) * 2.5 * sy;
    g.fillRect(x, y, (2 + rnd() * 6) * sx, 0.12 * sy);
    g.fillRect(w - x, y, (2 + rnd() * 6) * sx, 0.12 * sy);
  }
  const t = tex(c, false, true, 8);
  return t;
}

export function radialBlob(inner = 'rgba(0,0,0,0.55)', outer = 'rgba(0,0,0,0)') {
  const { c, g } = canvas(128, 128);
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return tex(c, false);
}

export function cloudTexture(seed: number) {
  const { c, g } = canvas(256, 128);
  const rnd = mulberry32(seed);
  for (let i = 0; i < 26; i++) {
    const x = 50 + rnd() * 156, y = 50 + rnd() * 40 - (Math.abs(x - 128) / 128) * 10;
    const r = 18 + rnd() * 30;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const shade = 235 + rnd() * 20;
    grd.addColorStop(0, `rgba(${shade},${shade},${shade + 5},0.55)`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // shade underside
  const ug = g.createLinearGradient(0, 40, 0, 128);
  ug.addColorStop(0, 'rgba(0,0,0,0)');
  ug.addColorStop(1, 'rgba(90,100,120,0.35)');
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = ug;
  g.fillRect(0, 0, 256, 128);
  return tex(c, false);
}

export function stripeTexture(a: string, b: string, n = 8) {
  const { c, g } = canvas(64, 256);
  for (let i = 0; i < n; i++) {
    g.fillStyle = i % 2 ? a : b;
    g.fillRect(0, (i * 256) / n, 64, 256 / n);
  }
  return tex(c);
}

export function waterNormal() {
  const s = 256;
  const { c, g } = canvas(s, s);
  const img = g.createImageData(s, s);
  const hgt = (x: number, y: number) => tileNoise(x, y, s, 8, 11) + tileNoise(x, y, s, 32, 12) * 0.5;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = hgt(x + 1, y) - hgt(x - 1, y);
      const dy = hgt(x, y + 1) - hgt(x, y - 1);
      const i = (y * s + x) * 4;
      img.data[i] = 128 + dx * 600;
      img.data[i + 1] = 128 + dy * 600;
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return tex(c, true, false);
}

export function windsockTexture() {
  return stripeTexture('#ffffff', '#ff5a1a', 5);
}

/** Small text/number decal (aircraft registration etc). */
export function labelTexture(text: string, fg = '#111', bg = 'rgba(0,0,0,0)') {
  const { c, g } = canvas(256, 64);
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = fg;
  g.font = 'bold 44px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 34);
  return tex(c, false);
}

/* ------------------------------------------------------------------ */
/*  Realistic ground / foliage textures                                */
/* ------------------------------------------------------------------ */
type RGB = [number, number, number];
const mixc = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function fillNoise(g: CanvasRenderingContext2D, size: number, seed: number, colorAt: (n1: number, n2: number, n3: number, r: number) => RGB) {
  const img = g.createImageData(size, size);
  const rnd = mulberry32(seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n1 = tileNoise(x, y, size, 4, seed) + 0.5;
      const n2 = tileNoise(x, y, size, 16, seed + 1) + 0.5;
      const n3 = tileNoise(x, y, size, 64, seed + 2) + 0.5;
      const c = colorAt(n1, n2, n3, rnd());
      const i = (y * size + x) * 4;
      img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

/** Wrap-around stroke so blades crossing the edge stay tileable. */
function wrapStroke(g: CanvasRenderingContext2D, size: number, draw: (ox: number, oy: number) => void) {
  for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) draw(ox, oy);
}

export function groundGrass(size = 512) {
  const { c, g } = canvas(size, size);
  const dark: RGB = [44, 62, 26], mid: RGB = [78, 100, 42], light: RGB = [112, 128, 60], dry: RGB = [140, 134, 82];
  fillNoise(g, size, 31, (n1, n2, n3, r) => {
    let col = mixc(dark, mid, n2 * 0.7 + n3 * 0.3);
    col = mixc(col, light, Math.max(0, n3 - 0.55) * 1.6);
    col = mixc(col, dry, Math.max(0, n1 - 0.62) * 1.8);
    const k = 0.9 + r * 0.2;
    return [col[0] * k, col[1] * k, col[2] * k];
  });
  const rnd = mulberry32(77);
  for (let i = 0; i < size * 22; i++) {
    const x = rnd() * size, y = rnd() * size, l = 3 + rnd() * 7, a = rnd() * Math.PI * 2;
    const t = rnd();
    const col = t < 0.15 ? dry : t < 0.55 ? mid : t < 0.85 ? light : dark;
    g.strokeStyle = `rgba(${col[0] * (0.85 + rnd() * 0.3) | 0},${col[1] * (0.85 + rnd() * 0.3) | 0},${col[2] | 0},${0.45 + rnd() * 0.4})`;
    g.lineWidth = 0.7 + rnd() * 0.9;
    wrapStroke(g, size, (ox, oy) => {
      g.beginPath();
      g.moveTo(x + ox, y + oy);
      g.quadraticCurveTo(x + ox + Math.cos(a) * l * 0.5 + (rnd() - 0.5) * 2, y + oy + Math.sin(a) * l * 0.5, x + ox + Math.cos(a) * l, y + oy + Math.sin(a) * l);
      g.stroke();
    });
  }
  return tex(c, true, true, 8);
}

export function groundDirt(size = 512) {
  const { c, g } = canvas(size, size);
  const a: RGB = [88, 70, 48], b: RGB = [132, 108, 76], cc: RGB = [70, 60, 44];
  fillNoise(g, size, 41, (n1, n2, n3, r) => {
    let col = mixc(a, b, n2 * 0.6 + n3 * 0.4);
    col = mixc(col, cc, Math.max(0, n1 - 0.6) * 1.5);
    const k = 0.85 + r * 0.3;
    return [col[0] * k, col[1] * k, col[2] * k];
  });
  const rnd = mulberry32(43);
  for (let i = 0; i < size * 3; i++) {
    const x = rnd() * size, y = rnd() * size, r = 0.6 + rnd() * 2.2, v = 90 + rnd() * 90;
    g.fillStyle = `rgba(${v},${v * 0.9 | 0},${v * 0.78 | 0},${0.5 + rnd() * 0.4})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  return tex(c, true, true, 8);
}

export function groundRock(size = 512) {
  const { c, g } = canvas(size, size);
  const a: RGB = [86, 84, 80], b: RGB = [148, 142, 132], m: RGB = [92, 100, 70];
  fillNoise(g, size, 51, (n1, n2, n3, r) => {
    let col = mixc(a, b, n1 * 0.5 + n2 * 0.3 + n3 * 0.2);
    col = mixc(col, m, Math.max(0, 0.4 - n2) * 1.2);
    const k = 0.88 + r * 0.24;
    return [col[0] * k, col[1] * k, col[2] * k];
  });
  const rnd = mulberry32(53);
  g.strokeStyle = 'rgba(40,38,36,0.55)';
  for (let i = 0; i < 70; i++) {
    let x = rnd() * size, y = rnd() * size;
    g.lineWidth = 0.6 + rnd() * 1.2;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 6; k++) { x += (rnd() - 0.5) * 30; y += (rnd() - 0.5) * 30; g.lineTo(x, y); }
    g.stroke();
  }
  return tex(c, true, true, 8);
}

/**
 * Foliage atlas (512x512):
 *  [0..256]x[0..256]   broadleaf cluster   -> uv (0..0.5, 0.5..1)
 *  [256..512]x[0..256] conifer spray       -> uv (0.5..1, 0.5..1)
 *  [0..512]x[256..384] bark strip          -> uv (0..1, 0.25..0.5)
 *  [0..256]x[384..512] dense bush cluster  -> uv (0..0.5, 0..0.25)
 */
export function foliageAtlas() {
  const { c, g } = canvas(512, 512);
  const rnd = mulberry32(61);
  // broadleaf: many leaves inside an irregular blob, darker inside
  const leafBlob = (ox: number, oy: number, w: number, h: number, count: number, base: RGB, spread: number) => {
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd());
      const edge = 0.82 + 0.18 * Math.sin(a * 5 + rnd());
      const x = ox + w / 2 + Math.cos(a) * rr * edge * (w / 2 - 6);
      const y = oy + h / 2 + Math.sin(a) * rr * edge * (h / 2 - 6);
      const shade = 0.55 + (1 - rr) * -0.15 + rnd() * 0.55 - (y - oy) / h * 0.15;
      const col = base.map((v) => Math.min(255, v * shade * (1 + (rnd() - 0.5) * spread))) as RGB;
      g.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
      g.save();
      g.translate(x, y);
      g.rotate(rnd() * Math.PI * 2);
      g.beginPath();
      const L = 4 + rnd() * 5;
      g.ellipse(0, 0, L, L * 0.48, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  };
  leafBlob(0, 0, 256, 256, 2600, [70, 108, 40], 0.35);
  leafBlob(0, 384, 256, 128, 1300, [74, 108, 46], 0.3);
  // conifer spray: drooping branch with needles, pointing right
  g.save();
  for (let i = 0; i < 9; i++) {
    const y0 = 128 + (i - 4) * 9;
    g.strokeStyle = 'rgb(70,52,36)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(262, 128); g.quadraticCurveTo(380, y0, 505, y0 + 20 + Math.abs(i - 4) * 8); g.stroke();
  }
  for (let i = 0; i < 5200; i++) {
    const t = rnd();
    const x = 262 + t * 243;
    const halfW = 105 * Math.sin(Math.PI * Math.min(1, t * 1.1)) * (1 - t * 0.35);
    const y = 128 + (rnd() * 2 - 1) * halfW + t * t * 40;
    const shade = 0.6 + rnd() * 0.6;
    g.strokeStyle = `rgb(${32 * shade | 0},${62 * shade | 0},${36 * shade | 0})`;
    g.lineWidth = 1.2;
    const a = rnd() * Math.PI * 2;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 5, y + Math.sin(a) * 5); g.stroke();
  }
  g.restore();
  // bark strip
  const img = g.getImageData(0, 256, 512, 128);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 512; x++) {
      const n = valueNoise2(x * 0.5, y * 0.04, 71) * 0.6 + valueNoise2(x * 0.08, y * 0.3, 73) * 0.4;
      const v = 55 + n * 60;
      const i = (y * 512 + x) * 4;
      img.data[i] = v * 1.05; img.data[i + 1] = v * 0.88; img.data[i + 2] = v * 0.7; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 256);
  return alphaTexture(c, [52, 80, 34]);
}

/** Grass tuft texture with alpha (blades rising from the bottom). */
export function grassBlades() {
  const { c, g } = canvas(256, 256);
  const rnd = mulberry32(81);
  for (let i = 0; i < 90; i++) {
    const x = 10 + rnd() * 236, h = 90 + rnd() * 160, lean = (rnd() - 0.5) * 80, w = 1.5 + rnd() * 2.5;
    const shade = 0.6 + rnd() * 0.6;
    const dry = rnd() < 0.12;
    const r = (dry ? 150 : 84) * shade, gg = (dry ? 140 : 108) * shade, b = (dry ? 80 : 46) * shade;
    const grd = g.createLinearGradient(0, 256, 0, 256 - h);
    grd.addColorStop(0, `rgb(${r * 0.75 | 0},${gg * 0.8 | 0},${b * 0.7 | 0})`);
    grd.addColorStop(1, `rgb(${r | 0},${gg | 0},${b | 0})`);
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(x - w, 256);
    g.quadraticCurveTo(x - w * 0.5 + lean * 0.4, 256 - h * 0.55, x + lean, 256 - h);
    g.quadraticCurveTo(x + w * 0.5 + lean * 0.4, 256 - h * 0.55, x + w, 256);
    g.fill();
  }
  return alphaTexture(c, [82, 110, 44]);
}

/** Carbon fibre weave. */
export function carbonTexture() {
  const { c, g } = canvas(64, 64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const v = (x + y) % 2 ? 28 : 44;
    const grd = (x + y) % 2 ? g.createLinearGradient(x * 8, 0, x * 8 + 8, 0) : g.createLinearGradient(0, y * 8, 0, y * 8 + 8);
    grd.addColorStop(0, `rgb(${v},${v},${v + 4})`);
    grd.addColorStop(0.5, `rgb(${v + 22},${v + 22},${v + 26})`);
    grd.addColorStop(1, `rgb(${v},${v},${v + 4})`);
    g.fillStyle = grd;
    g.fillRect(x * 8, y * 8, 8, 8);
  }
  const t = tex(c, true, true, 4);
  t.repeat.set(6, 6);
  return t;
}

/** Fuselage livery: u = along the fuselage (nose->tail), v = around (0 right side, .25 top, .5 left, .75 bottom). */
export function liveryTexture(base: string, stripe: string, accent: string, opts: { belly?: string; noseTo?: number; checker?: boolean } = {}) {
  const W = 1024, H = 256;
  const { c, g } = canvas(W, H);
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);
  // canvas y = (1 - v) * H
  const band = (v: number, hv: number, col: string, u0 = 0, u1 = 1) => {
    g.fillStyle = col;
    g.fillRect(u0 * W, (1 - v - hv / 2) * H, (u1 - u0) * W, hv * H);
  };
  if (opts.belly) band(0.75, 0.22, opts.belly);
  // cheat lines on both sides
  for (const v of [0.02, 0.98, 0.5]) { band(v, 0.07, stripe, 0.18, 0.98); band(v + 0.055 > 1 ? v - 0.055 : v + 0.055, 0.02, accent, 0.2, 0.96); }
  if (opts.noseTo) { g.fillStyle = accent; g.fillRect(0, 0, opts.noseTo * W, H); }
  if (opts.checker) {
    for (let i = 0; i < 16; i++) for (let j = 0; j < 4; j++) {
      g.fillStyle = (i + j) % 2 ? '#111' : '#f5f5f5';
      g.fillRect(i * (W * 0.006), j * (H / 4), W * 0.006, H / 4);
    }
  }
  // subtle panel lines
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  g.lineWidth = 2;
  for (const u of [0.25, 0.42, 0.6]) { g.beginPath(); g.moveTo(u * W, 0); g.lineTo(u * W, H); g.stroke(); }
  return tex(c, false, true, 8);
}

/* ------------------------------------------------------------------ */
/*  City textures                                                      */
/* ------------------------------------------------------------------ */
/**
 * Building facade tile: 4 window bays wide x 2 floors high.
 * Mapped in world units: one tile = 4 * bay (m) wide, 2 * floor (m) high.
 */
export function facadeTexture(style: 'glass' | 'office' | 'brick' | 'concrete' | 'house', seed = 1) {
  const W = 256, H = 256;
  const { c, g } = canvas(W, H);
  const rnd = mulberry32(seed + style.length * 31);
  const noiseFill = (base: RGB, amt: number, seedN: number) => {
    const img = g.getImageData(0, 0, W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const n = (valueNoise2(x * 0.08, y * 0.08, seedN) - 0.5) * amt + (Math.random() - 0.5) * amt * 0.5;
      const i = (y * W + x) * 4;
      img.data[i] = base[0] * (1 + n); img.data[i + 1] = base[1] * (1 + n); img.data[i + 2] = base[2] * (1 + n); img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  };
  const bays = 4, floors = 2, bw = W / bays, fh = H / floors;
  const window = (x: number, y: number, w: number, h: number, frame: string, glassTop: string, glassBot: string, lit: number) => {
    g.fillStyle = frame;
    g.fillRect(x - 2, y - 2, w + 4, h + 4);
    const grd = g.createLinearGradient(0, y, 0, y + h);
    grd.addColorStop(0, glassTop);
    grd.addColorStop(1, glassBot);
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
    // interior hint: curtains / lights
    if (rnd() < lit) { g.fillStyle = `rgba(255,236,190,${0.12 + rnd() * 0.2})`; g.fillRect(x, y + h * 0.5, w, h * 0.5); }
    if (rnd() < 0.3) { g.fillStyle = `rgba(230,225,215,${0.3 + rnd() * 0.4})`; g.fillRect(x, y, w * (0.2 + rnd() * 0.3), h); }
  };
  if (style === 'glass') {
    // curtain wall: blue-green glass with thin mullions
    const grd = g.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, '#5b7f95'); grd.addColorStop(0.5, '#3d5d74'); grd.addColorStop(1, '#6d8fa3');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(255,255,255,${rnd() * 0.06})`; g.fillRect(rnd() * W, 0, 8 + rnd() * 30, H); }
    g.fillStyle = '#9aa7ae';
    for (let b = 0; b <= bays * 2; b++) g.fillRect((b * W) / (bays * 2) - 1.5, 0, 3, H);
    for (let f = 0; f <= floors; f++) g.fillRect(0, f * fh - 4, W, 8);
  } else if (style === 'office') {
    noiseFill([196, 192, 184], 0.12, 5);
    for (let f = 0; f < floors; f++) for (let b = 0; b < bays; b++) window(b * bw + 7, f * fh + 22, bw - 14, fh - 40, '#5d636b', '#7d97ab', '#2e3d4a', 0.25);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let f = 0; f < floors; f++) g.fillRect(0, f * fh + fh - 12, W, 6);
  } else if (style === 'brick') {
    noiseFill([142, 74, 56], 0.18, 7);
    g.strokeStyle = 'rgba(210,200,190,0.35)';
    g.lineWidth = 1;
    for (let y = 0; y < H; y += 6) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      for (let x = (y / 6) % 2 ? 0 : 7; x < W; x += 14) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 6); g.stroke(); }
    }
    for (let f = 0; f < floors; f++) for (let b = 0; b < bays; b++) {
      window(b * bw + 16, f * fh + 26, bw - 32, fh - 50, '#e8e2d8', '#8aa0b0', '#33414c', 0.35);
      g.fillStyle = '#d8d0c4'; g.fillRect(b * bw + 12, f * fh + fh - 26, bw - 24, 5);
    }
  } else if (style === 'concrete') {
    noiseFill([165, 162, 156], 0.22, 9);
    for (let f = 0; f < floors; f++) {
      g.fillStyle = 'rgba(0,0,0,0.08)'; g.fillRect(0, f * fh + fh - 10, W, 10);
      for (let b = 0; b < bays; b++) window(b * bw + 10, f * fh + 24, bw - 20, fh - 46, '#7a7a76', '#8c9ca6', '#3a444a', 0.3);
    }
    // water stains
    for (let i = 0; i < 12; i++) {
      const x = rnd() * W;
      const grd2 = g.createLinearGradient(0, 0, 0, H);
      grd2.addColorStop(0, 'rgba(60,55,50,0.0)'); grd2.addColorStop(1, 'rgba(60,55,50,0.18)');
      g.fillStyle = grd2; g.fillRect(x, rnd() * H * 0.5, 3 + rnd() * 6, H);
    }
  } else {
    // house: plaster with wooden windows
    noiseFill([226, 214, 190], 0.1, 11);
    for (let f = 0; f < floors; f++) for (let b = 0; b < bays; b += 1) {
      if ((b + f) % 3 === 2) continue;
      window(b * bw + 18, f * fh + 30, bw - 36, fh - 60, '#f4f1ea', '#94a8b8', '#3a4650', 0.4);
    }
  }
  return tex(c, true, true, 8);
}

/** Sidewalk: concrete slabs. 1 tile = 4 m. */
export function sidewalkTexture() {
  const { c, g } = canvas(256, 256);
  fillNoise(g, 256, 121, (n1, n2, n3, r) => {
    const v = 150 + n2 * 30 + n3 * 20 + r * 12;
    return [v, v * 0.98, v * 0.94];
  });
  g.strokeStyle = 'rgba(70,70,70,0.45)';
  g.lineWidth = 1.5;
  for (let i = 0; i <= 4; i++) {
    g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i * 64); g.lineTo(256, i * 64); g.stroke();
  }
  return tex(c, true, true, 8);
}

/** Road along U: asphalt with edge lines and a dashed centre line. 1 tile = 24 m long x road width. */
export function roadTexture() {
  const W = 512, H = 128;
  const { c, g } = canvas(W, H);
  const img = g.createImageData(W, H);
  const rnd = mulberry32(131);
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i / W) | 0;
    const n = valueNoise2(x * 0.06, y * 0.06, 13) * 0.45 + valueNoise2(x * 0.5, y * 0.5, 17) * 0.3 + rnd() * 0.25;
    const v = 52 + n * 34;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v * 1.04; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // tyre tracks
  g.fillStyle = 'rgba(25,25,25,0.18)';
  for (const y of [0.22, 0.32, 0.68, 0.78]) g.fillRect(0, y * H - 3, W, 6);
  g.fillStyle = 'rgba(235,235,225,0.85)';
  g.fillRect(0, 5, W, 3);
  g.fillRect(0, H - 8, W, 3);
  g.fillStyle = 'rgba(240,200,60,0.9)';
  for (let x = 0; x < W; x += W / 4) g.fillRect(x, H / 2 - 2, W / 8, 4);
  // cracks
  g.strokeStyle = 'rgba(20,20,20,0.35)';
  for (let i = 0; i < 18; i++) {
    let x = rnd() * W, y = rnd() * H;
    g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(x, y);
    for (let k = 0; k < 5; k++) { x += (rnd() - 0.5) * 20; y += (rnd() - 0.5) * 10; g.lineTo(x, y); }
    g.stroke();
  }
  return tex(c, true, true, 16);
}

export function crosswalkTexture() {
  const { c, g } = canvas(128, 128);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 ? 'rgba(0,0,0,0)' : 'rgba(240,240,232,0.9)';
    g.fillRect(i * 16, 0, 16, 128);
  }
  return tex(c, false);
}

export function parkingTexture() {
  const { c, g } = canvas(256, 256);
  fillNoise(g, 256, 141, (n1, n2, n3, r) => { const v = 70 + n2 * 25 + r * 15; return [v, v, v * 1.03]; });
  g.fillStyle = 'rgba(235,235,225,0.8)';
  for (let x = 0; x < 256; x += 32) { g.fillRect(x, 0, 3, 100); g.fillRect(x, 156, 3, 100); }
  return tex(c, true, true, 8);
}

/** Raw concrete for bando frames, with stains and the odd graffiti tag. */
export function rawConcreteTexture(graffiti = true) {
  const { c, g } = canvas(512, 512);
  fillNoise(g, 512, 151, (n1, n2, n3, r) => {
    const v = 128 + (n1 - 0.5) * 40 + (n2 - 0.5) * 30 + (n3 - 0.5) * 18 + r * 10;
    return [v, v * 0.98, v * 0.93];
  });
  const rnd = mulberry32(157);
  for (let i = 0; i < 30; i++) {
    const x = rnd() * 512;
    const grd = g.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0, 'rgba(50,45,40,0.25)'); grd.addColorStop(1, 'rgba(50,45,40,0)');
    g.fillStyle = grd; g.fillRect(x, 0, 2 + rnd() * 8, 150 + rnd() * 300);
  }
  if (graffiti) {
    const cols = ['#e63946', '#2a9d8f', '#f4a261', '#7b2cbf', '#3a86ff', '#111111'];
    for (let i = 0; i < 7; i++) {
      g.strokeStyle = cols[i % cols.length];
      g.lineWidth = 4 + rnd() * 6;
      g.lineCap = 'round';
      let x = 40 + rnd() * 400, y = 300 + rnd() * 180;
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 9; k++) { x += 10 + rnd() * 18; y += (rnd() - 0.5) * 50; g.quadraticCurveTo(x - 8, y - 30 * rnd(), x, y); }
      g.stroke();
    }
  }
  return tex(c, true, true, 8);
}

export function barkTexture() {
  const { c, g } = canvas(128, 256);
  const img = g.createImageData(128, 256);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 128; x++) {
    const n = valueNoise2(x * 0.5, y * 0.04, 71) * 0.6 + valueNoise2(x * 0.08, y * 0.3, 73) * 0.4;
    const v = 50 + n * 60;
    const i = (y * 128 + x) * 4;
    img.data[i] = v * 1.05; img.data[i + 1] = v * 0.88; img.data[i + 2] = v * 0.7; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return tex(c, true, true, 4);
}
