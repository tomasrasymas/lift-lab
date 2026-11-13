/**
 * Realistic-ish electric RC aircraft sound, synthesised with WebAudio:
 *  - prop blade-pass tone with rich harmonics (the main "buzz"),
 *  - motor electrical whine (rpm * pole pairs),
 *  - broadband prop/air noise,
 *  - Doppler, distance attenuation + air absorption, stereo pan,
 *  - wheel rumble, impacts, field ambience (wind, birds),
 * plus the procedural music player.
 */
import { MusicPlayer } from './music';

export interface SoundProfile {
  count: number;     // number of motors
  blades: number;
  maxRpm: number;
  polePairs: number;
  wheels: boolean;
  loud: number;      // overall loudness factor
}

export interface SoundState {
  rpms: number[];
  airspeed: number;
  groundspeed: number;
  onGround: boolean;
  distance: number;      // listener -> aircraft (m)
  radialVel: number;     // + moving away (m/s)
  pan: number;           // -1 left .. 1 right
  onboard: boolean;      // FPV: listener rides on the aircraft
  impact: number;        // impact speed this frame (m/s), 0 if none
  paused: boolean;
}

interface MotorVoice {
  blade: OscillatorNode;
  whine: OscillatorNode;
  bladeG: GainNode;
  whineG: GainNode;
  noise: AudioBufferSourceNode;
  noiseF: BiquadFilterNode;
  noiseG: GainNode;
  jitter: number;
}

export class SoundSystem {
  ctx: AudioContext | null = null;
  music?: MusicPlayer;
  private master!: GainNode;
  private sfx!: GainNode;
  private amb!: GainNode;
  private air!: BiquadFilterNode;   // distance air absorption
  private distG!: GainNode;
  private pan!: StereoPannerNode;
  private voices: MotorVoice[] = [];
  private noiseBuf!: AudioBuffer;
  private windG!: GainNode;
  private windF!: BiquadFilterNode;
  private rumbleG!: GainNode;
  private ambWindG!: GainNode;
  private trafficG?: GainNode;
  private leavesG?: GainNode;
  private carTimer = 2;
  ambience: 'field' | 'forest' | 'city' = 'field';
  private profile: SoundProfile = { count: 1, blades: 2, maxRpm: 9000, polePairs: 7, wheels: true, loud: 1 };
  private birdTimer = 3;
  private doppler = 1;
  volumes = { master: 0.8, sfx: 0.8, music: 0.35, ambient: 0.5 };
  musicEnabled = true;
  onTrack?: (name: string) => void;

  /** Must be called from a user gesture. */
  start() {
    if (this.ctx) { this.ctx.resume(); if (this.musicEnabled) this.music?.start(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volumes.master;
    this.master.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.volumes.sfx;
    this.sfx.connect(this.master);
    this.amb = ctx.createGain();
    this.amb.gain.value = this.volumes.ambient;
    this.amb.connect(this.master);

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // aircraft chain: voices -> air absorption -> distance gain -> pan -> sfx
    this.air = ctx.createBiquadFilter();
    this.air.type = 'lowpass';
    this.air.frequency.value = 16000;
    this.distG = ctx.createGain();
    this.pan = ctx.createStereoPanner();
    this.air.connect(this.distG).connect(this.pan).connect(this.sfx);

    // rushing wind (onboard) + wheel rumble
    this.windF = ctx.createBiquadFilter();
    this.windF.type = 'bandpass';
    this.windF.Q.value = 0.5;
    this.windG = ctx.createGain();
    this.windG.gain.value = 0;
    this.loopNoise().connect(this.windF).connect(this.windG).connect(this.sfx);
    const rf = ctx.createBiquadFilter();
    rf.type = 'lowpass';
    rf.frequency.value = 180;
    this.rumbleG = ctx.createGain();
    this.rumbleG.gain.value = 0;
    this.loopNoise().connect(rf).connect(this.rumbleG).connect(this.distG);

    // field ambience: soft gusty wind
    const af = ctx.createBiquadFilter();
    af.type = 'lowpass';
    af.frequency.value = 380;
    this.ambWindG = ctx.createGain();
    this.ambWindG.gain.value = 0.05;
    this.loopNoise().connect(af).connect(this.ambWindG).connect(this.amb);

    // city traffic rumble / forest leaves
    const tf = ctx.createBiquadFilter();
    tf.type = 'lowpass';
    tf.frequency.value = 220;
    this.trafficG = ctx.createGain();
    this.trafficG.gain.value = 0;
    this.loopNoise().connect(tf).connect(this.trafficG).connect(this.amb);
    const lf = ctx.createBiquadFilter();
    lf.type = 'bandpass';
    lf.frequency.value = 2600;
    lf.Q.value = 0.4;
    this.leavesG = ctx.createGain();
    this.leavesG.gain.value = 0;
    this.loopNoise().connect(lf).connect(this.leavesG).connect(this.amb);

    this.music = new MusicPlayer(ctx, this.master);
    this.music.volume = this.volumes.music;
    this.music.onTrack = (n) => this.onTrack?.(n);
    if (this.musicEnabled) this.music.start();
    this.setProfile(this.profile);
  }

  private loopNoise() {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.loopStart = Math.random();
    src.start(0, Math.random() * 1.5);
    return src;
  }

  setVolumes(v: Partial<SoundSystem['volumes']>) {
    Object.assign(this.volumes, v);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.sfx.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
    this.amb.gain.setTargetAtTime(this.volumes.ambient, t, 0.05);
    this.music?.setVolume(this.volumes.music);
  }

  setMusic(on: boolean) {
    this.musicEnabled = on;
    this.music?.setEnabled(on);
  }

  setProfile(p: SoundProfile) {
    this.profile = p;
    const ctx = this.ctx;
    if (!ctx) return;
    for (const v of this.voices) {
      v.blade.stop(); v.whine.stop(); v.noise.stop();
      v.bladeG.disconnect(); v.whineG.disconnect(); v.noiseG.disconnect();
    }
    this.voices = [];
    // blade-pass harmonic spectrum: strong fundamental, slowly decaying harmonics (buzzy)
    const N = 14;
    const re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    for (let h = 1; h <= N; h++) im[h] = (1 / Math.pow(h, 1.05)) * (h % p.blades === 0 ? 1.3 : 1);
    const wave = ctx.createPeriodicWave(re, im);
    for (let i = 0; i < p.count; i++) {
      const blade = ctx.createOscillator();
      blade.setPeriodicWave(wave);
      const whine = ctx.createOscillator();
      whine.type = 'triangle';
      const bladeG = ctx.createGain(), whineG = ctx.createGain(), noiseG = ctx.createGain();
      bladeG.gain.value = 0; whineG.gain.value = 0; noiseG.gain.value = 0;
      const noiseF = ctx.createBiquadFilter();
      noiseF.type = 'bandpass';
      noiseF.Q.value = 0.9;
      const noise = this.loopNoise();
      blade.connect(bladeG).connect(this.air);
      whine.connect(whineG).connect(this.air);
      noise.connect(noiseF).connect(noiseG).connect(this.air);
      blade.start(); whine.start();
      this.voices.push({ blade, whine, bladeG, whineG, noise, noiseF, noiseG, jitter: Math.random() * 10 });
    }
  }

  update(dt: number, s: SoundState) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const p = this.profile;
    const T = 0.03;

    // Doppler (smoothed), only when we are not riding along
    const dop = s.onboard ? 1 : 343 / (343 + Math.max(-150, Math.min(150, s.radialVel)));
    this.doppler += (dop - this.doppler) * Math.min(1, dt * 10);

    const mute = s.paused ? 0 : 1;
    this.voices.forEach((v, i) => {
      const n = s.rpms[i] ?? s.rpms[0] ?? 0;
      v.jitter += dt;
      const wobble = 1 + 0.004 * Math.sin(v.jitter * 13.7 + i) + 0.002 * Math.sin(v.jitter * 31 + i * 2);
      const rpm = n * p.maxRpm * wobble;
      const fBlade = Math.max(1, (rpm / 60) * p.blades) * this.doppler;
      const fWhine = Math.max(1, (rpm / 60) * p.polePairs) * this.doppler;
      v.blade.frequency.setTargetAtTime(fBlade, t, T);
      v.whine.frequency.setTargetAtTime(fWhine, t, T);
      v.noiseF.frequency.setTargetAtTime(Math.min(9000, fBlade * 3.5 + 200), t, T);
      const on = n > 0.015 ? 1 : 0;
      const k = p.loud / Math.sqrt(p.count) * mute;
      v.bladeG.gain.setTargetAtTime(on * k * (0.02 + 0.3 * n * n), t, T);
      v.whineG.gain.setTargetAtTime(on * k * (0.012 + 0.035 * n), t, T);
      v.noiseG.gain.setTargetAtTime(on * k * 0.5 * Math.pow(n, 2.5), t, T);
    });

    // distance: inverse distance + air absorption of high frequencies
    const d = Math.max(1, s.distance);
    const g = s.onboard ? 0.55 : Math.min(1.2, 4 / (d + 2));
    this.distG.gain.setTargetAtTime(g, t, 0.05);
    this.air.frequency.setTargetAtTime(s.onboard ? 9000 : Math.max(700, 16000 * Math.exp(-d / 120)), t, 0.05);
    this.pan.pan.setTargetAtTime(s.onboard ? 0 : Math.max(-0.85, Math.min(0.85, s.pan)), t, 0.05);

    // rushing air when riding along
    const wv = Math.min(1, s.airspeed / 35);
    this.windG.gain.setTargetAtTime(s.onboard ? wv * wv * 0.5 * mute : 0, t, 0.1);
    this.windF.frequency.setTargetAtTime(300 + s.airspeed * 45, t, 0.1);
    // wheels rolling on the ground
    this.rumbleG.gain.setTargetAtTime(p.wheels && s.onGround ? Math.min(0.8, s.groundspeed / 12) * mute : 0, t, 0.05);

    // impacts
    if (s.impact > 0.8 && !s.paused) this.impact(s.impact, g);

    // ambience: gusty wind + birds (outdoors only)
    this.ambWindG.gain.setTargetAtTime((0.035 + 0.03 * Math.sin(t * 0.21) * Math.sin(t * 0.13)) * mute * (s.onboard ? 0.3 : 1), t, 0.5);
    const city = this.ambience === 'city', forest = this.ambience === 'forest';
    const outdoor = (s.onboard ? 0.35 : 1) * mute;
    this.trafficG?.gain.setTargetAtTime(city ? 0.16 * outdoor : 0, t, 0.5);
    const rustle = 0.5 + 0.5 * Math.sin(t * 0.37) * Math.sin(t * 0.23 + 1);
    this.leavesG?.gain.setTargetAtTime(forest ? (0.015 + 0.03 * rustle) * outdoor : 0, t, 0.4);
    this.birdTimer -= dt;
    if (this.birdTimer < 0) {
      this.birdTimer = forest ? 1.5 + Math.random() * 4 : city ? 9 + Math.random() * 15 : 4 + Math.random() * 10;
      if (!s.onboard && !s.paused) this.bird();
    }
    if (city) {
      this.carTimer -= dt;
      if (this.carTimer < 0) { this.carTimer = 2 + Math.random() * 5; if (!s.paused) this.carPass(outdoor); }
    }
  }

  private impact(speed: number, distGain: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const vol = Math.min(1, speed / 8) * Math.max(0.2, distGain);
    // thump
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.15);
    og.gain.setValueAtTime(vol * 0.9, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(og).connect(this.sfx);
    o.start(t); o.stop(t + 0.3);
    // crunch (foam / plastic)
    if (speed > 2.5) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 900 + Math.random() * 1200;
      f.Q.value = 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol * 0.8, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18 + Math.min(0.3, speed * 0.03));
      src.connect(f).connect(g).connect(this.sfx);
      src.start(t, Math.random()); src.stop(t + 0.6);
    }
  }

  /** A car driving past: filtered noise swell with a little Doppler-ish sweep. */
  private carPass(vol: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 0.8;
    f.frequency.setValueAtTime(500, t);
    f.frequency.linearRampToValueAtTime(380, t + 3);
    const g = ctx.createGain();
    const peak = (0.05 + Math.random() * 0.08) * vol;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 1.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime(Math.random() < 0.5 ? -0.8 : 0.8, t);
    pan.pan.linearRampToValueAtTime(-pan.pan.value, t + 3);
    src.connect(f).connect(g).connect(pan).connect(this.amb);
    src.start(t, Math.random());
    src.stop(t + 3.3);
  }

  private bird() {
    const ctx = this.ctx!;
    let t = ctx.currentTime + 0.05;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    const out = ctx.createGain();
    out.gain.value = 0.05 + Math.random() * 0.05;
    pan.connect(out).connect(this.amb);
    const base = 2600 + Math.random() * 2200;
    const notes = 2 + Math.floor(Math.random() * 5);
    const kind = Math.random();
    for (let i = 0; i < notes; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      const dur = 0.05 + Math.random() * 0.09;
      const f0 = base * (0.85 + Math.random() * 0.3);
      o.frequency.setValueAtTime(f0, t);
      if (kind < 0.5) o.frequency.exponentialRampToValueAtTime(f0 * 1.45, t + dur);
      else o.frequency.exponentialRampToValueAtTime(f0 * 0.7, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(pan);
      o.start(t); o.stop(t + dur + 0.02);
      t += dur + 0.03 + Math.random() * 0.08;
    }
  }
}
