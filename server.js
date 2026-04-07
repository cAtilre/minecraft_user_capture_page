const express = require("express");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const https = require("https");

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

