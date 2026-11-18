import * as THREE from 'three';
import type { World } from '../sim/world';
import { clamp, dampFactor } from '../sim/math';
import type { ViewMode } from '../settings';
import type { AircraftModel } from './models';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  mode: ViewMode = 'los';
  autoZoom = true;
  fpvFov = 100;
  private lookTarget = new THREE.Vector3();
  private chaseYaw = 0;
  private chaseInit = false;
  private shake = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.05, 9000);
    this.camera.position.set(0, 1.7, 26);
  }

  setMode(m: ViewMode) {
    this.mode = m;
    this.chaseInit = false;
  }

  snap(target: THREE.Vector3) {
    this.lookTarget.copy(target);
    this.chaseInit = false;
  }

  update(dt: number, model: AircraftModel, pos: THREE.Vector3, quat: THREE.Quaternion, vel: THREE.Vector3, world: World, opts: { gimbal: boolean; gimbalTilt: number; kind: 'plane' | 'quad' }) {
    const cam = this.camera;
    if (this.mode === 'los') {
      const PILOT_POS = world.layout.pilot;
      cam.position.copy(PILOT_POS);
      // the eye tracks smoothly, slightly lagging like a human head
      this.lookTarget.lerp(pos, dampFactor(14, dt));
      cam.up.copy(UP);
      cam.lookAt(this.lookTarget);
      const dist = PILOT_POS.distanceTo(pos);
      let fov = 55;
      if (this.autoZoom) {
        // keep the aircraft at a readable size on screen, like a real eye focusing on it
        const want = (2 * Math.atan((model.size * 8) / Math.max(dist, 1)) * 180) / Math.PI;
        fov = clamp(want, 7, 55);
      }
      cam.fov += (fov - cam.fov) * dampFactor(3, dt);
    } else if (this.mode === 'chase') {
      const back = opts.kind === 'quad' ? 1.6 : 3.2 * Math.max(0.8, model.size);
      const up = opts.kind === 'quad' ? 0.55 : 0.9;
      // Heading to sit behind. Only the compass heading is followed, so rolls and flips
      // never swing the camera around; when no heading can be read it holds the last one.
      const nose = _v.set(0, 0, -1).applyQuaternion(quat);
      const upright = _v2.set(0, 1, 0).applyQuaternion(quat).y;
      const hSpeed = Math.hypot(vel.x, vel.z);
      let hx = 0, hz = 0, valid = false;
      if (opts.kind === 'plane' && hSpeed > 3) {
        // a plane goes where it flies: the flight path stays readable through rolls
        hx = vel.x; hz = vel.z; valid = true;
      } else if (Math.hypot(nose.x, nose.z) > 0.35 && upright > 0.15) {
        hx = nose.x; hz = nose.z; valid = true;
      }
      if (valid) {
        const target = Math.atan2(hx, -hz);
        if (!this.chaseInit) this.chaseYaw = target;
        const d = Math.atan2(Math.sin(target - this.chaseYaw), Math.cos(target - this.chaseYaw));
        this.chaseYaw += d * dampFactor(opts.kind === 'quad' ? 9 : 5, dt);
      }
      this.chaseInit = true;
      const dir = _v.set(Math.sin(this.chaseYaw), 0, -Math.cos(this.chaseYaw));
      // locked straight behind the aircraft: no positional lag, so it cannot fall behind or drift sideways
      cam.position.copy(pos).addScaledVector(dir, -back).addScaledVector(UP, up);
      const gh = world.terrain.heightAt(cam.position.x, cam.position.z);
      if (cam.position.y < gh + 0.3) cam.position.y = gh + 0.3;
      cam.up.copy(UP);
      cam.lookAt(_v2.copy(pos).addScaledVector(dir, 1.5));
      cam.fov += (65 - cam.fov) * dampFactor(4, dt);
    } else {
      // FPV / cockpit camera
      model.fpvAnchor.getWorldPosition(cam.position);
      if (opts.gimbal) {
        // stabilised gimbal: only follow yaw, fixed tilt
        _e.setFromQuaternion(quat, 'YXZ');
        _q.setFromEuler(_e.set(opts.gimbalTilt * Math.PI / 180, _e.y, 0, 'YXZ'));
        cam.quaternion.slerp(_q, dampFactor(12, dt));
      } else {
        cam.quaternion.copy(quat);
        if (opts.kind === 'quad') cam.quaternion.multiply(_q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), opts.gimbalTilt * Math.PI / 180));
      }
      // vibration
      this.shake = Math.min(1, vel.length() / 40);
      if (this.shake > 0 && !opts.gimbal) {
        const t = performance.now() * 0.05;
        cam.position.x += Math.sin(t * 7.1) * 0.0008 * this.shake;
        cam.position.y += Math.sin(t * 9.7) * 0.0008 * this.shake;
      }
      // render wider than the final view: the lens shader compresses the edges (fisheye)
      const hfov = opts.gimbal ? 82 : Math.min(150, this.fpvFov + 18);
      // convert horizontal FOV to vertical
      const vfov = (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / cam.aspect) * 180) / Math.PI;
      cam.fov = vfov;
    }
    cam.near = this.mode === 'fpv' ? 0.03 : 0.15;
    cam.updateProjectionMatrix();
  }
}
