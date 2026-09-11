import { isTerminalBuildStatus } from '../../build-status.ts';
import type { Build } from '../../types.ts';

export { isTerminalBuildStatus };

/**
 * Live build-log panel for container builds. Mirrors the polling approach in
 * `deployment-logs.tsx` (client-side `setInterval`, advancing cursor,
 * autoscroll) — NOT a WebSocket.
 *
 * The poller hits `/admin/builds/:id/logs?since=<cursor>`, appends the new
 * `lines`, advances the cursor to `lastSeq`, and autoscrolls.
 *
 * Stopping at terminal: the page embeds the build's status at render time. If
 * the build is ALREADY terminal (`complete`/`failed`/`cancelled`), the script
 * does a single final fetch and never starts the interval. If it is still
 * in-flight, the script polls every ~2s; each poll re-fetches the build's own
 * status via the build page's `?status` probe — when that turns terminal the
 * script does one last fetch and `clearInterval`s. A page reload always picks
 * up the final status.
 *
 * Only the build id and the initial-terminal flag are interpolated into the
 * inline script, both via `JSON.stringify`, so no untrusted free-text (commit
 * message, branch, error) is ever inlined.
 */
export function BuildLogs({ build }: { build: Build }) {
  const terminal = isTerminalBuildStatus(build.status);
  return (
    <>
      <h2>Build Logs</h2>
      <pre
        id="build-log"
        style="min-height: 120px; max-height: 480px; overflow-y: auto; font-size: 0.78rem"
      >
        Loading logs...
      </pre>
      <script
        dangerouslySetInnerHTML={{
          __html: `
(function() {
  var logsPath = ${JSON.stringify(`/admin/builds/${build.id}/logs`)};
  var statusPath = ${JSON.stringify(`/admin/builds/${build.id}`)};
  var terminal = ${JSON.stringify(terminal)};
  var pre = document.getElementById('build-log');
  var cursor = 0;
  var pollTimer = null;
  var first = true;
  var polling = false;

  function escapeHtml(value) {
    var el = document.createElement('span');
    el.textContent = value;
    return el.innerHTML;
  }

  function append(lines) {
    if (!lines || lines.length === 0) return;
    if (first) { pre.innerHTML = ''; first = false; }
    var atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    var html = lines.map(function(l) {
      var text = typeof l === 'string' ? l : (l.line != null ? l.line : '');
      var stream = (l && l.stream) || 'stdout';
      var color = stream === 'stderr' ? '#dc2626' : 'inherit';
      return '<span style="color:' + color + '">' + escapeHtml(text) + '</span>';
    }).join('\\n');
    pre.innerHTML += (pre.innerHTML ? '\\n' : '') + html;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  function stop() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function pollLogs() {
    // Single-flight: a slow poll must not overlap the next interval tick. Two
    // concurrent fetches would share the same (not-yet-advanced) 'cursor', return
    // the same rows, and 'append' them twice. Skip if one is already in flight —
    // the interval will poll again once it settles (cursor advances first).
    if (polling) return Promise.resolve();
    polling = true;
    return fetch(logsPath + '?since=' + cursor)
      .then(function(r) { return r.json(); })
      .then(function(result) {
        append(result.lines);
        if (typeof result.lastSeq === 'number' && result.lastSeq > cursor) {
          cursor = result.lastSeq;
        }
        if (first) { pre.textContent = 'No logs yet.'; }
      })
      .catch(function() { /* ignore transient poll errors */ })
      .finally(function() { polling = false; });
  }

  // Probe the build's live status (cheap JSON shape: { status, terminal }).
  function checkTerminal() {
    return fetch(statusPath + '?status=1')
      .then(function(r) { return r.json(); })
      .then(function(s) { return !!(s && s.terminal); })
      .catch(function() { return false; });
  }

  if (terminal) {
    // Build already finished — fetch the full log once, then stop.
    pollLogs();
    return;
  }

  pollLogs();
  pollTimer = setInterval(function() {
    pollLogs().then(function() {
      checkTerminal().then(function(done) {
        if (done) { stop(); pollLogs(); }
      });
    });
  }, 2000);
})();
`,
        }}
      />
    </>
  );
}
