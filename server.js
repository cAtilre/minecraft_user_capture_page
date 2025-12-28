const express = require("express");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const https = require("https");

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

  const regex = /^[a-zA-Z0-9_]{2,16}$/;
  const valid = regex.test(username);

  let uuid = null;
  let uuidLookupError = null;

  if (valid) {
    uuid = await getMojangUUID(username);
    if (uuid === null) {
      uuidLookupError = "Username not found in Mojang database";
    }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    username,
    valid,
    publicIp,
    uuid: uuid || undefined,
    uuidLookupError: uuidLookupError || undefined
  };

  fs.appendFile(logFile, JSON.stringify(entry) + "\n", err => {
    if (err) console.error("Log write failed:", err);
  });

  res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
