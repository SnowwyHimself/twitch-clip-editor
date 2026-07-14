// Preload: the ONLY bridge between the (sandboxed, context-isolated) renderer
// and the main process. It exposes a small, explicit surface via contextBridge —
// no Node, no ipcRenderer, no arbitrary IPC leaks into the page.
const { contextBridge, ipcRenderer } = require('electron');

// The server's auth token, delivered here (not via a query string or the served
// HTML) and read by the injected fetch shim as window.electronAPI.appToken.
// sendSync is fine: it runs once, at preload init, before the page scripts.
const appToken = ipcRenderer.sendSync('clip:get-token');

contextBridge.exposeInMainWorld('electronAPI', {
  appToken,
  // Reopen a file-based project by absolute path (from the user's saved project
  // JSON). Replaces the removed /api/preview-file HTTP endpoint — the main
  // process handles the path, validated there. Returns { ok, previewUrl } | { ok:false }.
  reopenFile: (absPath) => ipcRenderer.invoke('reopen-file', absPath),
});
