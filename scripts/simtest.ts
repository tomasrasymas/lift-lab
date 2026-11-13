/* Headless physics sanity checks: npm run simtest */
import { Euler } from 'three';
import { World } from '../src/sim/world';
import { createAircraft, AircraftId } from '../src/sim/presets';
import { neutralInputs, ControlInputs } from '../src/sim/aircraft';

const DT = 1 / 400;
const mapArg = (globalThis as unknown as { process: { argv: string[] } }).process.argv[3] as 'field' | 'forest' | 'city' | undefined;
const world = new World(mapArg ?? 'field');
world.wind.settings = { speed: 0, fromDeg: 90, gusts: 0, turbulence: 0 };
world.wind.update(0);

function run(id: AircraftId, inAir: boolean, seconds: number, ctl: (t: number, i: ControlInputs) => void, every = 2) {
  const ac = createAircraft(id);
  ac.reset(world, { inAir });
  const inp = neutralInputs();
  inp.arm = true;
  const e = new Euler();
  console.log(`\n== ${id} ${inAir ? 'in-air' : 'ground'} ==`);
  let next = 0;
  for (let t = 0; t <= seconds; t += DT) {
    ctl(t, inp);
    if (t < 0.05) inp.throttle = 0; // arming requires low throttle, like a real radio
    world.time = t;
    ac.step(DT, inp, world);
    if (t >= next) {
      next += every;
      e.setFromQuaternion(ac.body.quat, 'YXZ');
      const tm = ac.telemetry;
      console.log(
        `t=${t.toFixed(1).padStart(5)} spd=${tm.airspeed.toFixed(1).padStart(5)} alt=${tm.altitude.toFixed(1).padStart(6)} vs=${tm.vspeed.toFixed(2).padStart(6)} ` +
        `pitch=${(e.x * 57.3).toFixed(1).padStart(6)} bank=${(-e.z * 57.3).toFixed(1).padStart(6)} hdg=${(e.y * 57.3).toFixed(0).padStart(4)} aoa=${tm.aoa.toFixed(1).padStart(5)} ` +
        `g=${tm.gForce.toFixed(2)} bat=${tm.cellV.toFixed(2)}V/${tm.batteryPct.toFixed(0)}% ${tm.stall ? 'STALL' : ''} ${ac.crashed ? 'CRASH:' + ac.crashReason : ''} ${tm.armed ? '' : 'disarmed'}`,
      );
    }
  }
  return ac;
}

const which = (globalThis as unknown as { process: { argv: string[] } }).process.argv[2];
if (!which || which === 'trim') {
  for (const id of ['trainer'] as AircraftId[]) run(id, true, 20, (_t, i) => { i.throttle = 0.5; });
}
if (!which || which === 'takeoff') {
  run('trainer', false, 14, (t, i) => { i.throttle = t < 8 ? 1 : 0.5; i.pitch = t > 2.5 && t < 4 ? -0.2 : 0; }, 1);
}
if (!which || which === 'roll') {
  run('trainer', true, 6, (t, i) => { i.throttle = 0.5; i.roll = t < 1 ? 1 : 0; }, 0.25);
}
if (!which || which === 'stall') {
  run('trainer', true, 10, (t, i) => { i.throttle = 0; i.pitch = t > 2 ? -1 : 0; }, 0.5);
}
if (!which || which === 'quad') {
  run('fpv', false, 8, (t, i) => { i.throttle = t < 1 ? 0 : 0.36; i.mode = 1; }, 1);
  run('fpv', true, 4, (t, i) => { i.throttle = 0.33; i.mode = 0; i.roll = t > 1 && t < 1.55 ? 1 : 0; }, 0.25);
  run('drone', false, 12, (t, i) => { i.mode = 0; i.throttle = t < 1 ? 0 : t < 4 ? 0.9 : 0.5; i.pitch = t > 6 ? 1 : 0; }, 1);
}
if (!which || which === 'wind') {
  world.wind.settings = { speed: 6, fromDeg: 90, gusts: 0.5, turbulence: 0.5 };
  world.wind.update(0);
  run('drone', true, 10, (_t, i) => { i.mode = 0; i.throttle = 0.5; }, 2);
}

if (which === 'battery') {
  // hover / cruise until the pack is empty: flight time check
  for (const [id, thr, mode] of [['trainer', 0.6, 2], ['fpv', 0.36, 1], ['drone', 0.5, 0]] as [AircraftId, number, 0 | 1 | 2][]) {
    const ac = createAircraft(id);
    ac.reset(world, { inAir: true });
    const inp = neutralInputs(); inp.arm = true; inp.throttle = thr; inp.mode = mode;
    let t = 0;
    while (t < 3600 && ac.telemetry.batteryPct > 3 && !ac.crashed) { ac.step(DT * 4, inp, world); t += DT * 4; }
    console.log(`${id}: ${(t / 60).toFixed(1)} min, ${ac.telemetry.usedMah.toFixed(0)} mAh, cell ${ac.telemetry.cellV.toFixed(2)} V, alt ${ac.telemetry.altitude.toFixed(0)} m ${ac.crashed ? ac.crashReason : ''}`);
  }
}
