// Server-sent events.
function onEvent(packet) {
  const event = packet?.event
  if (!event?.type) return
  const props = event.properties || {}
  const type = event.type
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
    if (id === state.activeId) {
      state.activeId = null
      state.messages = []
      showBanner("This session was deleted.")
      renderStream()
      renderHeader()
    }
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
    if (props.sessionID === state.activeId && props.error) showBanner(errorText(props.error), "session-error")
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
  if (sessionID && sessionID !== state.activeId) {
    if (type.startsWith("message.")) touchSession(sessionID)
    return
  }
  if (type === "message.updated" && props.info) {
    upsertMessageInfo(props.info)
    if (props.info.sessionID) touchSession(props.info.sessionID)
    return
  }
  if (type === "message.removed") {
    removeMessage(props.messageID)
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
    removePart(props.messageID, props.partID)
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
    try {
      await refreshSessions()
      if (state.activeId && !state.unavailable) await reloadMessages()
      await loadPermissions()
    } catch { /* the banner already explains an outage */ }
  }
}

async function reloadMessages() {
  const session = currentSession()
  if (!session) return
  const gen = state.loadGen
  try {
    const messages = await getJSON(`/session/${encodeURIComponent(session.id)}/message?limit=300`, session.directory)
    if (gen !== state.loadGen || state.activeId !== session.id) return
    if (Array.isArray(messages)) {
      state.messages = messages
      sortMessages()
      renderStream()
    }
  } catch (err) {
    if (gen !== state.loadGen) return
    if (err.status === 404) {
      state.unavailable = true
      showBanner("This session's project isn't available to the server.", "missing")
      renderStream()
      renderComposer()
    }
  }
}

