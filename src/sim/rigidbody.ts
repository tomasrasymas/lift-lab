import { Quaternion, Vector3 } from 'three';

/**
 * 6-DOF rigid body.
 * Body frame: +X right, +Y up, -Z forward (nose). Origin = centre of gravity.
 * Angular velocity and torque are stored in the BODY frame,
 * linear velocity and force in the WORLD frame.
 */
export class RigidBody {
  mass: number;
  /** Principal moments of inertia about body X (pitch), Y (yaw), Z (roll). */
  inertia: Vector3;

  pos = new Vector3();
  vel = new Vector3();
  quat = new Quaternion();
  angVel = new Vector3();

  force = new Vector3();
  torque = new Vector3();

  /** Gravity scale (1 normally). */
  gravity = 9.81;

  private tmp = new Vector3();
  private tmp2 = new Vector3();
  private qInv = new Quaternion();
  private qd = new Quaternion();

  constructor(mass: number, inertia: Vector3) {
    this.mass = mass;
    this.inertia = inertia.clone();
  }

  clearForces() {
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  toWorld(vBody: Vector3, out: Vector3) {
    return out.copy(vBody).applyQuaternion(this.quat);
  }

  toBody(vWorld: Vector3, out: Vector3) {
    this.qInv.copy(this.quat).invert();
    return out.copy(vWorld).applyQuaternion(this.qInv);
  }

  pointToWorld(pBody: Vector3, out: Vector3) {
    return out.copy(pBody).applyQuaternion(this.quat).add(this.pos);
  }

  /** Velocity of a body-fixed point, expressed in the body frame. */
  pointVelocityBody(pBody: Vector3, out: Vector3) {
    this.toBody(this.vel, out);
    this.tmp.copy(this.angVel).cross(pBody);
    return out.add(this.tmp);
  }

  /** Velocity of a body-fixed point, in world frame. */
  pointVelocityWorld(pBody: Vector3, out: Vector3) {
    this.tmp.copy(this.angVel).cross(pBody).applyQuaternion(this.quat);
    return out.copy(this.vel).add(this.tmp);
  }

  addForceBodyAt(fBody: Vector3, pBody: Vector3) {
    this.tmp.copy(fBody).applyQuaternion(this.quat);
    this.force.add(this.tmp);
    this.tmp2.copy(pBody).cross(fBody);
    this.torque.add(this.tmp2);
  }

  addForceWorldAt(fWorld: Vector3, pBody: Vector3) {
    this.force.add(fWorld);
    this.toBody(fWorld, this.tmp);
    this.tmp2.copy(pBody).cross(this.tmp);
    this.torque.add(this.tmp2);
  }

  addTorqueBody(t: Vector3) {
    this.torque.add(t);
  }

  integrate(dt: number) {
    // linear (semi-implicit Euler)
    this.vel.addScaledVector(this.force, dt / this.mass);
    this.vel.y -= this.gravity * dt;
    this.pos.addScaledVector(this.vel, dt);

    // angular: I*dw/dt = T - w x (I w)
    const I = this.inertia, w = this.angVel;
    const Iw = this.tmp.set(w.x * I.x, w.y * I.y, w.z * I.z);
    const gyro = this.tmp2.copy(w).cross(Iw);
    w.x += ((this.torque.x - gyro.x) / I.x) * dt;
    w.y += ((this.torque.y - gyro.y) / I.y) * dt;
    w.z += ((this.torque.z - gyro.z) / I.z) * dt;
    const maxW = 80;
    if (w.lengthSq() > maxW * maxW) w.setLength(maxW);

    // orientation: q' = 0.5 * q * (0, w)
    const q = this.quat;
    this.qd.set(w.x, w.y, w.z, 0);
    this.qd.premultiply(q);
    q.x += 0.5 * this.qd.x * dt;
    q.y += 0.5 * this.qd.y * dt;
    q.z += 0.5 * this.qd.z * dt;
    q.w += 0.5 * this.qd.w * dt;
    q.normalize();
  }

  /** Aero-style body rates (p roll right, q pitch up, r yaw right) in rad/s. */
  get p() { return -this.angVel.z; }
  get q() { return this.angVel.x; }
  get r() { return -this.angVel.y; }
}
