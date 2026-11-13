/**
 * Procedural lo-fi music generator (WebAudio only, no assets).
 * Endless: every song gets a new key, tempo, progression, groove and arrangement.
 */
import { mulberry32 } from '../sim/math';

const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
};
const PROGRESSIONS: Record<string, number[][]> = {
  major: [[1, 4, 0, 5], [0, 5, 3, 4], [3, 4, 2, 5], [0, 3, 1, 4], [3, 2, 1, 0]],
  minor: [[0, 5, 2, 6], [0, 3, 6, 2], [0, 6, 5, 4], [3, 6, 0, 0], [5, 6, 0, 4]],
  dorian: [[0, 3, 0, 3], [0, 6, 3, 4], [1, 0, 3, 6]],
};
const NAMES_A = ['Morning', 'Lazy', 'Golden', 'Quiet', 'Soft', 'Late', 'Gentle', 'Hazy', 'Calm', 'Drifting', 'Warm', 'Blue'];
const NAMES_B = ['Thermals', 'Crosswind', 'Final Approach', 'Holding Pattern', 'Glide Slope', 'Flare', 'Downwind Leg', 'Tailwind', 'Hangar Coffee', 'Prop Wash', 'Cloud Base', 'Touch and Go'];
const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

const KICK = [
  [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
  [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0],
  [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0],
];
const SNARE = [[0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]];
const HAT = [
  [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
  [1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0],
];
const KEYS_RHYTHM = [
  [[0, 6], [6, 4], [10, 6]],
  [[0, 10], [10, 6]],
  [[0, 3], [3, 3], [8, 8]],
  [[2, 6], [8, 4], [12, 4]],
];

interface Song {
  name: string;
  bpm: number;
  root: number;
  scale: number[];
  prog: number[];
  swing: number;
  kick: number[];
  hat: number[];
  keysRhythm: number[][];
  bars: number;
  rnd: () => number;
}

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class MusicPlayer {
  private out: GainNode;
  private bus: GainNode;
  private verb: ConvolverNode;
  private verbSend: GainNode;
  private noise: AudioBuffer;
  private crackleSrc?: AudioBufferSourceNode;
  private timer = 0;
  private song!: Song;
  private step = 0;          // 16th step within song
  private nextTime = 0;
  private seed = (Math.random() * 1e9) | 0;
  private playing = false;
  volume = 0.35;
  enabled = true;
  onTrack?: (name: string) => void;

  constructor(private ctx: AudioContext, destination: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    // tape-ish tone: soft top end + glue compression
    const tape = ctx.createBiquadFilter();
    tape.type = 'lowpass';
    tape.frequency.value = 7200;
    tape.Q.value = 0.4;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.8;
    this.bus.connect(tape).connect(comp).connect(this.out).connect(destination);
    // reverb
    this.verb = ctx.createConvolver();
    this.verb.buffer = this.impulse(2.4);
    this.verbSend = ctx.createGain();
    this.verbSend.gain.value = 0.35;
    this.verbSend.connect(this.verb).connect(tape);
    // shared noise
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  get trackName() { return this.song?.name ?? ''; }

  start() {
    if (this.playing || !this.enabled) return;
    this.playing = true;
    this.newSong();
    this.nextTime = this.ctx.currentTime + 0.1;
    this.startCrackle();
    this.out.gain.cancelScheduledValues(this.ctx.currentTime);
    this.out.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.8);
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    try { this.crackleSrc?.stop(this.ctx.currentTime + 1); } catch { /* already stopped */ }
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.playing) this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) this.start(); else this.stop();
  }

  next() {
    if (!this.playing) return;
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.25);
    setTimeout(() => {
      this.newSong();
      this.nextTime = this.ctx.currentTime + 0.05;
      this.out.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.5);
    }, 900);
  }

  /* ---------------------------------------------------------------- */
  private newSong() {
    const rnd = mulberry32(this.seed++);
    const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const scaleName = pick(['major', 'minor', 'minor', 'dorian']);
    const root = 45 + Math.floor(rnd() * 8); // A2..E3
    const bpm = 70 + Math.floor(rnd() * 18);
    this.song = {
      name: `${pick(NAMES_A)} ${pick(NAMES_B)} · ${NOTE[root % 12]} ${scaleName === 'major' ? 'major' : 'minor'} · ${bpm} BPM`,
      bpm, root, scale: SCALES[scaleName], prog: pick(PROGRESSIONS[scaleName]),
      swing: 0.08 + rnd() * 0.1, kick: pick(KICK), hat: pick(HAT), keysRhythm: pick(KEYS_RHYTHM) as number[][],
      bars: 40 + 4 * Math.floor(rnd() * 4), rnd,
    };
    this.step = 0;
    this.onTrack?.(this.song.name);
  }

  private schedule() {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    if (this.nextTime < ctx.currentTime - 0.5) this.nextTime = ctx.currentTime + 0.05; // tab was asleep
    const sixteenth = 60 / this.song.bpm / 4;
    while (this.nextTime < ctx.currentTime + 0.15) {
      const s = this.step % 16;
      const swing = s % 2 === 1 ? this.song.swing * sixteenth * 2 : 0;
      this.playStep(this.step, this.nextTime + swing);
      this.nextTime += sixteenth;
      this.step++;
      if (this.step >= this.song.bars * 16) {
        this.newSong();
      }
    }
  }

  /** Arrangement: which layers play in this bar. */
  private layers(bar: number) {
    const B = this.song.bars;
    const intro = bar < 4, outro = bar >= B - 4;
    const brk = bar >= B / 2 && bar < B / 2 + 4;
    return {
      pad: true,
      keys: !outro || bar < B - 1,
      drums: !intro && !brk && !outro,
      hats: !intro && !outro,
      bass: !intro && !brk && !outro,
      melody: bar >= 12 && !brk && !outro && bar % 8 >= 4,
    };
  }

  private chordNotes(bar: number) {
    const S = this.song;
    const deg = S.prog[bar % S.prog.length];
    const notes: number[] = [];
    for (const k of [0, 2, 4, 6]) {
      const idx = deg + k;
      notes.push(S.root + 12 + S.scale[idx % 7] + 12 * Math.floor(idx / 7));
    }
    return notes;
  }

  private playStep(step: number, t: number) {
    const S = this.song, rnd = S.rnd;
    const bar = Math.floor(step / 16), s = step % 16;
    const L = this.layers(bar);
    const beat = 60 / S.bpm;
    const human = () => (rnd() - 0.5) * 0.012;
    const chord = this.chordNotes(bar);

    if (s === 0 && L.pad) this.pad(chord, t, beat * 4);
    if (L.keys) {
      for (const [st, len] of S.keysRhythm) {
        if (st === s) {
          const voicing = chord.map((n, i) => n + (i === 0 && rnd() < 0.5 ? 12 : 0));
          voicing.forEach((n, i) => this.epiano(n + 12, t + human() + i * 0.012, (len * beat) / 4, 0.16 + rnd() * 0.05));
        }
      }
    }
    if (L.bass) {
      const root = S.root + S.scale[S.prog[bar % S.prog.length] % 7] - 12 + 12;
      if (s === 0) this.bass(root, t, beat * 1.4, 0.9);
      if (s === 10 && rnd() < 0.7) this.bass(root + (rnd() < 0.5 ? 7 : 12), t, beat * 0.6, 0.6);
      if (s === 14 && rnd() < 0.3) this.bass(root + S.scale[(S.prog[bar % 4] + 1) % 7] - S.scale[S.prog[bar % 4] % 7], t, beat * 0.4, 0.5);
    }
    if (L.drums) {
      if (S.kick[s]) this.kick(t + human(), 0.85);
      if (SNARE[0][s]) this.snare(t + human() + 0.01, 0.55);
      if (s === 15 && bar % 4 === 3 && rnd() < 0.6) this.snare(t, 0.25);
    }
    if (L.hats && S.hat[s]) this.hat(t + human(), s % 4 === 2 ? 0.2 : 0.12, s === 14 && rnd() < 0.15);
    if (L.melody && s % 2 === 0 && rnd() < 0.22) {
      const pent = [0, 2, 4, 7, 9].map((i) => (S.scale === SCALES.major ? i : [0, 3, 5, 7, 10][[0, 2, 4, 7, 9].indexOf(i)]));
      const n = S.root + 36 + pent[Math.floor(rnd() * 5)] + (rnd() < 0.3 ? 12 : 0);
      this.epiano(n, t + human(), beat * (rnd() < 0.5 ? 0.5 : 1), 0.11);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Instruments                                                       */
  /* ---------------------------------------------------------------- */
  private epiano(midi: number, t: number, dur: number, vel: number) {
    const ctx = this.ctx, f = mtof(midi);
    const car = ctx.createOscillator(), mod = ctx.createOscillator(), modG = ctx.createGain();
    car.frequency.value = f;
    mod.frequency.value = f;
    modG.gain.setValueAtTime(f * 1.4, t);
    modG.gain.exponentialRampToValueAtTime(f * 0.08, t + 0.6);
    mod.connect(modG).connect(car.frequency);
    const g = ctx.createGain();
    const rel = dur + 0.9;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + 0.006);
    g.gain.exponentialRampToValueAtTime(vel * 0.35, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + rel);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    car.connect(lp).connect(g);
    g.connect(this.bus);
    g.connect(this.verbSend);
    car.start(t); mod.start(t);
    car.stop(t + rel + 0.05); mod.stop(t + rel + 0.05);
  }

  private pad(notes: number[], t: number, dur: number) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(1100, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(600, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.035, t + 0.8);
    g.gain.setValueAtTime(0.035, t + dur - 0.2);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 1.2);
    lp.connect(g);
    g.connect(this.bus);
    g.connect(this.verbSend);
    for (const n of notes) {
      for (const det of [-8, 8]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(n);
        o.detune.value = det;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 1.3);
      }
    }
  }

  private bass(midi: number, t: number, dur: number, vel: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(), sub = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = mtof(midi);
    sub.frequency.value = mtof(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32 * vel, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.12 * vel, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.15);
    o.connect(lp); sub.connect(lp);
    lp.connect(g).connect(this.bus);
    o.start(t); sub.start(t);
    o.stop(t + dur + 0.2); sub.stop(t + dur + 0.2);
  }

  private kick(t: number, vel: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(vel * 0.75, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.4);
  }

  private noiseHit(t: number, dur: number, type: BiquadFilterType, freq: number, q: number, vel: number, send = 0) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.bus);
    if (send) { const sg = ctx.createGain(); sg.gain.value = send; g.connect(sg).connect(this.verbSend); }
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  private snare(t: number, vel: number) {
    this.noiseHit(t, 0.22, 'bandpass', 1900, 0.8, vel * 0.5, 0.6);
    const ctx = this.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(200, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    g.gain.setValueAtTime(vel * 0.25, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.12);
  }

  private hat(t: number, vel: number, open: boolean) {
    this.noiseHit(t, open ? 0.28 : 0.045, 'highpass', 7500, 0.5, vel * 0.35);
  }

  private startCrackle() {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const r = Math.random();
      d[i] = (r < 0.0004 ? (Math.random() * 2 - 1) * 0.9 : 0) + (Math.random() * 2 - 1) * 0.012;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    src.connect(hp).connect(g).connect(this.bus);
    src.start();
    this.crackleSrc = src;
  }

  private impulse(seconds: number) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }
}
