// Server-sent change feed for GET /_db/events.
//
// Watches OpenCode's SQLite file (and its WAL/journal sidecars) with fs.watch
// and a slow stat poll as a fallback, then pushes a small `change` event to
// every connected browser. This gives the page a liveness signal that does not
// depend on OpenCode's own event stream, so a stalled stream can still recover
// by reloading the list from the database the moment it changes.
import fs from "node:fs"
import path from "node:path"
import { resolveDbPath } from "./db.mjs"

const clients = new Set()
const SIDECARS = ["", "-wal", "-journal"]
const POLL_MS = 2000
const DEBOUNCE_MS = 250
const HEARTBEAT_MS = 15000

let watcher = null
let watchDir = null
let watchBase = null
let pollTimer = null
let debounceTimer = null
let currentFile = null
let currentSig = ""

function readSig(file) {
  let sig = ""
  for (const suffix of SIDECARS) {
    try {
      const stat = fs.statSync(file + suffix)
      sig += `${stat.size}:${Math.round(stat.mtimeMs)};`
    } catch {
      sig += "-;"
    }
  }
  return sig
}

function broadcast() {
  if (!clients.size) return
  const frame = `data: ${JSON.stringify({ type: "change", at: Date.now() })}\n\n`
  for (const client of clients) {
    try {
      client.res.write(frame)
    } catch {
      /* the client is going away */
    }
  }
}

function armWatcher(file) {
  const dir = path.dirname(file)
  const base = path.basename(file)
  if (watcher && watchDir === dir && watchBase === base) return
  if (watcher) {
    try { watcher.close() } catch { /* already closed */ }
    watcher = null
  }
  watchDir = dir
  watchBase = base
  try {
    watcher = fs.watch(dir, (_event, name) => {
      if (name && name !== base && !name.startsWith(`${base}-`)) return
      schedule()
    })
    watcher.on("error", () => {
      try { watcher.close() } catch { /* already closed */ }
      watcher = null
    })
  } catch {
    watcher = null
  }
}

function settle() {
  const file = resolveDbPath()
  if (!file) return
  if (file !== currentFile) {
    currentFile = file
    currentSig = readSig(file)
    armWatcher(file)
    return
  }
  const sig = readSig(file)
  if (sig !== currentSig) {
    currentSig = sig
    broadcast()
  }
}

function schedule() {
  if (debounceTimer) return
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    settle()
  }, DEBOUNCE_MS)
}

function start() {
  settle()
  if (!pollTimer) pollTimer = setInterval(settle, POLL_MS)
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (watcher) {
    try { watcher.close() } catch { /* already closed */ }
    watcher = null
  }
  watchDir = null
  watchBase = null
  currentFile = null
  currentSig = ""
}

export function handleDbEvents(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  })
  if (typeof res.flushHeaders === "function") res.flushHeaders()

  const client = { res }
  client.heartbeat = setInterval(() => {
    try {
      res.write(": hb\n\n")
    } catch {
      /* the client is going away */
    }
  }, HEARTBEAT_MS)
  clients.add(client)
  start()

  try {
    res.write(`data: ${JSON.stringify({ type: "connected", at: Date.now() })}\n\n`)
  } catch {
    /* the client is going away */
  }

  let closed = false
  const done = () => {
    if (closed) return
    closed = true
    clearInterval(client.heartbeat)
    clients.delete(client)
    if (!clients.size) stop()
  }
  req.on("close", done)
  req.on("error", done)
  res.on("close", done)
  res.on("error", done)
}
