import type { Plugin } from 'vite';

const BINDING_HINT_VIRTUAL = 'virtual:void/binding-hint';
const BINDING_HINT_RESOLVED = '\0' + BINDING_HINT_VIRTUAL;

const RESTARTING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Restarting</title>
  <style>
    body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#1a1a2e;color:#e0def4;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
    .tag{color:#c4a7e7;font-weight:700}
    @keyframes d{0%,80%{opacity:0}40%{opacity:1}}
    .dots span{opacity:0;animation:d 1.4s infinite}
    .dots span:nth-child(2){animation-delay:.2s}
    .dots span:nth-child(3){animation-delay:.4s}
  </style>
</head>
<body>
  <div><span class="tag">[void]</span> Restarting dev server<span class="dots"><span>.</span><span>.</span><span>.</span></span></div>
  <script>
    fetch("/__void/restart",{method:"POST"}).catch(function(){});
    setTimeout(function p(){
      fetch("/__void/ping").then(function(r){
        if(r.ok)location.href=new URLSearchParams(location.search).get("return")||"/";
        else setTimeout(p,150);
      }).catch(function(){setTimeout(p,150)});
    },300);
  </script>
</body>
</html>`;

const CLIENT_MODULE = `if (import.meta.hot) {
  import.meta.hot.on("void:new-binding", (d) => {
    if (document.getElementById("void-binding-hint")) return;
    const e = document.createElement("div");
    e.id = "void-binding-hint";
    e.style.cssText = "position:fixed;top:16px;right:16px;z-index:99999;padding:12px 16px;background:rgba(26,26,46,0.95);color:#e0def4;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;border-radius:8px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 8px 32px rgba(0,0,0,0.4);backdrop-filter:blur(8px);cursor:pointer;max-width:300px;transform:translateX(calc(100% + 16px));transition:transform .3s ease";
    e.innerHTML = "<strong style=\\"color:#c4a7e7\\">[void]</strong> " + d.message + " Click to restart.";
    e.onclick = () => { location.href = "/__void/restarting?return=" + encodeURIComponent(location.pathname + location.search); };
    document.body.appendChild(e);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      e.style.transform = "translateX(0)";
    }));
  });
}`;

/**
 * Vite plugin that provides controlled dev-server restart via the browser.
 *
 * Serves three endpoints:
 * - `/__void/restarting` — standalone loading page (no Vite HMR client)
 * - `/__void/restart`    — POST triggers `server.restart()` after a short delay
 * - `/__void/ping`       — health check; returns 503 on the old server instance
 *                          (after restart is triggered) and 200 on the new one
 *
 * Also injects a virtual module (`virtual:void/binding-hint`) that listens for
 * `void:new-binding` HMR events and shows a toast with a click-to-restart action.
 */
export function restartPlugin(): Plugin {
  return {
    name: 'void:restart',
    apply: 'serve',

    resolveId: {
      filter: { id: /^virtual:void\/binding-hint$/ },
      handler() {
        return BINDING_HINT_RESOLVED;
      },
    },

    load: {
      // eslint-disable-next-line no-control-regex -- Vite virtual module null-byte prefix
      filter: { id: /^\0virtual:void\/binding-hint$/ },
      handler() {
        return CLIENT_MODULE;
      },
    },

    configureServer(server) {
      let restartPending = false;

      server.middlewares.use('/__void/ping', (_req, res) => {
        res.writeHead(restartPending ? 503 : 200);
        res.end();
      });

      server.middlewares.use('/__void/restart', (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        restartPending = true;
        res.writeHead(200);
        res.end();
        setTimeout(() => server.restart(), 50);
      });

      server.middlewares.use('/__void/restarting', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(RESTARTING_HTML);
      });
    },
  };
}
