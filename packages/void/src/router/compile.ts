import type { VoidAuthProvider } from '../auth/providers.ts';
import type { DevRedirectRule, HeaderRule } from '../cli/types.ts';
import { resolveLayoutIds } from '../pages/layout-resolution.ts';
import { INTERNAL_BINDING_PREFIXES } from '../runtime/env-raw.ts';
import type { ScanResult } from './scan.ts';

/**
 * Script tag injected into dev HTML to load the binding-hint virtual module.
 * The virtual module (served by restartPlugin) listens for `void:new-binding`
 * HMR events and shows a toast with a click-to-restart action.
 */
const BINDING_HINT_SCRIPT = `<script type="module" src="/@id/virtual:void/binding-hint"></script>`;
const DEFAULT_ERROR_PAGE_FONT_STACK =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function pushDefaultErrorPageHelpers(lines: Array<string>, options: CompileOptions): void {
  const dev = options.dev === true;
  lines.push(
    `const __VOID_ERROR_PAGE_FONT_STACK = ${JSON.stringify(DEFAULT_ERROR_PAGE_FONT_STACK)};`,
  );
  lines.push(`const __VOID_DEV = ${JSON.stringify(dev)};`);
  lines.push(`const __VOID_PROJECT_ROOT = ${JSON.stringify(options.projectRoot)};`);
  lines.push(`const __VOID_HOME_DIR = ${JSON.stringify(options.homeDir)};`);
  lines.push(`function __voidEscapeHtml(value) {`);
  lines.push(
    `  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");`,
  );
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidShouldServeHtmlErrorPage(request) {`);
  lines.push(`  if (request.method !== "GET" && request.method !== "HEAD") return false;`);
  lines.push(`  const url = new URL(request.url);`);
  lines.push(`  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return false;`);
  lines.push(`  if (/\\/[^/]+\\.[^/]+$/.test(url.pathname)) return false;`);
  lines.push(`  const destination = request.headers.get("sec-fetch-dest");`);
  lines.push(
    `  if (destination && destination !== "document" && destination !== "empty") return false;`,
  );
  lines.push(`  const accept = request.headers.get("accept");`);
  lines.push(`  return !accept || accept.includes("text/html") || accept.includes("*/*");`);
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidNormalizeFsPath(value) {`);
  lines.push(`  return typeof value === "string" ? value.replaceAll("\\\\", "/") : "";`);
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidIsAbsolutePath(value) {`);
  lines.push(`  return value.startsWith("/") || /^[A-Za-z]:\\//.test(value);`);
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidDisplayPath(value) {`);
  lines.push(`  const path = __voidNormalizeFsPath(value);`);
  lines.push(`  const homeDir = __voidNormalizeFsPath(__VOID_HOME_DIR);`);
  lines.push(`  const projectRoot = __voidNormalizeFsPath(__VOID_PROJECT_ROOT);`);
  lines.push(`  if (!path) return "";`);
  lines.push(
    `  if (projectRoot && (path === projectRoot || path.startsWith(projectRoot + "/"))) {`,
  );
  lines.push(`    const suffix = path.slice(projectRoot.length).replace(/^\\/?/, "");`);
  lines.push(`    return suffix ? "./" + suffix : "./";`);
  lines.push(`  }`);
  lines.push(`  if (homeDir && (path === homeDir || path.startsWith(homeDir + "/"))) {`);
  lines.push(`    const suffix = path.slice(homeDir.length).replace(/^\\/?/, "");`);
  lines.push(`    return suffix ? "~/" + suffix : "~/";`);
  lines.push(`  }`);
  lines.push(`  return path;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidEditorHref(value, line, column) {`);
  lines.push(`  const path = __voidNormalizeFsPath(value);`);
  lines.push(`  if (!__voidIsAbsolutePath(path)) return "";`);
  lines.push(
    `  return "vscode://file/" + encodeURI(path).replaceAll("#", "%23").replaceAll("?", "%3F") + ":" + String(line) + ":" + String(column);`,
  );
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidCreateStackFrame(functionName, file, line, column, raw) {`);
  lines.push(`  const normalizedFile = __voidNormalizeFsPath(file);`);
  lines.push(`  const lineNumber = Number(line);`);
  lines.push(`  const columnNumber = Number(column);`);
  lines.push(
    `  if (!normalizedFile || !Number.isFinite(lineNumber) || lineNumber <= 0) return null;`,
  );
  lines.push(
    `  const safeColumn = Number.isFinite(columnNumber) && columnNumber > 0 ? columnNumber : 1;`,
  );
  lines.push(`  return {`);
  lines.push(`    functionName: functionName || "",`);
  lines.push(`    file: normalizedFile,`);
  lines.push(`    line: lineNumber,`);
  lines.push(`    column: safeColumn,`);
  lines.push(`    displayPath: __voidDisplayPath(normalizedFile),`);
  lines.push(`    href: __voidEditorHref(normalizedFile, lineNumber, safeColumn),`);
  lines.push(`    raw: raw || "",`);
  lines.push(`  };`);
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidParseFrameLocation(value) {`);
  lines.push(`  const match = value.match(/^(.*):(\\d+):(\\d+)$/);`);
  lines.push(`  if (!match) return null;`);
  lines.push(
    `  return __voidCreateStackFrame("", match[1], Number(match[2]), Number(match[3]), value);`,
  );
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidParseStackFrames(stack) {`);
  lines.push(`  if (!stack) return [];`);
  lines.push(`  const frames = [];`);
  lines.push(`  for (const rawLine of stack.split(/\\n+/)) {`);
  lines.push(`    const line = rawLine.trim();`);
  lines.push(`    if (!line) continue;`);
  lines.push(`    let frame = null;`);
  lines.push(`    let match = line.match(/^at\\s+(?:async\\s+)?(.+?)\\s+\\((.+)\\)$/);`);
  lines.push(`    if (match) {`);
  lines.push(`      const location = __voidParseFrameLocation(match[2]);`);
  lines.push(`      frame = location ? { ...location, functionName: match[1] } : null;`);
  lines.push(`    } else {`);
  lines.push(`      match = line.match(/^at\\s+(.+)$/);`);
  lines.push(`      if (match) {`);
  lines.push(`        frame = __voidParseFrameLocation(match[1]);`);
  lines.push(`      } else {`);
  lines.push(`        match = line.match(/^(.*?)@(.+)$/);`);
  lines.push(`        if (match) {`);
  lines.push(`          const location = __voidParseFrameLocation(match[2]);`);
  lines.push(`          frame = location ? { ...location, functionName: match[1] } : null;`);
  lines.push(`        }`);
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`    if (frame) frames.push({ ...frame, raw: line });`);
  lines.push(`  }`);
  lines.push(`  return frames;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidGetStackFrames(error) {`);
  lines.push(`  if (!(error instanceof Error)) return [];`);
  lines.push(`  if (!error.stack && typeof Error.captureStackTrace === "function") {`);
  lines.push(`    try {`);
  lines.push(`      Error.captureStackTrace(error, __voidGetStackFrames);`);
  lines.push(`    } catch {`);
  lines.push(`      // Ignore runtimes that reject captureStackTrace on thrown errors.`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  const originalPrepareStackTrace = Error.prepareStackTrace;`);
  lines.push(`  try {`);
  lines.push(`    Error.prepareStackTrace = (_, callSites) => callSites;`);
  lines.push(`    const structured = error.stack;`);
  lines.push(`    if (Array.isArray(structured)) {`);
  lines.push(`      const frames = [];`);
  lines.push(`      for (const callSite of structured) {`);
  lines.push(`        try {`);
  lines.push(
    `          const fileName = callSite.getFileName?.() || callSite.getScriptNameOrSourceURL?.();`,
  );
  lines.push(`          const line = callSite.getLineNumber?.();`);
  lines.push(`          const column = callSite.getColumnNumber?.();`);
  lines.push(
    `          const functionName = callSite.getFunctionName?.() || callSite.getMethodName?.() || "";`,
  );
  lines.push(
    `          const frame = __voidCreateStackFrame(functionName, fileName || "", line, column, String(callSite));`,
  );
  lines.push(`          if (frame) frames.push(frame);`);
  lines.push(`        } catch {`);
  lines.push(`          // Ignore malformed CallSite entries and continue rendering.`);
  lines.push(`        }`);
  lines.push(`      }`);
  lines.push(`      if (frames.length > 0) return frames;`);
  lines.push(`    }`);
  lines.push(`  } catch {`);
  lines.push(`    // Fall through to string parsing.`);
  lines.push(`  } finally {`);
  lines.push(`    Error.prepareStackTrace = originalPrepareStackTrace;`);
  lines.push(`  }`);
  lines.push(
    `  return __voidParseStackFrames(typeof error.stack === "string" ? error.stack : "");`,
  );
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidDescribeThrownValue(value) {`);
  lines.push(`  if (value instanceof Error) {`);
  lines.push(`    return {`);
  lines.push(`      name: value.name || "Error",`);
  lines.push(`      message: value.message || "",`);
  lines.push(`      stack: typeof value.stack === "string" ? value.stack : "",`);
  lines.push(`      frames: __voidGetStackFrames(value),`);
  lines.push(`    };`);
  lines.push(`  }`);
  lines.push(`  if (typeof value === "string") {`);
  lines.push(`    return { name: "Thrown value", message: value, stack: "", frames: [] };`);
  lines.push(`  }`);
  lines.push(`  let message = "";`);
  lines.push(`  try {`);
  lines.push(`    if (typeof value === "object" && value !== null) {`);
  lines.push(`      message = JSON.stringify(value, null, 2) ?? String(value);`);
  lines.push(`    } else {`);
  lines.push(`      message = String(value);`);
  lines.push(`    }`);
  lines.push(`  } catch {`);
  lines.push(`    message = String(value);`);
  lines.push(`  }`);
  lines.push(`  return { name: "Thrown value", message, stack: "", frames: [] };`);
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidRenderStack(entry) {`);
  lines.push(`  if (Array.isArray(entry.frames) && entry.frames.length > 0) {`);
  lines.push(`    const items = entry.frames.map((frame) => {`);
  lines.push(`      const name = frame.functionName || "(anonymous)";`);
  lines.push(`      const location = frame.displayPath + ":" + frame.line + ":" + frame.column;`);
  lines.push(
    `      const body = \`<span class="__void-error-frame-function">\${__voidEscapeHtml(name)}</span><span class="__void-error-frame-location">\${__voidEscapeHtml(location)}</span>\`;`,
  );
  lines.push(`      if (frame.href) {`);
  lines.push(
    `        return \`<a class="__void-error-frame" href="\${__voidEscapeHtml(frame.href)}">\${body}</a>\`;`,
  );
  lines.push(`      }`);
  lines.push(`      return \`<div class="__void-error-frame is-static">\${body}</div>\`;`);
  lines.push(`    }).join("");`);
  lines.push(
    `    return \`<div class="__void-error-stack"><div class="__void-error-stack-label">Stack trace</div><div class="__void-error-frames">\${items}</div></div>\`;`,
  );
  lines.push(`  }`);
  lines.push(`  if (!entry.stack) return "";`);
  lines.push(
    `  return \`<div class="__void-error-stack"><div class="__void-error-stack-label">Stack trace</div><pre>\${__voidEscapeHtml(entry.stack)}</pre></div>\`;`,
  );
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidCollectErrorChain(error) {`);
  lines.push(`  const chain = [];`);
  lines.push(`  const seen = new Set();`);
  lines.push(`  let current = error;`);
  lines.push(`  let depth = 0;`);
  lines.push(`  while (current != null && depth < 8 && !seen.has(current)) {`);
  lines.push(`    seen.add(current);`);
  lines.push(`    const entry = __voidDescribeThrownValue(current);`);
  lines.push(`    chain.push({`);
  lines.push(`      label: depth === 0 ? "Error" : "Cause " + depth,`);
  lines.push(`      ...entry,`);
  lines.push(`    });`);
  lines.push(`    current = current instanceof Error ? current.cause : undefined;`);
  lines.push(`    depth += 1;`);
  lines.push(`  }`);
  lines.push(`  if (current != null) {`);
  lines.push(`    chain.push({`);
  lines.push(`      label: "Cause " + depth,`);
  lines.push(`      name: "Truncated",`);
  lines.push(`      message: "Additional nested causes were omitted.",`);
  lines.push(`      stack: "",`);
  lines.push(`      frames: [],`);
  lines.push(`    });`);
  lines.push(`  }`);
  lines.push(`  if (chain.length === 0) {`);
  lines.push(`    chain.push({`);
  lines.push(`      label: "Error",`);
  lines.push(`      name: "Unknown error",`);
  lines.push(`      message: "No error details were available.",`);
  lines.push(`      stack: "",`);
  lines.push(`      frames: [],`);
  lines.push(`    });`);
  lines.push(`  }`);
  lines.push(`  return chain;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidRenderDevErrorOverlay(request, status, title, error) {`);
  lines.push(`  const chain = __voidCollectErrorChain(error);`);
  lines.push(
    `  const errorCountLabel = chain.length + (chain.length === 1 ? " Error" : " Errors");`,
  );
  lines.push(`  const sections = chain.map((entry, index) => {`);
  lines.push(`    const heading = entry.name || (index === 0 ? title : "Cause");`);
  lines.push(`    const message = entry.message || title;`);
  lines.push(`    const stack = __voidRenderStack(entry);`);
  lines.push(`    if (index === 0) {`);
  lines.push(
    `      return \`<section class="__void-error-section is-root"><p class="__void-error-message">\${__voidEscapeHtml(message)}</p>\${stack}</section>\`;`,
  );
  lines.push(`    }`);
  lines.push(
    `    return \`<section class="__void-error-section"><div class="__void-error-kicker">\${__voidEscapeHtml(entry.label)}</div><h2>\${__voidEscapeHtml(heading)}</h2><p>\${__voidEscapeHtml(message)}</p>\${stack}</section>\`;`,
  );
  lines.push(`  }).join("");`);
  lines.push(`  return \`<style>`);
  lines.push(`    .__void-error-overlay {`);
  lines.push(`      position: fixed;`);
  lines.push(`      inset: 0;`);
  lines.push(`      z-index: 2147483647;`);
  lines.push(`      pointer-events: none;`);
  lines.push(`      font-family: \${__VOID_ERROR_PAGE_FONT_STACK};`);
  lines.push(`      color: #f5f5f5;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-backdrop {`);
  lines.push(`      position: absolute;`);
  lines.push(`      inset: 0;`);
  lines.push(`      background: rgba(10, 10, 10, 0.52);`);
  lines.push(`      backdrop-filter: blur(4px);`);
  lines.push(`      transition: opacity 180ms ease;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-panel {`);
  lines.push(`      position: absolute;`);
  lines.push(`      inset: auto auto 24px 24px;`);
  lines.push(`      inline-size: min(760px, calc(100vw - 48px));`);
  lines.push(`      max-block-size: min(80dvh, 920px);`);
  lines.push(`      overflow: auto;`);
  lines.push(`      pointer-events: auto;`);
  lines.push(`      border-radius: 32px;`);
  lines.push(`      corner-shape: squircle;`);
  lines.push(`      border: 1px solid rgba(255, 255, 255, 0.14);`);
  lines.push(
    `      background: linear-gradient(180deg, rgba(24, 24, 27, 0.98), rgba(9, 9, 11, 0.98));`,
  );
  lines.push(`      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);`);
  lines.push(`      padding: 12px 16px;`);
  lines.push(`      transition: transform 180ms ease, opacity 180ms ease;`);
  lines.push(`      transform-origin: bottom left;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-close {`);
  lines.push(`      position: absolute;`);
  lines.push(`      inset: 12px 12px auto auto;`);
  lines.push(`      inline-size: 36px;`);
  lines.push(`      block-size: 36px;`);
  lines.push(`      border: 0;`);
  lines.push(`      border-radius: 999px;`);
  lines.push(`      background: rgba(255, 255, 255, 0.08);`);
  lines.push(`      color: #fafafa;`);
  lines.push(`      cursor: pointer;`);
  lines.push(`      display: grid;`);
  lines.push(`      place-items: center;`);
  lines.push(`      padding: 0;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-close:hover {`);
  lines.push(`      background: rgba(255, 255, 255, 0.14);`);
  lines.push(`    }`);
  lines.push(`    .__void-error-close svg {`);
  lines.push(`      inline-size: 16px;`);
  lines.push(`      block-size: 16px;`);
  lines.push(`      display: block;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-minimized {`);
  lines.push(`      position: absolute;`);
  lines.push(`      inset: auto auto 24px 24px;`);
  lines.push(`      pointer-events: none;`);
  lines.push(`      opacity: 0;`);
  lines.push(`      transform: scale(0.92);`);
  lines.push(`      transform-origin: bottom left;`);
  lines.push(`      border: 1px solid rgba(248, 113, 113, 0.35);`);
  lines.push(`      border-radius: 32px;`);
  lines.push(`      corner-shape: squircle;`);
  lines.push(`      background: rgba(24, 24, 27, 0.96);`);
  lines.push(`      color: #fca5a5;`);
  lines.push(`      padding: 12px 8px;`);
  lines.push(`      box-shadow: 0 18px 36px rgba(0, 0, 0, 0.28);`);
  lines.push(`      cursor: pointer;`);
  lines.push(`      font: 700 13px/1 \${__VOID_ERROR_PAGE_FONT_STACK};`);
  lines.push(`      letter-spacing: 0.04em;`);
  lines.push(`      text-transform: uppercase;`);
  lines.push(`      transition: transform 180ms ease, opacity 180ms ease;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-header {`);
  lines.push(`      display: flex;`);
  lines.push(`      flex-direction: column;`);
  lines.push(`      gap: 6px;`);
  lines.push(`      margin-block-end: 0;`);
  lines.push(`      padding-right: 52px;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-status {`);
  lines.push(`      margin: 0;`);
  lines.push(`      color: #fca5a5;`);
  lines.push(`      font-size: 12px;`);
  lines.push(`      font-weight: 700;`);
  lines.push(`      letter-spacing: 0.12em;`);
  lines.push(`      text-transform: uppercase;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-section {`);
  lines.push(`      border-top: 1px solid rgba(255, 255, 255, 0.08);`);
  lines.push(`      padding-top: 16px;`);
  lines.push(`      margin-top: 16px;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-section.is-root {`);
  lines.push(`      border-top: 0;`);
  lines.push(`      padding-top: 0;`);
  lines.push(`      margin-top: 0;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-message {`);
  lines.push(`      margin: 0;`);
  lines.push(`      color: #fff;`);
  lines.push(`      font-size: 1.7rem;`);
  lines.push(`      line-height: 1.15;`);
  lines.push(`      letter-spacing: -0.03em;`);
  lines.push(`      white-space: pre-wrap;`);
  lines.push(`      word-break: break-word;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-kicker {`);
  lines.push(`      margin-bottom: 6px;`);
  lines.push(`      color: #fda4af;`);
  lines.push(`      font-size: 12px;`);
  lines.push(`      font-weight: 700;`);
  lines.push(`      letter-spacing: 0.08em;`);
  lines.push(`      text-transform: uppercase;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-section h2 {`);
  lines.push(`      margin: 0 0 8px;`);
  lines.push(`      font-size: 1.05rem;`);
  lines.push(`      color: #fff;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-section p {`);
  lines.push(`      margin: 0;`);
  lines.push(`      color: #e4e4e7;`);
  lines.push(`      white-space: pre-wrap;`);
  lines.push(`      word-break: break-word;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-stack {`);
  lines.push(`      margin-top: 18px;`);
  lines.push(`      border: 1px solid rgba(255, 255, 255, 0.08);`);
  lines.push(`      border-radius: 32px;`);
  lines.push(`      background: rgba(255, 255, 255, 0.03);`);
  lines.push(`      corner-shape: squircle;`);
  lines.push(`      overflow: hidden;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-stack-label {`);
  lines.push(`      padding: 12px 14px 10px;`);
  lines.push(`      color: #f4f4f5;`);
  lines.push(`      font-size: 12px;`);
  lines.push(`      font-weight: 700;`);
  lines.push(`      letter-spacing: 0.08em;`);
  lines.push(`      text-transform: uppercase;`);
  lines.push(`      border-bottom: 1px solid rgba(255, 255, 255, 0.08);`);
  lines.push(`    }`);
  lines.push(`    .__void-error-frames {`);
  lines.push(`      display: flex;`);
  lines.push(`      flex-direction: column;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-frame {`);
  lines.push(`      display: flex;`);
  lines.push(`      align-items: baseline;`);
  lines.push(`      justify-content: space-between;`);
  lines.push(`      gap: 16px;`);
  lines.push(`      padding: 12px 14px;`);
  lines.push(`      color: inherit;`);
  lines.push(`      text-decoration: none;`);
  lines.push(`      border-top: 1px solid rgba(255, 255, 255, 0.06);`);
  lines.push(`    }`);
  lines.push(`    .__void-error-frame:first-child {`);
  lines.push(`      border-top: 0;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-frame:hover {`);
  lines.push(`      background: rgba(255, 255, 255, 0.05);`);
  lines.push(`    }`);
  lines.push(`    .__void-error-frame.is-static {`);
  lines.push(`      cursor: default;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-frame-function {`);
  lines.push(`      flex: 1 1 auto;`);
  lines.push(`      min-width: 0;`);
  lines.push(`      color: #fafafa;`);
  lines.push(`      font: 600 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;`);
  lines.push(`      white-space: nowrap;`);
  lines.push(`      overflow: hidden;`);
  lines.push(`      text-overflow: ellipsis;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-frame-location {`);
  lines.push(`      flex: 0 1 52%;`);
  lines.push(`      min-width: 0;`);
  lines.push(`      color: #fda4af;`);
  lines.push(`      font: 500 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;`);
  lines.push(`      text-align: right;`);
  lines.push(`      white-space: nowrap;`);
  lines.push(`      overflow: hidden;`);
  lines.push(`      text-overflow: ellipsis;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-section pre {`);
  lines.push(`      margin: 0;`);
  lines.push(`      padding: 12px 14px;`);
  lines.push(`      overflow: auto;`);
  lines.push(`      color: #e4e4e7;`);
  lines.push(`      font: 500 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;`);
  lines.push(`      white-space: pre-wrap;`);
  lines.push(`      word-break: break-word;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-overlay.is-minimized .__void-error-backdrop {`);
  lines.push(`      opacity: 0;`);
  lines.push(`      pointer-events: none;`);
  lines.push(`    }`);
  lines.push(`    .__void-error-overlay.is-minimized .__void-error-panel {`);
  lines.push(`      opacity: 0;`);
  lines.push(`      pointer-events: none;`);
  lines.push(`      transform: scale(0.92);`);
  lines.push(`    }`);
  lines.push(`    .__void-error-overlay.is-minimized .__void-error-minimized {`);
  lines.push(`      opacity: 1;`);
  lines.push(`      pointer-events: auto;`);
  lines.push(`      transform: scale(1);`);
  lines.push(`    }`);
  lines.push(`    @media (max-width: 720px) {`);
  lines.push(`      .__void-error-panel {`);
  lines.push(`        inset: auto 12px 12px 12px;`);
  lines.push(`        inline-size: auto;`);
  lines.push(`        max-block-size: min(70dvh, 920px);`);
  lines.push(`        padding: 16px;`);
  lines.push(`      }`);
  lines.push(`      .__void-error-minimized {`);
  lines.push(`        inset: auto auto 12px 12px;`);
  lines.push(`      }`);
  lines.push(`      .__void-error-frame {`);
  lines.push(`        flex-direction: column;`);
  lines.push(`        align-items: flex-start;`);
  lines.push(`      }`);
  lines.push(`      .__void-error-frame-location {`);
  lines.push(`        text-align: left;`);
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`  </style>`);
  lines.push(
    `<aside class="__void-error-overlay" data-void-error-overlay role="dialog" aria-label="Void dev error overlay"><div class="__void-error-backdrop" data-void-error-backdrop></div><section class="__void-error-panel"><button type="button" class="__void-error-close" data-void-error-close aria-label="Minimize error overlay"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.757 3.757 12.243 12.243M12.243 3.757 3.757 12.243" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg></button><header class="__void-error-header"><p class="__void-error-status">\${__voidEscapeHtml(String(status) + ": " + title)}</p></header>\${sections}</section><button type="button" class="__void-error-minimized" data-void-error-toggle aria-label="Show dev error overlay" aria-expanded="true">\${__voidEscapeHtml(errorCountLabel)}</button><script>(function(){const script=document.currentScript;if(!(script instanceof HTMLScriptElement))return;const root=script.closest("[data-void-error-overlay]");if(!(root instanceof HTMLElement))return;const backdrop=root.querySelector("[data-void-error-backdrop]");const closeButton=root.querySelector("[data-void-error-close]");const toggle=root.querySelector("[data-void-error-toggle]");const setMinimized=(minimized)=>{root.classList.toggle("is-minimized", minimized);if(toggle instanceof HTMLElement)toggle.setAttribute("aria-expanded", minimized ? "false" : "true");};if(backdrop instanceof HTMLElement)backdrop.addEventListener("click",()=>setMinimized(true));if(closeButton instanceof HTMLElement)closeButton.addEventListener("click",()=>setMinimized(true));if(toggle instanceof HTMLElement)toggle.addEventListener("click",()=>setMinimized(false));})();</script></aside>\`;`,
  );
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidInjectDevErrorOverlay(html, overlay) {`);
  lines.push(
    `  return /<\\/body\\s*>/i.test(html) ? html.replace(/<\\/body\\s*>/i, overlay + "</body>") : html + overlay;`,
  );
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidRenderErrorPage(request, status, title, error) {`);
  lines.push(`  const heading = status + ": " + title;`);
  lines.push(`  const prefix = status + ": ";`);
  lines.push(
    `  const overlay = __VOID_DEV && status === 500 && error ? __voidRenderDevErrorOverlay(request, status, title, error) : "";`,
  );
  lines.push(`  return \`<!doctype html>`);
  lines.push(`<html lang="en">`);
  lines.push(`  <head>`);
  lines.push(`    <meta charset="utf-8">`);
  lines.push(`    <meta name="viewport" content="width=device-width, initial-scale=1">`);
  lines.push(`    <title>\${__voidEscapeHtml(heading)}</title>`);
  lines.push(`    <style>`);
  lines.push(`      :root {`);
  lines.push(`        color-scheme: light dark;`);
  lines.push(`        font-family: \${__VOID_ERROR_PAGE_FONT_STACK};`);
  lines.push(`        background: #f5f5f5;`);
  lines.push(`        color: #171717;`);
  lines.push(`      }`);
  lines.push(`      * { box-sizing: border-box; }`);
  lines.push(`      body {`);
  lines.push(`        margin: 0;`);
  lines.push(`        min-block-size: 100dvh;`);
  lines.push(`        display: grid;`);
  lines.push(`        place-items: center;`);
  lines.push(`        padding: 24px;`);
  lines.push(
    `        background: radial-gradient(circle at top, rgba(255, 255, 255, 0.96), rgba(245, 245, 245, 0.96) 52%), linear-gradient(180deg, #fafafa 0%, #f1f1f1 100%);`,
  );
  lines.push(`        font: 500 16px/1.5 \${__VOID_ERROR_PAGE_FONT_STACK};`);
  lines.push(`      }`);
  lines.push(`      main {`);
  lines.push(`        inline-size: min(100%, 560px);`);
  lines.push(`        padding: 32px 36px;`);
  lines.push(`        border: 1px solid #d4d4d8;`);
  lines.push(`        border-radius: 32px;`);
  lines.push(`        corner-shape: squircle;`);
  lines.push(`        background: rgba(255, 255, 255, 0.88);`);
  lines.push(`        text-align: center;`);
  lines.push(`        backdrop-filter: blur(12px);`);
  lines.push(`      }`);
  lines.push(`      h1 {`);
  lines.push(`        margin: 0;`);
  lines.push(
    `        font: 400 clamp(1.5rem, 1.2rem + 1vw, 2rem) / 1.1 \${__VOID_ERROR_PAGE_FONT_STACK};`,
  );
  lines.push(`        letter-spacing: -0.03em;`);
  lines.push(`      }`);
  lines.push(`      strong {`);
  lines.push(`        font-weight: 600;`);
  lines.push(`      }`);
  lines.push(`      @media (prefers-color-scheme: dark) {`);
  lines.push(`        :root {`);
  lines.push(`          background: #0a0a0a;`);
  lines.push(`          color: #f5f5f5;`);
  lines.push(`        }`);
  lines.push(`        body {`);
  lines.push(
    `          background: radial-gradient(circle at top, rgba(38, 38, 38, 0.96), rgba(10, 10, 10, 0.96) 52%), linear-gradient(180deg, #171717 0%, #0a0a0a 100%);`,
  );
  lines.push(`        }`);
  lines.push(`        main {`);
  lines.push(`          border-color: #27272a;`);
  lines.push(`          background: rgba(23, 23, 23, 0.88);`);
  lines.push(`        }`);
  lines.push(`      }`);
  lines.push(`    </style>`);
  lines.push(`  </head>`);
  lines.push(`  <body>`);
  lines.push(`    <main>`);
  lines.push(
    `      <h1><strong>\${__voidEscapeHtml(prefix)}</strong>\${__voidEscapeHtml(title)}</h1>`,
  );
  lines.push(`    </main>`);
  lines.push(`    \${overlay}`);
  lines.push(`  </body>`);
  lines.push(`</html>\`;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`function __voidCreateErrorResponse(request, status, title, error) {`);
  lines.push(`  if (!__voidShouldServeHtmlErrorPage(request)) {`);
  lines.push(`    return new Response(title, { status });`);
  lines.push(`  }`);
  lines.push(
    `  return new Response(request.method === "HEAD" ? null : __voidRenderErrorPage(request, status, title, error), {`,
  );
  lines.push(`    status,`);
  lines.push(`    headers: { "content-type": "text/html; charset=utf-8" },`);
  lines.push(`  });`);
  lines.push(`}`);
  lines.push('');
}

export interface AuthCompileOptions {
  authRuntimePath: string;
  authConfigPath: string | null;
  authDatabasePath: string | null;
  authSchemaPath: string | null;
  dialect: 'sqlite' | 'postgresql';
  providers: ReadonlyArray<VoidAuthProvider> | null;
}

export interface CompileOptions {
  /** Absolute path to the hono module entry */
  honoPath: string;
  /** Absolute path to the void/response module */
  responsePath: string;
  /** Absolute path to the void/handler module (for runtime error classes) */
  handlerPath: string;
  /** Absolute path to the void/_env module */
  runtimeEnvPath: string;
  /** Absolute path to the project root */
  projectRoot: string;
  /** Absolute path to the current user's home directory */
  homeDir: string;
  /** Whether to inject React Fast Refresh preamble in dev SSR HTML. */
  reactRefresh: boolean;
  /** Whether the generated route module is being compiled for dev server usage. */
  dev?: boolean;
  /** Auth configuration (null = disabled) */
  auth: AuthCompileOptions | null;
  /** `node`/`bun`/`deno` target — omits executionCtx from ALS context */
  nodeTarget?: boolean;
  /** Absolute path to the binding handler module (for /__void/* native binding access) */
  bindingHandlerPath?: string;
  /** Absolute path to the migration handler module */
  migrationHandlerPath?: string;
  /** Bundled migration SQL entries */
  migrations?: Array<{ name: string; sql: string }>;
  /** Migration dialect (sqlite or postgresql) */
  migrationDialect?: 'sqlite' | 'postgresql';
  /** Header rules from routing.headers config (node/bun/deno targets only) */
  headerRules?: Array<HeaderRule>;
  /** Redirect rules from routing.redirects config (node/bun/deno targets only) */
  redirectRules?: Array<DevRedirectRule>;
  /**
   * Post-asset fallback rules (plain `_redirects` 200 + `routing.fallbacks`).
   * Only fire when no route/SSR handler matched — emitted inside Hono's
   * `notFound` hook on `node`/`bun`/`deno` targets. Empty/undefined skips
   * the fallback middleware entirely.
   */
  fallbackRules?: Array<DevRedirectRule>;
  /** Explicit prerender paths from void.json routing.prerender */
  explicitPrerenderPaths?: Array<string>;
  /** Absolute path to the internal WebSocket runtime module */
  webSocketRuntimePath?: string;
}

export interface SsrCompileOptions {
  /** Absolute path to src/main.ssr.ts(x) */
  serverEntryPath: string;
  /** Relative project path for src/main.client.ts(x), e.g. src/main.client.tsx */
  clientEntryRelativePath: string;
}

export interface PagesCompileOptions {
  /** Absolute path to pages/ directory */
  pagesDir: string;
  /** Pages directory relative to Vite root, e.g. "pages" — used for manifest key lookup */
  pagesDirRelative: string;
  /** Absolute path to void/pages-protocol module */
  protocolPath: string;
  /** Absolute path to void/pages-head module */
  headPath: string;
  /** Virtual module ID for the client entry (used for asset tags) */
  clientEntryId: string;
  /** Virtual module ID for the islands client entry (used for island asset tags) */
  islandClientEntryId?: string;
  /** Virtual module ID for the md plugin's client entry (script execution) */
  mdClientEntryId?: string;
  /** Head config from void.json */
  headConfig?: import('../pages/head.ts').HeadConfig;
}

/**
 * Generate the code for the virtual route table module (virtual:void-routes).
 * This module creates a Hono app with:
 * - Middleware registered via app.use()
 * - Routes registered with lazy-loaded handlers and auto-conversion
 */
export function compileRouteTable(
  scan: ScanResult,
  routesDir: string,
  middlewareDir: string,
  jobsDir: string,
  queuesDir: string,
  ssr: SsrCompileOptions | null,
  options: CompileOptions,
  pages: PagesCompileOptions | null = null,
): string {
  const lines: Array<string> = [];
  const auth = options.auth;
  const webSockets = scan.websockets ?? [];

  lines.push(`import { AsyncLocalStorage } from "node:async_hooks";`);
  lines.push(`import { Hono } from ${JSON.stringify(options.honoPath)};`);
  lines.push(`import { convertReturnValue } from ${JSON.stringify(options.responsePath)};`);
  lines.push(
    `import { VoidAssetRewriteError as __VoidAssetRewriteError } from ${JSON.stringify(options.handlerPath)};`,
  );
  if (options.nodeTarget) {
    lines.push(`const withRuntimeEnv = (_env, fn) => fn();`);
  } else {
    lines.push(`import { withRuntimeEnv } from ${JSON.stringify(options.runtimeEnvPath)};`);
  }

  if (auth) {
    const authImports = ['runVoidAuthMiddleware', 'handleVoidAuthRequest', 'runVoidAuthMigrations'];
    if (webSockets.length > 0) {
      authImports.push('resolveVoidAuthState as __resolveVoidAuthStateRuntime');
    }
    lines.push(
      `import { ${authImports.join(', ')} } from ${JSON.stringify(auth.authRuntimePath)};`,
    );
    if (auth.authDatabasePath) {
      lines.push(`import { __voidAuthDatabase } from ${JSON.stringify(auth.authDatabasePath)};`);
    }
    if (auth.authSchemaPath) {
      lines.push(
        `import { migrationSchema as __voidAuthMigrationSchema } from ${JSON.stringify(auth.authSchemaPath)};`,
      );
    }
    if (auth.authConfigPath) {
      lines.push(`import __voidAuthConfig from ${JSON.stringify(auth.authConfigPath)};`);
    }
  }
  if (webSockets.length > 0 && options.webSocketRuntimePath) {
    lines.push(
      `import { createWebSocketDurableObject as __createWebSocketDurableObject, handleWebSocketUpgrade as __handleWebSocketUpgrade, forwardWebSocketRequest as __forwardWebSocketRequest } from ${JSON.stringify(options.webSocketRuntimePath)};`,
    );
  }
  lines.push('');

  // Generate eager imports for middleware
  for (let i = 0; i < scan.middleware.length; i++) {
    const mw = scan.middleware[i];
    lines.push(`import middleware${i} from ${JSON.stringify(`${middlewareDir}/${mw.filePath}`)};`);
  }
  for (let i = 0; i < webSockets.length; i++) {
    const route = webSockets[i];
    lines.push(`import websocket${i} from ${JSON.stringify(`${routesDir}/${route.filePath}`)};`);
  }
  lines.push('');

  if (auth) {
    lines.push(
      `const __voidAuthOptions = { dialect: ${JSON.stringify(auth.dialect)}, providers: ${JSON.stringify(auth.providers)}, userConfig: ${auth.authConfigPath ? '__voidAuthConfig' : 'undefined'} };`,
    );
    if (webSockets.length > 0) {
      lines.push(
        `const __resolveVoidAuthState = (request, env, runtime) => __resolveVoidAuthStateRuntime(request, env, runtime${auth.authDatabasePath ? ', __voidAuthDatabase' : ''});`,
      );
    }
    lines.push('');
  }

  lines.push(`const app = new Hono();`);
  lines.push(`export const requestContext = new AsyncLocalStorage();`);
  // WeakMap<Request, URL> — keyed on the Request the user handler sees
  // (`c.req.raw`), value is the pre-rewrite URL. Single source of truth for
  // `c.originalUrl` / `c.isRewritten` and the "already re-dispatched, skip
  // routing rules" short-circuit. Populated by (a) in-worker `c.rewrite` on
  // the new `rewriteReq`, (b) the static-rewrite middleware on re-dispatch,
  // and (c) the entry middleware below, which migrates `X-Void-Original-URL`
  // set by an outer edge dispatcher into the map once per request. WeakMap
  // so entries collect when the Request is GC'd.
  lines.push('const __voidOriginalUrls = new WeakMap();');
  // WeakSet<Request> — marks re-dispatches that have already been through
  // the fallback-rules phase, so the `notFound` fallback check skips them
  // (prevents fallback→fallback cycles). Populated only by fallback rule
  // re-dispatches, NOT by `c.rewrite` or the static-rewrite middleware —
  // those should still get a chance at fallbacks for their target URL.
  lines.push('const __voidFallbackHandled = new WeakSet();');
  // Known static-asset extensions — `c.rewrite()` into one of these re-enters
  // the Hono router and 404s (static asset handlers run in front of the
  // worker, not inside it). `.html` is deliberately excluded: it's ambiguous
  // with legit route handlers at `.html` paths.
  //
  // The framework also lets users name route files with dotted extensions
  // (e.g. `routes/feed.xml.ts` → pattern `/feed.xml`), so we filter the
  // blocklist down to extensions NOT used by any registered route/page.
  // Without this, `c.rewrite("/feed.xml")` to a real `feed.xml.ts` route
  // would falsely throw, diverging from `routing.rewrites` which routes
  // the same destination to the same handler without complaint.
  const ASSET_EXTENSIONS = [
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'avif',
    'svg',
    'ico',
    'css',
    'js',
    'mjs',
    'cjs',
    'woff',
    'woff2',
    'ttf',
    'otf',
    'eot',
    'mp4',
    'webm',
    'mp3',
    'wav',
    'pdf',
    'txt',
    'xml',
    'json',
    'wasm',
    'map',
  ];
  const routePatterns: Array<string> = [];
  for (const r of scan.routes) {
    routePatterns.push(r.pattern);
  }
  if (pages && scan.pages.pages.length > 0) {
    for (const p of scan.pages.pages) {
      routePatterns.push(p.pattern);
    }
  }
  const usedExts = new Set<string>();
  for (const p of routePatterns) {
    const m = /\.([A-Za-z0-9]+)$/.exec(p);
    if (m) {
      usedExts.add(m[1]!.toLowerCase());
    }
  }
  const blockedExts = ASSET_EXTENSIONS.filter((e) => !usedExts.has(e));
  if (blockedExts.length > 0) {
    lines.push(`const __voidAssetRewriteExtRE = /\\.(${blockedExts.join('|')})$/i;`);
  } else {
    // Every asset extension is shadowed by a route — no blocklist needed.
    // Match-nothing regex keeps the throw site shape unchanged.
    lines.push('const __voidAssetRewriteExtRE = /(?!)/;');
  }
  // Dev-only compile-time flag gating the `X-Void-Routing` trace header.
  // Stays `false` in production builds so the header never ships to users.
  lines.push(`const __VOID_DEV_ROUTING = ${JSON.stringify(options.dev === true)};`);
  // Re-wrap a terminal Response with an added `X-Void-Routing` trace header.
  // Becomes an identity function in production because `__VOID_DEV_ROUTING`
  // is `false`, so the header never ships — and because the constant is a
  // literal `false`, minifiers can eliminate the whole branch.
  lines.push('function __voidAnnotateRouting(response, trace) {');
  lines.push('  if (!__VOID_DEV_ROUTING || !response) return response;');
  lines.push('  const headers = new Headers(response.headers);');
  lines.push('  headers.set("X-Void-Routing", trace);');
  lines.push(
    '  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });',
  );
  lines.push('}');
  lines.push('');
  // Internal signal consumed by platform dispatch: a 404 came from generated
  // no-route handling, not from a user route intentionally returning 404.
  // Dispatch strips the header before responding to the client.
  lines.push('function __voidShouldMarkNoMatch(request) {');
  lines.push('  const url = new URL(request.url);');
  lines.push('  if (request.method !== "GET" && request.method !== "HEAD") return false;');
  lines.push('  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return false;');
  lines.push('  if (/\\/[^/]+\\.[^/]+$/.test(url.pathname)) return false;');
  lines.push('  return true;');
  lines.push('}');
  lines.push('function __voidMarkNoMatch(request, response) {');
  lines.push(
    '  if (!response || response.status !== 404 || !__voidShouldMarkNoMatch(request)) return response;',
  );
  lines.push('  const headers = new Headers(response.headers);');
  lines.push('  headers.set("X-Void-No-Match", "1");');
  lines.push(
    '  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });',
  );
  lines.push('}');
  lines.push('');

  // `__mergeQueryIntoLocation` is used by both the routing-rules middleware
  // (static redirects) and the `c.redirect` wrapper below — emit it up-front
  // so it's available regardless of whether routing rules are compiled in.
  ensureMergeQueryHelperEmitted(lines);

  // Inject rewrite utility onto context — closure over `app` for re-dispatch.
  // Also wrap `c.redirect` so dynamic redirects preserve the incoming query
  // string the same way static `_redirects` entries do.
  lines.push('app.use(async (c, next) => {');
  // Migrate `X-Void-Original-URL` set by an outer edge dispatcher into the
  // WeakMap exactly once per request. Only emitted for the CF-prod target,
  // where dispatch runs in front of the worker and strips any client-supplied
  // value on ingress — making the header a trusted, dispatch-authored
  // handoff. On CF-dev (no dispatch) and on node/bun/deno self-hosted
  // targets (user owns ingress) the header is client-controlled and not
  // trustworthy, so the read is skipped. In-worker `c.rewrite` / static-
  // rewrite re-dispatches populate the WeakMap directly on the `rewriteReq`
  // and never depend on this header-read path.
  if (!options.nodeTarget && options.dev !== true) {
    lines.push('  if (!__voidOriginalUrls.has(c.req.raw)) {');
    lines.push('    const __h = c.req.raw.headers.get("X-Void-Original-URL");');
    lines.push('    if (__h != null) {');
    lines.push('      try { __voidOriginalUrls.set(c.req.raw, new URL(__h)); } catch {}');
    lines.push('    }');
    lines.push('  }');
  }
  lines.push('  c.rewrite = (path) => {');
  // `path: RewriteDestination` is typed to path-absolute strings, but a
  // leading `//` parses as a protocol-relative URL (`//host/path` →
  // `https://host/path`) and would silently turn the re-dispatch into a
  // cross-origin proxy. Combine both checks in one condition.
  lines.push('    if (!path.startsWith("/") || path.startsWith("//")) {');
  lines.push(
    '      throw new Error("c.rewrite() only accepts internal, path-absolute destinations — they must start with a single \\"/\\" (a leading \\"//\\" parses as protocol-relative and would proxy cross-origin); use fetch() for external URLs");',
  );
  lines.push('    }');
  // `URL.pathname` setter percent-encodes `?`, so split path into pathname +
  // search to keep query strings intact when callers pass `"/page?x=1"`.
  lines.push('    const __qIdx = path.indexOf("?");');
  // Reject re-dispatches into static asset paths — those handlers live in
  // front of the worker, so `app.fetch(rewriteReq)` would match nothing and
  // return a confusing 404. Strip query/fragment before matching so callers
  // passing cache-busters (e.g. `/hero.png?v=2`) still trip the guard.
  lines.push('    const __hIdx = path.indexOf("#");');
  lines.push(
    '    const __firstDelim = __qIdx === -1 ? __hIdx : __hIdx === -1 ? __qIdx : Math.min(__qIdx, __hIdx);',
  );
  lines.push(
    '    const __assetCheckPath = __firstDelim === -1 ? path : path.slice(0, __firstDelim);',
  );
  lines.push('    if (__voidAssetRewriteExtRE.test(__assetCheckPath)) {');
  lines.push('      throw new __VoidAssetRewriteError(path);');
  lines.push('    }');
  // Strip the fragment too: `URL.pathname` setter percent-encodes `#` into
  // `%23`, so `/foo#frag` would become `/foo%23frag` and the re-dispatched
  // request would land at the wrong route. Fragments don't reach servers
  // anyway, so we drop them rather than try to preserve them. The search
  // portion still starts at `?` (if present), trimmed at `#` (if present).
  lines.push('    const __pathOnly = __firstDelim === -1 ? path : path.slice(0, __firstDelim);');
  lines.push(
    '    const __searchOnly = __qIdx === -1 ? "" : path.slice(__qIdx, __hIdx === -1 ? path.length : __hIdx);',
  );
  lines.push('    const rewriteUrl = new URL(c.req.url);');
  lines.push('    rewriteUrl.pathname = __pathOnly;');
  // Only override the search when the destination carries its own query.
  // A queryless destination (`c.rewrite("/en" + c.req.path)`) preserves the
  // incoming query — mirrors the static-rewrite codegen below and keeps
  // callers from having to re-append `?page=2`, OAuth callbacks, etc.
  lines.push('    if (__searchOnly) rewriteUrl.search = __searchOnly;');
  lines.push('    const rewriteReq = new Request(rewriteUrl.toString(), c.req.raw);');
  // Preserve the earliest original URL across multi-hop rewrites: inherit
  // whatever the current hop was rewritten from (or record this hop's URL
  // if it's the first rewrite).
  lines.push('    const __prior = __voidOriginalUrls.get(c.req.raw);');
  lines.push('    __voidOriginalUrls.set(rewriteReq, __prior ?? new URL(c.req.url));');
  // `c.executionCtx` is only populated on the default Cloudflare target;
  // Hono's getter throws on node/bun/deno. Branch at compile time so we
  // don't need a runtime try/catch that could swallow unrelated errors.
  if (options.nodeTarget) {
    lines.push('    const __rewritePromise = app.fetch(rewriteReq, c.env);');
  } else {
    lines.push('    const __rewritePromise = app.fetch(rewriteReq, c.env, c.executionCtx);');
  }
  lines.push('    if (!__VOID_DEV_ROUTING) return __rewritePromise;');
  lines.push(
    '    return __rewritePromise.then((res) => __voidAnnotateRouting(res, "c.rewrite \\u2192 " + path + " (middleware)"));',
  );
  lines.push('  };');
  lines.push('  const __origRedirect = c.redirect.bind(c);');
  lines.push('  c.redirect = (location, status) => {');
  // `startsWith("/")` alone matches protocol-relative URLs ("//host/x"),
  // which the browser resolves cross-origin — merging the request query
  // there would leak params (incl. session tokens) off-origin. External
  // and protocol-relative locations pass through to the original redirect.
  lines.push(
    '    if (typeof location === "string" && location.startsWith("/") && !location.startsWith("//")) {',
  );
  lines.push('      const search = new URL(c.req.raw.url).search;');
  lines.push('      return __origRedirect(__mergeQueryIntoLocation(location, search), status);');
  lines.push('    }');
  lines.push('    return __origRedirect(location, status);');
  lines.push('  };');
  // Read helpers for rewrite metadata — single source is the WeakMap.
  lines.push('  c.originalUrl = () => __voidOriginalUrls.get(c.req.raw) ?? null;');
  lines.push('  c.isRewritten = () => __voidOriginalUrls.has(c.req.raw);');
  lines.push('  await next();');
  lines.push('});');
  lines.push('');

  // Request context middleware — threads outer request into ALS for isomorphic fetch
  lines.push('app.use(async (c, next) => {');
  if (options.nodeTarget) {
    lines.push('  await requestContext.run({ request: c.req.raw }, next);');
  } else {
    lines.push(
      '  await requestContext.run({ request: c.req.raw, executionCtx: c.executionCtx }, next);',
    );
  }
  lines.push('});');
  lines.push('');

  // Edge routing middleware. On `node`/`bun`/`deno` targets the emitted Hono
  // app owns routing end-to-end, so the middleware runs in both dev and prod.
  // On the default target the platform dispatch worker applies these rules in
  // front of the user worker at deploy time — we only emit them in dev there
  // so `vite dev` mirrors deployed behavior locally.
  const emitEdgeRules = options.nodeTarget || options.dev === true;
  if (emitEdgeRules && options.redirectRules?.length) {
    compileRoutingRulesMiddleware(
      lines,
      options.redirectRules,
      options.dev === true,
      options.nodeTarget === true,
    );
  }
  if (emitEdgeRules && options.headerRules?.length) {
    compileHeaderMiddleware(lines, options.headerRules);
  }

  if (auth) {
    lines.push('app.use(async (c, next) => {');
    lines.push(
      `  return runVoidAuthMiddleware(c, next, __voidAuthOptions${auth.authDatabasePath ? ', __voidAuthDatabase' : ''});`,
    );
    lines.push('});');
    lines.push('');
  }

  // Register user middleware
  for (let i = 0; i < scan.middleware.length; i++) {
    lines.push(`app.use(middleware${i});`);
  }
  if (scan.middleware.length > 0) {
    lines.push('');
  }

  if (auth) {
    lines.push('app.all("/api/auth", async (c) => {');
    lines.push(
      `  return handleVoidAuthRequest(c, __voidAuthOptions${auth.authDatabasePath ? ', __voidAuthDatabase' : ''});`,
    );
    lines.push('});');
    lines.push('');
    lines.push('app.all("/api/auth/*", async (c) => {');
    lines.push(
      `  return handleVoidAuthRequest(c, __voidAuthOptions${auth.authDatabasePath ? ', __voidAuthDatabase' : ''});`,
    );
    lines.push('});');
    lines.push('');
  }

  // Register routes with lazy-loaded handlers (shared loader per file)
  const seenFiles = new Set<string>();
  for (const route of scan.routes) {
    const filePath = `${routesDir}/${route.filePath}`;
    const varName = `_mod_${route.filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const loaderName = `_load_${route.filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    if (!seenFiles.has(route.filePath)) {
      seenFiles.add(route.filePath);
      lines.push(`let ${varName};`);
      lines.push(`async function ${loaderName}() {`);
      lines.push(`  if (!${varName}) ${varName} = await import(${JSON.stringify(filePath)});`);
      lines.push(`  return ${varName};`);
      lines.push(`}`);
    }

    if (route.methods.length === 0) {
      // No recognized HTTP exports — register as all()
      lines.push(`app.all(${JSON.stringify(route.pattern)}, async (c) => {`);
      lines.push(`  const mod = await ${loaderName}();`);
      lines.push(`  return convertReturnValue(await mod.default(c));`);
      lines.push(`});`);
    } else {
      for (const method of route.methods) {
        const honoMethod = method.toLowerCase();
        lines.push(`app.${honoMethod}(${JSON.stringify(route.pattern)}, async (c) => {`);
        lines.push(`  const mod = await ${loaderName}();`);
        lines.push(`  return convertReturnValue(await mod.${method}(c));`);
        lines.push(`});`);
      }
    }
  }
  lines.push('');

  if (webSockets.length > 0) {
    for (let i = 0; i < webSockets.length; i++) {
      const route = webSockets[i];
      lines.push(
        `export const ${route.className} = __createWebSocketDurableObject(websocket${i}, ${JSON.stringify(
          {
            pattern: route.pattern,
            params: route.params,
            className: route.className,
            bindingName: route.bindingName,
          },
        )}, ${auth ? '__voidAuthOptions' : 'undefined'}, ${auth ? '__resolveVoidAuthState' : 'undefined'});`,
      );
    }
    lines.push('');
    lines.push(
      `const __voidWebSocketRoutes = ${JSON.stringify(
        webSockets.map((route) => ({
          pattern: route.pattern,
          params: route.params,
          className: route.className,
          bindingName: route.bindingName,
        })),
      )};`,
    );
    lines.push('export async function __voidHandleWebSocket(request, env) {');
    lines.push('  return __handleWebSocketUpgrade(request, env, __voidWebSocketRoutes);');
    lines.push('}');
    lines.push('');
    for (let i = 0; i < webSockets.length; i++) {
      const route = webSockets[i];
      lines.push(`app.all(${JSON.stringify(route.pattern)}, async (c) => {`);
      lines.push(
        `  return __forwardWebSocketRequest(c.req.raw, c.env, __voidWebSocketRoutes[${i}]);`,
      );
      lines.push('});');
    }
    lines.push('');
  } else {
    lines.push('export async function __voidHandleWebSocket() { return null; }');
    lines.push('');
  }

  // Pages mode — generate page route handlers
  if (pages && scan.pages.pages.length > 0) {
    compilePageRoutes(lines, scan, pages, options);
  }

  compilePrerenderCollector(lines, scan, ssr, options);

  if (ssr) {
    const clientEntryUrl = `/${ssr.clientEntryRelativePath}`;
    lines.push(`const SSR_CLIENT_ENTRY_ID = ${JSON.stringify(ssr.clientEntryRelativePath)};`);
    lines.push(`const SSR_CLIENT_ENTRY_URL = ${JSON.stringify(clientEntryUrl)};`);
    lines.push(`let cachedSsrManifest = null;`);
    lines.push('');
    lines.push(`function escapeHtml(value) {`);
    lines.push(`  return String(value).replace(/"/g, "&quot;");`);
    lines.push(`}`);
    lines.push('');
    lines.push(`function getDevClientTags() {`);
    lines.push(`  const preloadTags = [\`<script type="module" src="/@vite/client"></script>\`];`);
    lines.push(`  preloadTags.push(\`${BINDING_HINT_SCRIPT}\`);`);
    if (options.reactRefresh) {
      lines.push(`  preloadTags.push(\`<script type="module">
import RefreshRuntime from "/@react-refresh";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script>\`);`);
    }
    lines.push(
      `  const bodyTag = \`<script type="module" src="\${escapeHtml(SSR_CLIENT_ENTRY_URL)}"></script>\`;`,
    );
    lines.push(`  return { css: "", preloads: preloadTags.join("\\n"), body: bodyTag };`);
    lines.push(`}`);
    lines.push('');
    lines.push(`function collectManifestFiles(manifest, entryId) {`);
    lines.push(`  const seen = new Set();`);
    lines.push(`  const toVisit = [entryId];`);
    lines.push(`  while (toVisit.length > 0) {`);
    lines.push(`    const currentId = toVisit.pop();`);
    lines.push(`    if (seen.has(currentId)) continue;`);
    lines.push(`    seen.add(currentId);`);
    lines.push(`    const chunk = manifest[currentId];`);
    lines.push(`    if (!chunk || !Array.isArray(chunk.imports)) continue;`);
    lines.push(`    for (const importedId of chunk.imports) toVisit.push(importedId);`);
    lines.push(`  }`);
    lines.push(`  return Array.from(seen);`);
    lines.push(`}`);
    lines.push('');
    lines.push(`async function loadSsrManifest(request, env) {`);
    lines.push(`  if (cachedSsrManifest) return cachedSsrManifest;`);
    lines.push(
      `  if (typeof globalThis.__VITE_MANIFEST__ === "object" && globalThis.__VITE_MANIFEST__) {`,
    );
    lines.push(`    cachedSsrManifest = globalThis.__VITE_MANIFEST__;`);
    lines.push(`    return cachedSsrManifest;`);
    lines.push(`  }`);
    lines.push(`  const assets = env?.ASSETS;`);
    lines.push(`  if (!assets || typeof assets.fetch !== "function") return null;`);
    lines.push(`  const manifestUrl = new URL("/.vite/manifest.json", request.url);`);
    lines.push(`  const response = await assets.fetch(new Request(manifestUrl.toString()));`);
    lines.push(`  if (!response.ok) return null;`);
    lines.push(`  cachedSsrManifest = await response.json();`);
    lines.push(`  return cachedSsrManifest;`);
    lines.push(`}`);
    lines.push('');
    lines.push(`async function getClientAssetTags(request, env) {`);
    lines.push(`  const manifest = await loadSsrManifest(request, env);`);
    lines.push(`  if (!manifest || typeof manifest !== "object") {`);
    lines.push(`    if (!import.meta.env.DEV) return { css: "", preloads: "", body: "" };`);
    lines.push(`    return getDevClientTags();`);
    lines.push(`  }`);
    lines.push(`  const entry = manifest[SSR_CLIENT_ENTRY_ID];`);
    lines.push(`  if (!entry || typeof entry !== "object" || typeof entry.file !== "string") {`);
    lines.push(`    return { css: "", preloads: "", body: "" };`);
    lines.push(`  }`);
    lines.push(`  const ids = collectManifestFiles(manifest, SSR_CLIENT_ENTRY_ID);`);
    lines.push(`  const cssFiles = new Set();`);
    lines.push(`  const preloadFiles = new Set();`);
    lines.push(`  for (const id of ids) {`);
    lines.push(`    const chunk = manifest[id];`);
    lines.push(`    if (!chunk || typeof chunk !== "object") continue;`);
    lines.push(`    if (Array.isArray(chunk.css)) {`);
    lines.push(`      for (const cssFile of chunk.css) cssFiles.add(cssFile);`);
    lines.push(`    }`);
    lines.push(`    if (id !== SSR_CLIENT_ENTRY_ID && typeof chunk.file === "string") {`);
    lines.push(`      preloadFiles.add(chunk.file);`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(`  const cssTags = [];`);
    lines.push(`  for (const cssFile of cssFiles) {`);
    lines.push(`    cssTags.push(\`<link rel="stylesheet" href="/\${escapeHtml(cssFile)}">\`);`);
    lines.push(`  }`);
    lines.push(`  const preloadTags = [];`);
    lines.push(`  for (const preloadFile of preloadFiles) {`);
    lines.push(
      `    preloadTags.push(\`<link rel="modulepreload" href="/\${escapeHtml(preloadFile)}">\`);`,
    );
    lines.push(`  }`);
    lines.push(
      `  const bodyTag = \`<script type="module" src="/\${escapeHtml(entry.file)}"></script>\`;`,
    );
    lines.push(
      `  return { css: cssTags.join("\\n"), preloads: preloadTags.join("\\n"), body: bodyTag };`,
    );
    lines.push(`}`);
    lines.push('');
    lines.push(`function shouldHandleSsrRequest(c) {`);
    lines.push(`  const path = c.req.path;`);
    lines.push(`  if (path === "/api" || path.startsWith("/api/")) return false;`);
    lines.push(`  if (/\\/[^/]+\\.[^/]+$/.test(path)) return false;`);
    lines.push(`  const destination = c.req.header("sec-fetch-dest");`);
    lines.push(
      `  if (destination && destination !== "document" && destination !== "empty") return false;`,
    );
    lines.push(`  return true;`);
    lines.push(`}`);
    lines.push('');
    lines.push(`async function fetchFromAssets(c) {`);
    lines.push(`  const assets = c.env?.ASSETS;`);
    lines.push(`  if (!assets || typeof assets.fetch !== "function") {`);
    lines.push(
      `    return __voidMarkNoMatch(c.req.raw, new Response("Not Found", { status: 404 }));`,
    );
    lines.push(`  }`);
    lines.push(`  const response = await assets.fetch(c.req.raw);`);
    lines.push(
      `  return response.status === 404 ? __voidMarkNoMatch(c.req.raw, new Response("Not Found", { status: 404 })) : response;`,
    );
    lines.push(`}`);
    lines.push('');
    lines.push(`async function renderSsrResponse(c, mod) {`);
    lines.push(`  const render = typeof mod.render === "function" ? mod.render : mod.default;`);
    lines.push(`  if (typeof render !== "function") {`);
    lines.push(`    throw new Error("ssr: Invalid entry. Export render(c, assetTags).");`);
    lines.push(`  }`);
    lines.push(`  const assetTags = await getClientAssetTags(c.req.raw, c.env);`);
    lines.push(`  return render(c, assetTags);`);
    lines.push(`}`);
    lines.push('');
    lines.push(`app.notFound(async (c) => {`);
    if (options.nodeTarget && options.fallbackRules?.length) {
      // On `node`/`bun`/`deno` the Hono app owns both routing and asset
      // serving, so "no route matched" is already the asset-miss phase —
      // run fallbacks before touching assets. (On the default target in dev
      // the flow below tries assets first, see the non-SSR branch for the
      // standalone hook and the `else` arm of this `shouldHandleSsrRequest`
      // for the SSR-path assets-then-fallback check.)
      emitFallbackRulesCheck(
        lines,
        options.fallbackRules,
        options.dev === true,
        '  ',
        options.nodeTarget === true,
      );
    }
    lines.push(`  if (!shouldHandleSsrRequest(c)) {`);
    if (!options.nodeTarget && options.dev === true && options.fallbackRules?.length) {
      // Default target in dev: static assets are served by the platform
      // runtime in front of this worker in production, so to reproduce that
      // behavior locally we look up assets first, then apply fallback rules
      // on a 404. Production builds on the default target skip this and let
      // the platform dispatch worker own the fallback phase.
      lines.push(`    const __assetRes = await fetchFromAssets(c);`);
      lines.push(`    if (__assetRes.status !== 404) return __assetRes;`);
      // This branch is gated on `!options.nodeTarget`, so pass `false`.
      emitFallbackRulesCheck(lines, options.fallbackRules, options.dev === true, '    ', false);
      lines.push(`    return __assetRes;`);
    } else {
      lines.push(`    return fetchFromAssets(c);`);
    }
    lines.push(`  }`);
    lines.push(`  const mod = await import(${JSON.stringify(ssr.serverEntryPath)});`);
    lines.push(`  return renderSsrResponse(c, mod);`);
    lines.push(`});`);
    lines.push('');
  } else if (
    (options.nodeTarget || options.dev === true) &&
    options.fallbackRules?.length &&
    !(pages && scan.pages.pages.length > 0)
  ) {
    // No SSR entry and no pages mode — emit a standalone notFound hook so
    // `_redirects` / `routing.fallbacks` rules still fire on asset-miss.
    // Pages mode owns its own notFound (with its own assets-first + SPA
    // fallback logic) and injects the fallback check inline at the correct
    // point; see `compilePageRoutes`.
    //
    // On `node`/`bun`/`deno` the Hono app owns asset serving, so "no route"
    // already means "no asset" — fallbacks run straight away.
    //
    // On the default target in dev we first ask the platform asset binding
    // (`env.ASSETS`) so the in-worker flow matches production, where the
    // platform serves static files before the worker even sees the request.
    // Fallbacks only fire when the asset lookup also 404s.
    lines.push(`app.notFound(async (c) => {`);
    if (!options.nodeTarget && options.dev === true) {
      lines.push(`  const assets = c.env?.ASSETS;`);
      lines.push(`  if (assets && typeof assets.fetch === "function") {`);
      lines.push(`    const __assetRes = await assets.fetch(c.req.raw);`);
      lines.push(`    if (__assetRes.status !== 404) return __assetRes;`);
      lines.push(`  }`);
    }
    emitFallbackRulesCheck(
      lines,
      options.fallbackRules,
      options.dev === true,
      '  ',
      options.nodeTarget === true,
    );
    lines.push(
      `  return __voidMarkNoMatch(c.req.raw, new Response("Not Found", { status: 404 }));`,
    );
    lines.push(`});`);
    lines.push('');
  }

  if (scan.jobs.length > 0) {
    for (let i = 0; i < scan.jobs.length; i++) {
      const job = scan.jobs[i];
      lines.push(`const job${i}Crons = ${JSON.stringify(job.crons)};`);
    }
    lines.push('');
    lines.push('export async function scheduled(controller, env, ctx) {');
    lines.push('  switch (controller.cron) {');
    for (let i = 0; i < scan.jobs.length; i++) {
      const job = scan.jobs[i];
      const filePath = JSON.stringify(`${jobsDir}/${job.filePath}`);
      for (let j = 0; j < job.crons.length; j++) {
        if (j < job.crons.length - 1) {
          lines.push(`    case job${i}Crons[${j}]:`);
        } else {
          lines.push(`    case job${i}Crons[${j}]: {`);
        }
      }
      lines.push(`      const mod = await import(${filePath});`);
      lines.push("      if (typeof mod.default === 'function') {");
      lines.push('        await mod.default(controller, env, ctx);');
      lines.push('      }');
      lines.push('      return;');
      lines.push('    }');
    }
    lines.push('    default:');
    lines.push('      return;');
    lines.push('  }');
    lines.push('}');
    lines.push('');
  } else {
    lines.push('export async function scheduled() {}');
    lines.push('');
  }

  if (scan.jobs.length > 0) {
    lines.push('const __scheduledHandler = async (c) => {');
    lines.push('  const __token = c.req.header("x-void-internal");');
    lines.push('  const __expected = __getRawEnv()?.__VOID_PROXY_TOKEN;');
    lines.push(
      '  if (__expected ? __token !== __expected : !import.meta.env.DEV && __token !== __VOID_BUILD_KEY) {',
    );
    lines.push('    return c.json({ error: "unauthorized" }, 401);');
    lines.push('  }');
    lines.push('  const { cron, scheduledTime } = await c.req.json();');
    lines.push('  const controller = { cron, scheduledTime, noRetry() {} };');
    lines.push('  await scheduled(controller, c.env, c.executionCtx);');
    lines.push('  return c.json({ ok: true });');
    lines.push('};');
    lines.push('app.post("/__void/scheduled", __scheduledHandler);');
    lines.push('');
  }

  if (scan.queues.length > 0) {
    for (let i = 0; i < scan.queues.length; i++) {
      lines.push(`const queue${i}Name = ${JSON.stringify(scan.queues[i].name)};`);
    }
    lines.push('');
    // Queue dispatch as a standalone function — called directly by native queue handler
    // and via the authenticated HTTP route. No global mutable state needed.
    lines.push('export async function __processQueue(payload, env) {');
    lines.push('  const queueSuffix = payload.queue;');
    lines.push('  const __decisions = new Map();');
    lines.push('  function __wrapMsg(m) {');
    lines.push('    let decided = false;');
    lines.push('    return {');
    lines.push(
      '      id: m.id, timestamp: new Date(m.timestamp), body: m.body, attempts: m.attempts,',
    );
    lines.push(
      '      ack() { if (!decided) { decided = true; __decisions.set(m.id, { action: "ack" }); } },',
    );
    lines.push(
      '      retry(opts) { if (!decided) { decided = true; __decisions.set(m.id, { action: "retry", ...(opts?.delaySeconds != null ? { delaySeconds: opts.delaySeconds } : {}) }); } },',
    );
    lines.push('    };');
    lines.push('  }');
    lines.push('  const __msgs = payload.messages.map(__wrapMsg);');
    lines.push('  const batch = {');
    lines.push('    queue: queueSuffix,');
    lines.push('    messages: __msgs,');
    lines.push('    ackAll() { for (const m of __msgs) m.ack(); },');
    lines.push('    retryAll(opts) { for (const m of __msgs) m.retry(opts); },');
    lines.push('  };');
    lines.push('  let __ok = true;');
    lines.push('  try {');
    for (let i = 0; i < scan.queues.length; i++) {
      const q = scan.queues[i];
      const cond = i === 0 ? 'if' : '} else if';
      lines.push(
        `    ${cond} (queueSuffix === queue${i}Name || queueSuffix.endsWith("-" + queue${i}Name)) {`,
      );
      lines.push(
        `      const mod = await import(${JSON.stringify(`${queuesDir}/${q.filePath}`)});`,
      );
      lines.push("      if (typeof mod.default === 'function') await mod.default(batch, env);");
    }
    lines.push('    }');
    lines.push('  } catch { __ok = false; }');
    lines.push(
      '  return { ok: __ok, ...(__decisions.size > 0 ? { decisions: Object.fromEntries(__decisions) } : {}) };',
    );
    lines.push('}');
    lines.push('');

    // HTTP route — same auth policy as /__void/scheduled (token required in
    // prod; in dev, skipped when `__VOID_PROXY_TOKEN` is unset).
    lines.push('const __queueHandler = async (c) => {');
    lines.push('  const __token = c.req.header("x-void-internal");');
    lines.push('  const __expected = __getRawEnv()?.__VOID_PROXY_TOKEN;');
    lines.push(
      '  if (__expected ? __token !== __expected : !import.meta.env.DEV && __token !== __VOID_BUILD_KEY) {',
    );
    lines.push('    return c.json({ error: "unauthorized" }, 401);');
    lines.push('  }');
    lines.push('  const payload = await c.req.json();');
    lines.push('  const result = await __processQueue(payload, c.env);');
    lines.push('  return c.json(result);');
    lines.push('};');
    lines.push('app.post("/__void/queue", __queueHandler);');
    lines.push('');
  }

  // /__void/migrate handler — runs bundled DB + auth migrations in-worker
  if (options.migrationHandlerPath && (options.migrations?.length || auth)) {
    lines.push(
      `import { createMigrationHandler as __createMigrationHandler } from ${JSON.stringify(options.migrationHandlerPath)};`,
    );
    lines.push(`const __migrations = ${JSON.stringify(options.migrations)};`);
    lines.push(
      `const __migrationDialect = ${JSON.stringify(options.migrationDialect ?? 'sqlite')};`,
    );
    lines.push('app.post("/__void/migrate", async (c) => {');
    lines.push('  const __voidMigrationHandler = __createMigrationHandler(');
    lines.push('    __getRawEnv(),');
    lines.push('    __migrations,');
    lines.push('    __migrationDialect,');
    if (auth) {
      lines.push(
        `    () => runVoidAuthMigrations(new Request(c.req.url), __getRawEnv(), __voidAuthOptions${
          auth.authSchemaPath ? ', __voidAuthMigrationSchema' : ''
        }),`,
      );
    } else {
      lines.push('    undefined,');
    }
    lines.push('  );');
    lines.push('  return __voidMigrationHandler(c.req.raw);');
    lines.push('});');
    lines.push('');
  }

  // /__void/* handler — native binding access via WfP dispatch (always injected for CF targets)
  if (options.bindingHandlerPath) {
    lines.push(
      `import { createBindingHandler as __createBindingHandler } from ${JSON.stringify(options.bindingHandlerPath)};`,
    );
    lines.push('let __voidBindingApp;');
    lines.push('app.all("/__void/*", async (c) => {');
    lines.push(
      '  if (!__voidBindingApp) __voidBindingApp = __createBindingHandler(__getRawEnv());',
    );
    lines.push('  const url = new URL(c.req.url);');
    lines.push('  url.pathname = url.pathname.slice(7);');
    lines.push('  return __voidBindingApp.fetch(new Request(url.toString(), c.req.raw));');
    lines.push('});');
    lines.push('');
  }

  // Request-scoped raw env — safe for concurrent requests (uses ALS, not a module global).
  // The worker entry wraps each request in __withRawEnv(env, fn). Internal route handlers
  // read it via __getRawEnv() which returns the per-request value from AsyncLocalStorage.
  lines.push('const __rawEnvStore = new AsyncLocalStorage();');
  lines.push('export function __withRawEnv(env, fn) { return __rawEnvStore.run(env, fn); }');
  lines.push('function __getRawEnv() { return __rawEnvStore.getStore(); }');
  // Build-time key for internal route auth when __VOID_PROXY_TOKEN is absent.
  // Embedded in the compiled route table — only same-build callers know it.
  lines.push(`export const __VOID_BUILD_KEY = ${JSON.stringify(crypto.randomUUID())};`);
  lines.push('');
  lines.push(`export default app;`);

  return lines.join('\n');
}

function compilePrerenderCollector(
  lines: Array<string>,
  scan: ScanResult,
  ssr: SsrCompileOptions | null,
  options: CompileOptions,
): void {
  const staticPaths = scan.pages.pages
    .filter((page) => page.prerender && page.params.length === 0 && !page.catchAll)
    .map((page) => page.pattern);
  const dynamicPages = scan.pages.pages.filter(
    (page) =>
      page.prerender && page.hasGetPrerenderPaths && (page.params.length > 0 || page.catchAll),
  );
  const explicitPaths = options.explicitPrerenderPaths ?? [];

  lines.push(`function __voidBuildPrerenderPath(pattern, params) {`);
  lines.push(`  let path = pattern;`);
  lines.push(`  for (const [key, value] of Object.entries(params)) {`);
  lines.push(`    path = path.replace(":" + key + "{.+}", value);`);
  lines.push(`    path = path.replace(":" + key, value);`);
  lines.push(`  }`);
  lines.push(`  return path;`);
  lines.push(`}`);
  lines.push('');

  lines.push(`export async function __voidCollectPrerenderPaths(request, env, ctx) {`);
  lines.push(`  return withRuntimeEnv(env, async () => {`);
  if (options.nodeTarget) {
    lines.push(`    return requestContext.run({ request }, async () => {`);
  } else {
    lines.push(`    return requestContext.run({ request, executionCtx: ctx }, async () => {`);
  }
  lines.push(`      const paths = [];`);

  for (const path of staticPaths) {
    lines.push(`      paths.push(${JSON.stringify(path)});`);
  }

  for (const page of dynamicPages) {
    const loaderName = `_pload_${page.componentId.replace(/[^a-zA-Z0-9]/g, '_')}`;
    lines.push(`      {`);
    lines.push(`        const mod = await ${loaderName}();`);
    lines.push(`        if (typeof mod.getPrerenderPaths === "function") {`);
    lines.push(`          const paramSets = await mod.getPrerenderPaths();`);
    lines.push(`          if (Array.isArray(paramSets)) {`);
    lines.push(`            for (const params of paramSets) {`);
    lines.push(
      `              paths.push(__voidBuildPrerenderPath(${JSON.stringify(page.pattern)}, params));`,
    );
    lines.push(`            }`);
    lines.push(`          }`);
    lines.push(`        }`);
    lines.push(`      }`);
  }

  if (ssr) {
    lines.push(`      {`);
    lines.push(`        const mod = await import(${JSON.stringify(ssr.serverEntryPath)});`);
    lines.push(`        if (typeof mod.getPrerenderPaths === "function") {`);
    lines.push(`          const ssrPaths = await mod.getPrerenderPaths();`);
    lines.push(`          if (Array.isArray(ssrPaths)) {`);
    lines.push(`            for (const path of ssrPaths) {`);
    lines.push(`              if (typeof path === "string") paths.push(path);`);
    lines.push(`            }`);
    lines.push(`          }`);
    lines.push(`        }`);
    lines.push(`      }`);
  }

  for (const path of explicitPaths) {
    lines.push(`      paths.push(${JSON.stringify(path)});`);
  }

  lines.push(`      return [...new Set(paths)];`);
  lines.push(`    });`);
  lines.push(`  });`);
  lines.push(`}`);
  lines.push('');
}

function compilePageRoutes(
  lines: Array<string>,
  scan: ScanResult,
  pages: PagesCompileOptions,
  options: CompileOptions,
): void {
  // Import protocol helpers and renderer
  lines.push(
    `import { handlePageGet, handlePageMutation } from ${JSON.stringify(pages.protocolPath)};`,
  );
  lines.push(
    `import { renderHeadToString, renderHtmlAttrs, renderBodyAttrs } from ${JSON.stringify(pages.headPath)};`,
  );
  lines.push(`import { renderPage } from "virtual:void-pages-renderer";`);

  // Import island renderer if any island pages exist
  const hasIslandPages = scan.pages.pages.some((p) => p.island);
  if (hasIslandPages) {
    lines.push(`import { renderIslandPage } from "virtual:void-islands-renderer";`);
  }
  lines.push('');

  // Emit head config constant from void.json
  lines.push(`const __voidHeadConfig = ${JSON.stringify(pages.headConfig ?? null)};`);
  lines.push('');
  pushDefaultErrorPageHelpers(lines, options);

  // Asset tags — reuse the SSR asset tags pattern with the pages client entry
  const clientEntryId = pages.clientEntryId;
  lines.push(`const PAGES_CLIENT_ENTRY_ID = ${JSON.stringify(clientEntryId)};`);
  lines.push(`const PAGES_CLIENT_ENTRY_URL = ${JSON.stringify('/@id/__x00__' + clientEntryId)};`);
  lines.push(`let cachedPagesManifest = null;`);
  lines.push('');
  lines.push(`function escapeHtmlAttr(value) {`);
  lines.push(`  return String(value).replace(/"/g, "&quot;");`);
  lines.push(`}`);
  lines.push('');
  lines.push(`function getPagesDevClientTags() {`);
  lines.push(
    `  const preloads = \`<script type="module" src="/@vite/client"></script>\\n${BINDING_HINT_SCRIPT}\`;`,
  );
  lines.push(
    `  const bodyTag = \`<script type="module" src="\${escapeHtmlAttr(PAGES_CLIENT_ENTRY_URL)}"></script>\`;`,
  );
  lines.push(`  return { css: "", preloads, body: bodyTag };`);
  lines.push(`}`);
  lines.push('');
  lines.push(`function collectPagesManifestFiles(manifest, entryId) {`);
  lines.push(`  const seen = new Set();`);
  lines.push(`  const toVisit = [entryId];`);
  lines.push(`  while (toVisit.length > 0) {`);
  lines.push(`    const currentId = toVisit.pop();`);
  lines.push(`    if (seen.has(currentId)) continue;`);
  lines.push(`    seen.add(currentId);`);
  lines.push(`    const chunk = manifest[currentId];`);
  lines.push(`    if (!chunk || !Array.isArray(chunk.imports)) continue;`);
  lines.push(`    for (const importedId of chunk.imports) toVisit.push(importedId);`);
  lines.push(`  }`);
  lines.push(`  return Array.from(seen);`);
  lines.push(`}`);
  lines.push('');
  // Build manifest-key mapping for each page and its layout chain
  // so CSS collection can be scoped to the active route only
  const relPagesDir = pages.pagesDirRelative;
  const pageCssKeys: Record<string, Array<string>> = {};
  for (const page of scan.pages.pages) {
    const keys = [`${relPagesDir}/${page.componentPath}`];
    const layoutIds = resolveLayoutIds(page, scan.pages.layouts, scan.pages.namedLayouts);
    for (const layoutId of layoutIds) {
      // Map layout IDs back to file paths
      const layout = scan.pages.layouts.find(
        (l) => (l.directory ? `${l.directory}/layout` : 'layout') === layoutId,
      );
      if (layout) {
        keys.push(`${relPagesDir}/${layout.filePath}`);
        continue;
      }
      const named = scan.pages.namedLayouts.find((nl) => {
        const id = nl.directory ? `${nl.directory}/_layouts/${nl.name}` : `_layouts/${nl.name}`;
        return id === layoutId;
      });
      if (named) {
        keys.push(`${relPagesDir}/${named.filePath}`);
      }
    }
    pageCssKeys[page.componentId] = keys;
  }
  lines.push(`const PAGE_CSS_KEYS = ${JSON.stringify(pageCssKeys)};`);
  lines.push('');

  lines.push(`function collectRouteCss(manifest, entryId, pageKeys) {`);
  lines.push(`  const cssFiles = new Set();`);
  lines.push(`  const visited = new Set();`);
  lines.push(`  const toVisit = [entryId];`);
  lines.push(`  while (toVisit.length > 0) {`);
  lines.push(`    const id = toVisit.pop();`);
  lines.push(`    if (visited.has(id)) continue;`);
  lines.push(`    visited.add(id);`);
  lines.push(`    const chunk = manifest[id];`);
  lines.push(`    if (!chunk) continue;`);
  lines.push(`    if (Array.isArray(chunk.css)) {`);
  lines.push(`      for (const f of chunk.css) cssFiles.add(f);`);
  lines.push(`    }`);
  lines.push(`    if (Array.isArray(chunk.imports)) {`);
  lines.push(`      for (const i of chunk.imports) toVisit.push(i);`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  for (const key of pageKeys) {`);
  lines.push(`    const stack = [key];`);
  lines.push(`    while (stack.length > 0) {`);
  lines.push(`      const id = stack.pop();`);
  lines.push(`      if (visited.has(id)) continue;`);
  lines.push(`      visited.add(id);`);
  lines.push(`      const chunk = manifest[id];`);
  lines.push(`      if (!chunk) continue;`);
  lines.push(`      if (Array.isArray(chunk.css)) {`);
  lines.push(`        for (const f of chunk.css) cssFiles.add(f);`);
  lines.push(`      }`);
  lines.push(`      if (Array.isArray(chunk.imports)) {`);
  lines.push(`        for (const i of chunk.imports) stack.push(i);`);
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  return cssFiles;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`async function loadPagesManifest(request, env) {`);
  lines.push(`  if (cachedPagesManifest) return cachedPagesManifest;`);
  lines.push(
    `  if (typeof globalThis.__VITE_MANIFEST__ === "object" && globalThis.__VITE_MANIFEST__) {`,
  );
  lines.push(`    cachedPagesManifest = globalThis.__VITE_MANIFEST__;`);
  lines.push(`    return cachedPagesManifest;`);
  lines.push(`  }`);
  lines.push(`  const assets = env?.ASSETS;`);
  lines.push(`  if (!assets || typeof assets.fetch !== "function") return null;`);
  lines.push(`  const manifestUrl = new URL("/.vite/manifest.json", request.url);`);
  lines.push(`  const response = await assets.fetch(new Request(manifestUrl.toString()));`);
  lines.push(`  if (!response.ok) return null;`);
  lines.push(`  cachedPagesManifest = await response.json();`);
  lines.push(`  return cachedPagesManifest;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`async function getPagesAssetTags(request, env, componentId) {`);
  lines.push(`  const manifest = await loadPagesManifest(request, env);`);
  lines.push(`  if (!manifest || typeof manifest !== "object") {`);
  lines.push(`    if (!import.meta.env.DEV) return { css: "", preloads: "", body: "" };`);
  lines.push(`    return getPagesDevClientTags();`);
  lines.push(`  }`);
  lines.push(`  const entry = manifest[PAGES_CLIENT_ENTRY_ID];`);
  lines.push(`  if (!entry || typeof entry !== "object" || typeof entry.file !== "string") {`);
  lines.push(`    return { css: "", preloads: "", body: "" };`);
  lines.push(`  }`);
  lines.push(`  const ids = collectPagesManifestFiles(manifest, PAGES_CLIENT_ENTRY_ID);`);
  lines.push(`  const pageKeys = componentId ? (PAGE_CSS_KEYS[componentId] || []) : [];`);
  lines.push(`  const cssFiles = collectRouteCss(manifest, PAGES_CLIENT_ENTRY_ID, pageKeys);`);
  lines.push(`  const preloadFiles = new Set();`);
  lines.push(`  for (const id of ids) {`);
  lines.push(`    const chunk = manifest[id];`);
  lines.push(`    if (!chunk || typeof chunk !== "object") continue;`);
  lines.push(`    if (id !== PAGES_CLIENT_ENTRY_ID && typeof chunk.file === "string") {`);
  lines.push(`      preloadFiles.add(chunk.file);`);
  lines.push(`    }`);
  lines.push(`  }`);
  lines.push(`  const cssTags = [];`);
  lines.push(`  for (const cssFile of cssFiles) {`);
  lines.push(`    cssTags.push(\`<link rel="stylesheet" href="/\${escapeHtmlAttr(cssFile)}">\`);`);
  lines.push(`  }`);
  lines.push(`  const preloadTags = [];`);
  lines.push(`  for (const preloadFile of preloadFiles) {`);
  lines.push(
    `    preloadTags.push(\`<link rel="modulepreload" href="/\${escapeHtmlAttr(preloadFile)}">\`);`,
  );
  lines.push(`  }`);
  lines.push(
    `  const bodyTag = \`<script type="module" src="/\${escapeHtmlAttr(entry.file)}"></script>\`;`,
  );
  lines.push(
    `  return { css: cssTags.join("\\n"), preloads: preloadTags.join("\\n"), body: bodyTag };`,
  );
  lines.push(`}`);
  lines.push('');

  // Island asset tags — same pattern but using the islands client entry
  if (hasIslandPages && pages.islandClientEntryId) {
    const islandEntryId = pages.islandClientEntryId;
    lines.push(`const ISLANDS_CLIENT_ENTRY_ID = ${JSON.stringify(islandEntryId)};`);
    lines.push(
      `const ISLANDS_CLIENT_ENTRY_URL = ${JSON.stringify('/@id/__x00__' + islandEntryId)};`,
    );
    if (pages.mdClientEntryId) {
      lines.push(`const MD_CLIENT_ENTRY_ID = ${JSON.stringify(pages.mdClientEntryId)};`);
      lines.push(
        `const MD_CLIENT_ENTRY_URL = ${JSON.stringify('/@id/__x00__' + pages.mdClientEntryId)};`,
      );
    }
    lines.push('');
    lines.push(`function getIslandsDevClientTags() {`);
    lines.push(
      `  const preloads = \`<script type="module" src="/@vite/client"></script>\\n${BINDING_HINT_SCRIPT}\`;`,
    );
    lines.push(
      `  let bodyTag = \`<script type="module" src="\${escapeHtmlAttr(ISLANDS_CLIENT_ENTRY_URL)}"></script>\`;`,
    );
    if (pages.mdClientEntryId) {
      lines.push(
        `  bodyTag += \`\\n<script type="module" src="\${escapeHtmlAttr(MD_CLIENT_ENTRY_URL)}"></script>\`;`,
      );
    }
    lines.push(`  return { css: "", preloads, body: bodyTag };`);
    lines.push(`}`);
    lines.push('');
    lines.push(`async function getIslandsAssetTags(request, env, componentId) {`);
    lines.push(`  const manifest = await loadPagesManifest(request, env);`);
    lines.push(`  if (!manifest || typeof manifest !== "object") {`);
    lines.push(`    if (!import.meta.env.DEV) return { css: "", preloads: "", body: "" };`);
    lines.push(`    return getIslandsDevClientTags();`);
    lines.push(`  }`);
    lines.push(`  const entry = manifest[ISLANDS_CLIENT_ENTRY_ID];`);
    lines.push(`  if (!entry || typeof entry !== "object" || typeof entry.file !== "string") {`);
    lines.push(`    return { css: "", preloads: "", body: "" };`);
    lines.push(`  }`);
    lines.push(`  const ids = collectPagesManifestFiles(manifest, ISLANDS_CLIENT_ENTRY_ID);`);
    // Collect md entry files too
    if (pages.mdClientEntryId) {
      lines.push(`  const mdEntry = manifest[MD_CLIENT_ENTRY_ID];`);
      lines.push(`  if (mdEntry && typeof mdEntry.file === "string") {`);
      lines.push(`    const mdIds = collectPagesManifestFiles(manifest, MD_CLIENT_ENTRY_ID);`);
      lines.push(`    for (const mdId of mdIds) ids.push(mdId);`);
      lines.push(`  }`);
    }
    // Collect route-scoped CSS (page + layout chunks) plus static-import CSS
    lines.push(`  const pageKeys = componentId ? (PAGE_CSS_KEYS[componentId] || []) : [];`);
    lines.push(`  const cssFiles = collectRouteCss(manifest, ISLANDS_CLIENT_ENTRY_ID, pageKeys);`);
    if (pages.mdClientEntryId) {
      // Also collect CSS from the md client entry's static imports
      lines.push(`  if (mdEntry && typeof mdEntry.file === "string") {`);
      lines.push(`    const mdKeys = [];`);
      lines.push(`    const mdCss = collectRouteCss(manifest, MD_CLIENT_ENTRY_ID, mdKeys);`);
      lines.push(`    for (const f of mdCss) cssFiles.add(f);`);
      lines.push(`  }`);
    }
    lines.push(`  const preloadFiles = new Set();`);
    lines.push(`  for (const id of ids) {`);
    lines.push(`    const chunk = manifest[id];`);
    lines.push(`    if (!chunk || typeof chunk !== "object") continue;`);
    // Exclude entry points from preloads (they get their own <script> tags)
    const excludeFromPreload = pages.mdClientEntryId
      ? `id !== ISLANDS_CLIENT_ENTRY_ID && id !== MD_CLIENT_ENTRY_ID`
      : `id !== ISLANDS_CLIENT_ENTRY_ID`;
    lines.push(`    if (${excludeFromPreload} && typeof chunk.file === "string") {`);
    lines.push(`      preloadFiles.add(chunk.file);`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(`  const cssTags = [];`);
    lines.push(`  for (const cssFile of cssFiles) {`);
    lines.push(
      `    cssTags.push(\`<link rel="stylesheet" href="/\${escapeHtmlAttr(cssFile)}">\`);`,
    );
    lines.push(`  }`);
    lines.push(`  const preloadTags = [];`);
    lines.push(`  for (const preloadFile of preloadFiles) {`);
    lines.push(
      `    preloadTags.push(\`<link rel="modulepreload" href="/\${escapeHtmlAttr(preloadFile)}">\`);`,
    );
    lines.push(`  }`);
    lines.push(
      `  let bodyTag = \`<script type="module" src="/\${escapeHtmlAttr(entry.file)}"></script>\`;`,
    );
    if (pages.mdClientEntryId) {
      lines.push(`  if (mdEntry && typeof mdEntry.file === "string") {`);
      lines.push(
        `    bodyTag += \`\\n<script type="module" src="/\${escapeHtmlAttr(mdEntry.file)}"></script>\`;`,
      );
      lines.push(`  }`);
    }
    lines.push(
      `  return { css: cssTags.join("\\n"), preloads: preloadTags.join("\\n"), body: bodyTag };`,
    );
    lines.push(`}`);
    lines.push('');
  }

  // Generate lazy loaders and route registrations for each page
  const seenServerFiles = new Set<string>();
  for (const page of scan.pages.pages) {
    const safeId = page.componentId.replace(/[^a-zA-Z0-9]/g, '_');

    // Determine server module path
    let serverImportPath: string | null = null;
    if (page.serverPath) {
      serverImportPath = `${pages.pagesDir}/${page.serverPath}`;
    }

    // Generate lazy loader for server module (if any)
    if (serverImportPath && !seenServerFiles.has(serverImportPath)) {
      seenServerFiles.add(serverImportPath);
      const varName = `_pmod_${safeId}`;
      const loaderName = `_pload_${safeId}`;
      lines.push(`let ${varName};`);
      lines.push(`async function ${loaderName}() {`);
      lines.push(
        `  if (!${varName}) ${varName} = await import(${JSON.stringify(serverImportPath)});`,
      );
      lines.push(`  return ${varName};`);
      lines.push(`}`);
    }

    // Generate inline head function for markdown pages without .server.ts
    let mdHeadRef: string | null = null;
    if (!serverImportPath && page.metadata && (page.metadata.title || page.metadata.description)) {
      const headObj: Record<string, unknown> = {};
      if (page.metadata.title) {
        headObj.title = page.metadata.title;
      }
      if (page.metadata.description) {
        headObj.meta = [{ name: 'description', content: page.metadata.description }];
      }
      const headVarName = `__mdHead_${safeId}`;
      lines.push(`const ${headVarName} = () => (${JSON.stringify(headObj)});`);
      mdHeadRef = headVarName;
    }

    // Choose renderer and asset tags based on island flag
    const renderer = page.island ? 'renderIslandPage' : 'renderPage';
    const assetTags =
      page.island && pages.islandClientEntryId ? 'getIslandsAssetTags' : 'getPagesAssetTags';
    const islandFlag = page.island ? ', true' : '';

    // Loader (always registered — pages always handle GET)
    lines.push(`app.get(${JSON.stringify(page.pattern)}, async (c) => {`);
    if (serverImportPath) {
      const loaderName = `_pload_${safeId}`;
      lines.push(`  const mod = await ${loaderName}();`);
      lines.push(
        `  return handlePageGet(mod.loader, mod.head, c, ${JSON.stringify(page.componentId)}, ${renderer}, ${assetTags}, __voidHeadConfig${islandFlag});`,
      );
    } else {
      const headArg = mdHeadRef ?? 'undefined';
      lines.push(
        `  return handlePageGet(undefined, ${headArg}, c, ${JSON.stringify(page.componentId)}, ${renderer}, ${assetTags}, __voidHeadConfig${islandFlag});`,
      );
    }
    lines.push(`});`);

    // Action (POST, PUT, PATCH, DELETE all route to action)
    if (page.methods.includes('action') || page.methods.includes('actions')) {
      const loaderName = `_pload_${safeId}`;
      lines.push(
        `app.on(["POST", "PUT", "PATCH", "DELETE"], ${JSON.stringify(page.pattern)}, async (c) => {`,
      );
      lines.push(`  const mod = await ${loaderName}();`);

      if (page.methods.includes('actions')) {
        // Named actions — resolve from query string
        lines.push(`  const actionName = new URL(c.req.url).searchParams.keys().next().value;`);
        lines.push(
          `  const handler = actionName ? mod.actions?.[actionName] : mod.actions?.default;`,
        );
        lines.push(
          `  if (!handler) return new Response("Unknown action" + (actionName ? ": " + actionName : ""), { status: 404 });`,
        );
      } else {
        // Single action (backward compat)
        lines.push(`  const handler = mod.action;`);
      }

      lines.push(
        `  return handlePageMutation(handler, mod.loader, mod.head, c, ${JSON.stringify(page.componentId)}, ${renderer}, ${assetTags}, __voidHeadConfig${islandFlag});`,
      );
      lines.push(`});`);
    }
  }
  lines.push('');

  // Asset fallback — delegates to env.ASSETS binding (static files from dist/client)
  lines.push(`async function fetchPagesAsset(c) {`);
  lines.push(`  if (c.req.method !== "GET" && c.req.method !== "HEAD") {`);
  lines.push(`    return new Response("Not Found", { status: 404 });`);
  lines.push(`  }`);
  lines.push(`  const assets = c.env?.ASSETS;`);
  lines.push(`  if (!assets || typeof assets.fetch !== "function") {`);
  lines.push(
    `    return __voidMarkNoMatch(c.req.raw, new Response("Not Found", { status: 404 }));`,
  );
  lines.push(`  }`);
  lines.push(`  return assets.fetch(c.req.raw);`);
  lines.push(`}`);
  lines.push('');

  // Custom error page helper — serves {status}.html from static assets (e.g. 404.html, 500.html)
  lines.push(`async function serveCustomErrorPage(c, status, fallbackText, error) {`);
  lines.push(`  try {`);
  lines.push(`    const assets = c.env?.ASSETS;`);
  lines.push(`    if (assets && typeof assets.fetch === "function") {`);
  lines.push(`      const errReq = new Request(new URL("/" + status + ".html", c.req.url));`);
  lines.push(`      const errRes = await assets.fetch(errReq);`);
  lines.push(`      if (errRes.ok) {`);
  lines.push(
    `        if (__VOID_DEV && status === 500 && error && __voidShouldServeHtmlErrorPage(c.req.raw)) {`,
  );
  lines.push(
    `          const overlay = __voidRenderDevErrorOverlay(c.req.raw, status, fallbackText, error);`,
  );
  lines.push(`          const html = await errRes.text();`);
  lines.push(
    `          return new Response(c.req.method === "HEAD" ? null : __voidInjectDevErrorOverlay(html, overlay), {`,
  );
  lines.push(`            status,`);
  lines.push(`            headers: { "content-type": "text/html; charset=utf-8" },`);
  lines.push(`          });`);
  lines.push(`        }`);
  lines.push(
    `        return new Response(errRes.body, { status, headers: { "content-type": "text/html; charset=utf-8" } });`,
  );
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`  } catch {}`);
  lines.push(`  return __voidCreateErrorResponse(c.req.raw, status, fallbackText, error);`);
  lines.push(`}`);
  lines.push('');

  // Global error handler — preserve HTTPException responses (e.g. 401 from requireAuth),
  // serve custom 500.html for unexpected errors
  lines.push(`app.onError((err, c) => {`);
  lines.push(
    `  if (err && typeof err === "object" && "getResponse" in err) return err.getResponse();`,
  );
  lines.push(`  console.error(err);`);
  lines.push(`  return serveCustomErrorPage(c, 500, "Internal Server Error", err);`);
  lines.push(`});`);
  lines.push('');

  // Page fallback — for unmatched non-API paths, try static assets first,
  // then serve the app's custom/default 404 page.
  // Uses notFound (not get("*")) so Vite's module pipeline can serve .vue/.ts files in dev.
  lines.push(`app.notFound(async (c) => {`);
  lines.push(`  const path = c.req.path;`);
  lines.push(`  if (path === "/api" || path.startsWith("/api/")) {`);
  lines.push(`    return c.text("Not Found", 404);`);
  lines.push(`  }`);
  lines.push(`  if (c.req.method !== "GET" && c.req.method !== "HEAD") {`);
  lines.push(`    return c.text("Not Found", 404);`);
  lines.push(`  }`);
  // Try static assets for any path (not just dot-containing last segments)
  lines.push(`  const assetRes = await fetchPagesAsset(c);`);
  lines.push(`  if (assetRes.status !== 404) return assetRes;`);
  // Post-asset fallback phase — `routing.fallbacks` / plain `_redirects 200`
  // rules re-dispatch through the app when assets miss but before the SPA
  // fallback renders. Node/bun/deno targets emit this in both dev and prod
  // (the Hono app owns the full pipeline there); the default target only
  // emits it in dev, since production relies on the platform dispatch
  // worker to apply fallbacks before assets are even served.
  if ((options.nodeTarget || options.dev === true) && options.fallbackRules?.length) {
    emitFallbackRulesCheck(
      lines,
      options.fallbackRules,
      options.dev === true,
      '  ',
      options.nodeTarget === true,
    );
  }
  // Dot-prefixed path segments (/.well-known/, /.env, /.git/) are never pages — 404
  lines.push(`  if (path.includes("/.")) {`);
  lines.push(`    return serveCustomErrorPage(c, 404, "Not Found");`);
  lines.push(`  }`);
  // If the last path segment contains a dot (e.g. style.css, favicon.ico),
  // treat it as a file request — serve 404 so the browser doesn't parse HTML as a file
  lines.push(`  const lastSeg = path.substring(path.lastIndexOf("/") + 1);`);
  lines.push(`  if (lastSeg.includes(".")) {`);
  lines.push(`    return serveCustomErrorPage(c, 404, "Not Found");`);
  lines.push(`  }`);
  // Non-root trailing slash — page routes never have trailing slashes,
  // so redirect /foo/ → /foo (301) instead of falling into the SPA fallback
  lines.push(`  if (path !== "/" && path.endsWith("/")) {`);
  lines.push(`    const url = new URL(c.req.url);`);
  lines.push(`    url.pathname = path.slice(0, -1);`);
  lines.push(`    return Response.redirect(url.href, 301);`);
  lines.push(`  }`);
  // All page routes are registered as explicit Hono handlers above.
  // Any path reaching here is genuinely unknown — serve the app's custom
  // 404 page when available, otherwise fall back to Void's default one.
  lines.push(
    `  return __voidMarkNoMatch(c.req.raw, await serveCustomErrorPage(c, 404, "Not Found"));`,
  );
  lines.push(`});`);
  lines.push('');
}

/**
 * Generate the Worker entry module code.
 * Re-exports the Hono app from the virtual module with an asset-serving
 * fallthrough: when the app returns 404, the entry tries env.ASSETS.fetch()
 * and adds proper Cache-Control headers (immutable for Vite-hashed /assets/*).
 *
 * When `hasQueues` is true, also exports a `queue()` handler that
 * serializes the native MessageBatch and dispatches it to the
 * `/__void/queue` Hono route. In local dev Miniflare delivers batches
 * natively to this export; in production the relay worker does it.
 *
 * When `remotePath` is provided, wraps the fetch handler to detect
 * remote mode (`__VOID_REMOTE`) and replace local bindings with
 * proxy-backed versions.
 */
export function compileWorkerEntry(
  hasQueues = false,
  remote?: { remotePath: string; envPath: string },
  assetsDir = 'assets',
  webSocketClasses: Array<string> = [],
  runtimeEnvPath = 'void/_env',
  envSchemaModule?: { importPath: string; helperPath: string },
  sandbox?: boolean | { bindingName?: string; className?: string; runtimePath?: string },
  serveSpaFallback = false,
): string {
  const remotePath = remote?.remotePath;
  const hasSandbox = sandbox === true || typeof sandbox === 'object';
  const sandboxClassName =
    typeof sandbox === 'object' ? (sandbox.className ?? 'Sandbox') : 'Sandbox';
  const sandboxBindingName =
    typeof sandbox === 'object' ? (sandbox.bindingName ?? 'SANDBOX') : 'SANDBOX';
  const sandboxRuntimePath =
    typeof sandbox === 'object' ? (sandbox.runtimePath ?? 'void/sandbox') : 'void/sandbox';
  const sandboxImport = hasSandbox
    ? `import { Sandbox as __VoidSandbox } from "@cloudflare/sandbox";\nimport { __setSandboxBindingName } from ${JSON.stringify(sandboxRuntimePath)};\n`
    : '';
  const sandboxExport = hasSandbox
    ? sandboxClassName === 'Sandbox'
      ? `export { __VoidSandbox as Sandbox };\n__setSandboxBindingName(${JSON.stringify(sandboxBindingName)});\n`
      : `export class ${sandboxClassName} extends __VoidSandbox {}\n__setSandboxBindingName(${JSON.stringify(sandboxBindingName)});\n`
    : '';
  const runtimeEnvImport = `import { withRuntimeEnv } from ${JSON.stringify(runtimeEnvPath)};\n`;
  const remoteImport = remote
    ? `import { createRemoteEnv } from ${JSON.stringify(remote.remotePath)};\n`
    : '';
  // Boot-time env validation: import the user's env.ts so the schema is
  // registered, plus the validator helper. The helper short-circuits after
  // the first call per isolate and throws EnvValidationError on bad values.
  const envSchemaImport = envSchemaModule
    ? `import ${JSON.stringify(envSchemaModule.importPath)};\nimport { _validateEnvOnce } from ${JSON.stringify(envSchemaModule.helperPath)};\n`
    : '';
  const envValidateCall = envSchemaModule ? '  await _validateEnvOnce(env);\n' : '';

  // Filter internal platform bindings so user code cannot access them via c.env.
  // The original env is preserved for framework internals (withRuntimeEnv, etc.).
  // Prefixes derived from INTERNAL_BINDING_PREFIXES (shared with env.ts).
  const prefixCheck = INTERNAL_BINDING_PREFIXES.map(
    (p) => `prop.startsWith(${JSON.stringify(p)})`,
  ).join(' || ');
  const prefixCheckNeg = INTERNAL_BINDING_PREFIXES.map(
    (p) => `!key.startsWith(${JSON.stringify(p)})`,
  ).join(' && ');
  const filterBindingsHelper = `
function __filterInternalBindings(env) {
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && (${prefixCheck})) return undefined;
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === "string" && (${prefixCheck})) return false;
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter(
        (key) => typeof key !== "string" || (${prefixCheckNeg})
      );
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string" && (${prefixCheck})) return undefined;
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}
`;

  // Asset fallthrough helper — if the app returns 404, check ASSETS binding
  // for static files and set cache headers. Edge caching of hashed assets
  // happens at the dispatch layer (see design doc 0042).
  // Safe for workers without ASSETS binding (env.ASSETS check short-circuits).
  //
  // Hashed assets under assetsDir get long immutable caching (content-addressed).
  // Non-hashed asset responses are stamped no-store: a stale entry there would
  // shadow routes that are added or fixed in subsequent deploys across the edge
  // cache boundary, which the platform's deploy-scoped cache keys (dispatch
  // layer) can't reach once CF's managed edge has cached the response.
  const spaFallbackCode = serveSpaFallback
    ? `  // SPA fallback: when routes/middleware make assetConfig.not_found_handling
  // = 'none', the asset binding returns 404 instead of falling back to
  // index.html itself. Do that fallback here, after user routes/middleware
  // have run, so auth gates and OAuth callbacks see the request first.
  // Pages and SSR apps leave this disabled so intentional HTML 404s stay 404.
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    const indexUrl = new URL("/index.html", request.url);
    const indexAsset = await env.ASSETS.fetch(new Request(indexUrl, { method: request.method }));
    if (indexAsset.status === 200) {
      const res = new Response(indexAsset.body, {
        status: 200,
        headers: indexAsset.headers,
      });
      res.headers.set("Cache-Control", "no-store");
      res.headers.set("Content-Type", "text/html; charset=utf-8");
      return res;
    }
  }
  return response;`
    : `  return response;`;

  const assetHelper = `
async function serveWithAssets(request, env, response) {
  if (response.status !== 404 || !env.ASSETS || (request.method !== "GET" && request.method !== "HEAD")) return response;
  const asset = await env.ASSETS.fetch(new Request(request.url, { method: request.method, headers: request.headers }));
  if (asset.status !== 404) {
    const res = new Response(asset.body, asset);
    if (new URL(request.url).pathname.startsWith(${JSON.stringify('/' + assetsDir + '/')})) {
      res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.headers.set("Cache-Control", "no-store");
    }
    return res;
  }
${spaFallbackCode}
}
`;

  const fetchHandler = remotePath
    ? `async (request, env, ctx) => {
${envValidateCall}  const ws = await __voidHandleWebSocket(request, env);
  if (ws) return ws;
  if (env.__VOID_REMOTE === "1") env = createRemoteEnv(env);
  return __withRawEnv(env, () => {
    const userEnv = __filterInternalBindings(env);
    return withRuntimeEnv(env, async () => {
      const internal = await __handleInternal(request, env, ctx);
      if (internal) return internal;
      return serveWithAssets(request, env, await app.fetch(request, userEnv, ctx));
    });
  });
}`
    : `async (request, env, ctx) => {
${envValidateCall}  const ws = await __voidHandleWebSocket(request, env);
  if (ws) return ws;
  return __withRawEnv(env, () => {
    const userEnv = __filterInternalBindings(env);
    return withRuntimeEnv(env, async () => {
      const internal = await __handleInternal(request, env, ctx);
      if (internal) return internal;
      return serveWithAssets(request, env, await app.fetch(request, userEnv, ctx));
    });
  });
}`;

  const internalRouteHelper = `async function __handleInternal(request, env, ctx) {
  const url = new URL(request.url);
  // Readiness probe — platform polls this to confirm the worker is live after WfP upload.
  // Handled here (before app.fetch) so user middleware cannot block it.
  if (request.method === "GET" && url.pathname === "/__void/ready") {
    return Response.json({ ready: true });
  }
  if (request.method !== "POST" || url.pathname !== "/__void/prerender-paths") return null;
  const __expected = env.__VOID_PROXY_TOKEN;
  if (__expected) {
    const __token = request.headers.get("x-void-internal");
    if (!__token || __token !== __expected) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const paths = await __voidCollectPrerenderPaths(request, env, ctx);
  return Response.json({ paths });
}`;

  const scheduledHandler = remotePath
    ? `async function handleScheduled(controller, env, ctx) {
${envValidateCall}  if (env.__VOID_REMOTE === "1") env = createRemoteEnv(env);
  const userEnv = __filterInternalBindings(env);
  return withRuntimeEnv(env, () => scheduled(controller, userEnv, ctx));
}`
    : `async function handleScheduled(controller, env, ctx) {
${envValidateCall}  const userEnv = __filterInternalBindings(env);
  return withRuntimeEnv(env, () => scheduled(controller, userEnv, ctx));
}`;

  if (hasQueues) {
    return `${sandboxImport}import app, { scheduled, __voidCollectPrerenderPaths, __voidHandleWebSocket, __withRawEnv, __processQueue${webSocketClasses.length > 0 ? `, ${webSocketClasses.join(', ')}` : ''} } from 'virtual:void-routes';
${runtimeEnvImport}${envSchemaImport}${remoteImport}${filterBindingsHelper}${assetHelper}
${internalRouteHelper}
${scheduledHandler}
async function queue(batch, env, ctx) {
${envValidateCall}${remotePath ? `  if (env.__VOID_REMOTE === "1") env = createRemoteEnv(env);\n` : ''}  const userEnv = __filterInternalBindings(env);
  const messages = [...batch.messages].map(m => ({
    id: m.id, timestamp: m.timestamp.toISOString(),
    body: m.body, attempts: m.attempts,
  }));
  const payload = { queue: batch.queue, messages };
  const __qr = await __withRawEnv(env, () => withRuntimeEnv(env, () => __processQueue(payload, userEnv)));
  if (__qr.decisions) {
    const __msgMap = new Map();
    for (const m of batch.messages) __msgMap.set(m.id, m);
    for (const [id, d] of Object.entries(__qr.decisions)) {
      const m = __msgMap.get(id);
      if (!m) continue;
      if (d.action === "ack") m.ack();
      else if (d.action === "retry") m.retry(d.delaySeconds != null ? { delaySeconds: d.delaySeconds } : undefined);
    }
  }
  if (!__qr.ok) throw new Error("queue: Handler failed.");
}

${webSocketClasses.map((name) => `export { ${name} };`).join('\n')}
${sandboxExport}
export default { fetch: ${fetchHandler}, scheduled: handleScheduled, queue };`;
  }
  return `${sandboxImport}import app, { scheduled, __voidCollectPrerenderPaths, __voidHandleWebSocket, __withRawEnv${webSocketClasses.length > 0 ? `, ${webSocketClasses.join(', ')}` : ''} } from 'virtual:void-routes';
${runtimeEnvImport}${envSchemaImport}${remoteImport}${filterBindingsHelper}${assetHelper}
${internalRouteHelper}
${scheduledHandler}
${webSocketClasses.map((name) => `export { ${name} };`).join('\n')}
${sandboxExport}
export default { fetch: ${fetchHandler}, scheduled: handleScheduled };`;
}

/**
 * Generate the app module — exports the Hono app with static asset serving.
 * This is the entry imported by `vite preview` and can be used programmatically.
 *
 * When `envSchemaModule` is provided, splices boot-time env validation so it
 * runs on the first request (including the prerender child process spawned
 * by `prerenderPagesNode`). Mirrors `compileWorkerEntry`: a side-effect import
 * registers the schema, and `_validateEnvOnce` throws `EnvValidationError` on
 * bad values. Env source on Node/Bun is `process.env`; on Deno it's
 * `Deno.env.toObject()`.
 */
export function compileNodeApp(
  target: 'node' | 'bun' | 'deno',
  honoPath: string,
  envSchemaModule?: { importPath: string; helperPath: string },
): string {
  const staticImport =
    target === 'bun'
      ? `import { serveStatic } from "hono/bun";`
      : target === 'deno'
        ? `import { serveStatic } from "hono/deno";`
        : `import { serveStatic } from "@hono/node-server/serve-static";`;

  // Boot-time env validation: side-effect import so defineEnv() registers the
  // schema, plus the validator helper. Helper short-circuits after the first
  // call per process and throws EnvValidationError on bad values. Node/Bun
  // read env from `process.env`; Deno from `Deno.env.toObject()`.
  const envSchemaImport = envSchemaModule
    ? `import ${JSON.stringify(envSchemaModule.importPath)};\nimport { _validateEnvOnce } from ${JSON.stringify(envSchemaModule.helperPath)};\n`
    : '';
  const envSource = target === 'deno' ? 'Deno.env.toObject()' : 'process.env';
  const envMiddleware = envSchemaModule
    ? `app.use("*", async (c, next) => { await _validateEnvOnce(${envSource}); return next(); });\n`
    : '';

  return `${staticImport}
import { Hono } from ${JSON.stringify(honoPath)};
import innerApp, { __voidCollectPrerenderPaths } from "virtual:void-routes";
${envSchemaImport}
const app = new Hono();
${envMiddleware}app.post("/__void/prerender-paths", async (c) => {
  const __expected = c.env?.__VOID_PROXY_TOKEN;
  if (__expected) {
    const __token = c.req.header("x-void-internal");
    if (!__token || __token !== __expected) return c.json({ error: "unauthorized" }, 401);
  }
  const paths = await __voidCollectPrerenderPaths(c.req.raw);
  return c.json({ paths });
});
app.use("/assets/*", serveStatic({ root: "./client" }));
app.all("*", (c) => innerApp.fetch(c.req.raw));
export default app;`;
}

/**
 * Generate the server entry — imports the app and starts an HTTP server.
 * This is what users run with `node dist/ssr/index.js`.
 */
export function compileNodeServer(target: 'node' | 'bun' | 'deno'): string {
  if (target === 'bun') {
    return `import app from "./app.js";

const port = Number(process.env.PORT || 3000);
Bun.serve({ fetch: app.fetch, port });
console.log("Listening on http://localhost:" + port);`;
  }

  if (target === 'deno') {
    return `import app from "./app.js";

const port = Number(Deno.env.get("PORT") || 3000);
Deno.serve({ port }, app.fetch);`;
  }

  // Node.js (default)
  return `import { serve } from "@hono/node-server";
import app from "./app.js";

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log("Listening on http://localhost:" + info.port);
});`;
}

/**
 * Generate the server-side fetch client module for non-CF targets.
 * Same as compileWorkerClient but without cloudflare:workers dependency.
 * Calls app.fetch() directly (no HTTP round-trip) with ALS context forwarding.
 */
export function compileBrowserClient(
  authClientPath: string,
  fetchPath: string,
  fetchStreamPath: string,
): string {
  return `export { fetch, FetchError } from ${JSON.stringify(fetchPath)};
export { fetchStream, StreamError } from ${JSON.stringify(fetchStreamPath)};
export { auth, createAuthClient } from ${JSON.stringify(authClientPath)};`;
}

export function compileNodeClient(authClientPath: string): string {
  return `import app, { requestContext } from "virtual:void-routes";
export { auth, createAuthClient } from ${JSON.stringify(authClientPath)};

export class FetchError extends Error {
  constructor(status, statusText, data) {
    super(\`fetch: Request failed with status \${status}.\`);
    this.name = "FetchError";
    this.status = status;
    this.statusText = statusText;
    this.data = data;
  }
}

export async function fetch(path, options) {
  let url = path;
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url = url.replace(":" + key, encodeURIComponent(value));
    }
  }

  if (options?.query) {
    const qs = new URLSearchParams(options.query).toString();
    if (qs) url += "?" + qs;
  }

  const method = options?.method ?? "GET";
  const headers = new Headers(options?.headers);

  const store = requestContext.getStore();
  if (store?.request) {
    const outerReq = store.request;
    if (!headers.has("cookie")) {
      const cookie = outerReq.headers.get("cookie");
      if (cookie) headers.set("cookie", cookie);
    }
    if (!headers.has("authorization")) {
      const auth = outerReq.headers.get("authorization");
      if (auth) headers.set("authorization", auth);
    }
  }

  if (options?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const request = new Request("http://localhost" + url, {
    method,
    headers,
    body: options?.body != null ? JSON.stringify(options.body) : undefined,
  });

  const response = await app.fetch(request);

  if (response.status === 204) return undefined;

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    throw new FetchError(response.status, response.statusText, data);
  }

  return data;
}`;
}

/**
 * Emit inline `__compilePattern()` and `__matchPattern()` — pattern compilation
 * with named captures, matching the dispatch worker's behavior in
 * `packages/dispatch/src/pattern.ts`.
 *
 * Syntax:
 *   :name    — single path segment (captured as `name`)
 *   :name*   — zero or more segments (captured as `name`)
 *   *        — zero or more segments (captured as `splat`, legacy)
 *
 * When a pattern contains multiple bare `*`, only the first captures as
 * `splat`; later occurrences emit a non-capturing `.*` so the constructed
 * `RegExp` doesn't reject "duplicate group name" at request time. `:name*`
 * uses a distinct group name and never clashes with `*`. `__matchPattern`
 * additionally swallows any compile-time `RegExp` error and returns `false`
 * so a single malformed rule cannot 500 unrelated requests on CF dev.
 */
function emitCompilePattern(lines: Array<string>): void {
  lines.push('function __compilePattern(source) {');
  lines.push('  const names = [];');
  lines.push('  let legacySplatCaptured = false;');
  lines.push('  let pattern = "";');
  lines.push('  let i = 0;');
  lines.push('  while (i < source.length) {');
  lines.push('    const ch = source[i];');
  lines.push('    if (ch === ":") {');
  lines.push('      let j = i + 1;');
  lines.push('      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;');
  lines.push('      const name = source.slice(i + 1, j);');
  lines.push('      if (!name) { pattern += "\\\\:"; i++; continue; }');
  lines.push('      if (source[j] === "*") {');
  lines.push('        names.push(name);');
  lines.push('        pattern += `(?<${name}>.*)`;');
  lines.push('        i = j + 1;');
  lines.push('      } else {');
  lines.push('        names.push(name);');
  lines.push('        pattern += `(?<${name}>[^/]+)`;');
  lines.push('        i = j;');
  lines.push('      }');
  lines.push('    } else if (ch === "*") {');
  lines.push('      if (legacySplatCaptured) {');
  lines.push('        pattern += ".*";');
  lines.push('      } else {');
  lines.push('        names.push("splat");');
  lines.push('        pattern += "(?<splat>.*)";');
  lines.push('        legacySplatCaptured = true;');
  lines.push('      }');
  lines.push('      i++;');
  lines.push('    } else {');
  lines.push('      if (/[.+?^${}()|[\\]\\\\]/.test(ch)) pattern += "\\\\";');
  lines.push('      pattern += ch;');
  lines.push('      i++;');
  lines.push('    }');
  lines.push('  }');
  lines.push('  return { regex: new RegExp(`^${pattern}$`), names };');
  lines.push('}');
  lines.push('const __matchPatternWarned = new Set();');
  lines.push('function __matchPattern(pattern, pathname) {');
  lines.push('  try {');
  lines.push('    return __compilePattern(pattern).regex.test(pathname);');
  lines.push('  } catch (err) {');
  lines.push('    if (!__matchPatternWarned.has(pattern)) {');
  lines.push('      __matchPatternWarned.add(pattern);');
  lines.push(
    '      console.warn(`[void] failed to compile route pattern ${JSON.stringify(pattern)}: ${err && err.message ? err.message : err}`);',
  );
  lines.push('    }');
  lines.push('    return false;');
  lines.push('  }');
  lines.push('}');
  lines.push('function __substituteParams(destination, params) {');
  lines.push('  return destination.replace(/:([A-Za-z0-9_]+)\\*?/g, (whole, name) => {');
  lines.push('    return params[name] != null ? params[name] : whole;');
  lines.push('  });');
  lines.push('}');
  lines.push('');
}

function ensureCompilePatternEmitted(lines: Array<string>): void {
  if (!lines.some((l) => l.includes('function __compilePattern'))) {
    emitCompilePattern(lines);
  }
}

/**
 * Emit the `__mergeQueryIntoLocation` helper. Shared between the static
 * routing-rules middleware (for `_redirects` entries) and the dynamic
 * `c.redirect` wrapper, so it's emitted unconditionally above the rewrite
 * middleware. If the destination already carries a param, the destination
 * wins — matching the static-redirect semantics.
 */
function ensureMergeQueryHelperEmitted(lines: Array<string>): void {
  if (lines.some((l) => l.includes('function __mergeQueryIntoLocation'))) {
    return;
  }
  lines.push('function __mergeQueryIntoLocation(destination, search) {');
  lines.push('  if (!search || search === "?") return destination;');
  lines.push('  const fragIdx = destination.indexOf("#");');
  lines.push('  const base = fragIdx === -1 ? destination : destination.slice(0, fragIdx);');
  lines.push('  const fragment = fragIdx === -1 ? "" : destination.slice(fragIdx);');
  lines.push('  const q = base.indexOf("?");');
  lines.push('  if (q === -1) return base + search + fragment;');
  lines.push('  if (q === base.length - 1) return base.slice(0, q) + fragment;');
  lines.push('  const dp = new URLSearchParams(base.slice(q + 1));');
  lines.push('  for (const [k, v] of new URLSearchParams(search)) {');
  lines.push('    if (!dp.has(k)) dp.append(k, v);');
  lines.push('  }');
  lines.push('  return base.slice(0, q) + "?" + dp.toString() + fragment;');
  lines.push('}');
  lines.push('');
}

/**
 * Shared body for routing-rule evaluation: match rules in order (last wins),
 * substitute captures into destination, handle rewrite (200) or redirect (3xx).
 * Used by both the pre-pipeline routing middleware and the post-pipeline
 * fallback (notFound) middleware.
 */
function emitApplyRoutingRules(
  lines: Array<string>,
  rulesVar: string,
  indent: string,
  nodeTarget: boolean,
  markFallbackHandled: boolean = false,
): void {
  lines.push(`${indent}let matched;`);
  lines.push(`${indent}for (const rule of ${rulesVar}) {`);
  // A malformed rule.source (e.g. `:id/:id` or `:splat`+`*` colliding on
  // the same group name) makes `new RegExp` throw inside __compilePattern.
  // Build-time validators reject those, but a hand-crafted manifest could
  // still reach the worker — skip the offending rule rather than 500ing
  // every request that hits this middleware. Mirrors dispatch's
  // applyRoutingRules try/catch (packages/dispatch/src/routing-rules.ts).
  lines.push(`${indent}  let regex;`);
  lines.push(`${indent}  try {`);
  lines.push(`${indent}    ({ regex } = __compilePattern(rule.source));`);
  lines.push(`${indent}  } catch (err) {`);
  lines.push(`${indent}    if (!__matchPatternWarned.has(rule.source)) {`);
  lines.push(`${indent}      __matchPatternWarned.add(rule.source);`);
  lines.push(
    `${indent}      console.warn(\`[void] skipping routing rule with invalid source \${JSON.stringify(rule.source)}: \${err && err.message ? err.message : err}\`);`,
  );
  lines.push(`${indent}    }`);
  lines.push(`${indent}    continue;`);
  lines.push(`${indent}  }`);
  lines.push(`${indent}  const m = regex.exec(pathname);`);
  lines.push(`${indent}  if (m) matched = { rule, params: m.groups || {} };`);
  lines.push(`${indent}}`);
  lines.push(`${indent}if (matched) {`);
  lines.push(
    `${indent}  const dest = __substituteParams(matched.rule.destination, matched.params);`,
  );
  lines.push(`${indent}  if (matched.rule.status === 200) {`);
  // Config-level validation already rejects `?` in rewrite/fallback
  // destinations, but split pathname + search here anyway so emitted code
  // stays defensive and parallel with the `c.rewrite` helper above.
  lines.push(`${indent}    const __qIdx = dest.indexOf("?");`);
  lines.push(`${indent}    const __pathOnly = __qIdx === -1 ? dest : dest.slice(0, __qIdx);`);
  lines.push(`${indent}    const __searchOnly = __qIdx === -1 ? "" : dest.slice(__qIdx);`);
  lines.push(`${indent}    const rewriteUrl = new URL(c.req.url);`);
  lines.push(`${indent}    rewriteUrl.pathname = __pathOnly;`);
  lines.push(`${indent}    if (__searchOnly) rewriteUrl.search = __searchOnly;`);
  lines.push(`${indent}    const rewriteReq = new Request(rewriteUrl.toString(), c.req.raw);`);
  // Seed the WeakMap so re-dispatched handlers see the pre-rewrite URL via
  // `c.originalUrl()` / `c.isRewritten()`. Inherit a prior hop's value if
  // one exists (multi-hop via `c.rewrite` from user middleware that wraps
  // a static rewrite).
  lines.push(`${indent}    const __prior = __voidOriginalUrls.get(c.req.raw);`);
  lines.push(`${indent}    __voidOriginalUrls.set(rewriteReq, __prior ?? new URL(c.req.url));`);
  if (markFallbackHandled) {
    // Fallback rule re-dispatch: tag the next hop so its `notFound` won't
    // re-enter the fallback phase (single-hop fallback semantics, parity
    // with dispatch's single `applyRoutingRules(fallbackRules, ...)` call).
    lines.push(`${indent}    __voidFallbackHandled.add(rewriteReq);`);
  }
  // Branch at compile time on target — Hono's `c.executionCtx` getter throws
  // on node/bun/deno targets where the ExecutionContext is absent.
  if (nodeTarget) {
    lines.push(`${indent}    const __r = await app.fetch(rewriteReq, c.env);`);
  } else {
    lines.push(`${indent}    const __r = await app.fetch(rewriteReq, c.env, c.executionCtx);`);
  }
  lines.push(`${indent}    if (!__VOID_DEV_ROUTING) return __r;`);
  lines.push(`${indent}    const __kind = matched.rule.force === true ? "rewrite" : "fallback";`);
  lines.push(
    `${indent}    const __trace = __kind + "[" + matched.rule.source + "] \\u2192 " + dest + " (" + (matched.rule.origin || "unknown") + ")";`,
  );
  lines.push(`${indent}    return __voidAnnotateRouting(__r, __trace);`);
  lines.push(`${indent}  }`);
  lines.push(
    `${indent}  const location = __mergeQueryIntoLocation(dest, new URL(c.req.url).search);`,
  );
  lines.push(`${indent}  const __redir = c.redirect(location, matched.rule.status);`);
  lines.push(`${indent}  if (!__VOID_DEV_ROUTING) return __redir;`);
  lines.push(
    `${indent}  const __rtrace = "redirect[" + matched.rule.source + "] \\u2192 " + dest + " " + matched.rule.status + " (" + (matched.rule.origin || "unknown") + ")";`,
  );
  lines.push(`${indent}  return __voidAnnotateRouting(__redir, __rtrace);`);
  lines.push(`${indent}}`);
}

/**
 * Strip dev-only `origin` metadata from a rule list before embedding in the
 * generated worker code. Keeps production bundles free of authoring hints.
 *
 * Keep in sync with `stripDevOnlyRuleFields` in `cli/package.ts`. This helper
 * intentionally preserves `force` because the Node/Bun/Deno-target codegen
 * reads it at runtime to label the `X-Void-Routing` trace header as either
 * `rewrite[...]` (force) or `fallback[...]`. The CLI version strips both
 * fields because the deploy manifest never transmits either to the dispatch
 * worker (phase is implied by which bucket the rule ships in).
 */
function stripOriginForProd(rules: Array<DevRedirectRule>): Array<DevRedirectRule> {
  return rules.map(({ origin: _origin, ...rest }) => rest);
}

/**
 * Emit routing rules middleware — handles both redirects (3xx) and rewrites (200).
 * Last match wins. Rewrites re-dispatch with a guard header to prevent loops.
 * Redirects preserve the request's query string in the Location header.
 *
 * When `dev === true` the per-rule `origin` metadata is preserved in the
 * compiled rule table and a matched rule's trace is emitted on the
 * `X-Void-Routing` response header. In production the origin field is
 * stripped and no trace header is emitted.
 */
function compileRoutingRulesMiddleware(
  lines: Array<string>,
  rules: Array<DevRedirectRule>,
  dev: boolean,
  nodeTarget: boolean,
): void {
  ensureCompilePatternEmitted(lines);
  lines.push('// Routing rules: redirects + rewrites (applied before route handlers)');
  lines.push(`const __routingRules = ${JSON.stringify(dev ? rules : stripOriginForProd(rules))};`);
  lines.push('app.use("*", async (c, next) => {');
  // Re-dispatched rewrites short-circuit: the outer caller (either a static
  // rule or a user `c.rewrite()`) owns annotating the final response, so
  // we intentionally don't set a trace header here.
  lines.push('  if (__voidOriginalUrls.has(c.req.raw)) return next();');
  lines.push('  const pathname = new URL(c.req.url).pathname;');
  emitApplyRoutingRules(lines, '__routingRules', '  ', nodeTarget);
  if (dev) {
    // No static rule matched — let the pipeline run, then annotate the final
    // response with a default pass-through trace (unless downstream already
    // set one, e.g. from a middleware `c.rewrite()` hop).
    lines.push('  await next();');
    lines.push('  if (__VOID_DEV_ROUTING && c.res && !c.res.headers.has("X-Void-Routing")) {');
    // Some runtimes produce Responses with guarded/immutable Headers; silently
    // skip the trace annotation rather than crashing the dev middleware.
    lines.push('    try { c.res.headers.set("X-Void-Routing", "pass-through"); } catch {}');
    lines.push('  }');
  } else {
    lines.push('  return next();');
  }
  lines.push('});');
  lines.push('');
}

/**
 * Emit a fallback-rule check inside Hono's `notFound` hook. Fires only when
 * the pipeline didn't match a route — the "asset-miss / no route matched"
 * phase. Re-dispatches through `app.fetch` on a rule match so the re-dispatched
 * request runs through the full middleware + route stack with
 * `X-Void-Original-URL` set; falls through to the caller's existing notFound
 * body when no rule matches.
 *
 * Indent `indent` so the emitted statements nest cleanly within the caller's
 * block. Expects `__matchPattern`, `__voidOriginalUrls`, `__mergeQueryIntoLocation`,
 * `__substituteParams`, and `__voidAnnotateRouting` to already be in scope —
 * which they are, because `compileRoutingRulesMiddleware` runs earlier in
 * compile order and emits every one of them.
 */
function emitFallbackRulesCheck(
  lines: Array<string>,
  rules: Array<DevRedirectRule>,
  dev: boolean,
  indent: string,
  nodeTarget: boolean,
): void {
  ensureCompilePatternEmitted(lines);
  // Emit the rule table once; reference from the notFound body. The table is
  // hoisted to module scope so multiple notFound call sites see the same
  // constant — today there's only one, but leaving the door open costs nothing.
  const tableMarker = '// Fallback rules (applied on no-match, post-route)';
  if (!lines.includes(tableMarker)) {
    lines.push(tableMarker);
    lines.push(
      `const __fallbackRules = ${JSON.stringify(dev ? rules : stripOriginForProd(rules))};`,
    );
    lines.push('');
  }
  // Single-hop guard: skip when this request was itself produced by a
  // fallback re-dispatch. User `c.rewrite` and static-rewrite middleware
  // re-dispatches are NOT marked here — they should still get a chance at
  // fallbacks for the rewrite target (`/old → /new` then `/new` matches
  // a fallback, or `c.rewrite('/missing')` where `/missing` is a fallback
  // source). See `__voidFallbackHandled` declaration above.
  lines.push(`${indent}if (!__voidFallbackHandled.has(c.req.raw)) {`);
  lines.push(`${indent}  const pathname = new URL(c.req.url).pathname;`);
  emitApplyRoutingRules(lines, '__fallbackRules', `${indent}  `, nodeTarget, true);
  lines.push(`${indent}}`);
}

/**
 * Emit header middleware — applies matching header rules to every response.
 * All matching rules merge; last match wins for same header name.
 */
function compileHeaderMiddleware(lines: Array<string>, rules: Array<HeaderRule>): void {
  ensureCompilePatternEmitted(lines);
  lines.push('// Header rules (applied to responses)');
  lines.push(`const __headerRules = ${JSON.stringify(rules)};`);
  lines.push('app.use("*", async (c, next) => {');
  lines.push('  await next();');
  lines.push('  const pathname = new URL(c.req.url).pathname;');
  lines.push('  const matched = [];');
  lines.push('  for (const rule of __headerRules) {');
  lines.push('    if (__matchPattern(rule.pattern, pathname)) matched.push(...rule.headers);');
  lines.push('  }');
  lines.push('  for (const [name, value] of matched) {');
  lines.push('    c.res.headers.set(name, value);');
  lines.push('  }');
  lines.push('});');
  lines.push('');
}

export function compileWorkerClient(authClientPath: string): string {
  return `import app, { requestContext } from "virtual:void-routes";
import { env } from "cloudflare:workers";
export { auth, createAuthClient } from ${JSON.stringify(authClientPath)};

export class FetchError extends Error {
  constructor(status, statusText, data) {
    super(\`fetch: Request failed with status \${status}.\`);
    this.name = "FetchError";
    this.status = status;
    this.statusText = statusText;
    this.data = data;
  }
}

export async function fetch(path, options) {
  let url = path;
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url = url.replace(":" + key, encodeURIComponent(value));
    }
  }

  if (options?.query) {
    const qs = new URLSearchParams(options.query).toString();
    if (qs) url += "?" + qs;
  }

  const method = options?.method ?? "GET";
  const headers = new Headers(options?.headers);

  // Auto-forward cookie and authorization from the outer request via ALS
  const store = requestContext.getStore();
  if (store?.request) {
    const outerReq = store.request;
    if (!headers.has("cookie")) {
      const cookie = outerReq.headers.get("cookie");
      if (cookie) headers.set("cookie", cookie);
    }
    if (!headers.has("authorization")) {
      const auth = outerReq.headers.get("authorization");
      if (auth) headers.set("authorization", auth);
    }
  }

  if (options?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const request = new Request("http://worker.local" + url, {
    method,
    headers,
    body: options?.body != null ? JSON.stringify(options.body) : undefined,
  });

  // Use real executionCtx from ALS if available, otherwise provide a no-op fallback
  const executionCtx = store?.executionCtx ?? { waitUntil() {}, passThroughOnException() {} };
  const response = await app.fetch(request, env, executionCtx);

  if (response.status === 204) return undefined;

  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok) {
    throw new FetchError(response.status, response.statusText, data);
  }

  return data;
}
`;
}
