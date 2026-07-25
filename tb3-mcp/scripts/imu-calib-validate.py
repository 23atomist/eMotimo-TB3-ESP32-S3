#!/usr/bin/env python3
"""
Standalone validation of an IMU-aided calibration solver for the TB3 rig.
Does NOT touch daemon source. Replicates the repo's geo helpers verbatim
(src/geo/wgs84.ts, boresight.ts) and cross-checks against ground-truth ENU
printed by scripts/imu-calib-groundtruth.mjs (which imports the compiled repo).

Model (matches docs/.../2026-07-22-imu-aided-calibration-design.md + task):
  World = ENU. down g_w = [0,0,-1].
  R  : mount-frame -> world (base orientation).
  M(pan,tilt) = Rz(-pan)*Rx(tilt)  (head-in-mount; M*[0,1,0] == panTiltToMount).
  c_head : FIXED unit camera-boresight vector in the HEAD frame (unknown, ~+Y).
  boresight_world(pan,tilt) = R * M(pan,tilt) * c_head.
  IMU:  g_s(pan,tilt) = R_s^T * M(pan,tilt)^T * d_base,  d_base = R^T*g_w.
        => M*R_s*g_s = d_base (constant).  d_base = base-frame DOWN vector.
"""
import json
import math
import numpy as np

np.set_printoptions(precision=6, suppress=True)

# ----------------------------------------------------------------------------
# Repo geo helpers, replicated EXACTLY from src/geo/wgs84.ts
# ----------------------------------------------------------------------------
A_WGS = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)


def geodetic_to_ecef(lat, lon, height):
    la, lo = math.radians(lat), math.radians(lon)
    sla, cla = math.sin(la), math.cos(la)
    n = A_WGS / math.sqrt(1 - E2 * sla * sla)
    x = (n + height) * cla * math.cos(lo)
    y = (n + height) * cla * math.sin(lo)
    z = (n * (1 - E2) + height) * sla
    return np.array([x, y, z])


def enu_direction(rig, tgt):
    la, lo = math.radians(rig["lat"]), math.radians(rig["lon"])
    sla, cla, slo, clo = math.sin(la), math.cos(la), math.sin(lo), math.cos(lo)
    d = geodetic_to_ecef(tgt["lat"], tgt["lon"], tgt["height"]) - geodetic_to_ecef(
        rig["lat"], rig["lon"], rig["height"])
    dx, dy, dz = d
    e = -slo * dx + clo * dy
    n = -sla * clo * dx - sla * slo * dy + cla * dz
    u = cla * clo * dx + cla * slo * dy + sla * dz
    enu = np.array([e, n, u])
    return enu / np.linalg.norm(enu), np.linalg.norm(enu)


def az_el(unit):
    az = math.degrees(math.atan2(unit[0], unit[1]))
    if az < 0:
        az += 360.0
    el = math.degrees(math.asin(max(-1, min(1, unit[2]))))
    return az, el


def unit_from_azel(az_deg, el_deg):
    a, e = math.radians(az_deg), math.radians(el_deg)
    return np.array([math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)])


# ----------------------------------------------------------------------------
# Mount kinematics (matches src/geo/boresight.ts panTiltToMount)
# ----------------------------------------------------------------------------
def Rz(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def Rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def M(pan_deg, tilt_deg):
    return Rz(math.radians(-pan_deg)) @ Rx(math.radians(tilt_deg))


def pan_tilt_to_mount(pan_deg, tilt_deg):
    p, t = math.radians(pan_deg), math.radians(tilt_deg)
    ct = math.cos(t)
    return np.array([math.sin(p) * ct, math.cos(p) * ct, math.sin(t)])


for (p, t) in [(-26, -31), (12, 40), (-125.2, -27.3)]:
    assert np.allclose(M(p, t) @ np.array([0, 1.0, 0]), pan_tilt_to_mount(p, t), atol=1e-12)
print("OK  M(pan,tilt)*[0,1,0] == panTiltToMount  (convention matches boresight.ts)")


def kabsch(src, dst):
    """Rotation Rk minimizing sum|Rk*src_i - dst_i|^2 (rows = unit vectors)."""
    H = src.T @ dst
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    return Vt.T @ np.diag([1, 1, d]) @ U.T


def rot_align(a, b):
    """Smallest rotation taking unit a -> unit b (Rodrigues)."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if np.linalg.norm(v) < 1e-12:
        return np.eye(3) if c > 0 else -np.eye(3) + 2 * np.outer(
            *(lambda k: (k, k))(np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0, 1.0, 0])))
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1 / (1 + c))


# ----------------------------------------------------------------------------
# Field data
# ----------------------------------------------------------------------------
with open("/private/tmp/claude-501/-Volumes-ExtData2-coding-TB3-ESP32/"
          "ac862f83-5c7e-4bc7-a9f4-c02e75fa94b0/scratchpad/imu-sweep-2026-07-22.json") as f:
    data = json.load(f)

rig = data["rig"]
sight = {s["label"]: s for s in data["sightings_at_solve"]}
sweep = data["sweep"]

enuA, rngA = enu_direction(rig, sight["A_towers"])
enuB, rngB = enu_direction(rig, sight["B_peak"])
azA, elA = az_el(enuA)
azB, elB = az_el(enuB)
print("\n--- ground-truth landmark directions (replicated wgs84.ts) ---")
print(f"A_towers enu={enuA}  az={azA:.4f} el={elA:.4f} range={rngA:.1f}m")
print(f"B_peak   enu={enuB}  az={azB:.4f} el={elB:.4f} range={rngB:.1f}m")
assert abs(azA - 127.1365) < 1e-3 and abs(elA - 3.7219) < 1e-3
assert abs(azB - 226.1561) < 1e-3 and abs(elB - 3.3475) < 1e-3
print("OK  Python ENU matches repo dist/geo ground truth (az/el within 1e-3 deg)")

# ============================================================================
# CONVENTION: the daemon stores USER-frame pan/tilt and feeds them straight to
# panTiltToMount. The field data has az ~= 101 - pan (slope -1) but panTiltToMount
# gives mount-az = +pan (slope +1); a proper rotation cannot flip that slope, so
# the geo mount kinematics need the opposite pan handedness. We pin (ps, ts) with
# an empirical search: MM(pan,tilt) = M(ps*pan, ts*tilt).
# ============================================================================
gsrc = np.array([[s["ax"], s["ay"], s["az"]] for s in sweep], float)
gsrc /= np.linalg.norm(gsrc, axis=1, keepdims=True)


def MM(pan, tilt, ps, ts):
    return M(ps * pan, ts * tilt)


def solve_Rs(dbase, ts, ps=1):
    Mi = [MM(s["pan"], s["tilt"], ps, ts) for s in sweep]
    wt = np.array([Mi_k.T @ dbase for Mi_k in Mi])
    wt /= np.linalg.norm(wt, axis=1, keepdims=True)
    Rs = kabsch(gsrc, wt)
    res = [math.degrees(math.acos(max(-1, min(1, np.dot(Rs @ gsrc[i], wt[i])))))
           for i in range(len(sweep))]
    return Rs, res


def solve_dbase(ts, ps):
    """Joint R_s + d_base from the sweep (IMU-only tripod attitude)."""
    dbase = np.array([0, 0, -1.0])
    Mi = [MM(s["pan"], s["tilt"], ps, ts) for s in sweep]
    for _ in range(500):
        Rs, _ = solve_Rs(dbase, ts, ps)
        v = np.array([Mi[i] @ Rs @ gsrc[i] for i in range(len(sweep))]).mean(axis=0)
        nv = v / np.linalg.norm(v)
        if np.allclose(nv, dbase, atol=1e-13):
            dbase = nv
            break
        dbase = nv
    Rs, res = solve_Rs(dbase, ts, ps)
    return dbase, Rs, res


def calibrate(dbase_used, ps, ts):
    R0 = rot_align(-dbase_used, np.array([0, 0, 1.0]))   # R = Rz(h)*R0
    rows, sel = [], []
    for s, el in [(sight["A_towers"], elA), (sight["B_peak"], elB)]:
        rows.append((R0 @ MM(s["panDeg"], s["tiltDeg"], ps, ts))[2])
        sel.append(math.sin(math.radians(el)))
    N = np.array(rows)
    c0 = np.linalg.pinv(N) @ np.array(sel)
    nz = np.cross(N[0], N[1])
    nz /= np.linalg.norm(nz)
    disc = 1 - float(np.dot(c0, c0))
    if disc < 0:
        return None
    cand_list = []
    for t in (math.sqrt(disc), -math.sqrt(disc)):
        c = c0 + t * nz
        hs = []
        for s, w in [(sight["A_towers"], enuA), (sight["B_peak"], enuB)]:
            p = R0 @ MM(s["panDeg"], s["tiltDeg"], ps, ts) @ c
            azp = math.degrees(math.atan2(p[0], p[1]))
            azw, _ = az_el(w / np.linalg.norm(w))
            hs.append((azp - azw) % 360)
        dh = abs((hs[0] - hs[1] + 180) % 360 - 180)
        hr = [math.radians(h) for h in hs]
        hz = math.degrees(math.atan2(sum(math.sin(x) for x in hr),
                                     sum(math.cos(x) for x in hr))) % 360
        R = Rz(math.radians(hz)) @ R0
        ferr = []
        for s, w in [(sight["A_towers"], enuA), (sight["B_peak"], enuB)]:
            bw = R @ (MM(s["panDeg"], s["tiltDeg"], ps, ts) @ c)
            bw /= np.linalg.norm(bw)
            ferr.append(math.degrees(math.acos(max(-1, min(1, np.dot(bw, w / np.linalg.norm(w)))))))
        # camera boresight azimuth at pan0,tilt0 -> should be ~101 ('az=101-pan' at pan0)
        b00 = R @ (MM(0, 0, ps, ts) @ c)
        az00, _ = az_el(b00 / np.linalg.norm(b00))
        pitch = math.degrees(math.atan2(c[2], math.hypot(c[0], c[1])))
        cand_list.append({"c": c, "R": R, "hs": hs, "dh": dh, "hz": hz, "ferr": ferr,
                          "pitch": pitch, "ps": ps, "ts": ts, "dbase": dbase_used,
                          "az00": az00})
    # DISAMBIGUATION: 2 near-horizon landmarks + gravity admit TWO solutions.
    # Prefer the physical one (camera looks forward: c_head . +Y > 0); fall back
    # to best heading-agreement only if the prior can't decide.
    physical = [d for d in cand_list if d["c"][1] > 0]
    best = min(physical or cand_list, key=lambda d: d["dh"])
    best["both"] = cand_list
    return best


print("\n=== CONVENTION SEARCH: pan handedness into the mount kinematics ===")
print("  (tilt_sign fixed at +1: the M=Rz(-pan)Rx(tilt) kinematics are verified with")
print("   tilt as-given; ts=-1 is a mirror gauge that just negates c_head. Only the")
print("   pan handedness was genuinely uncertain.)")
print(" ps ts | tripod_tilt Rs_rms | head_disagree fwd_errA fwd_errB | c_head_pitch  c_head")
cands = []
for ps in (1, -1):
    for ts in (1,):
        db, Rs, res = solve_dbase(ts, ps)
        tt = math.degrees(math.acos(max(-1, min(1, np.dot(-db, [0, 0, 1])))))
        rms = math.sqrt(np.mean(np.square(res)))
        sol_c = calibrate(db, ps, ts)
        if sol_c is None:
            print(f" {ps:+d} {ts:+d} | c_head has no real solution (|c0|>1)")
            continue
        cands.append(sol_c)
        print(f" {ps:+d} {ts:+d} | {tt:8.2f} {rms:8.2f} | {sol_c['dh']:11.3f} "
              f"{sol_c['ferr'][0]:8.3f} {sol_c['ferr'][1]:8.3f} | {sol_c['pitch']:8.2f}  "
              f"{np.array2string(sol_c['c'], precision=3)}")

# winner = smallest heading disagreement (the geometric over-determination check)
sol = min(cands, key=lambda s: s["dh"])
ps, ts = sol["ps"], sol["ts"]
dbase = sol["dbase"]
tripod_tilt = math.degrees(math.acos(max(-1, min(1, np.dot(-dbase, [0, 0, 1])))))
Rs_win, res_win = solve_Rs(dbase, ts, ps)
print(f"\n=> WINNING convention: pan_sign={ps:+d}, tilt_sign={ts:+d} "
      f"(mount kinematics use panTiltToMount({'-' if ps<0 else ''}pan,"
      f"{'-' if ts<0 else ''}tilt))")

print("\n=== TASK 1: R_s from sweep (winning convention) ===")
print("R_s =\n", Rs_win)
print(f"det(R_s)={np.linalg.det(Rs_win):+.6f}")
print("per-sample residual (deg):", "  ".join(f"{r:.2f}" for r in res_win),
      f"  | rms={math.sqrt(np.mean(np.square(res_win))):.2f} max={max(res_win):.2f}")
print(f"IMU-only tripod tilt from vertical = {tripod_tilt:.2f} deg  (d_base={dbase})")


def MMw(pan, tilt):
    return MM(pan, tilt, ps, ts)


c_head = sol["c"]
R = sol["R"]

# interpret c_head as offset from mechanical forward +Y
ang_fwd = math.degrees(math.acos(max(-1, min(1, np.dot(c_head, [0, 1, 0])))))
pitch_up = math.degrees(math.atan2(c_head[2], math.hypot(c_head[0], c_head[1])))
yaw_off = math.degrees(math.atan2(c_head[0], c_head[1]))
fwd_world = R @ np.array([0, 1.0, 0])
heading_fwd, _ = az_el(fwd_world / np.linalg.norm(fwd_world))
base_tilt = math.degrees(math.acos(max(-1, min(1, np.dot(R @ np.array([0, 0, 1.0]), [0, 0, 1])))))
print("\n=== TASK 2: calibration (gravity-anchored vertical + 2 landmarks) ===")
print(f"c_head = {c_head}")
print(f"  |c_head| = {np.linalg.norm(c_head):.6f}")
print(f"  angle from mechanical-forward +Y = {ang_fwd:.2f} deg")
print(f"  camera pitch-up above forward     = {pitch_up:.2f} deg  (expected ~ +34)")
print(f"  camera yaw offset from forward     = {yaw_off:.2f} deg")
print(f"heading per-landmark: A={sol['hs'][0]:.3f}  B={sol['hs'][1]:.3f}  "
      f"(disagreement {sol['dh']:.4f} deg)")
print(f"reported heading (az of forward @ pan0,tilt0) = {heading_fwd:.3f} deg")
print(f"sanity 'az ~= 101 - pan': A:101-({sight['A_towers']['panDeg']})="
      f"{101 - sight['A_towers']['panDeg']:.1f} vs {azA:.1f} ; "
      f"B:101-({sight['B_peak']['panDeg']})={101 - sight['B_peak']['panDeg']:.1f} vs {azB:.1f}")
print(f"base_tilt (mount-up vs vertical) = {base_tilt:.2f} deg  (was 144.56 broken TRIAD)")
print(f"camera boresight az at pan0,tilt0 = {sol['az00']:.2f} deg  (expected ~101 from 'az=101-pan')")
print("R (mount->world) =\n", R)
print("\n  two c_head candidates (sphere ∩ two elevation planes) for winning convention:")
for i, cc in enumerate(sol["both"]):
    print(f"   cand{i}: dh={cc['dh']:.3f}  fwd_err=({cc['ferr'][0]:.3f},{cc['ferr'][1]:.3f})  "
          f"pitch={cc['pitch']:+.2f}  az@pan0={cc['az00']:.2f}  c={np.array2string(cc['c'], precision=3)}")

# ============================================================================
# TASK 3 — forward + inverse validation  (uses winning convention MMw)
# ============================================================================
def boresight_world(pan, tilt, Rm=R, ch=c_head):
    return Rm @ (MMw(pan, tilt) @ ch)


print("\n=== TASK 3a: FORWARD (boresight_world(sighting pan,tilt) -> landmark?) ===")
for name, s, w in [("A_towers", sight["A_towers"], enuA), ("B_peak", sight["B_peak"], enuB)]:
    bw = boresight_world(s["panDeg"], s["tiltDeg"])
    bw /= np.linalg.norm(bw)
    az, el = az_el(bw)
    azt, elt = az_el(w)
    ang = math.degrees(math.acos(max(-1, min(1, np.dot(bw, w / np.linalg.norm(w))))))
    print(f"  {name}: pred az={az:.3f} el={el:.3f} | target az={azt:.3f} el={elt:.3f} "
          f"| daz={(az-azt+180)%360-180:+.4f} del={el-elt:+.4f} | ang err={ang:.4f} deg")


TILT_MIN, TILT_MAX = -90.0, 90.0   # device tilt limits (cfg.tiltMin/tiltMax)
PAN_MIN, PAN_MAX = -180.0, 180.0


def inverse_all(az_deg, el_deg, Rm=R, ch=c_head):
    """All (pan,tilt) postures whose boresight hits the target (both tilt roots)."""
    w = unit_from_azel(az_deg, el_deg)
    m = Rm.T @ w
    cy, cz = ch[1], ch[2]
    Rmag = math.hypot(cy, cz)
    phi = math.atan2(cz, cy)
    val = max(-1, min(1, m[2] / Rmag))
    out = []
    for base in (math.asin(val), math.pi - math.asin(val)):
        T = (base - phi + math.pi) % (2 * math.pi) - math.pi          # geo tilt
        u = Rx(T) @ ch
        P = math.atan2(m[0], m[1]) - math.atan2(u[0], u[1])           # geo pan
        pan = (math.degrees(P) * ps + 180) % 360 - 180                 # user pan
        tilt = math.degrees(T) * ts                                    # user tilt
        bw = boresight_world(pan, tilt, Rm, ch)
        err = math.degrees(math.acos(max(-1, min(1, np.dot(bw / np.linalg.norm(bw), w)))))
        out.append({"err": err, "pan": pan, "tilt": tilt,
                    "in_range": TILT_MIN <= tilt <= TILT_MAX and PAN_MIN <= pan <= PAN_MAX})
    return out


def inverse(az_deg, el_deg, Rm=R, ch=c_head, prefer=None):
    """Best posture: in-range solutions first (closest to `prefer` tilt), then err."""
    sols = inverse_all(az_deg, el_deg, Rm, ch)
    ranged = [s for s in sols if s["in_range"]]
    pool = ranged if ranged else sols
    if prefer is not None and ranged:
        pool = sorted(pool, key=lambda s: abs(s["tilt"] - prefer))
    else:
        pool = sorted(pool, key=lambda s: (s["err"], abs(s["tilt"])))
    s = pool[0]
    return s["err"], s["pan"], s["tilt"], s["in_range"]


print("\n=== TASK 3b: INVERSE (recover sighting pan/tilt from landmark az/el) ===")
for name, s, w in [("A_towers", sight["A_towers"], enuA), ("B_peak", sight["B_peak"], enuB)]:
    azt, elt = az_el(w)
    allsol = inverse_all(azt, elt)
    err, pan, tilt, inr = inverse(azt, elt, prefer=s["tiltDeg"])
    print(f"  {name}: in-range posture pan={pan:.2f} tilt={tilt:.2f} | recorded pan={s['panDeg']} "
          f"tilt={s['tiltDeg']} | dpan={pan-s['panDeg']:+.2f} dtilt={tilt-s['tiltDeg']:+.2f} | fwd-err={err:.4f}")
    print(f"          all branches: " +
          " ; ".join(f"pan={a['pan']:.1f} tilt={a['tilt']:.1f}{' [in-range]' if a['in_range'] else ''}"
                     for a in allsol))

print("\n=== TASK 3c: HIGH targets must NOT point into the ground ===")
for (az_t, el_t) in [(154.0, 10.0), (127.0, 10.0), (127.0, 30.0), (226.0, 20.0), (90.0, 45.0)]:
    err, pan, tilt, inr = inverse(az_t, el_t)
    verdict = ("OK (in-range, points up-ish)" if inr and tilt > -50
               else "OUT-OF-RANGE" if not inr else "SUSPECT (steep down)")
    print(f"  az={az_t} el={el_t:+.0f}: solved pan={pan:.2f} tilt={tilt:+.2f} in_range={inr} "
          f"fwd-err={err:.4f} -> {verdict}")
print(f"  (broken TRIAD drove a +10 el target to tilt -63 into the ground; "
      f"sightings were tilt ~ -30 at el +3.5)")

# ------------------------------------------------------------------
# AMBIGUITY: how far do the two c_head solutions diverge on GENERAL targets?
# (They agree at the 2 calibration landmarks by construction.)
# ------------------------------------------------------------------
print("\n=== 2-FOLD AMBIGUITY: divergence of the two c_head solutions on a target grid ===")
c0d, c1d = sol["both"][0], sol["both"][1]
# At each posture on a grid, compare the world direction the two calibrations
# predict for the SAME (pan,tilt). They must match at the 2 landmarks, but if
# they diverge elsewhere the 2-landmark solve is not uniquely determining.
diffs = []
for pan in range(-170, 171, 20):
    for tilt in range(-80, 81, 20):
        b0 = c0d["R"] @ (MMw(pan, tilt) @ c0d["c"])
        b1 = c1d["R"] @ (MMw(pan, tilt) @ c1d["c"])
        b0 /= np.linalg.norm(b0)
        b1 /= np.linalg.norm(b1)
        diffs.append(math.degrees(math.acos(max(-1, min(1, float(np.dot(b0, b1)))))))
print(f"  boresight_world disagreement between the two solutions over a "
      f"(pan,tilt) grid: mean={np.mean(diffs):.1f} deg  max={np.max(diffs):.1f} deg")
print(f"  => the two calibrations agree at the 2 landmarks but disagree by up to "
      f"{np.max(diffs):.0f} deg elsewhere: 2 landmarks + gravity is NOT uniquely determining.")

# ------------------------------------------------------------------
# CONTROL: winning pan/tilt convention but assume tripod LEVEL (ignore base tilt).
# Shows whether the ~4.7deg IMU base tilt actually matters for the solve.
# ------------------------------------------------------------------
sol_lvl = calibrate(np.array([0, 0, -1.0]), ps, ts)
if sol_lvl is not None:
    print("\n=== CONTROL: winning convention but LEVEL assumption (ignore base tilt) ===")
    print(f"  heading disagreement A-vs-B = {sol_lvl['dh']:.3f} deg "
          f"(gravity-anchored gave {sol['dh']:.4f})")
    print(f"  forward reprojection err A={sol_lvl['ferr'][0]:.3f} B={sol_lvl['ferr'][1]:.3f} deg  "
          f"(pitch-up={sol_lvl['pitch']:.2f})")

    e1, p1, t1, inr1 = inverse(154.0, 10.0, sol_lvl["R"], sol_lvl["c"])
    print(f"  high target az154 el+10 -> pan={p1:.2f} tilt={t1:+.2f} in_range={inr1} fwd-err={e1:.3f}")
