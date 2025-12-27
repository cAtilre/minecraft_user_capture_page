# Minecraft Username Logger

A simple web application that logs Minecraft player name submissions with validation and rate limiting.

## Features

- **Simple HTML form** for submitting Minecraft player names
- **Server-side validation** using regex: `^[a-zA-Z0-9_]{2,16}$`
- **JSON logging** of all submissions (valid and invalid) with timestamps and client IPs
- **Rate limiting** to prevent spam (30 requests per minute per IP)
- **Always returns HTTP 200** with response body "ok"
- **Dockerized** for production deployment
- **Node.js 20 LTS** for local development

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Static HTML
- **Logging:** Node.js fs (append-only)
- **Rate Limiting:** express-rate-limit
- **Containerization:** Docker with Alpine Linux

## Quick Start

### Local Development (without Docker)

```bash
# Use Node 20 LTS
nvm use 20

# Install dependencies
npm install

# Start the server
npm start
```

Then open http://localhost:8080 in your browser.

### Docker

```bash
docker build -t username-logger .
docker run -p 8080:8080 -v $(pwd)/logs:/app/logs username-logger
```

## Project Structure

```
.
├── server.js           # Express backend
├── public/
│   └── index.html      # Frontend form
├── logs/
│   └── access.log      # JSON log file
├── package.json
├── .nvmrc              # Node version specification
├── Dockerfile          # Production image
└── .github/workflows/  # CI/CD pipeline
```

## Logging

Each submission is logged to `logs/access.log` in JSON format:

```json
{
  "timestamp": "2025-12-27T12:34:56.789Z",
  "username": "steve123",
  "valid": true,
  "ip": "127.0.0.1"
}
```

## API

### POST /submit

Accepts form data with field `playerName`.

**Response:**
- Status: `200`
- Body: `"ok"`

All submissions are logged regardless of validation result.

## License

MIT
