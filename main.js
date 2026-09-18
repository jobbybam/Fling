// main.js — Electron main process.
// This is the ONLY place that touches disk or spawns processes. The renderer
// (index.html) never gets raw Node/fs access — it only talks to this file
// through the safe API exposed in preload.js.

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, execFile, execFileSync } = require("child_process");

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
      "Fling Launcher — startup error",
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
    };
  } catch (e) {
    // No file yet (first run) or unreadable — start clean.
    return { installPaths: {}, ...SETTINGS_DEFAULTS, selectedId: null };
  }
}

function saveData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

let data = loadData();

// Tracks currently-running games, keyed by alpha id:
//   { child, pid, exeName, pollTimer }
// so the renderer's STOP button has something real to act on and so we can
// push a "it closed" event back when a game exits on its own (closed
// normally, crashed, or was killed via STOP). See killProcessTree /
// isImageRunning below for why this stores more than just the child handle.
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
  createWindow();
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
  runningProcesses.forEach(entry => {
    if (entry.pollTimer) clearInterval(entry.pollTimer);
  });
  runningProcesses.clear();
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

// Marks an entry as no longer running and tells the renderer once — guarded
// so a manual STOP and the child's own "exit" event can't double-fire it.
function reportClosed(id) {
  const entry = runningProcesses.get(id);
  if (!entry) return;
  if (entry.pollTimer) clearInterval(entry.pollTimer);
  runningProcesses.delete(id);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("game:closed", id);
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

// assets/commandlist.txt — one command per line, formatted as:
//   command [args] (description text)
// Returns null if the file doesn't exist yet (renderer shows a fallback).
function loadCommandList() {
  const file = path.join(getAppRoot(), "assets", "commandlist.txt");
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const m = line.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
        if (m) return { command: m[1].trim(), description: m[2].trim() };
        return { command: line, description: "" };
      });
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
  fs.mkdirSync(path.dirname(FLAGS_TXT_FILE), { recursive: true });
  fs.writeFileSync(FLAGS_TXT_FILE, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Leaderboard tab — top 10 world records for a title, pulled live from
// speedrun.com's public read API (no key required). The game itself is
// resolved by NAME (each entry's `full` field) rather than a guessed
// abbreviation, since speedrun.com's abbreviations aren't predictable —
// this means it works for the whole roster with zero per-entry setup.
// Results are cached for a few minutes per id so flipping between the same
// couple of entries in the Leaderboard grid doesn't refetch every time.
// ---------------------------------------------------------------------------
const SPEEDRUN_API = "https://www.speedrun.com/api/v1";
const speedrunCache = new Map(); // id -> { gameId, categories, fetchedAt }
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
  const res = await fetch(url, {
    headers: {
      "User-Agent": "FlingLauncher/1.0",
      ...(key ? { "X-API-Key": key } : {}),
    },
  });
  if (!res.ok) throw new Error("speedrun.com returned " + res.status);
  return res.json();
}

async function resolveSpeedrunGame(name) {
  const json = await speedrunFetchJson(SPEEDRUN_API + "/games?name=" + encodeURIComponent(name) + "&max=5");
  const list = (json && json.data) || [];
  if (list.length === 0) return null;
  const exact = list.find(g => g.names && (g.names.international || "").toLowerCase() === name.toLowerCase());
  return exact || list[0];
}

async function getSpeedrunCategories(gameId) {
  const json = await speedrunFetchJson(SPEEDRUN_API + "/games/" + gameId + "/categories?embed=variables");
  // "per-game" categories only — excludes individual-level (IL) categories,
  // which need a level picked too and don't fit a simple top-10 view. Also
  // excludes categories speedrun.com itself flags "miscellaneous": true —
  // these are the ones hidden behind that game's own "Show misc." toggle on
  // speedrun.com (leftover/alternate categories, e.g. an old pre-restructure
  // "PC" category that a later, non-misc category superseded) and are what
  // produced a duplicate-looking, empty entry (an extra "PC - Any%" board
  // with nothing on it, sitting first in the dropdown) alongside the real
  // category of the same name.
  const perGame = ((json && json.data) || []).filter(c => c.type === "per-game" && !c.miscellaneous);

  // Category extensions: a "per-game" category can carry a subcategory
  // variable (speedrun.com flags these "is-subcategory": true) that splits
  // its board into distinct boards — e.g. Any% - PC vs Any% - Console, or
  // Any% - Standard vs Any% - No Wrong Warp — rather than one leaderboard
  // mixing every value together. Each returned entry below is one concrete,
  // fetchable board: either a plain category (no subcategory variable), or
  // one category+value combination (an "extension" of that category).
  const expanded = [];
  perGame.forEach(cat => {
    const vars = (cat.variables && cat.variables.data) || [];
    const subVars = vars.filter(v => v["is-subcategory"] && (!v.category || v.category === cat.id));
    if (subVars.length === 0) {
      expanded.push({ id: cat.id, name: cat.name, categoryId: cat.id, varId: null, varValue: null });
      return;
    }
    // Split on the first subcategory variable found — most titles have at
    // most one per category; stacking every combination for the rare title
    // with more would blow the dropdown up combinatorially.
    const variable = subVars[0];
    const values = (variable.values && variable.values.values) || {};
    Object.keys(values)
      // Secondary safety net: speedrun.com can also flag an individual
      // variable VALUE (not just a whole category) "miscellaneous" — same
      // idea as the category-level filter above, one level down. Doesn't
      // hurt to also skip these while we're here.
      .filter(valueId => !(values[valueId] && values[valueId].flags && values[valueId].flags.miscellaneous))
      .forEach(valueId => {
        const valueName = (values[valueId] && values[valueId].label) || valueId;
        expanded.push({
          id: cat.id + "::" + variable.id + "::" + valueId,
          name: cat.name + " - " + valueName,
          categoryId: cat.id,
          varId: variable.id,
          varValue: valueId,
        });
      });
  });
  return expanded;
}

async function getSpeedrunLeaderboard(gameId, categoryId, varId, varValue) {
  let url = SPEEDRUN_API + "/leaderboards/" + gameId + "/category/" + categoryId + "?top=10&embed=players";
  if (varId && varValue) url += "&var-" + varId + "=" + varValue;
  const json = await speedrunFetchJson(url);
  const board = json && json.data;
  const runs = (board && board.runs) || [];
  const playersById = {};
  const embeddedPlayers = (board && board.players && board.players.data) || [];
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
    };
  });
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
      error: 'Couldn\'t find it automatically — checked the default Steam folders for "' + game.steamFolder + '".',
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
      return { ok: false, error: "This alpha is singleplayer only right now — no multiplayer mod to launch." };
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

    const entry = { child, pid: child.pid, exeName, pollTimer: null };
    runningProcesses.set(id, entry);

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
        if (!alive && runningProcesses.get(id) === current) reportClosed(id);
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
        " — it may need to be closed manually, or it declined the admin prompt.",
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

ipcMain.handle("console:getCommands", () => {
  return loadCommandList();
});

ipcMain.handle("leaderboard:get", async (event, id, categoryId) => {
  const game = GAMES.find(g => g.id === id);
  if (!game) return { ok: false, error: "Unknown title." };

  try {
    let cached = speedrunCache.get(id);
    if (!cached || (Date.now() - cached.fetchedAt) > SPEEDRUN_CACHE_MS) {
      const found = await resolveSpeedrunGame(game.full);
      if (!found) return { ok: false, error: 'Couldn\'t find "' + game.full + '" on speedrun.com.' };
      const categories = await getSpeedrunCategories(found.id);
      cached = { gameId: found.id, gameName: (found.names && found.names.international) || game.full, categories, fetchedAt: Date.now() };
      speedrunCache.set(id, cached);
    }
    if (!cached.categories.length) {
      return { ok: false, error: "No leaderboard categories found for " + game.full + " on speedrun.com." };
    }
    // A specific category can be requested (the category picker in the
    // Leaderboard tab); fall back to the first per-game category — the
    // previous default — if none was requested or the id doesn't match
    // anything for this title (e.g. a stale selection from switching games).
    const category = cached.categories.find(c => c.id === categoryId) || cached.categories[0];
    const runs = await getSpeedrunLeaderboard(cached.gameId, category.categoryId, category.varId, category.varValue);
    return {
      ok: true,
      game: cached.gameName,
      category: category.name,
      categoryId: category.id,
      // Full list so the renderer can populate a category dropdown without
      // a separate round trip — {id, name} only, no need for the raw
      // speedrun.com category objects.
      categories: cached.categories.map(c => ({ id: c.id, name: c.name })),
      runs,
    };
  } catch (e) {
    return { ok: false, error: "Couldn't reach speedrun.com: " + e.message };
  }
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
    return { ok: false, error: "Downloaded file was incomplete — try again." };
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
