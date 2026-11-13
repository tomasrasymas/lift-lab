import * as THREE from 'three';
import './style.css';
import { loadSettings, saveSettings, ViewMode } from './settings';
import { World } from './sim/world';
import { createAircraft, AircraftId } from './sim/presets';
import { Aircraft, ControlInputs, neutralInputs } from './sim/aircraft';
import { Multirotor } from './sim/multirotor';
import { Scenery } from './render/scenery';
import { createModel, AircraftModel } from './render/models';
import { CameraRig } from './render/cameras';
import { radialBlob } from './render/textures';
import { InputManager } from './input/input';
import { Hud } from './ui/hud';
import { Osd } from './ui/osd';
import { FpvEffect } from './render/fpvfx';
import { Menu, setTrackLabel } from './ui/menu';
import { SoundSystem, SoundProfile } from './audio/sound';
import { FixedWing } from './sim/fixedwing';

const STEP = 1 / 400;

const settings = loadSettings();
const canvas = document.createElement('canvas');
canvas.id = 'view';
document.body.prepend(canvas);

// ---------------------------------------------------------------- renderer
const q = settings.quality;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: q !== 'low', powerPreference: 'high-performance', stencil: false });
const basePR = q === 'low' ? Math.min(window.devicePixelRatio, 1) * 0.85 : q === 'medium' ? Math.min(window.devicePixelRatio, 1.5) : Math.min(window.devicePixelRatio, 2);
let pixelRatio = basePR;
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = q !== 'low';
renderer.shadowMap.type = THREE.PCFShadowMap;

// ---------------------------------------------------------------- world
const world = new World(settings.map, q === 'low' ? 2500 : q === 'medium' ? 6000 : 11000);
world.wind.settings = settings.wind;
world.wind.update(0);
const scenery = new Scenery(renderer, world, q);
const scene = scenery.scene;
const rig = new CameraRig(window.innerWidth / window.innerHeight);
const input = new InputManager(settings);
const audio = new SoundSystem();
audio.musicEnabled = settings.musicOn;
audio.volumes = { master: settings.volume, sfx: settings.sfxVolume, music: settings.musicVolume, ambient: settings.ambientVolume };
const hud = new Hud(settings);
const osd = new Osd();
const fpvfx = new FpvEffect(q === 'low' ? 0 : 4);
let linkQ = 1, linkTimer = 0;
const _hit = { kind: 'tree' as const, normal: new THREE.Vector3(), depth: 0, soft: false };
const _eul = new THREE.Euler();
audio.ambience = settings.map;
audio.onTrack = (name) => { hud.showTrack(name); setTrackLabel(name); };

// blob shadow (used when real shadows are off)
const blob = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ map: radialBlob('rgba(0,0,0,0.6)'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }),
);
blob.visible = q === 'low';
scene.add(blob);

let aircraft: Aircraft;
let model: AircraftModel;
let acId: AircraftId = settings.aircraft;
const prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion();
let acc = 0;
let paused = false;
let flightTime = 0;
let lastInputs: ControlInputs = neutralInputs();
let hudVisible = true;

function applyQuadSettings() {
  if (aircraft instanceof Multirotor && aircraft.cfg.type === 'fpv') {
    aircraft.rates = { ...settings.fpvRates };
    aircraft.camTilt = settings.camTilt;
  }
}

function loadAircraft(id: AircraftId) {
  acId = id;
  if (model) scene.remove(model.root);
  aircraft = createAircraft(id);
  applyQuadSettings();
  model = createModel(id, settings.camTilt);
  applyEnv(model.root);
  scene.add(model.root);
  audio.setProfile(soundProfile(aircraft));
  if (aircraft.battery) aircraft.battery.drain = settings.batterySim;
  rig.setMode(settings.view[id]);
  resetAircraft();
}

function resetAircraft() {
  aircraft.reset(world, { inAir: settings.spawnInAir });
  prevPos.copy(aircraft.body.pos);
  prevQuat.copy(aircraft.body.quat);
  acc = 0;
  flightTime = 0;
  // sensible keyboard stick position after a reset: GPS drone = centre (hold), in-air FPV = hover
  const gps = aircraft instanceof Multirotor && aircraft.cfg.type === 'gps';
  input.resetKeyboardThrottle(gps ? 0.5 : settings.spawnInAir ? (aircraft.kind === 'quad' ? 0.34 : 0.5) : 0);
  rig.snap(aircraft.body.pos);
}

// ---------------------------------------------------------------- menu
const menu = new Menu(settings, input, {
  onFly() { menu.setOpen(false); paused = false; audio.start(); },
  onAircraft(id) { loadAircraft(id); },
  onReset() { resetAircraft(); },
  onSettingsChanged() {
    world.wind.settings = settings.wind;
    rig.setMode(settings.view[acId]);
    rig.autoZoom = settings.autoZoom;
    rig.fpvFov = settings.fpvFov;
    audio.setVolumes({ master: settings.volume, sfx: settings.sfxVolume, music: settings.musicVolume, ambient: settings.ambientVolume });
    if (audio.musicEnabled !== settings.musicOn) audio.setMusic(settings.musicOn);
    if (aircraft.battery) aircraft.battery.drain = settings.batterySim;
    applyQuadSettings();
    if (model && aircraft instanceof Multirotor && aircraft.cfg.type === 'fpv') {
      scene.remove(model.root);
      model = createModel(acId, settings.camTilt);
      applyEnv(model.root);
      scene.add(model.root);
    }
    if (!settings.autoQuality) { pixelRatio = basePR; renderer.setPixelRatio(pixelRatio); }
  },
  onNextTrack() { audio.music?.next(); },
  trackName() { return audio.music?.trackName ?? ''; },
});
rig.autoZoom = settings.autoZoom;
rig.fpvFov = settings.fpvFov;
loadAircraft(acId);
menu.setOpen(true);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  rig.camera.aspect = window.innerWidth / window.innerHeight;
  rig.camera.updateProjectionMatrix();
});
window.addEventListener('gamepadconnected', () => { if (menu.open) menu.render(); });
window.addEventListener('gamepaddisconnected', () => { if (menu.open) menu.render(); });

// ---------------------------------------------------------------- loop
const VIEWS: ViewMode[] = ['los', 'chase', 'fpv'];
let last = performance.now();
let fps = 60, frameAvg = 1 / 60, qualityTimer = 0;
const renderPos = new THREE.Vector3(), renderQuat = new THREE.Quaternion();
const _rel = new THREE.Vector3(), _right = new THREE.Vector3();

/** Reflections of the sky on glossy aircraft materials only. */
function applyEnv(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m && m.isMeshStandardMaterial) { m.envMap = scenery.envMap; m.needsUpdate = true; }
  });
}

function soundProfile(ac: Aircraft): SoundProfile {
  if (ac instanceof FixedWing) return { count: 1, blades: ac.cfg.prop.blades, maxRpm: ac.cfg.prop.maxRpm, polePairs: 7, wheels: !ac.cfg.handLaunch, loud: 1 };
  const q = ac as Multirotor;
  return { count: 4, blades: q.cfg.blades, maxRpm: q.cfg.maxRpm, polePairs: 7, wheels: false, loud: q.cfg.type === 'fpv' ? 1.1 : 0.8 };
}

function handleActions() {
  for (const a of input.consume()) {
    if (a === 'menu') {
      if (menu.open) { menu.setOpen(false); paused = false; audio.start(); }
      else { menu.setOpen(true); paused = true; }
    } else if (menu.open) continue;
    else if (a === 'reset') resetAircraft();
    else if (a === 'pause') paused = !paused;
    else if (a === 'hud') { hudVisible = !hudVisible; hud.setVisible(hudVisible); }
    else if (a === 'view') {
      const next = VIEWS[(VIEWS.indexOf(rig.mode) + 1) % VIEWS.length];
      settings.view[acId] = next;
      rig.setMode(next);
      saveSettings(settings);
    }
  }
}

function statusMessage(inp: ControlInputs): [string, 'info' | 'warn' | 'bad'] {
  if (paused && !menu.open) return ['PAUSED — press P to continue', 'info'];
  if (aircraft.crashed) return [`CRASHED — ${aircraft.crashReason}. Press <b>R</b> or your reset switch.`, 'bad'];
  if (aircraft.awaitingLaunch) return ['Hand launch: push throttle above 50% to throw the wing', 'info'];
  const armLive = input.hasLive('arm');
  const isPlane = aircraft instanceof FixedWing;
  const armed = isPlane ? (aircraft as FixedWing).motorArmed : (aircraft as Multirotor).armed;
  if (!armed) {
    const what = isPlane ? 'MOTOR SAFE' : 'DISARMED';
    if (!inp.arm) return [armLive ? `${what} — flip your ARM switch (CH5) with throttle low` : `${what} — press E to arm`, 'warn'];
    const gpsDrone = aircraft instanceof Multirotor && aircraft.cfg.type === 'gps';
    if (inp.throttle > (gpsDrone ? 0.62 : 0.06)) return [`${what} — ${gpsDrone ? 'centre or lower' : 'lower'} the throttle to arm`, 'warn'];
  }
  const tm0 = aircraft.telemetry;
  if (settings.batterySim && tm0.batteryPct < 3) return ['BATTERY EMPTY — ESC is cutting power, land now!', 'bad'];
  if (settings.batterySim && (tm0.batteryPct < 20 || tm0.cellV < 3.45)) return [`LOW BATTERY — ${tm0.cellV.toFixed(2)} V/cell, land soon`, 'warn'];
  if (aircraft.telemetry.stall) return ['STALL', 'bad'];
  if (aircraft.kind === 'plane' && aircraft.onGround && aircraft.telemetry.groundspeed < 0.5 && flightTime < 4)
    return ['Take off into the wind: smoothly add full throttle, steer with rudder', 'info'];
  return ['', 'info'];
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frameAvg += (dt - frameAvg) * 0.05;
  fps = 1 / Math.max(frameAvg, 1e-3);

  handleActions();
  const inp = input.poll(dt, aircraft.kind);
  lastInputs = inp;
  menu.tick(dt, inp);

  const running = !paused && !menu.open;
  if (running) {
    acc += dt * settings.simSpeed;
    let n = 0;
    while (acc >= STEP && n < 80) {
      prevPos.copy(aircraft.body.pos);
      prevQuat.copy(aircraft.body.quat);
      world.time += STEP;
      world.wind.update(world.time);
      aircraft.step(STEP, inp, world);
      acc -= STEP;
      n++;
    }
    if (n === 80) acc = 0;
    if (!aircraft.crashed && !aircraft.onGround) flightTime += dt * settings.simSpeed;
  }
  const alpha = running ? acc / STEP : 1;
  renderPos.lerpVectors(prevPos, aircraft.body.pos, alpha);
  renderQuat.slerpQuaternions(prevQuat, aircraft.body.quat, alpha);
  model.root.position.copy(renderPos);
  model.root.quaternion.copy(renderQuat);
  model.update(aircraft.telemetry, running ? dt * settings.simSpeed : 0, world.time);
  model.root.updateMatrixWorld(true);

  const isGimbal = aircraft instanceof Multirotor && aircraft.cfg.type === 'gps';
  const tilt = aircraft instanceof Multirotor ? (isGimbal ? aircraft.cfg.camTilt : settings.camTilt) : 0;
  rig.update(dt, model, renderPos, renderQuat, aircraft.body.vel, world, { gimbal: isGimbal, gimbalTilt: tilt, kind: aircraft.kind });
  const fpv = rig.mode === 'fpv';
  model.setFpvView(fpv && aircraft.kind === 'quad', settings.fpvProps && !isGimbal);
  hud.setFpvMode(fpv);
  osd.setVisible(fpv && hudVisible);
  // video link quality: distance + obstruction between pilot and aircraft
  linkTimer -= dt;
  if (linkTimer <= 0) {
    linkTimer = 0.12;
    const target = world.linkQuality(renderPos, _hit as never);
    linkQ += (target - linkQ) * 0.5;
  }
  scenery.update(dt, rig.camera.position, renderPos, world.time);

  if (blob.visible) {
    const gh = world.terrain.surfaceHeight(renderPos.x, renderPos.z);
    const h = renderPos.y - gh;
    blob.position.set(renderPos.x, gh + 0.03, renderPos.z);
    const s = model.size * (1.1 + h * 0.02);
    blob.scale.set(s, 1, s);
    (blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - h / 40);
  }

  const [msg, lvl] = statusMessage(inp);
  const pad = input.activePad;
  const w = world.wind.settings;
  hud.update(dt, {
    name: aircraft.name, kind: aircraft.kind, tm: aircraft.telemetry, input: inp, view: rig.mode, message: msg, messageLevel: lvl,
    wind: { speed: w.speed, fromDeg: w.fromDeg }, fps, paused,
    controller: pad && !input.usingKeyboard ? `🎮 ${pad.id.split('(')[0].trim().slice(0, 28)}` : '⌨ Keyboard (W/S, arrows, A/D)',
    flightTime,
  });
  // listener: the pilot (LOS), the chase camera, or onboard (FPV)
  const cam = rig.camera;
  const toAc = _rel.copy(renderPos).sub(cam.position);
  const dist = toAc.length();
  const dir = toAc.divideScalar(Math.max(dist, 1e-3));
  _right.set(1, 0, 0).applyQuaternion(cam.quaternion);
  const tm = aircraft.telemetry;
  audio.update(dt, {
    rpms: tm.motorRpm, airspeed: tm.airspeed, groundspeed: tm.groundspeed, onGround: aircraft.onGround,
    distance: rig.mode === 'fpv' ? 0.3 : dist, radialVel: aircraft.body.vel.dot(dir), pan: dir.dot(_right),
    onboard: rig.mode === 'fpv', impact: tm.impact, paused: !running,
  });
  tm.impact = 0;

  // dynamic resolution
  if (settings.autoQuality && running) {
    qualityTimer += dt;
    if (qualityTimer > 2) {
      qualityTimer = 0;
      if (fps < 42 && pixelRatio > 0.5) { pixelRatio = Math.max(0.5, pixelRatio * 0.85); renderer.setPixelRatio(pixelRatio); }
      else if (fps > 58 && pixelRatio < basePR) { pixelRatio = Math.min(basePR, pixelRatio * 1.08); renderer.setPixelRatio(pixelRatio); }
    }
  }

  if (fpv) {
    const analog = !isGimbal && settings.fpvVideo === 'analog';
    fpvfx.render(renderer, scene, rig.camera, {
      analog, lq: Math.max(0, linkQ + (analog ? (Math.random() - 0.5) * 0.06 : 0)), time: performance.now() / 1000,
      distortion: isGimbal ? 0 : aircraft.kind === 'quad' ? 0.42 : 0.3, lens: !isGimbal,
    }, dt);
    _eul.setFromQuaternion(renderQuat, 'YXZ');
    const tmo = aircraft.telemetry;
    const armedNow = aircraft instanceof FixedWing ? aircraft.motorArmed : (aircraft as Multirotor).armed;
    const warn = aircraft.crashed ? 'CRASH' : tmo.batteryPct < 3 ? 'BATTERY EMPTY' : (tmo.batteryPct < 20 || tmo.cellV < 3.45) ? 'LOW BATTERY'
      : tmo.stall ? 'STALL' : linkQ < 0.25 ? (isGimbal ? 'Weak Signal' : 'VIDEO WEAK') : '';
    osd.update(dt, {
      style: isGimbal ? 'dji' : 'betaflight', tm: tmo, armed: armedNow, modeName: tmo.modeName, lq: linkQ, flightTime,
      distance: renderPos.distanceTo(world.layout.pilot), pitchDeg: _eul.x * 57.3, rollDeg: -_eul.z * 57.3, headingDeg: _eul.y * 57.3,
      warning: warn, analog: !isGimbal && settings.fpvVideo === 'analog', frozen: fpvfx.frozen && !analog, imperial: settings.imperial,
    });
  } else renderer.render(scene, rig.camera);
}

document.getElementById('loading')?.remove();
requestAnimationFrame(frame);
void lastInputs;

// dev-only hook for automated visual checks
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__ll = { rig, get model() { return model; }, get aircraft() { return aircraft; }, renderer, scene };
