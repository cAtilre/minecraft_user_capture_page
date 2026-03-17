const express = require("express");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const https = require("https");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 8080;

// Trust proxy headers from nginx
app.set('trust proxy', true);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files (HTML)
app.use(express.static(path.join(__dirname, "public")));

// Ensure logs directory exists
const logDir = path.join(__dirname, "logs");
const logFile = path.join(logDir, "access.log");

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// Set up SQLite database
const db = new Database(path.join(logDir, "submissions.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    username  TEXT NOT NULL,
    valid     INTEGER NOT NULL,
    public_ip TEXT,
    uuid      TEXT,
    uuid_error TEXT
  )
`);
const insertStmt = db.prepare(`
  INSERT INTO submissions (timestamp, username, valid, public_ip, uuid, uuid_error)
  VALUES (@timestamp, @username, @valid, @publicIp, @uuid, @uuidLookupError)
`);

// Simple rate limit
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,             // 30 requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false
});

app.use(limiter);

function getClientIp(req) {
  return req.ip || "unknown";
}

function getMojangUUID(username) {
  return new Promise((resolve) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const url = `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}?at=${timestamp}`;

    https.get(url, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          if (res.statusCode === 200) {
            const result = JSON.parse(data);
            resolve(result.id || null);
          } else {
            resolve(null);
          }
        } catch (err) {
          resolve(null);
        }
      });
    }).on("error", () => {
      resolve(null);
    });
  });
}

app.post("/submit", async (req, res) => {
  const username = (req.body.playerName || "").trim();
  const publicIp = (req.body.myIP || "").trim();
  const ip = getClientIp(req);

  const usernameRegex = /^[a-zA-Z0-9_]{2,16}$/;
  const valid = usernameRegex.test(username);

  // Validate IPv4 and IPv6 addresses
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
  const validIp = ipv4Regex.test(publicIp) || ipv6Regex.test(publicIp);

  let uuid = null;
  let uuidLookupError = null;

  if (valid) {
    uuid = await getMojangUUID(username);
    if (uuid === null) {
      uuidLookupError = "Username not found in Mojang database";
    }
    if (!validIp) {
      uuidLookupError = uuidLookupError + "; Invalid IP address";
    }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    username,
    valid,
    publicIp: validIp ? publicIp : undefined,
    uuid: uuid || undefined,
    uuidLookupError: uuidLookupError || undefined
  };

  fs.appendFile(logFile, JSON.stringify(entry) + "\n", err => {
    if (err) console.error("Log write failed:", err);
  });

  try {
    insertStmt.run({
      timestamp: entry.timestamp,
      username: entry.username,
      valid: entry.valid ? 1 : 0,
      publicIp: entry.publicIp ?? null,
      uuid: entry.uuid ?? null,
      uuidLookupError: entry.uuidLookupError ?? null
    });
  } catch (dbErr) {
    console.error("DB write failed:", dbErr);
  }

  if (uuidLookupError !== null) {
    return res.status(400).send(`Error: ${uuidLookupError}`);
  }
  res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
