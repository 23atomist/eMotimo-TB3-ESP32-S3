export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [Vec3, Vec3, Vec3]; // three rows

export function deg2rad(d: number): number { return (d * Math.PI) / 180; }
export function rad2deg(r: number): number { return (r * 180) / Math.PI; }

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function norm(a: Vec3): number { return Math.sqrt(dot(a, a)); }
export function scale(a: Vec3, k: number): Vec3 { return [a[0] * k, a[1] * k, a[2] * k]; }
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (n === 0) throw new Error("cannot normalize a zero-length vector");
  return [a[0] / n, a[1] / n, a[2] / n];
}

// Columns c0,c1,c2 become the images of the standard basis vectors.
export function matFromColumns(c0: Vec3, c1: Vec3, c2: Vec3): Mat3 {
  return [
    [c0[0], c1[0], c2[0]],
    [c0[1], c1[1], c2[1]],
    [c0[2], c1[2], c2[2]],
  ];
}
export function matVec(m: Mat3, v: Vec3): Vec3 {
  return [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
}
export function transpose(m: Mat3): Mat3 {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}
export function matMul(a: Mat3, b: Mat3): Mat3 {
  const bt = transpose(b); // rows of bt are columns of b
  return [
    [dot(a[0], bt[0]), dot(a[0], bt[1]), dot(a[0], bt[2])],
    [dot(a[1], bt[0]), dot(a[1], bt[1]), dot(a[1], bt[2])],
    [dot(a[2], bt[0]), dot(a[2], bt[1]), dot(a[2], bt[2])],
  ];
}
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const c = dot(normalize(a), normalize(b));
  return rad2deg(Math.acos(Math.max(-1, Math.min(1, c))));
}

export function rotX(rad: number): Mat3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}
export function rotZ(rad: number): Mat3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
export function det3(m: Mat3): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}
export function inv3(m: Mat3): Mat3 {
  const d = det3(m);
  if (Math.abs(d) < 1e-15) throw new Error("inv3: singular matrix");
  const c00 = m[1][1] * m[2][2] - m[1][2] * m[2][1];
  const c01 = m[1][2] * m[2][0] - m[1][0] * m[2][2];
  const c02 = m[1][0] * m[2][1] - m[1][1] * m[2][0];
  const c10 = m[0][2] * m[2][1] - m[0][1] * m[2][2];
  const c11 = m[0][0] * m[2][2] - m[0][2] * m[2][0];
  const c12 = m[0][1] * m[2][0] - m[0][0] * m[2][1];
  const c20 = m[0][1] * m[1][2] - m[0][2] * m[1][1];
  const c21 = m[0][2] * m[1][0] - m[0][0] * m[1][2];
  const c22 = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  // inverse = adjugate / det ; adjugate = transpose of cofactor matrix
  return [
    [c00 / d, c10 / d, c20 / d],
    [c01 / d, c11 / d, c21 / d],
    [c02 / d, c12 / d, c22 / d],
  ];
}
