// Parses a `Cookie` request header for a single named cookie's value.
//
// Why this exists: with `dashboardAuth: true`, /api and /camera require the
// mcpToken, but `EventSource("/api/stream")` and `<img src="/camera/stream">`
// cannot send a custom `Authorization` header. dashboard/public/app.js works
// around this by storing the token (passed once as `?token=`) as a
// `tb3_token` session cookie, which same-origin EventSource/<img>/fetch
// requests all carry automatically. server.ts's authGate calls this to pull
// that cookie back out alongside the header/query-param checks.
export function tokenFromCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value; // malformed escape sequence: fall back to the raw value
    }
  }
  return null;
}
