export interface DeviceState {
  connected: boolean;
  panSteps: number;
  tiltSteps: number;
  auxSteps: number;
  moving: boolean;
  programEngaged: boolean;
  batteryV: number;
  staIp: string;
  lastUpdateMs: number;
}
