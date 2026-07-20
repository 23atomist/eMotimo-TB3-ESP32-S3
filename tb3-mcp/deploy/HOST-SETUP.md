# Host Setup for TB3 Dashboard

This guide covers the on-host prerequisites for running the TB3 operations dashboard and camera integration.

## Prerequisites

### 1. gvfs Release (Camera Access)

The GNOME Virtual File System (gvfs) reserves access to USB cameras via `gvfs-gphoto2-volume-monitor`. To let `gphoto2` open the camera directly, mask the monitor:

```bash
systemctl --user mask gvfs-gphoto2-volume-monitor
```

Then disconnect and re-plug the camera (D5000), or kill the running monitor:

```bash
killall gvfs-gphoto2-volume-monitor
```

**Verify camera access:**

```bash
gphoto2 --capture-preview --filename /tmp/t.jpg
```

A JPEG should appear at `/tmp/t.jpg`. If the command times out or fails, the camera is still held by gvfs — try the kill/re-plug step again.

### 2. ffmpeg

The dashboard uses `ffmpeg` to transcode camera streams. Ensure it is installed:

```bash
ffmpeg -version
```

On Debian/Ubuntu:

```bash
sudo apt-get install ffmpeg
```

On macOS:

```bash
brew install ffmpeg
```

### 3. systemctl Permission for Agent Toggle

The dashboard's **Auto** toggle shells out to `systemctl start/stop tb3-agent`. The service user must have permission to control the agent service without a password. Set up a polkit rule or sudoers entry.

**Option A: polkit rule (recommended)**

Create `/etc/polkit-1/rules.d/50-tb3-agent.rules`:

```javascript
polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      action.lookup("unit") == "tb3-agent.service" &&
      subject.user == "atomist") {
    return polkit.Result.YES;
  }
});
```

Reload polkit:

```bash
sudo systemctl reload polkit
```

**Option B: sudoers entry (simpler, less auditable)**

Add to `/etc/sudoers` (edit with `sudo visudo`):

```
atomist ALL=(ALL) NOPASSWD: /bin/systemctl start tb3-agent, /bin/systemctl stop tb3-agent, /bin/systemctl restart tb3-agent
```

### 4. Dashboard Auth Configuration

If `dashboardAuth: true` is set in `config.json`, the dashboard's API routes (camera, status, controls, E-STOP) require a valid bearer token in the `Authorization: Bearer <token>` header. **The token is the value of `mcpToken` from the config.**

Failing to set `mcpToken` when `dashboardAuth: true` will cause all gated routes to return `401 Unauthorized`.

Default is `dashboardAuth: false` (no auth required).

### 5. Network Access

The dashboard listens on the address and port configured in `config.json` (`dashboardBind` and `dashboardPort`; defaults are `"0.0.0.0"` and `8788`). Access it from the LAN:

```
http://<host-lan-ip>:8788
```

Example: `http://192.168.4.104:8788`

## Service Installation (systemd)

Once the above prerequisites are met:

1. **Copy the service file:**

   ```bash
   sudo cp deploy/tb3-dashboard.service /etc/systemd/system/
   ```

2. **Reload systemd and enable the service:**

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable tb3-dashboard
   ```

3. **Start the dashboard:**

   ```bash
   sudo systemctl start tb3-dashboard
   ```

4. **Check status:**

   ```bash
   systemctl status tb3-dashboard
   ```

## Verification

1. Open `http://<host-lan-ip>:8788` in a browser.
2. Confirm the rig's status, telemetry, and camera feed load.
3. Test the camera preview or live view (if camera is plugged in and accessible).
4. Test manual controls: jog, goto, and the E-STOP button.
5. If the Auto toggle is enabled, confirm it can start/stop the `tb3-agent` service.

## Troubleshooting

**Dashboard does not start or crashes immediately**

- Check the systemd journal: `journalctl -u tb3-dashboard -n 50 -e`
- Ensure the service dependencies are running: `systemctl is-active tb3-mcp` (the core MCP daemon must be running first)
- Rebuild if needed: `npm run build` from `tb3-mcp/`

**Camera feed shows "fallback" or no video**

- Verify gvfs is masked and the camera is re-plugged
- Run `gphoto2 --capture-preview --filename /tmp/t.jpg` to confirm camera access
- Check `config.json` for `cameraFps`, `cameraFallbackMs`, and `cameraDevicePort` (should be auto-detected if empty)

**Auth returns 401**

- Confirm `dashboardAuth` and `mcpToken` are set correctly in `config.json`
- If auth is disabled, `dashboardAuth: false` should be the default

**Agent toggle permission denied**

- Verify the polkit or sudoers rule is in place and the service user is correct (`id -u -n` on the host should be `atomist`)
- Reload polkit: `sudo systemctl reload polkit`
