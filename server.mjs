/**
 * Zero-dependency proxy for Openview.
 *
 * Serves index.html at "/" and forwards every other request to the OpenCode
 * HTTP server. GET /_db/sessions reads the local SQLite database read-only.
 * POST /_library writes one agent or skill markdown file.
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

const OPENCODE_URL = process.env.OPENCODE_URL || "http://127.0.0.1:4096"
const HOST = process.env.HOST || "127.0.0.1"
const PORT = Number(process.env.PORT || 8080)
const UI_USERNAME = process.env.UI_USERNAME ?? ""
const UI_PASSWORD = process.env.UI_PASSWORD ?? ""
const OC_USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode"
const OC_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || ""

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.html")
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

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
  })
  res.end(payload)
}

const LIBRARY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LIBRARY_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:@+-]*$/

function libraryError(status, message, extra) {
  const err = new Error(message)
  err.status = status
  if (extra) Object.assign(err, extra)
  return err
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(libraryError(413, "That file is too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function yamlQuote(value) {
  return JSON.stringify(String(value))
}

function configRoot() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.resolve(base, "opencode")
}

function inDocker() {
  return fs.existsSync("/.dockerenv")
}

function cleanText(value, label, max) {
  if (typeof value !== "string") throw libraryError(400, `${label} is required`)
  const text = value.replace(/\r\n/g, "\n").trim()
  if (!text) throw libraryError(400, `${label} is required`)
  if (text.includes("\0")) throw libraryError(400, `${label} contains a null character`)
  if (text.length > max) throw libraryError(400, `${label} is too long`)
  return text
}

function libraryName(value) {
  const name = cleanText(value, "Name", 64)
  if (!LIBRARY_NAME.test(name)) {
    throw libraryError(400, "Name must be lowercase letters, numbers, and single hyphens")
  }
  return name
}

function libraryMarkdown(input) {
  const kind = input.kind === "skill" ? "skill" : input.kind === "agent" ? "agent" : ""
  if (!kind) throw libraryError(400, "Choose an agent or a skill")
  const name = libraryName(input.name)
  const description = cleanText(input.description, "Description", 1024)
  const body = cleanText(input.body, "Instructions", 100_000)
  const lines = ["---"]
  if (kind === "skill") lines.push(`name: ${yamlQuote(name)}`)
  lines.push(`description: ${yamlQuote(description)}`)
  if (kind === "agent") {
    const mode = input.mode === "subagent" ? "subagent" : input.mode === "primary" ? "primary" : ""
    if (!mode) throw libraryError(400, "Choose primary or subagent")
    lines.push(`mode: ${mode}`)
    if (input.model != null && String(input.model).trim()) {
      const model = String(input.model).trim()
      if (!LIBRARY_MODEL.test(model) || model.length > 200) throw libraryError(400, "Model must look like provider/model")
      lines.push(`model: ${model}`)
    }
  }
  lines.push("---", "", body, "")
  return { kind, name, content: lines.join("\n") }
}

function projectRoot(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw libraryError(400, "Choose a project")
  }
  let real
  try {
    real = fs.realpathSync(directory)
  } catch {
    throw libraryError(400, "That project directory is not visible to this proxy")
  }
  if (!fs.statSync(real).isDirectory()) throw libraryError(400, "Choose a project directory")
  if (real === path.parse(real).root || real === os.homedir()) {
    throw libraryError(400, "Refusing to write into that directory")
  }
  return real
}

function staysInside(root, target) {
  const rel = path.relative(root, target)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function libraryTarget(kind, scope, directory, name) {
  if (scope !== "project" && scope !== "global") throw libraryError(400, "Choose where to save it")
  if (scope === "global" && inDocker()) {
    const rel = kind === "agent" ? path.join("agents", `${name}.md`) : path.join("skills", name, "SKILL.md")
    return {
      skip: true,
      path: path.join("~/.config/opencode", rel),
      reason: "This proxy is running in Docker, so it cannot write your config directory. Copy the file to that path on the host.",
    }
  }
  const root = scope === "global" ? configRoot() : projectRoot(directory)
  const rel = kind === "agent"
    ? path.join(scope === "global" ? "agents" : path.join(".opencode", "agents"), `${name}.md`)
    : path.join(scope === "global" ? "skills" : path.join(".opencode", "skills"), name, "SKILL.md")
  const target = path.resolve(root, rel)
  if (!staysInside(root, target)) throw libraryError(400, "Refusing to write outside the chosen directory")
  return { root, target }
}

function writeLibrary(input) {
  const { kind, name, content } = libraryMarkdown(input)
  const scope = input.scope
  const dest = libraryTarget(kind, scope, input.directory, name)
  if (dest.skip) return { written: false, path: dest.path, content, reason: dest.reason }
  fs.mkdirSync(path.dirname(dest.target), { recursive: true })
  const realRoot = fs.realpathSync(dest.root)
  const realParent = fs.realpathSync(path.dirname(dest.target))
  if (!staysInside(realRoot, realParent) && realParent !== realRoot) {
    throw libraryError(400, "Refusing to follow a link outside the chosen directory")
  }
  if (fs.existsSync(dest.target)) {
    const realFile = fs.realpathSync(dest.target)
    if (!staysInside(realRoot, realFile)) {
      throw libraryError(400, "Refusing to follow a link outside the chosen directory")
    }
    if (input.overwrite !== true) {
      throw libraryError(409, "A file with that name already exists", { path: dest.target, content })
    }
  }
  const flag = input.overwrite === true ? "w" : "wx"
  try {
    fs.writeFileSync(dest.target, content, { encoding: "utf8", flag, mode: 0o644 })
  } catch (err) {
    if (err.code === "EEXIST") {
      throw libraryError(409, "A file with that name already exists", { path: dest.target, content })
    }
    throw libraryError(500, "Could not write the file")
  }
  return { written: true, path: dest.target, content }
}

async function handleLibrary(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST" })
    return
  }
  let payload
  try {
    payload = JSON.parse(await readBody(req))
  } catch (err) {
    const status = err.status || 400
    if (!res.headersSent) sendJson(res, status, { error: status === 413 ? err.message : "Expected JSON" })
    return
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    sendJson(res, 400, { error: "Expected JSON" })
    return
  }
  try {
    const result = writeLibrary(payload)
    sendJson(res, result.written ? 201 : 200, result)
  } catch (err) {
    const status = err.status || 500
    if (status >= 500) console.error("library:", err.message)
    if (!res.headersSent) {
      sendJson(res, status, { error: err.message || "Could not write the file", path: err.path, content: err.content })
    }
  }
}

function candidateDirs() {
  const dirs = []
  const add = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir)
  }
  if (process.env.XDG_DATA_HOME) add(path.join(process.env.XDG_DATA_HOME, "opencode"))
  add(path.join(os.homedir(), ".local", "share", "opencode"))
  if (process.platform === "darwin") {
    add(path.join(os.homedir(), "Library", "Application Support", "opencode"))
  }
  return dirs
}

function newestOpencodeDb(dir) {
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  let best = null
  let bestTime = -1
  for (const name of entries) {
    if (!/^opencode.*\.db$/.test(name)) continue
    const full = path.join(dir, name)
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    if (stat.mtimeMs > bestTime) {
      bestTime = stat.mtimeMs
      best = full
    }
  }
  return best
}

function resolveDbPath() {
  if (process.env.OPENCODE_DB) {
    try {
      return fs.statSync(process.env.OPENCODE_DB).isFile() ? process.env.OPENCODE_DB : null
    } catch {
      return null
    }
  }
  for (const dir of candidateDirs()) {
    const exact = path.join(dir, "opencode.db")
    try {
      if (fs.statSync(exact).isFile()) return exact
    } catch {
      /* try the directory's other opencode*.db files */
    }
    const fallback = newestOpencodeDb(dir)
    if (fallback) return fallback
  }
  return null
}

let sqliteModule
async function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule
  try {
    sqliteModule = await import("node:sqlite")
  } catch {
    sqliteModule = null
  }
  return sqliteModule
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

function firstColumn(cols, candidates) {
  for (const name of candidates) {
    if (cols.has(name) && IDENT.test(name)) return name
  }
  return null
}

function selectExpr(cols, candidates, alias) {
  const name = firstColumn(cols, candidates)
  return name ? `${name} AS ${alias}` : `NULL AS ${alias}`
}

function pragmaNames(db, table) {
  if (!IDENT.test(table)) return new Set()
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all()
    return new Set(rows.map((row) => row.name).filter((name) => typeof name === "string"))
  } catch {
    return new Set()
  }
}

function inspectDatabase(file) {
  return loadSqlite().then((mod) => {
    if (!mod) return
    const db = new mod.DatabaseSync(file, { readOnly: true })
    try {
      db.exec("PRAGMA query_only = ON")
      const session = [...pragmaNames(db, "session")]
      const project = [...pragmaNames(db, "project")]
      console.log("session columns:", session.join(", ") || "(none)")
      console.log("project columns:", project.join(", ") || "(none)")
    } finally {
      db.close()
    }
  })
}

function likePattern(query) {
  return `%${String(query).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
}

function querySessions(db, { archived, q, limit }) {
  const sessionCols = pragmaNames(db, "session")
  const projectCols = pragmaNames(db, "project")
  if (!sessionCols.has("id")) {
    const err = new Error("session table not found")
    err.status = 404
    throw err
  }

  const parentCol = firstColumn(sessionCols, ["parent_id", "parentID", "parent"])
  const archivedCol = firstColumn(sessionCols, ["time_archived", "archived", "archived_at"])
  const titleCol = firstColumn(sessionCols, ["title"])
  const updatedCol = firstColumn(sessionCols, ["time_updated", "updated", "updated_at"])
  const projectIdCol = firstColumn(sessionCols, ["project_id", "projectID"])
  const directoryCol = firstColumn(sessionCols, ["directory"])

  let directorySql = selectExpr(sessionCols, ["directory"], "directory")
  let join = ""
  if (!directoryCol && projectIdCol && projectCols.has("id") && projectCols.has("worktree")) {
    directorySql = "project.worktree AS directory"
    join = ` LEFT JOIN project ON project.id = session.${projectIdCol}`
  }

  const sql = [
    "SELECT",
    [
      selectExpr(sessionCols, ["id"], "id"),
      selectExpr(sessionCols, ["title"], "title"),
      directorySql,
      selectExpr(sessionCols, ["project_id", "projectID"], "projectId"),
      selectExpr(sessionCols, ["parent_id", "parentID", "parent"], "parentId"),
      selectExpr(sessionCols, ["time_created", "created", "created_at"], "created"),
      selectExpr(sessionCols, ["time_updated", "updated", "updated_at"], "updated"),
      selectExpr(sessionCols, ["time_archived", "archived", "archived_at"], "archived"),
    ].join(", "),
    "FROM session",
    join,
  ]

  const where = []
  const params = []
  if (parentCol) where.push(`(session.${parentCol} IS NULL OR session.${parentCol} = '')`)
  if (archivedCol && !archived) {
    where.push(`(session.${archivedCol} IS NULL OR session.${archivedCol} = 0)`)
  }
  if (q && titleCol) {
    where.push(`session.${titleCol} LIKE ? ESCAPE '\\'`)
    params.push(likePattern(q))
  }
  if (where.length) sql.push("WHERE", where.join(" AND "))
  if (updatedCol) sql.push(`ORDER BY session.${updatedCol} DESC`)
  sql.push("LIMIT ?")
  params.push(limit)

  return db.prepare(sql.join(" ")).all(...params).map((row) => {
    const item = {
      id: row.id,
      title: row.title || "",
      directory: row.directory || "",
      projectId: row.projectId || null,
      parentId: row.parentId || null,
      time: {
        created: Number(row.created) || 0,
        updated: Number(row.updated) || 0,
      },
    }
    if (row.archived != null && row.archived !== 0 && row.archived !== "") item.archived = Number(row.archived)
    return item
  })
}

async function handleDbSessions(req, res) {
  const mod = await loadSqlite()
  if (!mod) {
    sendJson(res, 501, { error: "node:sqlite is unavailable" })
    return
  }
  const file = resolveDbPath()
  if (!file) {
    sendJson(res, 404, { error: "opencode database not found" })
    return
  }
  const url = new URL(req.url, "http://127.0.0.1")
  const archived = url.searchParams.get("archived") === "1"
  const q = url.searchParams.get("q") || ""
  let limit = Number(url.searchParams.get("limit"))
  if (!Number.isFinite(limit) || limit <= 0) limit = 5000
  limit = Math.min(Math.floor(limit), 10000)

  let db
  try {
    db = new mod.DatabaseSync(file, { readOnly: true })
    db.exec("PRAGMA query_only = ON")
    const rows = querySessions(db, { archived, q, limit })
    sendJson(res, 200, rows)
  } catch (err) {
    const status = err.status || 500
    console.error("db sessions:", err.message)
    if (!res.headersSent) sendJson(res, status, { error: err.message || "database read failed" })
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}

function serveIndex(res) {
  let html
  try {
    html = fs.readFileSync(INDEX)
  } catch {
    sendJson(res, 500, { error: "index.html is missing" })
    return
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": html.length,
    "cache-control": "no-cache",
  })
  res.end(html)
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
  if (req.method === "GET" && url.pathname === "/_db/sessions") {
    handleDbSessions(req, res)
    return
  }
  if (url.pathname === "/_library") {
    handleLibrary(req, res)
    return
  }
  if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/" || url.pathname === "/index.html")) {
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" })
      res.end()
      return
    }
    serveIndex(res)
    return
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
