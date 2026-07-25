// tb3-mcp/dashboard/public/rigview.js
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";

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

    // Placeholder marker (replaced by the rig model in Task 3).
    this.rigGroup = new THREE.Group();
    this.rigGroup.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x4caf50 }),
    ));
    this.scene.add(this.rigGroup);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1, 0);
    // Render on demand: on orbit change + a short damping loop, and on update().
    this.controls.addEventListener("change", () => this.requestRender());

    this._needsRender = true;
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

  // Task 3 fills this in (pose the model from rig.panDeg/tiltDeg). Safe stub now.
  update(_rig) { if (this.ok) this.requestRender(); }

  dispose() {
    if (!this.ok) return;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.controls.dispose();
    this.renderer.dispose();
  }
}
