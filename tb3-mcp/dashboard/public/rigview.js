// tb3-mcp/dashboard/public/rigview.js
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import {
  panGroupRotationY, tiltGroupRotationX, boresightThreeJs,
  panArcPoints, tiltArcPoints, axisLimitState,
} from "./rigmath.js";

// Travel-limit envelope colors — deliberately the SAME hex values as
// style.css's --green/--yellow/--red tokens, so the 3D view and the rest of
// the dashboard's warning language agree. THREE.Color/Line take numeric hex,
// not CSS custom properties, hence the duplication here.
const LIMIT_COLORS = { ok: 0x3fb950, warn: 0xd29922, at: 0xf85149 };
const ARC_RADIUS = 1.8;      // inside the boresight arrow's own length (2.2)
const ARC_SEGMENTS_PAN = 48;
const ARC_SEGMENTS_TILT = 24;

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

    // Travel-limit envelope: two thin arcs tracing the permitted pan/tilt
    // sweep (Task Part 3) — geometry from rigmath.js's panArcPoints/
    // tiltArcPoints, colored green/amber/red by axisLimitState. Hidden
    // (visible=false) until update() receives a real `limits` snapshot, so a
    // pre-poll/degraded dashboard state never draws a fabricated envelope.
    // Shares the boresight arrow's origin (0, 0.85, 0) so both read as one
    // gauge: the arrow is the needle, the arcs are the dial.
    const arcOrigin = new THREE.Vector3(0, 0.85, 0);
    this.panArcGeom = new THREE.BufferGeometry();
    this.panArcLine = new THREE.Line(
      this.panArcGeom, new THREE.LineBasicMaterial({ color: LIMIT_COLORS.ok }),
    );
    this.panArcLine.position.copy(arcOrigin);
    this.panArcLine.visible = false;
    this.scene.add(this.panArcLine);

    this.tiltArcGeom = new THREE.BufferGeometry();
    this.tiltArcLine = new THREE.Line(
      this.tiltArcGeom, new THREE.LineBasicMaterial({ color: LIMIT_COLORS.ok }),
    );
    this.tiltArcLine.position.copy(arcOrigin);
    this.tiltArcLine.visible = false;
    this.scene.add(this.tiltArcLine);

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

  // Pose the model from rig.panDeg/tiltDeg (holds at 0/0 when there's no rig
  // yet). `limits` is the effective (taught-or-config) pan/tilt range —
  // { panMinDeg, panMaxDeg, tiltMinDeg, tiltMaxDeg } — or null/undefined
  // before the dashboard's first successful poll of it; the envelope simply
  // stays hidden until then rather than drawing a fabricated range.
  update(rig, limits) {
    if (!this.ok) return;
    const pan = rig && Number.isFinite(rig.panDeg) ? rig.panDeg : 0;
    const tilt = rig && Number.isFinite(rig.tiltDeg) ? rig.tiltDeg : 0;
    const hasTel = !!(rig && rig.connected && Number.isFinite(rig.panDeg));

    // Turntable about +Y; tilt about the turntable's local X. Rotation angles come
    // from rigmath.js (panGroupRotationY/tiltGroupRotationX) so the model pose and
    // the boresight arrow below are always derived from one shared mapping instead
    // of two independently-tweaked sign choices — see rigmath.js for the full
    // derivation. Tilt was field-confirmed inverted (positive tilt pitched the
    // model down while the real camera pitched up) and corrected 2026-07-27; pan
    // was reported reading correctly during that same bring-up and is unchanged
    // (it still negates pan because the rig reads az = base − pan).
    this.panGroup.rotation.y = panGroupRotationY(pan);
    this.tiltGroup.rotation.x = tiltGroupRotationX(tilt);

    // Boresight arrow: same ENU → Three.js mapping used to derive the rotations
    // above (see enuToThreeJs in rigmath.js), so the arrow always agrees with the
    // model and with the real rig's up/down sense.
    const tv = boresightThreeJs(pan, tilt);
    this.boresight.setDirection(new THREE.Vector3(tv.x, tv.y, tv.z).normalize());

    this._updateLimitEnvelope(pan, tilt, limits);

    // Dim when there's no live telemetry (holds at 0/0).
    this.renderer.domElement.style.opacity = hasTel ? "1" : "0.45";
    this.requestRender();
  }

  // Draws (or hides) the travel-limit envelope and colors it + the boresight
  // arrow by how close the current pose is to each axis's edge. Pure
  // geometry/classification lives in rigmath.js; this method only turns that
  // into THREE objects.
  _updateLimitEnvelope(pan, tilt, limits) {
    const visible = !!limits
      && Number.isFinite(limits.panMinDeg) && Number.isFinite(limits.panMaxDeg)
      && Number.isFinite(limits.tiltMinDeg) && Number.isFinite(limits.tiltMaxDeg);
    this.panArcLine.visible = visible;
    this.tiltArcLine.visible = visible;
    if (!visible) {
      // No envelope to compare against — leave the arrow at its plain
      // default color rather than guessing a proximity state.
      this.boresight.setColor(new THREE.Color(0xffc107));
      return;
    }

    const panPts = panArcPoints(limits.panMinDeg, limits.panMaxDeg, tilt, ARC_RADIUS, ARC_SEGMENTS_PAN);
    this.panArcGeom.setFromPoints(panPts.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
    const panState = axisLimitState(pan, limits.panMinDeg, limits.panMaxDeg);
    this.panArcLine.material.color.setHex(LIMIT_COLORS[panState]);

    const tiltPts = tiltArcPoints(limits.tiltMinDeg, limits.tiltMaxDeg, pan, ARC_RADIUS, ARC_SEGMENTS_TILT);
    this.tiltArcGeom.setFromPoints(tiltPts.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
    const tiltState = axisLimitState(tilt, limits.tiltMinDeg, limits.tiltMaxDeg);
    this.tiltArcLine.material.color.setHex(LIMIT_COLORS[tiltState]);

    // The arrow itself only ever turns red — "you have stopped, here is
    // why" — rather than also carrying the amber "warn" state, so it stays
    // legible as a single unmissable cue instead of competing with the arcs'
    // own finer-grained gradient.
    const atLimit = panState === "at" || tiltState === "at";
    this.boresight.setColor(new THREE.Color(atLimit ? LIMIT_COLORS.at : 0xffc107));
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
