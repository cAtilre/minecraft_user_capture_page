const express = require("express");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const https = require("https");
const archiver = require("archiver");

const app = express();
const PORT = process.env.PORT || 8080;

// Trust proxy headers from nginx
app.set("trust proxy", true);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files (HTML)
app.use(express.static(path.join(__dirname, "public")));

// Ensure logs directory exists
const logDir = path.join(__dirname, "logs");
const logFile = path.join(logDir, "access.log");
const playersFile = path.join(logDir, "players.json");

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Mods file browser — read-only listing + zip download from /data/mods
// ---------------------------------------------------------------------------

const MODS_ROOT = path.resolve(process.env.MODS_DIR || "/data/mods");

// Resolves a user-supplied relative path against MODS_ROOT, rejecting any
// attempt to escape the root (e.g. via "..", absolute paths, symlinks).
function resolveModsPath(relPath) {
  const safeRel = path.normalize(relPath || ".").replace(/^(\.\.[/\\])+/, "");
  const full = path.resolve(MODS_ROOT, safeRel);
  const realRoot = fs.realpathSync(MODS_ROOT);
  let realFull;
  try {
    realFull = fs.realpathSync(full);
  } catch {
    return null; // doesn't exist
  }
  if (realFull !== realRoot && !realFull.startsWith(realRoot + path.sep)) {
    return null; // escapes the mods root
  }
  return realFull;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Crafty Controller server-name lookup (used to label mods instances)
// ---------------------------------------------------------------------------

const CRAFTY_API_BASE = process.env.CRAFTY_API_BASE || "https://crafty.pullen.co.za";
const CRAFTY_API_TOKEN = process.env.CRAFTY_API_TOKEN || "";
const CRAFTY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const craftyCache = new Map(); // uuid -> { name, expires }

function getCraftyServerName(uuid) {
  const cached = craftyCache.get(uuid);
  if (cached && cached.expires > Date.now()) {
    return Promise.resolve(cached.name);
  }

  return new Promise((resolve) => {
    const url = `${CRAFTY_API_BASE}/api/v2/servers/${encodeURIComponent(uuid)}`;
    const req = https.get(
      url,
      {
        headers: CRAFTY_API_TOKEN ? { Authorization: `Bearer ${CRAFTY_API_TOKEN}` } : {},
        timeout: 5000
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          let name = null;
          try {
            if (res.statusCode === 200) {
              const parsed = JSON.parse(data);
              name = parsed?.data?.server_name || null;
            }
          } catch {
            name = null;
          }
          // Only cache definitive responses — network errors/timeouts are retried next time.
          craftyCache.set(uuid, { name, expires: Date.now() + CRAFTY_CACHE_TTL_MS });
          resolve(name);
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

// Top-level entries under MODS_ROOT are per-player work directories named by
// UUID; only these are exposed for the instance picker (not raw root listing).
app.get("/api/mods/instances", async (req, res) => {
  const rootDir = resolveModsPath("");
  if (!rootDir) {
    return res.status(500).json({ error: "Mods root not found" });
  }

  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    const uuids = entries
      .filter((entry) => entry.isDirectory() && UUID_REGEX.test(entry.name))
      .map((entry) => entry.name);

    const items = await Promise.all(
      uuids.map(async (uuid) => ({
        name: uuid,
        serverName: await getCraftyServerName(uuid)
      }))
    );
    items.sort((a, b) => (a.serverName || a.name).localeCompare(b.serverName || b.name));
    res.json({ items });
  } catch (e) {
    console.error("Failed to list mods instances:", e);
    res.status(500).json({ error: "Failed to list instances" });
  }
});

app.get("/api/mods/list", (req, res) => {
  const relDir = typeof req.query.dir === "string" ? req.query.dir : "";
  const fullDir = resolveModsPath(relDir);

  if (!fullDir) {
    return res.status(400).json({ error: "Invalid directory" });
  }

  let stat;
  try {
    stat = fs.statSync(fullDir);
  } catch {
    return res.status(404).json({ error: "Not found" });
  }
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: "Not a directory" });
  }

  try {
    const entries = fs.readdirSync(fullDir, { withFileTypes: true });
    const items = entries.map((entry) => {
      const entryRel = path.join(relDir, entry.name);
      const entryFull = path.join(fullDir, entry.name);
      const isDir = entry.isDirectory();
      let size = null;
      if (!isDir) {
        try {
          size = fs.statSync(entryFull).size;
        } catch {
          size = null;
        }
      }
      return { name: entry.name, path: entryRel.split(path.sep).join("/"), type: isDir ? "dir" : "file", size };
    });
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    res.json({ dir: relDir.split(path.sep).join("/"), items });
  } catch (e) {
    console.error("Failed to list mods directory:", e);
    res.status(500).json({ error: "Failed to list directory" });
  }
});

app.post("/api/mods/download", (req, res) => {
  const requested = Array.isArray(req.body.paths) ? req.body.paths : [];
  if (requested.length === 0) {
    return res.status(400).json({ error: "No paths provided" });
  }

  const resolved = [];
  for (const relPath of requested) {
    if (typeof relPath !== "string") {
      return res.status(400).json({ error: "Invalid path" });
    }
    const full = resolveModsPath(relPath);
    if (!full) {
      return res.status(400).json({ error: `Invalid path: ${relPath}` });
    }
    const stat = fs.statSync(full);
    resolved.push({ full, name: path.basename(full), isDir: stat.isDirectory() });
  }

  // A single selected file is sent as-is; anything else (multiple items,
  // or a single directory) is bundled into a zip.
  if (resolved.length === 1 && !resolved[0].isDir) {
    return res.download(resolved[0].full, resolved[0].name);
  }

  const zipName = resolved.length === 1 ? `${resolved[0].name}.zip` : "mods-selection.zip";
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    console.error("Zip archive error:", err);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);

  for (const item of resolved) {
    if (item.isDir) {
      archive.directory(item.full, item.name);
    } else {
      archive.file(item.full, { name: item.name });
    }
  }

  archive.finalize();
});

// Simple rate limit
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,             // 30 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const usernameRegex = /^[a-zA-Z0-9_]{2,16}$/;
const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
const fqdnRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

function getClientIp(req) {
  return req.ip || "unknown";
}

// ---------------------------------------------------------------------------
// Mojang UUID lookup
// ---------------------------------------------------------------------------

function hyphenateUUID(raw) {
  // Mojang returns 32 hex chars without hyphens → reformat as 8-4-4-4-12
  return `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;
}

function getMojangUUID(username) {
  return new Promise((resolve) => {
    const url = `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode === 200) {
            const result = JSON.parse(data);
            resolve(result.id ? hyphenateUUID(result.id) : null);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    }).on("error", () => resolve(null));
  });
}

// ---------------------------------------------------------------------------
// JSON player store (upsert by UUID, keyed by current Minecraft username)
// ---------------------------------------------------------------------------

function upsertPlayer(record) {
  let db = {};
  if (fs.existsSync(playersFile)) {
    try {
      db = JSON.parse(fs.readFileSync(playersFile, "utf8"));
    } catch (e) {
      console.error("Failed to parse players.json — starting fresh:", e);
    }
  }

  // If this UUID already exists under a different username (player renamed their
  // Minecraft account), remove the stale entry before writing the new one.
  for (const [key, existing] of Object.entries(db)) {
    if (existing.uuid === record.uuid && key !== record.username) {
      console.log(`UUID ${record.uuid}: username changed ${key} → ${record.username}`);
      delete db[key];
      break;
    }
  }

  db[record.username] = record;
  // Atomic write: temp file → rename
  const tmp = playersFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, playersFile);
}

// ---------------------------------------------------------------------------
// POST /submit
// ---------------------------------------------------------------------------

app.post("/submit", async (req, res) => {
  const username = (req.body.playerName || "").trim();
  const realName = (req.body.realName   || "").trim() || username; // default to username
  const rawIp    = (req.body.myIP       || "").trim();
  const rawFqdn  = (req.body.myFQDN     || "").trim();

  const errors = [];

  // Minecraft username
  if (!usernameRegex.test(username)) {
    errors.push("Invalid Minecraft username (2–16 alphanumeric/underscore chars)");
  }

  // IP — optional but must be valid if provided
  let validIp = null;
  if (rawIp) {
    if (ipv4Regex.test(rawIp) || ipv6Regex.test(rawIp)) {
      validIp = rawIp;
    } else {
      errors.push("Invalid IP address format");
    }
  }

  // FQDN — optional but must be valid if provided
  let validFqdn = null;
  if (rawFqdn) {
    if (fqdnRegex.test(rawFqdn)) {
      validFqdn = rawFqdn;
    } else {
      errors.push("Invalid hostname / FQDN format");
    }
  }

  // Must supply at least one address
  if (!validIp && !validFqdn && errors.length === 0) {
    errors.push("At least one of IP address or hostname must be provided");
  }

  if (errors.length > 0) {
    return res.status(400).send("Error: " + errors.join("; "));
  }

  // Mojang UUID verification
  const uuid = await getMojangUUID(username);
  if (!uuid) {
    return res.status(400).send("Error: Minecraft username not found in Mojang's database");
  }

  const record = {
    username,
    realName,
    uuid,
    ...(validIp   ? { ip:   validIp   } : {}),
    ...(validFqdn ? { fqdn: validFqdn } : {}),
    lastUpdated: new Date().toISOString()
  };

  // Audit log (one JSON entry per line)
  const logEntry = { ...record, clientIp: getClientIp(req) };
  fs.appendFile(logFile, JSON.stringify(logEntry) + "\n", err => {
    if (err) console.error("Audit log write failed:", err);
  });

  // Upsert to players.json
  try {
    upsertPlayer(record);
  } catch (e) {
    console.error("Failed to write players.json:", e);
    return res.status(500).send("Error saving your information. Please try again.");
  }

  res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

