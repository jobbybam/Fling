// preload.js — the only bridge between the renderer (index.html) and the
// main process. Exposes a small, specific API instead of raw Node access.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcher", {
  listGames: () => ipcRenderer.invoke("games:list"),

  browseForFolder: () => ipcRenderer.invoke("path:browse"),
  autoDetectPath: (id) => ipcRenderer.invoke("path:autoDetect", id),
  setInstallPath: (id, installPath) => ipcRenderer.invoke("path:set", id, installPath),
  clearInstallPath: (id) => ipcRenderer.invoke("path:clear", id),
  openInstallFolder: (id) => ipcRenderer.invoke("path:openInExplorer", id),

  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),

  getSelectedAlpha: () => ipcRenderer.invoke("state:getSelected"),
  setSelectedAlpha: (id) => ipcRenderer.invoke("state:setSelected", id),
  getBootFlags: () => ipcRenderer.invoke("boot:getFlags"),

  getFlags: () => ipcRenderer.invoke("flags:get"),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  getConsoleCommands: () => ipcRenderer.invoke("console:getCommands"),
  // mode: "main" (the game itself) or "ext" (its Category Extensions game)
  getLeaderboard: (id, categoryId, mode) => ipcRenderer.invoke("leaderboard:get", id, categoryId, mode),

  // Linked speedrun.com account (public profile only, no login).
  getSpeedrunUser: () => ipcRenderer.invoke("src:getUser"),
  linkSpeedrunUser: (nameOrLink) => ipcRenderer.invoke("src:link", nameOrLink),
  unlinkSpeedrunUser: () => ipcRenderer.invoke("src:unlink"),

  // One-click tool installer. Tools are addressed by id; the download URLs
  // live in main.js, not here.
  listTools: () => ipcRenderer.invoke("tools:list"),
  installTool: (id, opts) => ipcRenderer.invoke("tools:install", id, opts),
  launchTool: (id) => ipcRenderer.invoke("tools:launch", id),
  setToolShortcut: (id, on) => ipcRenderer.invoke("tools:setShortcut", id, on),
  openToolFolder: (id) => ipcRenderer.invoke("tools:openFolder", id),
  uninstallTool: (id) => ipcRenderer.invoke("tools:uninstall", id),
  onToolProgress: (callback) => ipcRenderer.on("tools:progress", (event, data) => callback(data)),

  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  closeWindow: () => ipcRenderer.send("window:close"),

  launch: (id, modded) => ipcRenderer.invoke("game:launch", id, modded),
  stop: (id) => ipcRenderer.invoke("game:stop", id),
  // payload is now { id, crashed, crashLogPath } rather than a bare id, so
  // the renderer can tell a crash apart from a normal close and offer the
  // crash log.
  onGameClosed: (callback) => ipcRenderer.on("game:closed", (event, payload) => callback(payload)),

  toggleFavorite: (id) => ipcRenderer.invoke("favorites:toggle", id),
  openCrashLog: (logPath) => ipcRenderer.invoke("crashlog:open", logPath),

  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateProgress: (callback) => ipcRenderer.on("update:progress", (event, data) => callback(data)),
});
