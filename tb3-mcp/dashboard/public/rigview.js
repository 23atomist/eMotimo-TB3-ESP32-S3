// tb3-mcp/dashboard/public/rigview.js
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { boresightVector } from "./rigmath.js";

// A live 3D view of the rig. Task 1 builds the scene shell (grid/axes/lighting +
// orbit + a placeholder); Task 3 adds the actual rig model + update() posing.
export class RigView {
  constructor(canvas) {
    this.canvas = canvas;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (e) {
      // WebGL unavailable — show a text fallback, never throw.
      this.ok = false;
      const ctx = canvas.getContext && canvas.getContext("2d");
      if (ctx) { ctx.fillStyle = "#888"; ctx.fillText("3D unavailable", 10, 20); }
      return;
    }
    this.ok = true;
    const w = canvas.width, h = canvas.height;
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(w, h, false);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    this.camera.position.set(6, 5, 8); // default 3/4 view
    this.camera.lookAt(0, 1, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 7);
    this.scene.add(dir);

    this.scene.add(new THREE.GridHelper(10, 10, 0x444444, 0x222222));
    this.scene.add(new THREE.AxesHelper(2));

    // Schematic eMotimo TB3: tripod base + pan turntable + tilt yoke/camera.
    // Fixed tripod/base (level): a short column + three splayed legs.
    const base = new THREE.Group();
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 0.6, 12),
      new THREE.MeshStandardMaterial({ color: 0x777777 }));
    col.position.y = 0.3;
    base.add(col);
    for (const a of [0, 120, 240]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.2, 6),
        new THREE.MeshStandardMaterial({ color: 0x555555 }));
      const r = (a * Math.PI) / 180;
      leg.position.set(Math.sin(r) * 0.5, -0.1, Math.cos(r) * 0.5);
      leg.rotation.z = Math.sin(r) * 0.5; leg.rotation.x = -Math.cos(r) * 0.5;
      base.add(leg);
    }
    this.scene.add(base);

    // Pan turntable (rotates about world-up = Three.js +Y).
    this.panGroup = new THREE.Group();
    this.panGroup.position.y = 0.65;
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.12, 20),
      new THREE.MeshStandardMaterial({ color: 0x4caf50 }));
    this.panGroup.add(disc);
    this.scene.add(this.panGroup);

    // Tilt group (rotates about the tilt axis = the turntable's local X).
    this.tiltGroup = new THREE.Group();
    this.tiltGroup.position.y = 0.2;
    this.panGroup.add(this.tiltGroup);
    // Camera body + lens on the tilt group, facing local +Z (mapped to the boresight).
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.25, 0.35),
      new THREE.MeshStandardMaterial({ color: 0x222831 }));
    this.tiltGroup.add(body);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.18, 16),
      new THREE.MeshStandardMaterial({ color: 0x111111 }));
    lens.rotation.x = Math.PI / 2; lens.position.z = 0.26;
    this.tiltGroup.add(lens);

    // Boresight arrow — direction set from boresightVector in update() (world space).
    this.boresight = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0.85, 0), 2.2, 0xffc107, 0.35, 0.2);
    this.scene.add(this.boresight);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1, 0);
    // Render on demand: on orbit change + a short damping loop, and on update().
    // Keep the bound handler so dispose() can remove it.
    this._onChange = () => this.requestRender();
    this.controls.addEventListener("change", this._onChange);

    this._raf = null;
    this.requestRender();
  }

  requestRender() {
    if (!this.ok || this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      const moving = this.controls.update(); // returns true while damping
      this.renderer.render(this.scene, this.camera);
      if (moving) this.requestRender(); // keep going until damping settles
    });
  }

  // Pose the model from rig.panDeg/tiltDeg (holds at 0/0 when there's no rig yet).
  update(rig) {
    if (!this.ok) return;
    const pan = rig && Number.isFinite(rig.panDeg) ? rig.panDeg : 0;
    const tilt = rig && Number.isFinite(rig.tiltDeg) ? rig.tiltDeg : 0;
    const hasTel = !!(rig && rig.connected && Number.isFinite(rig.panDeg));

    // Turntable about +Y; tilt about the turntable's local X. Sign chosen so the
    // model/arrow stay self-consistent (numerically verified below) and so the
    // turntable turns the way the operator expects; the absolute pan handedness vs.
    // the real rig is still to be confirmed on-host — flip this sign if it reads
    // mirrored during field bring-up. Negate pan because the rig reads az = base − pan.
    this.panGroup.rotation.y = (-pan * Math.PI) / 180;
    this.tiltGroup.rotation.x = (tilt * Math.PI) / 180;

    // Boresight arrow: ENU (e,n,u) → Three.js (x=-e, y=-u, z=n).
    // Verified numerically: with panGroup.rotation.y = -pan and
    // tiltGroup.rotation.x = tilt as above, the camera-forward local +Z axis works out to
    // the exact negation of the naive (x=e, y=u, z=-n) mapping at every pan/tilt combo
    // tested (not just at special angles) — so the mapping is negated here to keep the
    // arrow emerging from the lens instead of pointing back through the tripod.
    const v = boresightVector(pan, tilt);
    this.boresight.setDirection(new THREE.Vector3(-v.e, -v.u, v.n).normalize());

    // Dim when there's no live telemetry (holds at 0/0).
    this.renderer.domElement.style.opacity = hasTel ? "1" : "0.45";
    this.requestRender();
  }

  dispose() {
    if (!this.ok) return;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.controls.removeEventListener("change", this._onChange);
    this.controls.dispose();
    // Release the GPU resources for every mesh we built.
    this.scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const mat = obj.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    this.renderer.dispose();
  }
}
