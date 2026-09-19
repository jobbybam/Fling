// main.js — Electron main process.
// This is the ONLY place that touches disk or spawns processes. The renderer
// (index.html) never gets raw Node/fs access — it only talks to this file
// through the safe API exposed in preload.js.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, execFile, execFileSync } = require("child_process");
const { downloadFile, looksLikeZip, extractZip, findFile } = require("./toolinstaller");

// discord-rpc is a real dependency (see package.json), but we still load it
// defensively: if `npm install` hasn't been run yet in a dev checkout, or the
// module fails to resolve for any other reason, Discord presence should just
// silently not happen instead of taking the whole app down at require-time.
let DiscordRPC = null;
try {
  DiscordRPC = require("discord-rpc");
} catch (e) {
  console.warn("discord-rpc not available — Discord Rich Presence disabled:", e.message);
}

// ---------------------------------------------------------------------------
// Safety net: if anything throws while this file is still being evaluated
// top-to-bottom (module load), Node/Electron would otherwise just crash the
// process — and depending on exactly where it happened, that can look like
// "some ipcMain.handle() calls near the bottom of the file never ran" (e.g.
// "No handler registered for 'game:stop'" in the renderer) rather than an
// obvious crash, because whatever DID finish registering before the throw
// still works. That's a confusing failure mode to debug blind, so surface it
// loudly instead: log it and show a real dialog naming the error.
process.on("uncaughtException", (err) => {
  console.error("Fling Launcher — uncaught exception:", err);
  try {
    dialog.showErrorBox(
      "Fling Launcher: startup error",
      "Something threw while the app was starting, which can leave some " +
        "buttons or tabs (STOP, Leaderboard, etc.) without a working handler " +
        "until this is fixed and the app is relaunched:\n\n" +
        (err && err.stack ? err.stack : String(err))
    );
  } catch (e) {
    // dialog module not ready yet (very early crash) — the console.error
    // above is still the fallback.
  }
});

// ---------------------------------------------------------------------------
// Where user-editable stuff (feature toggle files, assets/, the one-shot
// assets/data flags file, mods) actually lives on disk.
//
// In dev (`npm start`) __dirname IS the real project folder, so that's fine.
// But once this is packaged into an .exe, __dirname points INSIDE the app
// bundle (app.asar by default) — a single read-only archive file, not a
// real folder. There's no way for a user to drop an "iconsoff" file, a new
// assets/mods/<id>/ folder, or edit assets/commandlist.txt "next to
// main.js" if main.js isn't actually sitting in an editable folder anymore.
// That's why iconsoff/modinjectoroff (and anything else read this way)
// silently stopped working the moment the app got packaged, even though
// the exact same code works fine running from source.
//
// Fix: for a packaged build, resolve these against the folder the real
// installed .exe lives in (path.dirname(process.execPath)) instead of
// __dirname. That's always a normal, writable folder on disk regardless of
// whether asar packing is on, so "drop a file next to Fling Launcher.exe"
// keeps meaning exactly that after install, not "reach inside app.asar".
function getAppRoot() {
  return app.isPackaged ? path.dirname(process.execPath) : __dirname;
}

// ---------------------------------------------------------------------------
// Static per-alpha metadata. Install paths are NOT stored here — those live
// in the persisted data file below, since they're user/machine-specific.
// `steamFolder` is the guessed folder name under Steam's common install
// directory, used for "Auto-detect" in the install-path modal. These are
// best-guess names — edit them here if your actual Steam folder differs.
// Multiplayer-mod availability is NOT set here anymore — it's detected live
// from assets/mods/ (see getModStatus below), so a game's mod status updates
// automatically the moment you drop files in or add a "_nomods" folder.
//
// `label`    — what's drawn INSIDE the sidebar button when no icon image is
//              available (short, fits a 44px square).
// `short`    — the abbreviated caption drawn UNDERNEATH the sidebar button,
//              always visible whether or not an icon loaded (A1, HN2, HN2D...).
// `tutorial` — whether clicking INSTALL shows the 3-image tutorial popup
//              first. Only the alphas use it; full games, betas and the demo
//              go straight to the folder picker.
// ---------------------------------------------------------------------------
const GAMES = [
  // ---- HN1 ----
  { id: "f_hn1", label: "HN1", short: "HN1", full: "Hello Neighbor", group: "hn1",
    tutorial: false, isFullGame: true,
    steamFolder: "Hello Neighbor",
    description: "Go to the Steam Store and search for Hello Neighbor. Install the game and link it to the launcher." },
  { id: "f_hnhas", label: "H&S", short: "HNHAS", full: "Hello Neighbor: Hide and Seek", group: "hn1",
    tutorial: false, isFullGame: true,
    steamFolder: "Hello Neighbor Hide and Seek",
    description: "Go to the Steam Store and search for Hello Neighbor: Hide and Seek. Install the game and link it to the launcher." },
  { id: "apre", label: "PRE", short: "PRE", full: "Pre Alpha", group: "hn1",
    tutorial: true,
    steamFolder: "Hello Neighbor Pre Alpha",
    description: "Go to the Steam Store and search for the Hello Neighbor Pre Alpha. Install the alpha and link it to the launcher." },
  { id: "a1", label: "1", short: "A1", full: "Alpha 1", group: "hn1",
    tutorial: true,
    steamFolder: "Hello Neighbor Alpha 1",
    description: "Go to the Steam Store and search for Hello Neighbor Alpha 1. Install the alpha and link it to the launcher." },
  { id: "a2", label: "2", short: "A2", full: "Alpha 2", group: "hn1",
    tutorial: true,
    steamFolder: "Hello Neighbor Alpha 2",
    description: "Go to the Steam Store and search for Hello Neighbor Alpha 2. Install the alpha and link it to the launcher." },
  { id: "a3", label: "3", short: "A3", full: "Alpha 3", group: "hn1",
    tutorial: true,
    steamFolder: "Hello Neighbor Alpha 3",
    description: "Go to the Steam Store and search for Hello Neighbor Alpha 3. Install the alpha and link it to the launcher." },
  { id: "a4", label: "4", short: "A4", full: "Alpha 4", group: "hn1",
    tutorial: true,
    steamFolder: "Hello Neighbor Alpha 4",
    description: "Go to the Steam Store and search for Hello Neighbor Alpha 4. Install the alpha and link it to the launcher." },
  { id: "b_hn1_1", label: "B1", short: "HN1B1", full: "Hello Neighbor Beta 1", group: "hn1",
    tutorial: false,
    steamFolder: "Hello Neighbor Beta 1",
    description: "Go to the Steam Store and search for Hello Neighbor Beta 1. Install the beta and link it to the launcher." },
  { id: "b_hn1_3", label: "B3", short: "HN1B3", full: "Hello Neighbor Beta 3", group: "hn1",
    tutorial: false,
    steamFolder: "Hello Neighbor Beta 3",
    description: "Go to the Steam Store and search for Hello Neighbor Beta 3. Install the beta and link it to the launcher." },

  // ---- HN2 ----
  { id: "f_hn2", label: "HN2", short: "HN2", full: "Hello Neighbor 2", group: "hn2",
    tutorial: false, isFullGame: true,
    steamFolder: "Hello Neighbor 2",
    description: "Go to the Steam Store and search for Hello Neighbor 2. Install the game and link it to the launcher." },
  { id: "a_hg_proto", label: "PROTO", short: "HGPROTO", full: "Hello Guest Prototype", group: "hn2",
    tutorial: false,
    steamFolder: "Hello Guest Prototype",
    description: "Go to the Steam Store and search for the Hello Guest Prototype. Install the build and link it to the launcher." },
  { id: "a_hg", label: "HG", short: "HG", full: "Hello Guest", group: "hn2",
    tutorial: true,
    steamFolder: "Hello Guest",
    description: "Go to the Steam Store and search for Hello Guest. Install the alpha and link it to the launcher." },
  { id: "a1_hn2", label: "1", short: "HN2A1", full: "HN2 Alpha 1", group: "hn2",
    tutorial: true,
    steamFolder: "Hello Neighbor 2 Alpha 1",
    description: "Go to the Steam Store and search for Hello Neighbor 2 Alpha 1. Install the alpha and link it to the launcher." },
  { id: "hn2_a1_5", label: "1.5", short: "HN2A1.5", full: "HN2 Alpha 1.5", group: "hn2",
    tutorial: true,
    steamFolder: "Hello Neighbor 2 Alpha 1.5",
    description: "Go to the Steam Store and search for Hello Neighbor 2 Alpha 1.5. Install the alpha and link it to the launcher." },
  { id: "b_hn2", label: "BETA", short: "HN2B", full: "HN2 Beta", group: "hn2",
    tutorial: false,
    steamFolder: "Hello Neighbor 2 Beta",
    description: "Go to the Steam Store and search for Hello Neighbor 2 Beta. Install the beta and link it to the launcher." },
  { id: "d_hn2", label: "DEMO", short: "HN2D", full: "HN2 Demo", group: "hn2",
    tutorial: false,
    steamFolder: "Hello Neighbor 2 Demo",
    description: "Go to the Steam Store and search for Hello Neighbor 2 Demo. Install the demo and link it to the launcher." },

  // ---- HN3 ----
  { id: "pa_hn3", label: "PRE", short: "HN3PRE", full: "Hello Neighbor 3 Pre-Alpha", group: "hn3",
    tutorial: false,
    // Leaderboard-only: HN3 has no full game yet, so its speedrun.com boards
    // hang off this entry. Doesn't affect the library/sidebar at all.
    leaderboard: true, leaderboardName: "Hello Neighbor 3", gridLabel: "HN3",
    steamFolder: "Hello Neighbor 3 Pre Alpha",
    description: "Go to the Steam Store and search for the Hello Neighbor 3 Pre-Alpha. Install the build and link it to the launcher." },
];

// Some asset folders (icons + mods) use a "friendly" folder name that's
// different from the internal id, per the real assets/ layout supplied.
// Backgrounds mostly match the id directly except Hello Neighbor 1's full
// game, which uses "f_hn" everywhere assets are concerned except its own
// background art, which is also "f_hn". Kept as two separate maps since
// they were given as two separate (mostly-overlapping) conventions.
const ICON_FOLDER_OVERRIDES = { f_hn1: "f_hn", a1_hn2: "hn2_a1" };
const MOD_FOLDER_OVERRIDES = { f_hn1: "f_hn", a1_hn2: "hn2_a1" };
const BG_FOLDER_OVERRIDES = { f_hn1: "f_hn" };

// ---------------------------------------------------------------------------
// Discord Rich Presence — deliberately NOT going through Steam's rich
// presence. Steam's is proprietary Steamworks plumbing (a game writes it via
// the Steamworks SDK while running as a registered Steam app), and Discord's
// Steam integration reads it back through an undocumented, version-fragile
// local IPC channel. None of these alpha builds are wired into Steamworks
// rich presence anyway (that's usually added late, near a full release), so
// there'd be nothing to "hijack" even if spoofing that channel were a good
// idea.
//
// Instead: a small local IPC socket straight to the Discord client, using
// the actual supported discord-rpc library, tied to a Discord Application
// (free — just a client id, registered at discord.com/developers/applications).
//
// >>> Replace this with your own Discord Application's client id. <<<
// Rich Presence silently does nothing (no crash, no toast) until you do.
const DISCORD_CLIENT_ID = "1550661102763773982";

// ---------------------------------------------------------------------------
// Discord RPC is silent by design on success (no toast, no console line),
// which makes "is it actually working?" impossible to answer just by
// eyeballing a packaged build — Electron gives packaged apps no visible
// console at all, so console.log/warn calls disappear into nothing outside
// of `npm start` run from a terminal. Mirror every RPC lifecycle event to a
// small log file in userData too, so this is debuggable either way.
const DISCORD_LOG_FILE = path.join(app.getPath("userData"), "discord-rpc.log");
function discordLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(DISCORD_LOG_FILE, line + "\n"); } catch (e) { /* best effort */ }
}

let discordClient = null;
let discordReady = false;

function initDiscordRpc() {
  if (!DiscordRPC) { discordLog("init skipped — discord-rpc module failed to load"); return; }
  if (!DISCORD_CLIENT_ID || DISCORD_CLIENT_ID === "YOUR_DISCORD_CLIENT_ID_HERE") {
    discordLog("init skipped — no client id set");
    return;
  }
  discordLog(`init starting — clientId=${DISCORD_CLIENT_ID}`);
  try {
    discordClient = new DiscordRPC.Client({ transport: "ipc" });
    discordClient.on("ready", () => {
      discordReady = true;
      discordLog(`ready — connected as ${discordClient.user ? discordClient.user.username : "unknown user"}`);
    });
    discordClient.on("disconnected", () => {
      discordReady = false;
      discordLog("disconnected from Discord IPC");
    });
    // login() legitimately hangs (never resolves or rejects) if Discord
    // desktop isn't running/reachable on the local IPC pipe — that's the
    // "nothing in console, nothing ever happens" failure mode. Race it
    // against a timeout so that case gets logged instead of staying silent.
    const loginPromise = discordClient.login({ clientId: DISCORD_CLIENT_ID });
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timed out after 10s — Discord desktop app likely isn't running")), 10000)
    );
    Promise.race([loginPromise, timeout]).catch(e => {
      discordLog(`login failed: ${e.message}`);
    });
  } catch (e) {
    discordLog(`init threw: ${e.message}`);
  }
}

// Called right when a launch succeeds. Silently a no-op if Discord isn't
// connected — presence is a nice-to-have, never something launch should
// wait on or fail over.
function setDiscordPresence(game) {
  if (!discordClient || !discordReady) {
    discordLog(`setDiscordPresence skipped for ${game.id} — client=${!!discordClient} ready=${discordReady}`);
    return;
  }
  const seriesState = game.group === "hn1" ? "Hello Neighbor"
    : game.group === "hn3" ? "Hello Neighbor 3"
    : "Hello Neighbor 2";
  discordClient.setActivity({
    details: "Playing " + game.full,
    state: seriesState,
    startTimestamp: new Date(),
    largeImageKey: "fling_logo",
    largeImageText: "Fling Launcher",
    instance: false,
  }).then(() => discordLog(`setActivity succeeded for ${game.id}`))
    .catch(e => discordLog(`setActivity failed for ${game.id}: ${e.message}`));
}

function clearDiscordPresence() {
  if (!discordClient || !discordReady) return;
  discordClient.clearActivity().catch(() => {});
}

// ---------------------------------------------------------------------------
// Persisted data (install paths + settings). Stored as plain JSON in the
// user's Electron userData folder — separate from the app install, survives
// updates. Starts empty: no alpha has an install path until the user sets one.
// ---------------------------------------------------------------------------
const DATA_FILE = path.join(app.getPath("userData"), "fling-launcher-data.json");

// Defaults for everything the Settings panel owns. Kept in one place so a
// missing/older data file just falls back field by field instead of blowing up.
const SETTINGS_DEFAULTS = {
  hideTutorial: false,
  // "dark" | "light" | one of the other four theme ids (see THEME_IDS).
  theme: "dark",
  // false = strip every transition/animation in the UI.
  animations: true,
  // What the launcher window does once a game actually starts:
  // "stay" (nothing), "minimize", or "close".
  launchBehavior: "stay",
};

// Valid theme ids. All six are normal, always-available options — there's
// no gated/experimental subset anymore.
const THEME_IDS = ["dark", "light", "crimson", "midnight", "terminal", "sunset"];

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      installPaths: parsed.installPaths || {},
      hideTutorial: !!parsed.hideTutorial,
      theme: THEME_IDS.includes(parsed.theme) ? parsed.theme : SETTINGS_DEFAULTS.theme,
      animations: parsed.animations === undefined ? SETTINGS_DEFAULTS.animations : !!parsed.animations,
      launchBehavior: ["stay", "minimize", "close"].includes(parsed.launchBehavior)
        ? parsed.launchBehavior
        : SETTINGS_DEFAULTS.launchBehavior,
      // Last-selected alpha id, so the app reopens on whatever the user was
      // last looking at instead of always resetting to the first alpha.
      selectedId: parsed.selectedId || null,
      // Pinned ids for the Favorites sidebar group — a favorited entry stays
      // in its normal HN1/HN2 group too, this is pure duplication for quick
      // access, not a move.
      favoriteIds: Array.isArray(parsed.favoriteIds) ? parsed.favoriteIds : [],
      // Cumulative playtime per id, in whole seconds.
      playtime: (parsed.playtime && typeof parsed.playtime === "object") ? parsed.playtime : {},
      // Whether this user has already seen the welcome animation. A data
      // file that predates this field belongs to an existing user, so treat
      // them as already welcomed instead of replaying it after an update.
      welcomeShown: parsed.welcomeShown === undefined ? true : !!parsed.welcomeShown,
      // Tools installed through the Tools tab: id -> { version, installedAt }.
      tools: (parsed.tools && typeof parsed.tools === "object") ? parsed.tools : {},
      // Linked speedrun.com account: { id, name } or null. The id is what
      // gets matched against leaderboard runs (usernames can change).
      speedrunUser: (parsed.speedrunUser && typeof parsed.speedrunUser.id === "string" && typeof parsed.speedrunUser.name === "string")
        ? { id: parsed.speedrunUser.id, name: parsed.speedrunUser.name }
        : null,
    };
  } catch (e) {
    // No file yet (first run) or unreadable — start clean. welcomeShown is
    // false here, which is what makes a brand-new install show the welcome
    // animation exactly once.
    return { installPaths: {}, ...SETTINGS_DEFAULTS, selectedId: null, favoriteIds: [], playtime: {}, welcomeShown: false, tools: {}, speedrunUser: null };
  }
}

function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

let data = loadData();

// Tracks currently-running games, keyed by alpha id:
//   { child, pid, exeName, pollTimer, launchedAt, installPath, pollCount }
// so the renderer's STOP button has something real to act on and so we can
// push a "it closed" event back when a game exits on its own (closed
// normally, crashed, or was killed via STOP). See killProcessTree /
// isImageRunning below for why this stores more than just the child handle.
// launchedAt/installPath are also what playtime accounting and crash-log
// detection key off of (see reportClosed / findCrashArtifact below).
const runningProcesses = new Map();

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#0d0f0d",
    autoHideMenuBar: true,
    frame: false, // no native OS titlebar/border — the renderer draws its own
    icon: path.join(__dirname, "favicon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile("index.html");
}

app.whenReady().then(() => {
  // Clean up the save file left behind by the old built-in split timer.
  try { fs.rmSync(path.join(app.getPath("userData"), "fling-launcher-splits.json"), { force: true }); } catch (e) { /* nothing to clean */ }
  createWindow();
  initDiscordRpc();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Closing the launcher doesn't close anything it launched — games keep
// running on their own. Just stop polling for them.
app.on("before-quit", () => {
  runningProcesses.forEach((entry, id) => {
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    flushEntryPlaytime(entry, id);
  });
  runningProcesses.clear();
  if (discordClient) { try { discordClient.destroy(); } catch (e) { /* already gone */ } }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Find the most likely .exe to launch inside an install folder. Alphas are
// typically a flat Unreal/Unity build folder with one obvious top-level exe,
// but we don't assume a filename — we scan for it.
function findExecutable(installPath) {
  try {
    const entries = fs.readdirSync(installPath, { withFileTypes: true });
    const exeFiles = entries
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith(".exe"))
      // Skip obvious non-game executables that ship alongside some builds.
      .filter(e => !/unins|redist|vcredist|directx|crashreport/i.test(e.name));
    if (exeFiles.length === 0) return null;
    return path.join(installPath, exeFiles[0].name);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stopping a game — why this isn't just child.kill().
//
// Two things broke the old STOP button:
//   1. Lots of these builds ship a small launcher/shim .exe that immediately
//      starts the real game binary and then exits. The moment that shim
//      exited, our child's "exit" event fired, we cleared the entry, and STOP
//      would answer "That isn't running right now" while the game was clearly
//      still on screen.
//   2. Even when the exe we spawned IS the game, child.kill() on Windows only
//      terminates that one process — never anything it spawned underneath —
//      and a detached+unref'd process often ignores it outright.
//
// So: kill the whole process TREE by pid (taskkill /T /F on Windows), and if
// the pid is already gone, fall back to killing by image name, which catches
// the shim case. Separately, we don't trust the child's "exit" event alone to
// mean "the game closed" — we poll for the image name until it's really gone.
// ---------------------------------------------------------------------------
const isWindows = process.platform === "win32";

// tasklist's default "table" output truncates the Image Name column at 25
// characters, which silently breaks the "does the output include exeName"
// substring check below for anything with a longer filename (not rare for
// Unreal/Unity builds — e.g. "HelloNeighborAlphaFour-Win64-Shipping.exe" is
// 43 chars, well past the cutoff) — tasklist would just never appear to
// match, so STOP could report "still running" forever, or the closed-poll
// could never fire. /FO CSV disables truncation entirely and gives a real
// quoted, parseable image-name field to compare exactly against.
function parseTasklistCsv(out, exeName) {
  const needle = exeName.toLowerCase();
  return out.split(/\r?\n/).some(line => {
    const m = line.match(/^"([^"]*)"/);
    return m && m[1].toLowerCase() === needle;
  });
}

// Is any process with this executable name currently running?
function isImageRunning(exeName) {
  if (!exeName) return false;
  try {
    if (isWindows) {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq " + exeName, "/FO", "CSV", "/NH"], {
        encoding: "utf-8", windowsHide: true, timeout: 5000,
      });
      return parseTasklistCsv(out, exeName);
    }
    execFileSync("pgrep", ["-f", exeName], { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch (e) {
    // tasklist prints "INFO: No tasks..." (exit 0) and pgrep exits non-zero
    // when nothing matched — either way, treat it as "not running".
    return false;
  }
}

// Async twin of isImageRunning, used by the every-few-seconds poll so the
// main process (and therefore the window) never blocks on tasklist.
function isImageRunningAsync(exeName) {
  return new Promise(resolve => {
    if (!exeName) return resolve(false);
    const cmd = isWindows ? "tasklist" : "pgrep";
    const args = isWindows ? ["/FI", "IMAGENAME eq " + exeName, "/FO", "CSV", "/NH"] : ["-f", exeName];
    execFile(cmd, args, { encoding: "utf-8", windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(false);
      if (!isWindows) return resolve(true);
      resolve(parseTasklistCsv(String(stdout), exeName));
    });
  });
}

// ---------------------------------------------------------------------------
// PID-tree lookup — a second, name-independent way of finding the real game
// process, added because the exe-name approach above has a real gap: it only
// catches the launcher-shim case (comment above killProcessTree) when the
// real game happens to share the shim's exe name, which the code has always
// just assumed rather than verified. When it doesn't share the name (a shim
// that launches a differently-named Shipping exe, for instance), exe-name
// matching can never find it — no method above, and no amount of retrying,
// would ever locate the right process, which is a plausible reason STOP can
// still fail even after all of the retry/elevation work.
//
// Windows records a process's ParentProcessId once, at creation time, and
// never updates it — even after that parent has long since exited. So a full
// process snapshot taken NOW can still tell us "this process was ultimately
// spawned by the pid we originally launched", however many levels of
// shimming happened in between, and regardless of what any of those
// processes are named. That makes it possible to find (and kill) the actual
// running game even when it shares nothing but ancestry with what we spawned.
function getProcessSnapshotAsync() {
  return new Promise(resolve => {
    if (!isWindows) return resolve([]);
    execFile("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
    ], { windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      try {
        let parsed = JSON.parse(stdout);
        if (!Array.isArray(parsed)) parsed = [parsed];
        resolve(parsed.filter(p => p && p.ProcessId != null));
      } catch (e) {
        resolve([]);
      }
    });
  });
}

// Every currently-live pid descended from rootPid (not including rootPid
// itself), at any depth, based on a snapshot from getProcessSnapshotAsync().
function collectLiveDescendantPids(snapshot, rootPid) {
  const byParent = new Map();
  snapshot.forEach(p => {
    const ppid = p.ParentProcessId;
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid).push(p.ProcessId);
  });
  const found = [];
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const cur = stack.pop();
    (byParent.get(cur) || []).forEach(pid => {
      if (seen.has(pid)) return;
      seen.add(pid);
      found.push(pid);
      stack.push(pid);
    });
  }
  return found;
}

// Combined liveness check for a tracked entry: true if either the exe-name
// check finds a match, OR the pid-tree snapshot still shows the original
// spawned pid or any live descendant of it. Used everywhere an entry's
// liveness is decided (the launch-time poll, the exit handler, and STOP)
// instead of the exe-name check alone, so a differently-named descendant
// still counts as "the game is still running."
async function isEntryStillRunningAsync(entry) {
  if (!entry) return false;
  if (await isImageRunningAsync(entry.exeName)) return true;
  if (isWindows && entry.pid) {
    const snapshot = await getProcessSnapshotAsync();
    if (snapshot.some(p => p.ProcessId === entry.pid)) return true;
    if (collectLiveDescendantPids(snapshot, entry.pid).length > 0) return true;
  }
  return false;
}

// Run an external command without throwing — resolves true/false instead of
// rejecting, since a "failed" kill attempt (nothing to kill, wrong
// permissions, etc.) is an expected outcome here, not an error.
function runCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err) => resolve(!err));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Kill a process and everything it spawned. Tries several methods in order,
// checking after each one whether the exe is actually gone before moving on
// to the next — so a game that resists one approach still gets a real shot
// from the others instead of STOP just giving up after a single attempt.
//
// Windows, in order:
//   1. taskkill by PID, whole tree            (the normal case)
//   1.5. taskkill each live pid-tree           (catches the launcher-shim
//        descendant individually, by pid       case even when the real
//        (see getProcessSnapshotAsync)          game does NOT share the
//                                                shim's exe name — method 2
//                                                below only ever worked when
//                                                it happened to)
//   2. taskkill by image name, whole tree      (catches the launcher-shim
//                                                case when the real game
//                                                DOES share its exe name)
//   3. PowerShell Stop-Process by name         (a different code path/
//                                                permission model than
//                                                taskkill — occasionally
//                                                succeeds where it fails)
//   4. An ELEVATED taskkill, via PowerShell's
//      "Start-Process -Verb RunAs"             (last resort — pops a real
//                                                Windows UAC prompt asking
//                                                the user to grant admin
//                                                rights; only some titles
//                                                that were installed/are
//                                                running with elevated
//                                                permissions need this)
// POSIX: SIGTERM the process group, wait, then SIGKILL the process group,
// then SIGKILL the bare pid as a last resort in case it was never actually
// its own group leader.
//
// Returns { killed: boolean, elevated: boolean } — elevated is true only if
// method 4 was the one that actually ran, so the UI can say so.
async function killProcessTree(pid, exeName) {
  let killedAny = false;

  const stillRunning = async () => isEntryStillRunningAsync({ pid, exeName });

  if (isWindows) {
    // Method 1 — by PID
    if (pid) {
      const ok = await runCmd("taskkill", ["/PID", String(pid), "/T", "/F"]);
      killedAny = killedAny || ok;
      await wait(350);
      if (!(await stillRunning())) return { killed: true, elevated: false };
    }

    // Method 1.5 — by pid-tree descendant, name-independent (see
    // getProcessSnapshotAsync's comment for why this exists on top of
    // method 2 below). Kills every currently-live process descended from
    // the pid we originally spawned, individually, by its OWN pid — this
    // is the one method here that still works even if the real game
    // shares nothing but ancestry with the exe we launched.
    if (pid) {
      const snapshot = await getProcessSnapshotAsync();
      const descendantPids = collectLiveDescendantPids(snapshot, pid);
      if (descendantPids.length) {
        for (const dpid of descendantPids) {
          const ok = await runCmd("taskkill", ["/PID", String(dpid), "/T", "/F"]);
          killedAny = killedAny || ok;
        }
        await wait(350);
        if (!(await stillRunning())) return { killed: true, elevated: false };
      }
    }

    // Method 2 — by image name (the shim case)
    if (exeName) {
      const ok = await runCmd("taskkill", ["/IM", exeName, "/T", "/F"]);
      killedAny = killedAny || ok;
      await wait(350);
      if (!(await stillRunning())) return { killed: true, elevated: false };

      // Method 3 — PowerShell Stop-Process
      const psName = exeName.replace(/\.exe$/i, "");
      const psOk = await runCmd("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Stop-Process -Name '" + psName.replace(/'/g, "''") + "' -Force -ErrorAction SilentlyContinue",
      ]);
      killedAny = killedAny || psOk;
      await wait(350);
      if (!(await stillRunning())) return { killed: true, elevated: false };

      // Method 4 — elevated retry. This pops a UAC prompt; if the user
      // approves it, an admin-level taskkill runs. If they dismiss it, this
      // just fails like any other attempt and we fall through to reporting
      // "still running" below.
      const elevatedOk = await runCmd("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Start-Process -FilePath taskkill -ArgumentList '/IM','" + exeName.replace(/'/g, "''") +
          "','/T','/F' -Verb RunAs -WindowStyle Hidden",
      ]);
      killedAny = killedAny || elevatedOk;
      // The elevated process launches asynchronously (UAC + a fresh
      // taskkill), so give it a bit longer before the final check.
      await wait(1200);
      if (!(await stillRunning())) return { killed: true, elevated: true };
    }
  } else {
    // macOS/Linux — SIGTERM the group, wait, SIGKILL the group, then a bare
    // SIGKILL on the pid itself as a last resort.
    try { process.kill(-pid, "SIGTERM"); killedAny = true; } catch (e) {
      try { process.kill(pid, "SIGTERM"); killedAny = true; } catch (e2) { /* already gone */ }
    }
    await wait(1500);
    if (!(await stillRunning())) return { killed: true, elevated: false };

    try { process.kill(-pid, "SIGKILL"); killedAny = true; } catch (e) { /* group already gone */ }
    await wait(350);
    if (!(await stillRunning())) return { killed: true, elevated: false };

    try { process.kill(pid, "SIGKILL"); killedAny = true; } catch (e) { /* nothing left */ }
    await wait(350);
  }

  return { killed: killedAny && !(await stillRunning()), elevated: isWindows };
}

// ---------------------------------------------------------------------------
// Playtime tracking — a cumulative seconds total per id in the data file.
// addPlaytimeMs is called both on a normal flush (every couple of polls,
// see the launch handler) and one final time in reportClosed, each time
// advancing entry.lastFlushAt so the same span is never double-counted.
// Flushing periodically rather than only at the end means a launcher crash
// mid-session loses at most a minute or two of accounting, not the whole
// session.
// ---------------------------------------------------------------------------
function addPlaytimeMs(id, ms) {
  if (!ms || ms <= 0) return;
  const prev = data.playtime[id] || 0;
  data.playtime[id] = prev + ms / 1000;
  saveData(data);
}

function flushEntryPlaytime(entry, id) {
  if (!entry || !entry.launchedAt) return;
  const now = Date.now();
  const since = entry.lastFlushAt || entry.launchedAt;
  addPlaytimeMs(id, now - since);
  entry.lastFlushAt = now;
}

// ---------------------------------------------------------------------------
// Crash detection. Since STOP/close detection works by polling whether the
// exe is still running (no reliable exit code — see killProcessTree's
// comment), "crashed vs. closed normally" can't be told from that alone.
//
// The signal has to be Saved/Crashes specifically, NOT Saved/Logs — Unreal
// writes/updates a log under Saved/Logs on every single launch, crash or
// not, so treating a fresh .log as crash evidence flags basically every
// close. Saved/Crashes (a folder, often prefixed UECC-, containing a
// minidump + diagnostics text) is the part that only gets written when the
// engine's crash reporter actually fires — that's the real signal.
//
// Two separate questions, answered in two steps:
//   1. Did anything appear under Saved/Crashes after launch at all? (the
//      crashed/not-crashed signal)
//   2. If so, what's the most useful file to hand Notepad? Prefer a
//      human-readable diagnostics/log file inside that crash folder over
//      the raw .dmp, and fall back to the newest Saved/Logs/*.log (which
//      still has the lead-up to the crash) if the crash folder has nothing
//      readable in it.
//
// This is a heuristic, not a guarantee — some builds structure Saved/
// differently, or don't have crash reporting enabled at all — so it catches
// the common case well without claiming certainty.
function findLatestUnder(dir, launchedAtMs, filter) {
  let best = null; // { path, mtimeMs, isDirectory }
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
  for (const e of entries) {
    if (filter && !filter(e)) continue;
    const p = path.join(dir, e.name);
    let st;
    try { st = fs.statSync(p); } catch (e2) { continue; }
    if (st.mtimeMs <= launchedAtMs) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs, isDirectory: e.isDirectory() };
  }
  return best;
}

function findCrashArtifact(installPath, launchedAtMs) {
  if (!installPath || !launchedAtMs) return null;
  try {
    // Unreal projects are usually <installPath>/<ProjectName>/Saved/... —
    // scan one level down for any "Saved" folder rather than assuming a
    // fixed project-folder name. Some builds put Saved/ directly at the
    // install root instead.
    const topEntries = fs.readdirSync(installPath, { withFileTypes: true }).filter(e => e.isDirectory());
    const savedDirs = topEntries
      .map(e => path.join(installPath, e.name, "Saved"))
      .filter(p => fs.existsSync(p));
    if (fs.existsSync(path.join(installPath, "Saved"))) savedDirs.push(path.join(installPath, "Saved"));

    // Step 1 — the actual crash signal: newest thing under any Saved/Crashes
    // that appeared after this launch.
    let crashEntry = null;
    for (const savedDir of savedDirs) {
      const found = findLatestUnder(path.join(savedDir, "Crashes"), launchedAtMs);
      if (found && (!crashEntry || found.mtimeMs > crashEntry.mtimeMs)) crashEntry = found;
    }
    if (!crashEntry) return null; // no crash evidence — closed normally

    // Step 2 — pick the best file to actually open. If the newest crash
    // entry is a folder, look inside it for a readable diagnostics/log
    // file first (this is what Unreal's crash reporter usually names
    // MinidumpDiagnostics.txt or similar — far more useful than the raw
    // .dmp). Otherwise fall back to the newest Saved/Logs/*.log for
    // whichever Saved/ folder held the crash.
    if (crashEntry.isDirectory) {
      let readable;
      try {
        readable = fs.readdirSync(crashEntry.path, { withFileTypes: true })
          .filter(e => e.isFile() && /\.(txt|log)$/i.test(e.name))
          .sort((a, b) => /diag/i.test(b.name) - /diag/i.test(a.name))[0];
      } catch (e) { readable = null; }
      if (readable) return path.join(crashEntry.path, readable.name);
    } else if (/\.(txt|log)$/i.test(crashEntry.path)) {
      return crashEntry.path;
    }

    for (const savedDir of savedDirs) {
      const newestLog = findLatestUnder(path.join(savedDir, "Logs"), 0, e => e.isFile() && /\.log$/i.test(e.name));
      if (newestLog) return newestLog.path;
    }

    // Nothing readable found — hand back the crash folder/dump itself;
    // crashlog:open reveals it in Explorer instead of dumping it into
    // Notepad if it turns out to be a folder or a binary .dmp.
    return crashEntry.path;
  } catch (e) {
    return null;
  }
}

// Marks an entry as no longer running and tells the renderer once — guarded
// so a manual STOP and the child's own "exit" event can't double-fire it.
// Flushes remaining playtime and, if this close looks like a crash (evidence
// under Saved/Crashes appeared after launch), tells the renderer which file
// to offer.
function reportClosed(id) {
  const entry = runningProcesses.get(id);
  if (!entry) return;
  if (entry.pollTimer) clearInterval(entry.pollTimer);
  runningProcesses.delete(id);

  flushEntryPlaytime(entry, id);
  clearDiscordPresence();

  const crashLogPath = findCrashArtifact(entry.installPath, entry.launchedAt);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("game:closed", {
      id,
      crashed: !!crashLogPath,
      crashLogPath: crashLogPath || null,
    });
  }
}

// Recursively copy a mod folder's contents into the install folder.
function copyModFiles(modSourceDir, installPath) {
  const copyRecursive = (src, dest) => {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  };
  copyRecursive(modSourceDir, installPath);
}

// Mod availability is read live from disk every time it's needed — nothing
// about it is cached in memory or in the persisted data file. There are two
// possible mods/ folder states per alpha (folder name per MOD_FOLDER_OVERRIDES,
// falling back to the alpha's id):
//   assets/mods/<name>          -> multiplayer mod available, offer both
//                                   "Launch Multiplayer" and "Launch Offline".
//   assets/mods/<name>_nomods   -> explicitly marked singleplayer-only, even
//                                   though a folder exists for it. "Launch
//                                   Multiplayer" is not offered.
//   (neither exists)            -> no mod support yet, PLAY just launches
//                                   directly with no menu.
function modFolderName(id) {
  return MOD_FOLDER_OVERRIDES[id] || id;
}

function getModStatus(id) {
  const modsRoot = path.join(getAppRoot(), "assets", "mods");
  const folderName = modFolderName(id);
  const noModsDir = path.join(modsRoot, folderName + "_nomods");
  const modDir = path.join(modsRoot, folderName);

  if (fs.existsSync(noModsDir)) {
    return { modFolderExists: true, singleplayerOnly: true, sourceDir: null };
  }
  if (fs.existsSync(modDir)) {
    return { modFolderExists: true, singleplayerOnly: false, sourceDir: modDir };
  }
  return { modFolderExists: false, singleplayerOnly: false, sourceDir: null };
}

// Steam auto-detect: checks the default Steam library locations for a
// folder matching this alpha's guessed Steam folder name.
const STEAM_COMMON_DIRS = [
  "C:\\Program Files (x86)\\Steam\\steamapps\\common",
  "C:\\Program Files\\Steam\\steamapps\\common",
];

function guessInstallPath(steamFolder) {
  if (!steamFolder) return null;
  for (const base of STEAM_COMMON_DIRS) {
    const candidate = path.join(base, steamFolder);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Feature toggle files: drop a file with no extension named exactly
// "iconsoff" or "modinjectoroff" in the app's root folder (next to
// main.js) to disable that feature. Their absence (or the presence of the
// "...on" counterpart, which itself does nothing — it's just there for
// symmetry/documentation) means the feature stays enabled. Checked fresh
// each time flags:get is called, so toggling the file works without
// restarting the app.
function featureEnabled(offFileName) {
  return !fs.existsSync(path.join(getAppRoot(), offFileName));
}

// Command list — pulled from GitHub instead of a local assets file, since
// the local-file approach (assets/commandlist.txt next to the packaged
// .exe) doesn't reliably resolve once electron-builder packs "assets" into
// app.asar rather than leaving it next to the executable; getAppRoot()
// pointing at process.execPath's directory then finds nothing there. Falls
// back to that local file only if the fetch itself fails (e.g. offline),
// so local testing without network still works.
const COMMANDLIST_URL = "https://raw.githubusercontent.com/jobbybam/Fling/refs/heads/main/commandlist.txt";

function parseCommandListText(raw) {
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const m = line.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      if (m) return { command: m[1].trim(), description: m[2].trim() };
      return { command: line, description: "" };
    });
}

// Returns null if neither the remote fetch nor the local fallback produced
// anything (renderer shows a fallback message in that case).
async function loadCommandList() {
  try {
    const res = await fetch(COMMANDLIST_URL, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const parsed = parseCommandListText(await res.text());
      if (parsed.length) return parsed;
    } else {
      console.warn(`Command list fetch returned ${res.status} — falling back to local file.`);
    }
  } catch (e) {
    console.warn("Command list fetch failed — falling back to local file:", e.message);
  }
  const file = path.join(getAppRoot(), "assets", "commandlist.txt");
  try {
    return parseCommandListText(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return null;
  }
}

// assets/data — simple hand-editable control file, e.g:
//   firstlaunch=0, tutorial=0
// Set tutorial=1 and relaunch to force the tutorial popups to show again
// (clears the persisted "Don't show this again" setting) — it flips back
// to 0 automatically once applied, so it's a one-shot reset trigger, not a
// permanent setting. Same one-shot pattern for firstlaunch=1: shows the
// welcome animation once on boot, then resets itself back to 0. Created
// with defaults if it doesn't exist yet.
const FLAGS_TXT_FILE = path.join(getAppRoot(), "assets", "data");

function loadFlagsFile() {
  const defaults = { firstlaunch: 0, tutorial: 0 };
  try {
    const raw = fs.readFileSync(FLAGS_TXT_FILE, "utf-8");
    const parsed = { ...defaults };
    raw.split(/[,\n]/).forEach(part => {
      const m = part.trim().match(/^(\w+)\s*=\s*(\d+)$/);
      if (m) parsed[m[1]] = parseInt(m[2], 10);
    });
    return parsed;
  } catch (e) {
    saveFlagsFile(defaults);
    return defaults;
  }
}

function saveFlagsFile(flags) {
  const content = "firstlaunch=" + (flags.firstlaunch ? 1 : 0) + ", tutorial=" + (flags.tutorial ? 1 : 0);
  // Best effort: if the app is installed somewhere read-only (e.g. under
  // Program Files) this write fails. That must not break startup — the
  // renderer awaits boot:getFlags before it loads anything.
  try {
    fs.mkdirSync(path.dirname(FLAGS_TXT_FILE), { recursive: true });
    fs.writeFileSync(FLAGS_TXT_FILE, content, "utf-8");
  } catch (e) {
    console.warn("Couldn't write assets/data:", e.message);
  }
}

// ---------------------------------------------------------------------------
// Leaderboard tab — top 50 runs for a title, pulled live from
// speedrun.com's public read API (no key required). Which speedrun.com
// game(s) and categories each launcher entry maps to is spelled out in
// SPEEDRUN_SOURCES below. Category lists are cached for a few minutes per
// id so flipping between the same couple of entries in the Leaderboard grid
// doesn't refetch every time.
// ---------------------------------------------------------------------------
const SPEEDRUN_API = "https://www.speedrun.com/api/v1";
const speedrunCache = new Map(); // "<launcher id>::<mode>" -> { boards, gameName, fetchedAt }
const SPEEDRUN_CACHE_MS = 5 * 60 * 1000;

// Optional API key, read from a "speedrun.key" file dropped next to the
// installed .exe (same getAppRoot() convention as iconsoff/modinjectoroff,
// so it survives packaging the same way those do) — one line, just the key,
// nothing else. Not required: every endpoint this tab uses (games,
// categories, leaderboards) is public/read-only per speedrun.com's own docs,
// but sending a key raises the rate-limit ceiling, and some users may want
// one attached to their account regardless. Deliberately NOT hardcoded in
// source — an API key baked into main.js would ship inside the packaged
// .exe (and inside the repo, if this project is ever put in version
// control or the installer shared with anyone else), tied to whoever's
// account it belongs to. Read fresh each call, same as the other toggle
// files, so dropping/removing/editing it takes effect without a relaunch.
const SPEEDRUN_KEY_FILE = path.join(getAppRoot(), "speedrun.key");
function loadSpeedrunApiKey() {
  try {
    return fs.readFileSync(SPEEDRUN_KEY_FILE, "utf-8").trim();
  } catch (e) {
    return "";
  }
}

async function speedrunFetchJson(url) {
  const key = loadSpeedrunApiKey();
  const doFetch = (useKey) => fetch(url, {
    headers: {
      "User-Agent": "FlingLauncher/1.0",
      ...(useKey && key ? { "X-API-Key": key } : {}),
    },
    signal: AbortSignal.timeout(12000),
  });

  let res = await doFetch(true);
  // A stale/invalid key file shouldn't take the whole tab down: every
  // endpoint used here is public, so if speedrun.com rejects the key
  // itself (401/403) just retry once without it.
  if ((res.status === 401 || res.status === 403) && key) {
    res = await doFetch(false);
  }
  // Rate limited (429) — wait a moment and try once more instead of
  // surfacing an error for what is usually a momentary burst.
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 1500));
    res = await doFetch(true);
  }
  if (!res.ok) throw new Error("speedrun.com returned " + res.status);
  return res.json();
}

// Lowercase + strip everything except letters, digits and dots, so
// "Pre-Alpha" / "Pre Alpha" / "pre_alpha" all compare equal, while
// "Alpha 1" and "Alpha 1.5" (and "Alpha 3 (Old Leaderboards)") stay distinct.
function normalizeSrcName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9.]+/g, "");
}

// ---------------------------------------------------------------------------
// Which speedrun.com game(s) each Leaderboard-tab entry pulls its boards from.
// On speedrun.com the alphas/betas/demo are CATEGORIES of these games (e.g.
// Pre-Alpha ... Beta 3 inside `hn1`; Alpha 1 / Hello Guest / Beta Playtest /
// Demo inside `hn2`), so each game loads ALL of its categories — the
// miscellaneous ones included — and expands every subcategory combination.
//
// Two modes, switched by the toggle above the category dropdown:
//   main — the game itself
//   ext  — its separate "Category Extensions" game on speedrun.com (an
//          entry with no `ext` sources simply doesn't show the toggle)
//
// Each source: { game: <speedrun.com abbreviation>, match?: [category names] }
// — omit `match` to keep every category.
// ---------------------------------------------------------------------------
const SPEEDRUN_SOURCES = {
  f_hn1:   { main: [{ game: "hn1" }],                            ext: [{ game: "hnce" }] },
  f_hnhas: { main: [{ game: "hello_neighbor_hide_and_seek" }],   ext: [] },
  f_hn2:   { main: [{ game: "hn2" }],                            ext: [{ game: "hn2_ce" }] },
  // No abbreviation known: resolved by exact name ("Hello Neighbor 3") via
  // resolveSpeedrunGameByName. Swap in { game: "<abbrev>" } to pin it.
  pa_hn3:  { main: [{ name: "Hello Neighbor 3" }],                ext: [] },
};

function hasSpeedrunExtensions(gameId) {
  const entry = SPEEDRUN_SOURCES[gameId];
  return !!(entry && entry.ext && entry.ext.length);
}

// Fallback for a roster entry with no explicit mapping above (e.g. a new
// title added to GAMES later): find the game by EXACT name only. No more
// "take whatever came back first" — that's how "Alpha 1" used to resolve
// to some unrelated game.
async function resolveSpeedrunGameByName(name) {
  const json = await speedrunFetchJson(SPEEDRUN_API + "/games?name=" + encodeURIComponent(name) + "&max=50");
  const list = (json && json.data) || [];
  const want = normalizeSrcName(name);
  return list.find(g => g.names && normalizeSrcName(g.names.international) === want) || null;
}

// Every subcategory variable that applies to a board. speedrun.com treats
// each combination of subcategory values as its own leaderboard, so ALL of
// them matter — the old code only looked at the first one, which merged
// e.g. Any% and Glitchless into one board.
//
// Variable scope decides where a variable applies: "full-game" boards use
// full-game/global ones; a level's boards use all-levels/global ones plus
// any scoped to that specific level.
function getSubcategoryVariables(cat, level) {
  const vars = (cat.variables && cat.variables.data) || [];
  return vars.filter(v => {
    if (!v["is-subcategory"]) return false;
    if (v.category && v.category !== cat.id) return false;
    const scope = v.scope && v.scope.type;
    if (!scope || scope === "global") return true;
    if (level) {
      if (scope === "all-levels") return true;
      if (scope === "single-level") return !!(v.scope.level && v.scope.level === level.id);
      return false;
    }
    return scope === "full-game";
  });
}

// speedrun.com has a leftover empty duplicate that reads "Any% ." (Any% plus
// a stray dot). It never has runs on it, so it's hidden everywhere — as a
// category name AND as a variable value. Plain "Any%" is untouched: the
// label has to contain a dot to count.
function isJunkSpeedrunLabel(label) {
  const s = String(label || "");
  return /[.·•]/.test(s) && /^[\s.·•]*any\s*%[\s.·•]*$/i.test(s);
}

const SPEEDRUN_MAX_COMBOS_PER_CATEGORY = 64;
// How many places to pull per board (ties at the cutoff are included).
const SPEEDRUN_TOP_N = 50;

// Turns one speedrun.com category into one-or-more concrete, fetchable
// boards: the cross product of every subcategory variable's values.
function expandSpeedrunCategory(cat, gameId, prefix, level) {
  const subVars = getSubcategoryVariables(cat, level).map(v => {
    const values = (v.values && v.values.values) || {};
    const list = Object.keys(values)
      .filter(valueId => !isJunkSpeedrunLabel(values[valueId] && values[valueId].label))
      .map(valueId => ({
      varId: v.id,
      valueId,
      label: (values[valueId] && values[valueId].label) || valueId,
      misc: !!(values[valueId] && values[valueId].flags && values[valueId].flags.miscellaneous),
    }));
    // misc-flagged values still show up (that's the "Show misc." stuff
    // people were missing) — just after the regular ones.
    list.sort((a, b) => (a.misc ? 1 : 0) - (b.misc ? 1 : 0));
    return list;
  }).filter(list => list.length > 0);

  let combos = [[]];
  subVars.forEach(list => {
    const next = [];
    combos.forEach(c => list.forEach(val => next.push(c.concat(val))));
    combos = next;
  });
  combos = combos.slice(0, SPEEDRUN_MAX_COMBOS_PER_CATEGORY);

  // A level board (e.g. the HN2 DLCs) is grouped under its level's name,
  // with the category (Any%, Glitchless…) as the option inside it; a
  // full-game board is grouped under its category, with the variations
  // (platform, Any%, …) as the options.
  const group = level ? prefix + "Level: " + level.name : prefix + cat.name;
  return combos.map(combo => {
    const labelPart = combo.map(c => c.label).join(" / ");
    const label = level ? (labelPart ? cat.name + " / " + labelPart : cat.name) : (labelPart || cat.name);
    return {
      id: gameId + "::" + (level ? "L" + level.id + "::" : "") + cat.id + "::" + combo.map(c => c.varId + "=" + c.valueId).join(","),
      group,
      label,
      name: label === group ? group : group + " - " + label,
      gameId,
      levelId: level ? level.id : null,
      categoryId: cat.id,
      vars: combo.map(c => ({ varId: c.varId, valueId: c.valueId })),
    };
  });
}

// Loads one source: resolves the game, fetches ALL its categories
// (miscellaneous ones included) plus its levels, keeps what the source asks
// for, and expands everything into boards.
async function loadSpeedrunSource(src, fallbackName) {
  let game = null;
  if (src.game) {
    const json = await speedrunFetchJson(SPEEDRUN_API + "/games/" + encodeURIComponent(src.game));
    game = json && json.data;
  } else {
    game = await resolveSpeedrunGameByName(src.name || fallbackName);
  }
  if (!game || !game.id) throw new Error('Couldn\'t find "' + (src.game || src.name || fallbackName) + '" on speedrun.com.');

  const catJson = await speedrunFetchJson(SPEEDRUN_API + "/games/" + game.id + "/categories?embed=variables");
  const allCats = (catJson && catJson.data) || [];
  let perGame = allCats.filter(c => c.type === "per-game" && !isJunkSpeedrunLabel(c.name));
  if (src.match && src.match.length) {
    const wanted = new Set(src.match.map(normalizeSrcName));
    perGame = perGame.filter(c => wanted.has(normalizeSrcName(c.name)));
  }
  // Regular categories first, miscellaneous ones after — same order the
  // site itself uses when you tick "Show miscellaneous categories".
  perGame.sort((a, b) => (a.miscellaneous ? 1 : 0) - (b.miscellaneous ? 1 : 0));

  const prefix = "";
  const boards = [];
  perGame.forEach(cat => boards.push(...expandSpeedrunCategory(cat, game.id, prefix)));

  // Level boards (individual levels — e.g. the Hello Neighbor 2 "Late Fees"
  // and "Back to School" DLCs live here, not under the game's categories).
  // Skipped when the source asks for specific categories by name. A failure
  // here never costs you the full-game boards above.
  if (!(src.match && src.match.length)) {
    const levelCats = allCats.filter(c => c.type === "per-level" && !isJunkSpeedrunLabel(c.name))
      .sort((a, b) => (a.miscellaneous ? 1 : 0) - (b.miscellaneous ? 1 : 0));
    if (levelCats.length) {
      try {
        const levelJson = await speedrunFetchJson(SPEEDRUN_API + "/games/" + game.id + "/levels");
        ((levelJson && levelJson.data) || []).forEach(level => {
          levelCats.forEach(cat => boards.push(...expandSpeedrunCategory(cat, game.id, prefix, level)));
        });
      } catch (e) {
        console.warn("Couldn't load levels for " + (src.game || fallbackName) + ":", e.message);
      }
    }
  }
  return { gameName: (game.names && game.names.international) || fallbackName, boards };
}

async function buildSpeedrunBoards(game, mode) {
  const entry = SPEEDRUN_SOURCES[game.id];
  // A roster entry with no mapping falls back to an exact-name lookup
  // (main mode only — there's no way to guess an extensions game).
  const sources = entry ? (entry[mode] || []) : (mode === "main" ? [{ name: game.full }] : []);
  if (!sources.length) return { boards: [], gameName: game.full, fetchedAt: Date.now() };
  const results = await Promise.allSettled(sources.map(src => loadSpeedrunSource(src, game.full)));

  const boards = [];
  const seen = new Set();
  let gameName = null;
  let firstError = null;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if (!gameName && r.value.boards.length) gameName = r.value.gameName;
      r.value.boards.forEach(b => { if (!seen.has(b.id)) { seen.add(b.id); boards.push(b); } });
    } else {
      // One source failing (renamed abbreviation, network blip) shouldn't
      // hide the boards the other sources did return.
      console.warn("Leaderboard source failed for " + game.id + " (" + (sources[i].game || game.full) + "):", r.reason && r.reason.message);
      if (!firstError) firstError = r.reason;
    }
  });
  // Every source failed outright — that's an error, not "no boards".
  if (!boards.length && firstError && results.every(r => r.status === "rejected")) throw firstError;
  return { boards, gameName: gameName || game.full, fetchedAt: Date.now() };
}

async function getSpeedrunLeaderboard(board) {
  const path = board.levelId
    ? "/level/" + board.levelId + "/" + board.categoryId
    : "/category/" + board.categoryId;
  let url = SPEEDRUN_API + "/leaderboards/" + board.gameId + path + "?top=" + SPEEDRUN_TOP_N + "&embed=players";
  board.vars.forEach(v => { url += "&var-" + encodeURIComponent(v.varId) + "=" + encodeURIComponent(v.valueId); });
  const json = await speedrunFetchJson(url);
  const data = json && json.data;
  const runs = (data && data.runs) || [];
  const playersById = {};
  const embeddedPlayers = (data && data.players && data.players.data) || [];
  embeddedPlayers.forEach(p => {
    if (p.id) playersById[p.id] = (p.names && p.names.international) || p.name || "Unknown";
  });
  return runs.map(entry => {
    const run = entry.run || {};
    const names = (run.players || []).map(pl => {
      if (pl.rel === "guest") return pl.name || "Guest";
      return playersById[pl.id] || "Unknown";
    });
    const videoLinks = run.videos && run.videos.links;
    return {
      place: entry.place,
      player: names.length ? names.join(", ") : "Unknown",
      // Only used to recognise the linked speedrun.com account's own runs;
      // stripped again before the list reaches the renderer.
      playerIds: (run.players || []).filter(pl => pl.rel === "user").map(pl => pl.id),
      seconds: (run.times && typeof run.times.primary_t === "number") ? run.times.primary_t : null,
      time: formatSpeedrunTime(run.times && run.times.primary_t),
      videoUrl: videoLinks && videoLinks[0] ? videoLinks[0].uri : null,
    };
  });
}

function formatSpeedrunTime(seconds) {
  if (seconds === undefined || seconds === null) return "—";
  const totalMs = Math.round(seconds * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n, l) => String(n).padStart(l, "0");
  return (h > 0 ? h + ":" + pad(m, 2) : String(m)) + ":" + pad(s, 2) + (ms ? "." + pad(ms, 3) : "");
}

// ---------------------------------------------------------------------------
// Linked speedrun.com account. Linking just remembers a public profile (id +
// name) — no login, no password, no API key — and uses it to spot the user's
// own runs on a board and, when they're outside the top 50, look their
// personal best up directly.
// ---------------------------------------------------------------------------
const userPbCache = new Map(); // "<userId>::<speedrun gameId>" -> { list, fetchedAt }

// Accepts a bare username, "@name", or a pasted profile link
// (https://www.speedrun.com/users/<name>) and returns just the name.
function parseSpeedrunUsername(input) {
  let s = String(input || "").trim();
  const m = s.match(/speedrun\.com\/users?\/([^/?#\s]+)/i);
  if (m) {
    try { s = decodeURIComponent(m[1]); } catch (e) { s = m[1]; }
  }
  return s.replace(/^@/, "").trim();
}

async function getUserPersonalBests(userId, gameId) {
  const key = userId + "::" + gameId;
  const hit = userPbCache.get(key);
  if (hit && (Date.now() - hit.fetchedAt) < SPEEDRUN_CACHE_MS) return hit.list;
  const json = await speedrunFetchJson(
    SPEEDRUN_API + "/users/" + encodeURIComponent(userId) + "/personal-bests?game=" + encodeURIComponent(gameId)
  );
  const list = (json && json.data) || [];
  userPbCache.set(key, { list, fetchedAt: Date.now() });
  return list;
}

// The linked user's result on `board`: their row from the top 50 if they're
// on it, otherwise their personal best fetched from their profile (matched
// on category, level and subcategory values). `runs` is the board's top list,
// so the gap to the world record is just runs[0].
async function findLinkedUserResult(user, board, runs) {
  const base = { name: user.name, found: false };
  let entry = null;

  const inTop = runs.find(r => r.playerIds && r.playerIds.includes(user.id));
  if (inTop) {
    entry = { place: inTop.place, time: inTop.time, seconds: inTop.seconds, videoUrl: inTop.videoUrl, inTop: true };
  } else {
    let list;
    try {
      list = await getUserPersonalBests(user.id, board.gameId);
    } catch (e) {
      console.warn("Couldn't look up personal bests for " + user.name + ":", e.message);
      return { ...base, failed: true };
    }
    const pb = list.find(e => {
      const r = e && e.run;
      if (!r || r.category !== board.categoryId) return false;
      if ((r.level || null) !== (board.levelId || null)) return false;
      const values = r.values || {};
      return board.vars.every(v => values[v.varId] === v.valueId);
    });
    if (pb) {
      const r = pb.run;
      const links = r.videos && r.videos.links;
      entry = {
        place: typeof pb.place === "number" ? pb.place : null,
        time: formatSpeedrunTime(r.times && r.times.primary_t),
        seconds: (r.times && typeof r.times.primary_t === "number") ? r.times.primary_t : null,
        videoUrl: links && links[0] ? links[0].uri : null,
        inTop: false,
      };
    }
  }
  if (!entry) return base;

  const wr = runs[0];
  let gap = null;
  if (entry.place !== 1 && wr && wr.seconds !== null && entry.seconds !== null) {
    gap = formatSpeedrunTime(Math.max(0, entry.seconds - wr.seconds));
  }
  return { ...base, found: true, ...entry, isWR: entry.place === 1, gap };
}

// ---------------------------------------------------------------------------
// IPC handlers — the only surface the renderer can reach.
// ---------------------------------------------------------------------------

ipcMain.handle("games:list", () => {
  return GAMES.map(g => {
    const modStatus = getModStatus(g.id);
    return {
      ...g,
      installPath: data.installPaths[g.id] || null,
      // "modded" keeps its old meaning for the renderer: true only when a
      // multiplayer mod is actually available to launch right now.
      modded: modStatus.modFolderExists && !modStatus.singleplayerOnly,
      modFolderExists: modStatus.modFolderExists,
      singleplayerOnly: modStatus.singleplayerOnly,
      isFavorite: data.favoriteIds.includes(g.id),
      playtimeSeconds: Math.round(data.playtime[g.id] || 0),
    };
  });
});

// Toggles favorite status and returns the full updated list of favorite ids
// — a pinned list of ids in the data file, nothing fancier. The renderer
// duplicates a favorited entry into a "Favorites" sidebar group above
// HN1/HN2 without removing it from its normal group.
ipcMain.handle("favorites:toggle", (event, id) => {
  if (!GAMES.some(g => g.id === id)) return { ok: false, error: "Unknown alpha." };
  const idx = data.favoriteIds.indexOf(id);
  if (idx === -1) data.favoriteIds.push(id);
  else data.favoriteIds.splice(idx, 1);
  saveData(data);
  return { ok: true, favoriteIds: data.favoriteIds, isFavorite: idx === -1 };
});

ipcMain.handle("path:browse", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Select install folder",
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("path:autoDetect", (event, id) => {
  const game = GAMES.find(g => g.id === id);
  if (!game) return { ok: false, error: "Unknown alpha." };
  const found = guessInstallPath(game.steamFolder);
  if (!found) {
    return {
      ok: false,
      error: 'Couldn\'t find it automatically. Checked the default Steam folders for "' + game.steamFolder + '".',
    };
  }
  data.installPaths[id] = found;
  saveData(data);
  return { ok: true, path: found };
});

ipcMain.handle("path:set", (event, id, installPath) => {
  if (!GAMES.some(g => g.id === id)) return { ok: false, error: "Unknown alpha." };
  data.installPaths[id] = installPath;
  saveData(data);
  return { ok: true };
});

ipcMain.handle("path:clear", (event, id) => {
  delete data.installPaths[id];
  saveData(data);
  return { ok: true };
});

ipcMain.handle("settings:get", () => {
  return {
    hideTutorial: data.hideTutorial,
    theme: data.theme,
    animations: data.animations,
    launchBehavior: data.launchBehavior,
  };
});

// Partial save: only the keys actually present in `settings` are written, so
// callers that just want to flip one thing (e.g. the tutorial's "don't show
// this again" checkbox) don't have to resend the whole settings object.
ipcMain.handle("settings:save", (event, settings) => {
  const s = settings || {};
  if (s.hideTutorial !== undefined) data.hideTutorial = !!s.hideTutorial;
  if (s.animations !== undefined) data.animations = !!s.animations;
  if (s.theme !== undefined && THEME_IDS.includes(s.theme)) {
    data.theme = s.theme;
  }
  if (["stay", "minimize", "close"].includes(s.launchBehavior)) {
    data.launchBehavior = s.launchBehavior;
  }
  saveData(data);
  return { ok: true, settings: {
    hideTutorial: data.hideTutorial,
    theme: data.theme,
    animations: data.animations,
    launchBehavior: data.launchBehavior,
  } };
});

ipcMain.handle("game:launch", async (event, id, modded) => {
  const game = GAMES.find(g => g.id === id);
  if (!game) return { ok: false, error: "Unknown alpha." };

  const installPath = data.installPaths[id];
  if (!installPath) return { ok: false, error: "No install path assigned yet." };
  if (!fs.existsSync(installPath)) {
    return { ok: false, error: "Install folder no longer exists at " + installPath + "." };
  }

  if (modded) {
    const modStatus = getModStatus(id);
    if (!modStatus.modFolderExists || modStatus.singleplayerOnly) {
      return { ok: false, error: "This alpha is singleplayer only right now: no multiplayer mod to launch." };
    }
    try {
      copyModFiles(modStatus.sourceDir, installPath);
    } catch (e) {
      return { ok: false, error: "Failed to copy mod files: " + e.message };
    }
  }

  const exePath = findExecutable(installPath);
  if (!exePath) {
    return { ok: false, error: "No .exe found in " + installPath + "." };
  }

  const exeName = path.basename(exePath);

  try {
    const child = spawn(exePath, [], {
      cwd: installPath,
      detached: true,
      stdio: "ignore",
    });

    const launchedAt = Date.now();
    const entry = {
      child, pid: child.pid, exeName, pollTimer: null,
      // installPath + launchedAt feed both playtime accounting and
      // findCrashArtifact (see reportClosed). lastFlushAt/pollCount drive
      // the periodic playtime flush below.
      installPath, launchedAt, lastFlushAt: launchedAt, pollCount: 0,
    };
    runningProcesses.set(id, entry);
    setDiscordPresence(game);

    // Poll for the executable actually being gone, rather than trusting the
    // spawned process's own exit. A launcher shim exits within a second or
    // two while the real game keeps running under the same exe name; without
    // this the button would flip back to PLAY AGAIN immediately and STOP
    // would have nothing left to act on.
    let pollBusy = false;
    entry.pollTimer = setInterval(async () => {
      if (pollBusy) return;
      const current = runningProcesses.get(id);
      if (!current) return;
      pollBusy = true;
      try {
        const alive = await isEntryStillRunningAsync(current);
        if (!alive && runningProcesses.get(id) === current) {
          reportClosed(id);
        } else if (alive) {
          // Flush playtime roughly every 60s (every 15th 4s poll) instead of
          // only at the end — so if the launcher itself closes or crashes
          // while a game is running, that session loses at most a minute or
          // two of accounting rather than the whole thing.
          current.pollCount++;
          if (current.pollCount % 15 === 0) flushEntryPlaytime(current, id);
        }
      } finally {
        pollBusy = false;
      }
    }, 4000);

    child.on("exit", () => {
      // Give a launcher shim a moment to hand off to the real game before the
      // poll gets a chance to decide it's over.
      setTimeout(async () => {
        const current = runningProcesses.get(id);
        if (!current) return;
        if (!(await isEntryStillRunningAsync(current))) reportClosed(id);
      }, 2000);
    });

    child.on("error", () => reportClosed(id));
    child.unref();
  } catch (e) {
    return { ok: false, error: "Failed to launch: " + e.message };
  }

  return { ok: true, exePath, modded };
});

ipcMain.handle("game:stop", async (event, id) => {
  const entry = runningProcesses.get(id);
  if (!entry) return { ok: false, error: "That isn't running right now." };

  let result;
  try {
    // Tries several kill methods in sequence — see killProcessTree's own
    // comment for the full list — including, as a last resort, an elevated
    // attempt that prompts for administrator rights.
    result = await killProcessTree(entry.pid, entry.exeName);
  } catch (e) {
    return { ok: false, error: "Failed to stop it: " + e.message };
  }

  // Confirm it's actually gone rather than assuming the last method worked,
  // then report the close ourselves — the spawned handle may already be
  // dead (shim case), so its "exit" event can't be relied on to do it.
  const stillRunning = await isEntryStillRunningAsync(entry);
  if (stillRunning) {
    return {
      ok: false,
      error: entry.exeName + " is still running after trying several stop methods" +
        (isWindows ? " (including an elevated close attempt)" : "") +
        ". It may need to be closed manually, or it declined the admin prompt.",
    };
  }

  reportClosed(id);
  return { ok: true, killed: result.killed, elevated: result.elevated };
});

ipcMain.handle("state:getSelected", () => {
  return { selectedId: data.selectedId || null };
});

ipcMain.handle("state:setSelected", (event, id) => {
  data.selectedId = id || null;
  saveData(data);
  return { ok: true };
});

// Read once at boot (before settings:get is called by the renderer), applies
// any one-shot triggers from assets/data, then resets those triggers back
// to 0 on disk so they don't keep firing on every future launch.
ipcMain.handle("boot:getFlags", () => {
  const flags = loadFlagsFile();
  const result = { showWelcome: false, tutorialWasReset: false };

  if (flags.tutorial === 1) {
    data.hideTutorial = false;
    saveData(data);
    flags.tutorial = 0;
    result.tutorialWasReset = true;
  }
  // Welcome animation: once per user, on their very first launch. This is
  // tracked in that user's own data file (%APPDATA%), so it works on every
  // machine the installer is run on — no hand-edited file needed.
  if (!data.welcomeShown) {
    data.welcomeShown = true;
    saveData(data);
    result.showWelcome = true;
  }
  // assets/data firstlaunch=1 still works as a manual "show it again".
  if (flags.firstlaunch === 1) {
    flags.firstlaunch = 0;
    result.showWelcome = true;
  }

  saveFlagsFile(flags);
  return result;
});

ipcMain.handle("path:openInExplorer", async (event, id) => {
  const installPath = data.installPaths[id];
  if (!installPath || !fs.existsSync(installPath)) return { ok: false };
  shell.openPath(installPath);
  return { ok: true };
});

// Opens a crash log (or crash-dump folder) in Notepad — the button on the
// "closed unexpectedly" toast/modal. logPath is never taken from the
// renderer for anything other than this one purpose, and only ever a path
// findCrashArtifact itself produced (sent back on game:closed), so this
// isn't accepting an arbitrary path from script-controlled UI.
ipcMain.handle("crashlog:open", async (event, logPath) => {
  if (!logPath || typeof logPath !== "string" || !fs.existsSync(logPath)) {
    return { ok: false, error: "That crash log no longer exists." };
  }
  try {
    const st = fs.statSync(logPath);
    // A crash-dump folder (e.g. Saved/Crashes/UECC-...) or a raw binary
    // .dmp — nothing for Notepad to usefully open, so reveal it in
    // Explorer instead. findCrashArtifact already prefers a readable
    // .txt/.log over these when one exists inside the crash folder.
    if (st.isDirectory() || /\.dmp$/i.test(logPath)) {
      shell.openPath(st.isDirectory() ? logPath : path.dirname(logPath));
      return { ok: true, openedFolder: true };
    }
    if (isWindows) {
      spawn("notepad.exe", [logPath], { detached: true, stdio: "ignore" }).unref();
    } else {
      // Notepad doesn't exist off Windows — fall back to whatever the OS
      // considers the default text-file handler.
      shell.openPath(logPath);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "Couldn't open the crash log: " + e.message };
  }
});

ipcMain.handle("flags:get", () => {
  return {
    iconsEnabled: featureEnabled("iconsoff"),
    modInjectorEnabled: featureEnabled("modinjectoroff"),
    // All six themes are normal, always-on options now — no gating flag file.
    themes: THEME_IDS,
  };
});

ipcMain.handle("external:open", (event, url) => {
  // Only ever open http(s) links this way — never anything else.
  if (typeof url === "string" && /^https:\/\//i.test(url)) {
    shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false };
});

ipcMain.handle("console:getCommands", async () => {
  return await loadCommandList();
});

ipcMain.handle("leaderboard:get", async (event, id, boardId, modeArg) => {
  const game = GAMES.find(g => g.id === id);
  if (!game) return { ok: false, error: "Unknown title." };

  const mode = modeArg === "ext" ? "ext" : "main";
  // Sent back on every response (errors included) so the renderer can keep
  // the Normal / Category Extensions toggle visible even when one side has
  // nothing to show.
  const hasExtensions = hasSpeedrunExtensions(id);

  try {
    const cacheKey = id + "::" + mode;
    let cached = speedrunCache.get(cacheKey);
    if (!cached || (Date.now() - cached.fetchedAt) > SPEEDRUN_CACHE_MS) {
      cached = await buildSpeedrunBoards(game, mode);
      // Only cache a real result — an empty list shouldn't stick for five
      // minutes if it was just a hiccup.
      if (cached.boards.length) speedrunCache.set(cacheKey, cached);
    }
    if (!cached.boards.length) {
      return {
        ok: false, hasExtensions, mode,
        error: mode === "ext"
          ? 'No category extension boards found for "' + (game.leaderboardName || game.full) + '" on speedrun.com.'
          : 'No speedrun.com boards found for "' + (game.leaderboardName || game.full) + '" yet.',
      };
    }
    // A specific board can be requested (the dropdown in the Leaderboard
    // tab); fall back to the first one if none was requested or the id
    // doesn't exist in this mode (e.g. a stale selection after switching).
    const board = cached.boards.find(b => b.id === boardId) || cached.boards[0];
    const runs = await getSpeedrunLeaderboard(board);
    const linkedUser = data.speedrunUser;
    const you = linkedUser ? await findLinkedUserResult(linkedUser, board, runs) : null;
    runs.forEach(r => {
      r.isYou = !!linkedUser && r.playerIds.includes(linkedUser.id);
      delete r.playerIds;
    });
    return {
      ok: true,
      you,
      hasExtensions,
      mode,
      game: cached.gameName,
      category: board.name,
      categoryId: board.id,
      // Full list so the renderer can populate a dropdown without another
      // round trip. `group` lets it nest each category's variations under
      // one heading instead of a flat wall of options.
      categories: cached.boards.map(b => ({ id: b.id, name: b.name, label: b.label, group: b.group })),
      runs,
    };
  } catch (e) {
    return { ok: false, hasExtensions, mode, error: "Couldn't reach speedrun.com: " + e.message };
  }
});

// ---------------------------------------------------------------------------
// speedrun.com account linking IPC
// ---------------------------------------------------------------------------
ipcMain.handle("src:getUser", () => ({ ok: true, user: data.speedrunUser }));

ipcMain.handle("src:link", async (event, input) => {
  const name = parseSpeedrunUsername(input);
  if (!name || name.length > 60) {
    return { ok: false, error: "Enter your speedrun.com username or profile link." };
  }
  try {
    const json = await speedrunFetchJson(SPEEDRUN_API + "/users/" + encodeURIComponent(name));
    const u = json && json.data;
    if (!u || !u.id) return { ok: false, error: 'Couldn\'t find a speedrun.com user named "' + name + '".' };
    data.speedrunUser = { id: u.id, name: (u.names && u.names.international) || name };
    saveData(data);
    userPbCache.clear();
    return { ok: true, user: data.speedrunUser };
  } catch (e) {
    if (/returned 404/.test(e.message)) {
      return { ok: false, error: 'Couldn\'t find a speedrun.com user named "' + name + '".' };
    }
    return { ok: false, error: "Couldn't reach speedrun.com: " + e.message };
  }
});

ipcMain.handle("src:unlink", () => {
  data.speedrunUser = null;
  saveData(data);
  userPbCache.clear();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Tool installer — one-click download + unzip of the helper tools shown in
// the Tools tab, into <userData>/tools/<id>/ (always writable, unlike the
// install folder under Program Files), plus an optional desktop shortcut.
// The download URLs live here in the registry: the renderer only ever passes
// a tool id, never a URL, so it can't be used to fetch arbitrary files.
// ---------------------------------------------------------------------------
const TOOLS = {
  livesplit: {
    name: "LiveSplit",
    version: "1.8.37",
    url: "https://github.com/LiveSplit/LiveSplit/releases/download/1.8.37/LiveSplit_1.8.37.zip",
    exeNames: ["LiveSplit.exe"],
  },
  umodel: {
    name: "UModel",
    version: null,
    url: "https://ts.fuckingfast.net/d/dtwzrr32266c?v=XwdJFZ-RwhlQr3FnYL_bY9VrLyuwqEaV18rA5tDvPNKks9yZwDYztzAuF_qEIa2z0oMTAmWyv3n9GHj82NmOEqCTD6bW3LDNZNMkIUGK8geEJWZqIjZTHSD3mgkl5CMiN4u-x7RTfX-jwWNZzQqv1q-vnORy",
    // Prefer the 64-bit build when the zip ships one.
    exeNames: ["umodel_64.exe", "umodel.exe"],
  },
  uuu: {
    name: "UUU",
    version: null,
    url: "https://ts.fuckingfast.net/d/9zqt9kg3rt05?v=skeJFTxeYZvnvSprvU15nEaR2I5fOa8aABsx9qi8UY9qJbCajKimSLrqW2JSZM77gzkm0AlkxQQKqkBYQJOiUUkTx-rgIL5CHCQ5yh6gSkZSYY8zpfJM3Zj9JWKkrELYhEmadXBmgKVNguI",
    // Case-insensitive; first name found anywhere in the unpacked tree wins.
    exeNames: ["uuuclient.exe"],
  },
};
const TOOLS_ROOT = path.join(app.getPath("userData"), "tools");
const toolsBusy = new Set(); // ids with an install/uninstall in flight

const toolDir = id => path.join(TOOLS_ROOT, id);
const toolExe = id => (fs.existsSync(toolDir(id)) ? findFile(toolDir(id), TOOLS[id].exeNames) : null);
const toolShortcutPath = id => path.join(app.getPath("desktop"), TOOLS[id].name + ".lnk");

function shortcutPointsAt(lnk, exe) {
  try {
    return shell.readShortcutLink(lnk).target.toLowerCase() === exe.toLowerCase();
  } catch (e) {
    return false;
  }
}

function toolStatus(id) {
  const tool = TOOLS[id];
  const exe = toolExe(id);
  const lnk = toolShortcutPath(id);
  return {
    id,
    name: tool.name,
    downloadUrl: tool.url,
    installed: !!exe,
    installedVersion: (data.tools[id] && data.tools[id].version) || null,
    shortcut: !!exe && process.platform === "win32" && fs.existsSync(lnk) && shortcutPointsAt(lnk, exe),
    busy: toolsBusy.has(id),
  };
}

// Creates or removes the desktop shortcut. It only ever deletes a shortcut
// that points at this tool's own exe, and won't overwrite a same-named one
// the user made themselves.
function setToolShortcut(id, on) {
  if (process.platform !== "win32") return { ok: false, error: "Desktop shortcuts are only supported on Windows." };
  const exe = toolExe(id);
  if (!exe) return { ok: false, error: TOOLS[id].name + " isn't installed." };
  const lnk = toolShortcutPath(id);
  const exists = fs.existsSync(lnk);
  const ours = exists && shortcutPointsAt(lnk, exe);
  try {
    if (on) {
      if (exists && !ours) {
        return { ok: false, error: 'A different "' + TOOLS[id].name + '" shortcut already exists on your desktop.' };
      }
      // "create" (not "replace"): "replace" only works on a shortcut that
      // already exists and returns false otherwise, so it never made a new one.
      const ok = shell.writeShortcutLink(lnk, "create", {
        target: exe,
        cwd: path.dirname(exe),
        description: TOOLS[id].name,
        icon: exe,
        iconIndex: 0,
      });
      if (!ok) return { ok: false, error: "Couldn't create the desktop shortcut." };
    } else if (ours) {
      fs.rmSync(lnk, { force: true });
    }
  } catch (e) {
    return { ok: false, error: "Couldn't update the desktop shortcut: " + e.message };
  }
  return { ok: true };
}

ipcMain.handle("tools:list", () => ({
  ok: true,
  supported: process.platform === "win32",
  tools: Object.keys(TOOLS).map(toolStatus),
}));

ipcMain.handle("tools:install", async (event, id, opts) => {
  const tool = TOOLS[id];
  if (!tool) return { ok: false, error: "Unknown tool." };
  if (process.platform !== "win32") return { ok: false, error: "The one-click installer is only available on Windows." };
  if (toolsBusy.has(id)) return { ok: false, error: tool.name + " is already being installed." };
  if (toolExe(id)) return { ok: false, error: tool.name + " is already installed." };

  toolsBusy.add(id);
  const send = (payload) => {
    if (!event.sender.isDestroyed()) event.sender.send("tools:progress", { id, ...payload });
  };
  const zipPath = path.join(TOOLS_ROOT, id + ".zip.partial");
  const dir = toolDir(id);
  try {
    // Leftovers from an earlier failed attempt.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });

    let lastPercent = -1;
    send({ stage: "download", percent: 0 });
    try {
      await downloadFile(tool.url, zipPath, {
        onProgress: p => {
          if (p.percent !== lastPercent) {
            lastPercent = p.percent;
            send({ stage: "download", percent: p.percent });
          }
        },
      });
    } catch (e) {
      return { ok: false, error: "Download failed: " + e.message + "." };
    }
    if (!looksLikeZip(zipPath)) {
      return { ok: false, error: "The download wasn't a zip file, so it was discarded." };
    }

    send({ stage: "extract", percent: null });
    try {
      await extractZip(zipPath, dir);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: false, error: "Couldn't unpack " + tool.name + ": " + e.message };
    }
    if (!toolExe(id)) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { ok: false, error: "The download unpacked, but " + tool.exeNames[tool.exeNames.length - 1] + " wasn't inside it." };
    }

    data.tools[id] = { version: tool.version, installedAt: Date.now() };
    saveData(data);

    const result = { ok: true };
    if (opts && opts.shortcut) {
      const sc = setToolShortcut(id, true);
      if (!sc.ok) result.shortcutError = sc.error;
    }
    return result;
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: "Install failed: " + e.message };
  } finally {
    fs.rmSync(zipPath, { force: true });
    toolsBusy.delete(id);
  }
});

ipcMain.handle("tools:launch", async (event, id) => {
  if (!TOOLS[id]) return { ok: false, error: "Unknown tool." };
  const exe = toolExe(id);
  if (!exe) return { ok: false, error: TOOLS[id].name + " isn't installed." };
  return await new Promise(resolve => {
    try {
      const child = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: "ignore" });
      child.once("error", e => resolve({ ok: false, error: "Couldn't start " + TOOLS[id].name + ": " + e.message }));
      child.once("spawn", () => { child.unref(); resolve({ ok: true }); });
    } catch (e) {
      resolve({ ok: false, error: "Couldn't start " + TOOLS[id].name + ": " + e.message });
    }
  });
});

ipcMain.handle("tools:setShortcut", (event, id, on) => {
  if (!TOOLS[id]) return { ok: false, error: "Unknown tool." };
  return setToolShortcut(id, !!on);
});

ipcMain.handle("tools:openFolder", async (event, id) => {
  if (!TOOLS[id]) return { ok: false, error: "Unknown tool." };
  const exe = toolExe(id);
  if (!exe) return { ok: false, error: TOOLS[id].name + " isn't installed." };
  const err = await shell.openPath(path.dirname(exe));
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle("tools:uninstall", (event, id) => {
  if (!TOOLS[id]) return { ok: false, error: "Unknown tool." };
  if (toolsBusy.has(id)) return { ok: false, error: TOOLS[id].name + " is busy right now." };
  // Remove our shortcut first, while there's still an exe for it to point at.
  setToolShortcut(id, false);
  try {
    fs.rmSync(toolDir(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  } catch (e) {
    return { ok: false, error: "Couldn't remove it. Close " + TOOLS[id].name + " first, then try again." };
  }
  delete data.tools[id];
  saveData(data);
  return { ok: true };
});

// Custom window chrome (frame: false) needs the renderer to ask for these.
ipcMain.on("window:minimize", () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on("window:close", () => { if (mainWindow) mainWindow.close(); });

// ---------------------------------------------------------------------------
// Update manager — checks GitHub Releases for a newer build, downloads the
// installer .exe attached to that release, and hands off to it. Deliberately
// NOT silent/automatic: the person clicks to download, then clicks again to
// restart and run the installer, which runs exactly like running it by hand
// (same "Choose install location" NSIS UI) — this just automates finding
// and fetching it. Uses the same global fetch() the speedrun.com lookups
// already use, no new dependency.
// ---------------------------------------------------------------------------
const UPDATE_REPO = "jobbybam/Fling";
const UPDATE_API_URL = "https://api.github.com/repos/" + UPDATE_REPO + "/releases/latest";

// Holds whatever the most recent update:check found, so update:download and
// update:install have something to act on without repeating the GitHub
// lookup. Cleared/replaced wholesale on every fresh check.
let pendingUpdate = null;

// Compares two "vX.Y.Z"-ish version strings (leading "v" optional, any
// number of numeric segments). Returns >0 if a is newer than b, <0 if
// older, 0 if equal-as-far-as-both-specify. Non-numeric segments compare
// as 0 rather than throwing, so a stray "-beta" suffix etc. doesn't crash
// the comparison — worst case it's treated as equal on that segment.
function compareVersions(a, b) {
  const clean = v => String(v || "").replace(/^v/i, "").split(".").map(s => parseInt(s, 10) || 0);
  const pa = clean(a), pb = clean(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

ipcMain.handle("update:check", async () => {
  let json;
  try {
    const res = await fetch(UPDATE_API_URL, {
      headers: {
        "User-Agent": "FlingLauncher",
        "Accept": "application/vnd.github+json",
      },
    });
    if (!res.ok) return { ok: false, error: "GitHub returned " + res.status };
    json = await res.json();
  } catch (e) {
    return { ok: false, error: "Couldn't reach GitHub: " + e.message };
  }

  const currentVersion = app.getVersion();
  const latestVersion = json.tag_name || json.name || "";
  if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0) {
    return { ok: true, available: false, currentVersion };
  }

  const asset = (json.assets || []).find(a => /\.exe$/i.test(a.name));
  if (!asset) {
    // A release exists but has no installer attached yet (e.g. still
    // uploading) — not an error exactly, just nothing to offer yet.
    return { ok: true, available: false, currentVersion };
  }

  // A previous check may have left a downloaded installer for a DIFFERENT
  // version sitting in temp — it's now stale, so drop it rather than let a
  // later update:install silently run the wrong installer.
  if (pendingUpdate && pendingUpdate.downloadedPath && pendingUpdate.version !== latestVersion) {
    try { fs.unlinkSync(pendingUpdate.downloadedPath); } catch (e) { /* already gone, fine */ }
  }

  pendingUpdate = {
    version: latestVersion,
    notes: json.body || "",
    assetUrl: asset.browser_download_url,
    assetName: asset.name,
    assetSize: asset.size,
    downloadedPath: (pendingUpdate && pendingUpdate.version === latestVersion) ? pendingUpdate.downloadedPath : null,
  };

  return {
    ok: true,
    available: true,
    currentVersion,
    latestVersion,
    notes: pendingUpdate.notes,
    assetName: asset.name,
    assetSize: asset.size,
    alreadyDownloaded: !!(pendingUpdate.downloadedPath && fs.existsSync(pendingUpdate.downloadedPath)),
  };
});

ipcMain.handle("update:download", async (event) => {
  if (!pendingUpdate) return { ok: false, error: "Check for updates first." };

  // Already fetched this exact version's installer — nothing to redo.
  if (pendingUpdate.downloadedPath && fs.existsSync(pendingUpdate.downloadedPath)) {
    return { ok: true, path: pendingUpdate.downloadedPath };
  }

  const destPath = path.join(app.getPath("temp"), pendingUpdate.assetName);
  let res;
  try {
    res = await fetch(pendingUpdate.assetUrl, { headers: { "User-Agent": "FlingLauncher" } });
    if (!res.ok || !res.body) return { ok: false, error: "Download returned " + res.status };
  } catch (e) {
    return { ok: false, error: "Couldn't reach GitHub: " + e.message };
  }

  const total = Number(res.headers.get("content-length")) || pendingUpdate.assetSize || 0;
  let received = 0;
  const ws = fs.createWriteStream(destPath);
  try {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ws.write(Buffer.from(value));
      received += value.length;
      event.sender.send("update:progress", {
        received,
        total,
        percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
      });
    }
    await new Promise((resolve, reject) => {
      ws.end(err => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    ws.destroy();
    try { fs.unlinkSync(destPath); } catch (e2) { /* nothing to clean up */ }
    return { ok: false, error: "Download failed: " + e.message };
  }

  // Sanity check — a truncated/interrupted download is worse than none.
  if (total && fs.statSync(destPath).size !== total) {
    try { fs.unlinkSync(destPath); } catch (e) { /* already gone, fine */ }
    return { ok: false, error: "Downloaded file was incomplete. Try again." };
  }

  pendingUpdate.downloadedPath = destPath;
  return { ok: true, path: destPath };
});

ipcMain.handle("update:install", async () => {
  if (!pendingUpdate || !pendingUpdate.downloadedPath || !fs.existsSync(pendingUpdate.downloadedPath)) {
    return { ok: false, error: "The installer isn't downloaded yet." };
  }
  try {
    // Runs exactly like double-clicking the installer by hand — normal NSIS
    // UI, "Choose install location" step and all. detached + unref so it
    // survives this process quitting right after.
    const child = spawn(pendingUpdate.downloadedPath, [], { detached: true, stdio: "ignore" });
    child.unref();
  } catch (e) {
    return { ok: false, error: "Couldn't start the installer: " + e.message };
  }
  setTimeout(() => app.quit(), 300);
  return { ok: true };
});
