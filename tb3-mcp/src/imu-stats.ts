/** One burst as returned by GET /api/imu. Sample element order is fixed:
 *  [t_us, ax,ay,az, gx,gy,gz, mx,my,mz, tempC, pressHpa]. Mag entries may be
 *  null (a failed/overflowed read on that sample). */
export interface ImuBurst {
  info: {
    present: boolean;
    mpu_who: string; mag_who: string; bmp_id: string;
    accel_fs_g: number; gyro_fs_dps: number;
  };
  n: number;
  span_us: number;
  read_errors: number;
  samples: ReadonlyArray<ReadonlyArray<number | null>>;
}

export interface AxisStats { mean: number; std: number; }

export interface ImuStats {
  sampleCount: number;
  rateHz: number;
  readErrors: number;
  accel: { x: AxisStats; y: AxisStats; z: AxisStats; magMean: number };
  gyro: { x: AxisStats; y: AxisStats; z: AxisStats };
  mag: { x: AxisStats; y: AxisStats; z: AxisStats; magMean: number; validCount: number };
  baro: { tempMean: number; pressMean: number };
}

function axisStats(values: readonly number[]): AxisStats {
  const n = values.length;
  if (n === 0) return { mean: NaN, std: NaN };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return { mean, std: Math.sqrt(variance) };
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Column indices into a sample row.
const T = 0, AX = 1, AY = 2, AZ = 3, GX = 4, GY = 5, GZ = 6, MX = 7, MY = 8, MZ = 9, TEMP = 10, PRESS = 11;

export function computeImuStats(burst: ImuBurst): ImuStats {
  const rows = burst.samples;
  const col = (i: number): number[] => rows.map((r) => Number(r[i]));

  // Effective rate from the median inter-sample dt (robust; see the project's
  // 5 Hz-aliasing lesson — median beats mean for rate).
  const t = rows.map((r) => Number(r[T]));
  const dts: number[] = [];
  for (let i = 1; i < t.length; i++) dts.push(t[i] - t[i - 1]);
  const medDtUs = median(dts);
  const rateHz = medDtUs > 0 ? 1e6 / medDtUs : NaN;

  const ax = axisStats(col(AX)), ay = axisStats(col(AY)), az = axisStats(col(AZ));
  const accelMag = rows.map((r) => Math.hypot(Number(r[AX]), Number(r[AY]), Number(r[AZ])));

  // Mag rows with any null component are invalid; stats over the finite rest.
  const magRows = rows.filter((r) => r[MX] != null && r[MY] != null && r[MZ] != null);
  const mx = magRows.map((r) => Number(r[MX]));
  const my = magRows.map((r) => Number(r[MY]));
  const mz = magRows.map((r) => Number(r[MZ]));
  const magMag = magRows.map((r) => Math.hypot(Number(r[MX]), Number(r[MY]), Number(r[MZ])));

  return {
    sampleCount: rows.length,
    rateHz,
    readErrors: burst.read_errors,
    accel: { x: ax, y: ay, z: az, magMean: axisStats(accelMag).mean },
    gyro: { x: axisStats(col(GX)), y: axisStats(col(GY)), z: axisStats(col(GZ)) },
    mag: { x: axisStats(mx), y: axisStats(my), z: axisStats(mz), magMean: axisStats(magMag).mean, validCount: magRows.length },
    baro: { tempMean: axisStats(col(TEMP)).mean, pressMean: axisStats(col(PRESS)).mean },
  };
}
