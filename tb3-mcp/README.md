# tb3-mcp

Always-on MCP daemon that lets any LLM control the eMotimo TB3 over the network.

## Run

```bash
cd tb3-mcp
npm install
cp config.example.json config.json   # edit deviceHost + limits for your rig
npm run build
npm start                             # serves MCP at http://<host>:8770/mcp
```

Dev mode (no build): `npm run dev`. Tests: `npm test`.

## Configuration

`config.json` (all keys overridable by env, e.g. `TB3_DEVICE_HOST`, `TB3_MCP_PORT`,
`TB3_MCP_TOKEN`, `TB3_MAX_SPEED_DPS`, `TB3_PAN_SIGN`):

| key | default | meaning |
|---|---|---|
| deviceHost | `tb3.local` | TB3 host or `ip:port` |
| mcpPort | `8770` | MCP HTTP/SSE listen port |
| mcpToken | (unset) | if set, clients must send `Authorization: Bearer <token>` |
| panMin/panMax | `-180/180` | pan soft limits (degrees) |
| tiltMin/tiltMax | `-90/90` | tilt soft limits (degrees) |
| maxSpeedDps | `22` | max goto speed (°/s); the firmware caps point-to-point moves at ~22.5°/s (10000 steps/s) |
| maxJogDps | `19` | °/s at full joystick deflection — **measured** on the rig (both axes), not a preference. Note the firmware's deflection→rate curve is *cubic*, so `jog` (which maps linearly) is approximate by design; layer-3 tracking inverts the cubic. |
| panSign/tiltSign/auxSign | `1` | per-axis sign flip (`1` or `-1`) |
| calibrationFile | `~/.tb3-mcp/calibration.json` | where the calibration profile is persisted (env `TB3_CALIBRATION_FILE`) |

**Soft limits refuse out-of-range moves** — there are no endstops. Set them to your rig's real reachable range.

## Tools

`get_status`, `goto_angle`, `jog`, `stop`, `set_home`, `trigger_camera`, `list_programs`, `select_program`.

`goto_angle` is the soft-limit-enforced primitive — out-of-range targets are refused. `jog` is
manual/supervised open-loop rate control and does **not** enforce pan/tilt soft limits, so an
operator can drive past the configured limits with sustained jogs. (There are no endstops.)

## Geo-pointing (layer 2)

Azimuth/elevation pointing requires a **calibration** that solves the mount's orientation from two sightings of known landmarks. Once calibrated, use `point_at` (geographic target) or `point_at_azel` (absolute azimuth/elevation).

### Calibration Workflow

1. **`set_rig_location`** — Set the rig's fixed WGS84 location (lat/lon/height). Clears any prior sightings and solution.
2. **Aim and sight** — Using the camera feed and `jog` to fine-tune, aim at a well-known landmark (e.g., a distant building or mountain), then call **`sight_landmark`** with its lat/lon/height and optional label. Capture the *current* pan/tilt as a sighting.
3. **Repeat** — Aim at a second landmark well-separated in azimuth (ideally >15° apart) and call `sight_landmark` again. Two sightings are required.
4. **`solve_calibration`** — Solves the mount's 3D orientation (heading and level) from the two sightings using TRIAD. Reports landmark separation (warn if <15°), heading, and base tilt. The solution is persisted to disk.
5. **`point_at`** or **`point_at_azel`** — Once calibrated, point at any geographic target or absolute azimuth/elevation. Blocks until arrival.

### Tools

| Tool | Purpose |
|---|---|
| `set_rig_location` | Set the rig's WGS84 position (lat, lon, height_m); clears sightings. |
| `sight_landmark` | Record the *current* pan/tilt as a sighting of a landmark (aim first via live feed + jog). Returns sighting slot (1/2 or 2/2). Warns if rig was moving. |
| `solve_calibration` | TRIAD-solve the mount orientation from two sightings. Reports heading (°), base tilt (°), and landmark separation (°). Persists solution. |
| `point_at` | Point at a geographic target (lat, lon, height_m). Requires calibration. Returns azimuth, elevation, range, and final pan/tilt. |
| `point_at_azel` | Point at absolute azimuth/elevation. Requires calibration. Returns final pan/tilt. |
| `get_calibration` | Report the full calibration profile: rig location, sightings, solved orientation, timestamp. |
| `clear_calibration` | Erase the calibration profile. |

### Documented Assumptions

- **Height datum**: Rig height and target heights *must* share the same vertical datum (both WGS84 ellipsoidal or both orthometric MSL). Mixing datums introduces a constant bias. The code does not model geoid separation because it cancels locally.
- **Out of scope**: Atmospheric refraction and lever-arm offset (distance from mount zero to camera). Both are small for typical applications (<0.5° refraction near horizon, <0.1° lever-arm error on distant targets).

## Connect a client

Point any MCP client at `http://<host>:8770/mcp` (streamable HTTP). Example Claude Desktop
config entry:

```json
{ "mcpServers": { "tb3": { "url": "http://localhost:8770/mcp" } } }
```

## Always-on

- macOS: edit paths in `deploy/tb3-mcp.plist`, then `launchctl load -w ~/Library/LaunchAgents/tb3-mcp.plist`.
- Linux/Pi: edit `deploy/tb3-mcp.service`, then `systemctl enable --now tb3-mcp`.
