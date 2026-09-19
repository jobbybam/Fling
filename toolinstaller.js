// toolinstaller.js — download / extract / locate helpers for the Tools tab's
// one-click installer. Deliberately has NO electron import, so it can be
// exercised on its own; main.js owns the IPC handlers, the tool registry and
// the desktop shortcuts (those need Electron's `shell`).

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// Streams `url` to `dest`, reporting progress as { received, total, percent }.
// Follows redirects (GitHub release assets redirect to a CDN). Throws on a
// non-2xx status, a timeout, or a body bigger than maxBytes; never leaves a
// half-written `dest` behind.
async function downloadFile(url, dest, opts = {}) {
  const { onProgress, maxBytes = 200 * 1024 * 1024, timeoutMs = 5 * 60 * 1000 } = opts;
  const res = await fetch(url, {
    headers: { "User-Agent": "FlingLauncher" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) throw new Error("the server returned " + res.status);

  const total = Number(res.headers.get("content-length")) || 0;
  if (total && total > maxBytes) throw new Error("the file is unexpectedly large");

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const ws = fs.createWriteStream(dest);
  let received = 0;
  try {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) throw new Error("the file is unexpectedly large");
      if (!ws.write(Buffer.from(value))) {
        await new Promise(resolve => ws.once("drain", resolve));
      }
      if (onProgress) {
        onProgress({
          received,
          total,
          percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
        });
      }
    }
    await new Promise((resolve, reject) => ws.end(err => (err ? reject(err) : resolve())));
  } catch (e) {
    ws.destroy();
    try { fs.unlinkSync(dest); } catch (e2) { /* nothing written yet */ }
    throw e;
  }
  if (total && received !== total) {
    try { fs.unlinkSync(dest); } catch (e2) { /* already gone */ }
    throw new Error("the download was cut short");
  }
  return received;
}

// A zip always starts with "PK\x03\x04". Catches the classic failure where a
// download link hands back an HTML error page instead of the archive.
function looksLikeZip(file) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(4);
      fs.readSync(fd, buf, 0, 4, 0);
      return buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return false;
  }
}

function run(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 120000, ...options }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr && String(stderr).trim()) || err.message));
      else resolve();
    });
  });
}

// Extracts `zipPath` into `destDir`. Windows: PowerShell's Expand-Archive
// (ships with every supported Windows), falling back to the built-in
// tar.exe. Paths go in through environment variables rather than being
// spliced into the command string, so odd characters in a user's profile
// folder name can't break — or inject into — the command. Other platforms
// only matter for developing the launcher, so they just use `unzip`.
async function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    const env = { ...process.env, FLING_ZIP: zipPath, FLING_DEST: destDir };
    try {
      await run("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
        "Expand-Archive -LiteralPath $env:FLING_ZIP -DestinationPath $env:FLING_DEST -Force",
      ], { env });
      return;
    } catch (psError) {
      const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
      try {
        await run(tar, ["-xf", zipPath, "-C", destDir]);
        return;
      } catch (tarError) {
        throw new Error("couldn't unzip it (" + psError.message + ")");
      }
    }
  }
  await run("unzip", ["-o", "-q", zipPath, "-d", destDir]);
}

// Finds a file by name (case-insensitive) somewhere under `dir`, at most
// `maxDepth` folders down — release zips often wrap everything in one
// versioned folder. `names` is in priority order: the first name that exists
// anywhere in the tree wins, so ["tool_64.exe", "tool.exe"] prefers the 64-bit
// build when both are shipped. Returns the full path, or null.
function findFile(dir, names, maxDepth = 3) {
  const wanted = names.map(n => n.toLowerCase());
  const found = new Map(); // lowercase name -> full path
  (function walk(current, depth) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (wanted.includes(lower) && !found.has(lower)) found.set(lower, full);
      } else if (entry.isDirectory() && depth < maxDepth) {
        walk(full, depth + 1);
      }
    }
  })(dir, 0);
  for (const name of wanted) {
    if (found.has(name)) return found.get(name);
  }
  return null;
}

module.exports = { downloadFile, looksLikeZip, extractZip, findFile };
