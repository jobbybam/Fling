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
  getLeaderboard: (id, categoryId) => ipcRenderer.invoke("leaderboard:get", id, categoryId),

  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  closeWindow: () => ipcRenderer.send("window:close"),

  launch: (id, modded) => ipcRenderer.invoke("game:launch", id, modded),
  stop: (id) => ipcRenderer.invoke("game:stop", id),
  onGameClosed: (callback) => ipcRenderer.on("game:closed", (event, id) => callback(id)),

  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateProgress: (callback) => ipcRenderer.on("update:progress", (event, data) => callback(data)),
});
