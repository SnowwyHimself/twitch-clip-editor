// Preload: the ONLY bridge between the (sandboxed, context-isolated) renderer
// and the main process. It exposes a small, explicit surface via contextBridge —
// no Node, no ipcRenderer, no arbitrary IPC leaks into the page.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The server's auth token, delivered here (not via a query string or the served
// HTML) and read by the injected fetch shim as window.electronAPI.appToken.
// sendSync is fine: it runs once, at preload init, before the page scripts.
const appToken = ipcRenderer.sendSync('clip:get-token');

contextBridge.exposeInMainWorld('electronAPI', {
  appToken,
  // Resolve the absolute disk path of a File the user picked (input/drag-drop).
  // Electron 32+ removed the old File.path property; webUtils.getPathForFile is
  // the sanctioned replacement and must run here in the preload (it can't cross
  // into the isolated page world). Returns '' for File objects without a real
  // path (e.g. in a plain browser or a synthesized File).
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

  // Reopen a file-based project by absolute path (from the user's saved project
  // JSON). Replaces the removed /api/preview-file HTTP endpoint — the main
  // process handles the path, validated there. `opts.size` (bytes) is matched
  // against the file on disk so a DIFFERENT file now sitting at that path is
  // treated as missing (→ re-locate) rather than silently loaded.
  // Returns { ok, previewUrl } | { ok:false, reason }.
  reopenFile: (absPath, opts) => ipcRenderer.invoke('reopen-file', absPath, opts),

  // Quiet updates: the renderer only learns that an update is READY (to show the
  // pill), and can relaunch or dismiss. All update logic lives in the main process.
  onUpdateReady: (cb) => {
    const handler = (_e, version) => cb(version);
    ipcRenderer.on('update:ready', handler);
    return () => ipcRenderer.removeListener('update:ready', handler);
  },
  relaunchToUpdate: () => ipcRenderer.invoke('update:relaunch'),
  dismissUpdate: () => ipcRenderer.invoke('update:dismiss'),

  // Open the personal asset library folder in the OS file manager (Settings).
  openLibraryFolder: () => ipcRenderer.invoke('library:open-folder'),

  // Reveal a finished export in Finder/Explorer. Takes the export's /outputs/…
  // URL; the main process re-derives the real path inside userData/outputs, so
  // the renderer can never point the shell at an arbitrary file.
  showExportInFolder: (outputUrl) => ipcRenderer.invoke('export:show-in-folder', outputUrl),
});
