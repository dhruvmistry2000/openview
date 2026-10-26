// Server-sent events.
let lastEventAt = Date.now()
let lastDataAt = Date.now()
function onEvent(packet) {
  const event = packet?.event
  if (!event?.type) return
  const type = event.type
  lastEventAt = Date.now()
  if (type !== "server.heartbeat" && type !== "server.connected") lastDataAt = Date.now()
  const props = event.properties || {}
  if (type === "server.connected") {
    state.conn = "live"
    renderFooter()
    return
  }
  if (type === "session.created" || type === "session.updated") {
    if (props.info && !props.info.directory && packet.directory) props.info = { ...props.info, directory: packet.directory }
    applySessionInfo(props.info)
    return
  }
  if (type === "session.deleted") {
    const id = props.sessionID || props.info?.id
    if (!id) return
    state.sessions.delete(id)
    state.status.delete(id)
    const index = state.tabs.indexOf(id)
    const wasActive = id === state.activeId
    if (index !== -1) {
      state.tabs.splice(index, 1)
      state.views.delete(id)
      saveTabs()
    }
    if (wasActive) {
      state.activeId = null
      state.messages = []
      state.loadingMessages = false
      state.unavailable = false
      const next = index === -1 ? null : (state.tabs[index] || state.tabs[index - 1] || null)
      if (next) openSession(next)
      else {
        showBanner("This session was deleted.")
        restoreDraft(state.homeDraft)
        renderStream()
        renderHeader()
      }
    } else renderTabs()
    scheduleSidebar()
    return
  }
  if (type === "session.status") {
    if (props.sessionID) state.status.set(props.sessionID, props.status || { type: "idle" })
    scheduleSidebar()
    renderComposer()
    if (props.status?.type === "idle") {
      flushQueue(props.sessionID)
      if (props.sessionID === state.activeId) {
        const session = currentSession()
        if (session?.directory) loadChanges(session.directory, session.id, true)
      }
    }
    return
  }
  if (type === "session.idle") {
    if (props.sessionID) state.status.set(props.sessionID, { type: "idle" })
    scheduleSidebar()
    renderComposer()
    flushQueue(props.sessionID)
    if (props.sessionID === state.activeId) {
      const session = currentSession()
      if (session?.directory) loadChanges(session.directory, session.id, true)
    }
    return
  }
  if (type === "session.error") {
    if (props.sessionID && props.error) {
      const text = errorText(props.error)
      if (isLimitError(null, null, props.error) || isLimitError(null, null, text)) {
        showLimitDialog(text)
        if (props.sessionID === state.activeId) showBanner(text, "session-error")
        else if (state.tabs.includes(props.sessionID)) {
          const view = ensureView(props.sessionID)
          view.banner = text.length > 500 ? `${text.slice(0, 500)}…` : text
          view.bannerKind = "session-error"
          view.unseen = true
          renderTabs()
        }
        return
      }
      if (props.sessionID === state.activeId) showBanner(text, "session-error")
      else if (state.tabs.includes(props.sessionID)) {
        const view = ensureView(props.sessionID)
        view.banner = text.length > 500 ? `${text.slice(0, 500)}…` : text
        view.bannerKind = "session-error"
        view.unseen = true
        renderTabs()
      }
    }
    return
  }
  if (type === "permission.asked" || type === "permission.updated" || type === "permission.v2.asked") {
    upsertPermission(props)
    return
  }
  if (type === "permission.replied" || type === "permission.v2.replied") {
    removePermission(props.requestID || props.id)
    return
  }
  if (type === "question.asked" || type === "question.v2.asked") {
    if (props.id) {
      state.questions = state.questions.filter((item) => item.id !== props.id)
      state.questions.push(props)
      renderPrompts()
    }
    return
  }
  if (type === "question.replied" || type === "question.rejected" || type === "question.v2.replied" || type === "question.v2.rejected") {
    const id = props.requestID || props.id
    state.questions = state.questions.filter((item) => item.id !== id)
    renderPrompts()
    return
  }
  const sessionID = props.sessionID || props.info?.sessionID || props.part?.sessionID
  if (sessionID && sessionID !== state.activeId && !state.tabs.includes(sessionID)) {
    if (type.startsWith("message.")) touchSession(sessionID)
    return
  }
  if (type === "message.updated" && props.info) {
    upsertMessageInfo(props.info)
    if (props.info.sessionID) touchSession(props.info.sessionID)
    return
  }
  if (type === "message.removed") {
    removeMessage(props.messageID, props.sessionID)
    return
  }
  if (type === "message.part.updated" && props.part) {
    upsertPart(props.part)
    return
  }
  if (type === "message.part.delta") {
    applyDelta(props)
    return
  }
  if (type === "message.part.removed") {
    removePart(props.messageID, props.partID, props.sessionID)
  }
}

function nearBottom() {
  const root = $("stream")
  return root.scrollHeight - root.scrollTop - root.clientHeight < 96
}

async function sleep(ms, signal) {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

async function pumpSse(body, onData, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      let split
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const data = raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n")
        if (!data || data === "[DONE]") continue
        try { onData(JSON.parse(data)) } catch { /* keep the stream alive */ }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

function unwrapEvent(data) {
  if (data && data.payload && data.payload.type) return { event: data.payload, directory: data.directory || null }
  return { event: data, directory: null }
}

let eventAbort = null
function stopEvents() {
  eventAbort?.abort()
  eventAbort = new AbortController()
  return eventAbort.signal
}

async function openEvent(path, directory, signal) {
  const res = await apiFetch(withDir(path, directory), {
    headers: { accept: "text/event-stream" },
    signal,
  })
  return res
}

async function projectStreams(parent) {
  const dirs = new Set()
  for (const project of state.projects) if (project.worktree && project.worktree !== "/") dirs.add(project.worktree)
  if (state.home) dirs.add(state.home)
  const active = currentSession()
  if (active?.directory && active.directory !== "/") dirs.add(active.directory)
  if (!dirs.size) throw new Error("no project event streams")
  const child = new AbortController()
  const onParentAbort = () => child.abort()
  parent.addEventListener("abort", onParentAbort)
  let opened = 0
  try {
    await Promise.all([...dirs].map(async (dir) => {
      const res = await openEvent("/event", dir, child.signal)
      if (parent.aborted || child.signal.aborted) return
      if (res.status === 404 || res.status === 405) return
      if (!res.ok || !res.body) throw Object.assign(new Error("event " + res.status), { status: res.status })
      opened += 1
      state.conn = "live"
      renderFooter()
      try {
        await pumpSse(res.body, (data) => onEvent(unwrapEvent(data)), child.signal)
      } catch (err) {
        if (err.name !== "AbortError") throw err
      }
      if (!parent.aborted) child.abort()
    }))
  } catch (err) {
    if (parent.aborted || err.name === "AbortError") return
    throw err
  } finally {
    child.abort()
    parent.removeEventListener("abort", onParentAbort)
  }
  if (parent.aborted) return
  if (!opened) throw new Error("no project event streams")
}

async function connectEvents() {
  const signal = stopEvents()
  let mode = "global"
  while (!signal.aborted) {
    try {
      if (mode === "global") {
        const res = await openEvent("/global/event", undefined, signal)
        if (res.status === 404 || res.status === 405) {
          mode = "projects"
          continue
        }
        if (!res.ok || !res.body) throw Object.assign(new Error("event " + res.status), { status: res.status })
        state.conn = "live"
        renderFooter()
        await pumpSse(res.body, (data) => onEvent(unwrapEvent(data)), signal)
      } else {
        await projectStreams(signal)
      }
      if (signal.aborted) return
    } catch (err) {
      if (signal.aborted || err.name === "AbortError") return
      if (err.status === 401) {
        state.conn = "offline"
        renderFooter()
        return
      }
      state.conn = state.offline ? "offline" : "reconnecting"
      renderFooter()
    }
    if (signal.aborted) return
    state.conn = "reconnecting"
    renderFooter()
    await sleep(2000, signal)
    if (signal.aborted) return
    await resync()
  }
}

async function resync(opts = {}) {
  try {
    await refreshSessions()
    if (opts.messages !== false && state.activeId && !state.unavailable) await reloadMessages()
    markTabsStale()
    await loadPermissions()
    if (state.activeId) flushQueue(state.activeId)
  } catch { /* the banner already explains an outage */ }
}

// The proxy watches the SQLite file and streams a `change` event when it moves.
// That signal does not depend on OpenCode's event stream, so when the stream is
// dead or silent we use it to reload the list and release a stuck queue.
const DB_RECONCILE_MS = 2000
const DB_STALE_MS = 20000
let dbFeedAbort = null
let dbFeedDirty = false
let dbFeedAt = 0
let dbReconcileTimer = null

function onDbFeed(msg) {
  if (!msg || msg.type !== "change") return
  state.dbFeed = "live"
  if (state.conn === "live" && Date.now() - lastDataAt < DB_STALE_MS) return
  dbFeedDirty = true
  if (dbReconcileTimer) return
  const wait = Math.max(0, DB_RECONCILE_MS - (Date.now() - dbFeedAt))
  dbReconcileTimer = setTimeout(reconcileFromDb, wait)
}

async function reconcileFromDb() {
  dbReconcileTimer = null
  if (!dbFeedDirty) return
  dbFeedDirty = false
  dbFeedAt = Date.now()
  await resync({ messages: false })
  if (dbFeedDirty && !dbReconcileTimer) dbReconcileTimer = setTimeout(reconcileFromDb, DB_RECONCILE_MS)
}

async function connectDbEvents() {
  dbFeedAbort?.abort()
  const ctrl = new AbortController()
  dbFeedAbort = ctrl
  while (!ctrl.signal.aborted) {
    try {
      const res = await apiFetch("/_db/events", {
        headers: { accept: "text/event-stream" },
        signal: ctrl.signal,
      })
      if (res.status === 404 || res.status === 501) {
        state.dbFeed = "off"
        return
      }
      if (!res.ok || !res.body) throw Object.assign(new Error("db feed " + res.status), { status: res.status })
      state.dbFeed = "live"
      await pumpSse(res.body, onDbFeed, ctrl.signal)
    } catch (err) {
      if (ctrl.signal.aborted || err.name === "AbortError") return
      state.dbFeed = state.offline ? "off" : "reconnecting"
    }
    if (ctrl.signal.aborted) return
    await sleep(3000, ctrl.signal)
    if (ctrl.signal.aborted) return
    await resync({ messages: false })
  }
}

async function reloadMessages() {
  const session = currentSession()
  if (!session) return
  const view = ensureView(session.id)
  const gen = view.gen
  try {
    const messages = await getJSON(`/session/${encodeURIComponent(session.id)}/message?limit=300`, session.directory)
    if (!loadCurrent(session.id, gen) || state.activeId !== session.id) return
    if (Array.isArray(messages)) {
      sortList(messages)
      const where = commitLoaded(session.id, gen, messages)
      if (where === "active") renderStream()
    }
  } catch (err) {
    if (!loadCurrent(session.id, gen)) return
    if (err.status === 404) {
      state.unavailable = true
      showBanner("This session's project isn't available to the server.", "missing")
      renderStream()
      renderComposer()
    }
  }
}

