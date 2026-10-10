// Read-only session listing for GET /_db/sessions.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { sendJson } from "./respond.mjs"

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

export function resolveDbPath() {
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
export async function loadSqlite() {
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

export function inspectDatabase(file) {
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

export async function handleDbSessions(req, res) {
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
