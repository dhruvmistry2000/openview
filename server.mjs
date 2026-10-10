/**
 * Zero-dependency proxy for Openview.
 *
 * Serves index.html, css/, and js/, then forwards every other request to the
 * OpenCode HTTP server. GET /_home returns this machine's home directory.
 * GET /_db/sessions reads the local SQLite database read-only. POST /_library
 * writes one agent or skill markdown file.
 *
 * Node 22+ is required for the database endpoint (node:sqlite). The proxy
 * itself runs on Node 18+.
 */
import http from "node:http"
import https from "node:https"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, timingSafeEqual } from "node:crypto"
import { fileURLToPath } from "node:url"
import { sendJson } from "./lib/respond.mjs"
import { handleLibrary } from "./lib/library.mjs"
import { handleDbSessions, inspectDatabase, loadSqlite, resolveDbPath } from "./lib/db.mjs"

const OPENCODE_URL = process.env.OPENCODE_URL || "http://127.0.0.1:4096"
const HOST = process.env.HOST || "127.0.0.1"
const PORT = Number(process.env.PORT || 8080)
const UI_USERNAME = process.env.UI_USERNAME ?? ""
const UI_PASSWORD = process.env.UI_PASSWORD ?? ""
const OC_USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode"
const OC_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || ""

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
}
const DROP_HEADERS = new Set([
  "origin",
  "referer",
  "authorization",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "proxy-authorization",
])

let upstream
try {
  upstream = new URL(OPENCODE_URL)
} catch {
  console.error("OPENCODE_URL is not a valid URL:", OPENCODE_URL)
  process.exit(1)
}
if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
  console.error("OPENCODE_URL must be http or https")
  process.exit(1)
}

function isLoopback(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "").toLowerCase()
  return h === "127.0.0.1" || h === "localhost" || h === "::1"
}

if (!isLoopback(HOST) && !UI_PASSWORD) {
  console.warn(
    "warning: HOST is not a loopback address and UI_PASSWORD is unset; the UI is reachable without a password",
  )
}

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest()
}

function safeEqual(a, b) {
  return timingSafeEqual(digest(a), digest(b))
}

function uiAuthorized(req) {
  if (!UI_PASSWORD) return true
  const header = req.headers.authorization || ""
  if (!header.startsWith("Basic ")) return false
  let decoded = ""
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8")
  } catch {
    return false
  }
  const split = decoded.indexOf(":")
  const user = split === -1 ? decoded : decoded.slice(0, split)
  const pass = split === -1 ? "" : decoded.slice(split + 1)
  const userOk = safeEqual(user, UI_USERNAME)
  const passOk = safeEqual(pass, UI_PASSWORD)
  return userOk && passOk
}

function rejectUi(res) {
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="Openview"',
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end("Authentication required")
}


function localFile(pathname) {
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "")
  if (rel !== "index.html" && !rel.startsWith("css/") && !rel.startsWith("js/")) return null
  if (rel.includes("\0") || rel.split("/").includes("..")) return null
  const ext = path.extname(rel)
  if (rel !== "index.html" && !TYPES[ext]) return null
  const file = path.resolve(ROOT, rel)
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return null
  return file
}

function serveLocal(req, res, file) {
  if (!fs.existsSync(file)) {
    sendJson(res, 404, { error: "Not found" })
    return
  }
  const type = TYPES[path.extname(file)] || TYPES[".html"]
  if (req.method === "HEAD") {
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" })
    res.end()
    return
  }
  let body
  try {
    body = fs.readFileSync(file)
  } catch {
    sendJson(res, 404, { error: "Not found" })
    return
  }
  res.writeHead(200, {
    "content-type": type,
    "content-length": body.length,
    "cache-control": "no-cache",
  })
  res.end(body)
}

function forward(req, res) {
  const target = new URL(req.url, upstream)
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (DROP_HEADERS.has(name.toLowerCase())) continue
    if (value == null) continue
    headers[name] = value
  }
  const isEvent = target.pathname === "/event" || target.pathname === "/global/event" || target.pathname.endsWith("/event")
  if (isEvent) delete headers["accept-encoding"]
  if (OC_PASSWORD) {
    headers.authorization = `Basic ${Buffer.from(`${OC_USERNAME}:${OC_PASSWORD}`).toString("base64")}`
  }

  const transport = target.protocol === "https:" ? https : http
  const upstreamReq = transport.request(
    target,
    { method: req.method, headers, timeout: 0 },
    (upstreamRes) => {
      const out = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (name.toLowerCase() === "transfer-encoding") continue
        if (value != null) out[name] = value
      }
      const type = String(upstreamRes.headers["content-type"] || "")
      const stream = type.includes("text/event-stream") || isEvent
      if (stream) {
        out["cache-control"] = "no-cache, no-transform"
        out["x-accel-buffering"] = "no"
        out["x-content-type-options"] = "nosniff"
        if (!out["content-type"]) out["content-type"] = "text/event-stream; charset=utf-8"
        delete out["content-length"]
      }
      res.writeHead(upstreamRes.statusCode || 502, out)
      if (stream && typeof res.flushHeaders === "function") res.flushHeaders()
      upstreamRes.pipe(res)
    },
  )

  const fail = (err) => {
    if (res.headersSent) {
      res.end()
      return
    }
    sendJson(res, 502, { error: "Can't reach the server", detail: err.message })
  }
  upstreamReq.on("error", fail)
  upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("upstream timeout")))
  res.on("close", () => upstreamReq.destroy())
  req.pipe(upstreamReq)
}

const server = http.createServer((req, res) => {
  if (!uiAuthorized(req)) {
    rejectUi(res)
    return
  }
  const url = new URL(req.url || "/", "http://127.0.0.1")
  if (req.method === "GET" && url.pathname === "/_home") {
    const directory = os.homedir()
    if (!directory || directory === path.parse(directory).root) {
      sendJson(res, 404, { error: "Home directory is not available" })
      return
    }
    sendJson(res, 200, { directory })
    return
  }
  if (req.method === "GET" && url.pathname === "/_db/sessions") {
    handleDbSessions(req, res)
    return
  }
  if (url.pathname === "/_library") {
    handleLibrary(req, res)
    return
  }
  if (req.method === "GET" || req.method === "HEAD") {
    const file = localFile(url.pathname)
    if (file) {
      serveLocal(req, res, file)
      return
    }
  }
  forward(req, res)
})

server.requestTimeout = 0
server.headersTimeout = 60_000
server.keepAliveTimeout = 0

server.on("error", (err) => {
  console.error(err.message)
  process.exit(1)
})

server.listen(PORT, HOST, async () => {
  const shown = HOST.includes(":") && !HOST.startsWith("[") ? `[${HOST}]` : HOST
  console.log(`Openview on http://${shown}:${PORT}`)
  console.log(`proxying to ${upstream.origin}`)
  const mod = await loadSqlite()
  if (!mod) {
    console.log("node:sqlite is unavailable; GET /_db/sessions will return 501")
    return
  }
  const file = resolveDbPath()
  if (!file) {
    console.log("opencode database not found; GET /_db/sessions will return 404")
    return
  }
  console.log("opencode database:", file)
  try {
    await inspectDatabase(file)
  } catch (err) {
    console.error("database inspect failed:", err.message)
  }
})
