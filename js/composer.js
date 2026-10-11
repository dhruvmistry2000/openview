// Opening a session and sending a message.
function sessionFromHash() {
  const match = location.hash.match(/^#\/s\/([^/?#]+)$/)
  return match ? decodeURIComponent(match[1]) : null
}

function setHash(id) {
  const next = `#/s/${encodeURIComponent(id)}`
  if (location.hash === next) return
  state.ignoreHash = true
  location.hash = next
}

async function openSession(id) {
  if (!id) return
  if ($("main").classList.contains("home-view")) {
    $("input").value = ""
    growInput()
  }
  state.activeId = id
  state.unavailable = false
  state.stick = true
  clearChanges()
  state.loadGen += 1
  const gen = state.loadGen
  setHash(id)
  if (state.bannerKind === "missing" || state.bannerKind === "session-error") clearBanner()
  const pending = state.messages.filter((message) => String(message.info?.id || "").startsWith("pending:"))
  state.messages = []
  state.loadingMessages = true
  renderSidebar()
  renderHeader()
  renderStream()
  renderPrompts()
  const known = state.sessions.get(id)
  if (!known) {
    state.loadingMessages = false
    state.unavailable = true
    showBanner("This session's project isn't available to the server.", "missing")
    renderStream()
    renderComposer()
    return
  }
  try {
    let full = null
    try {
      full = await getJSON(`/session/${encodeURIComponent(id)}`, known.directory)
    } catch (err) {
      if (err.status !== 404) throw err
      try {
        full = await getJSON(`/session/${encodeURIComponent(id)}`)
      } catch {
        throw err
      }
    }
    if (gen !== state.loadGen) return
    if (full?.id) applySessionInfo(full)
    const directory = full?.directory || known.directory
    const messages = await getJSON(`/session/${encodeURIComponent(id)}/message?limit=300`, directory)
    if (gen !== state.loadGen) return
    state.messages = Array.isArray(messages) ? messages : []
    if (!state.messages.some((message) => message.info?.role === "user") && pending.length) {
      state.messages = pending.concat(state.messages)
    }
    sortMessages()
    state.loadingMessages = false
    state.unavailable = false
    renderHeader()
    renderStream()
    $("stream").scrollTop = $("stream").scrollHeight
    loadPickers(directory)
    loadChanges(directory, id)
  } catch (err) {
    if (gen !== state.loadGen) return
    state.loadingMessages = false
    if (err.status === 404) {
      state.unavailable = true
      showBanner("This session's project isn't available to the server.", "missing")
    } else if (!err.offline && err.status !== 401) {
      showBanner(err.message || "Couldn't open this session.")
    }
    renderStream()
    renderComposer()
  }
}

function splitModel(value) {
  const index = String(value || "").indexOf("\u001f")
  if (index === -1) return null
  const providerID = value.slice(0, index)
  const modelID = value.slice(index + 1)
  if (!providerID || !modelID) return null
  return { providerID, modelID }
}

function renderQueue() {
  const root = $("queue")
  root.replaceChildren()
  const mine = state.queue.filter((item) => item.sessionId === state.activeId)
  mine.forEach((item, index) => {
    const row = el("div", "queue-item")
    const label = item.skill ? `Queued ${item.skill}: ${item.text}` : `Queued: ${item.text}`
    row.append(el("span", null, label))
    const remove = el("button", "text-btn", "Remove")
    remove.type = "button"
    remove.addEventListener("click", () => {
      const at = state.queue.indexOf(item)
      if (at !== -1) state.queue.splice(at, 1)
      renderQueue()
    })
    row.append(remove)
    root.append(row)
    if (index === 0) row.title = "Sends when the session is idle"
  })
}

function renderComposer() {
  const session = currentSession()
  const onHome = !session && Boolean(state.home)
  const blocked = state.unavailable || state.starting || (!session && !onHome)
  $("input").disabled = blocked
  $("send").disabled = blocked
  const busy = session ? isBusy(session.id) : false
  $("input").placeholder = state.skill
    ? `What should ${state.skill} do?`
    : busy
      ? "Waits until this one finishes"
      : (onHome ? "How can I help you today?" : "Message")
  paintSend(onHome)
  $("send").classList.toggle("is-wait", state.starting)
  $("send").hidden = busy
  $("stop").hidden = !busy
  renderQueue()
}

async function refreshTranscript(session) {
  const messages = await getJSON(`/session/${encodeURIComponent(session.id)}/message?limit=300`, session.directory)
  if (session.id !== state.activeId) return
  state.messages = Array.isArray(messages) ? messages : []
  sortMessages()
  state.stick = true
  renderStream()
  loadChanges(session.directory, session.id, true)
}

async function revertTo(messageID) {
  const session = currentSession()
  if (!session || !messageID) return
  if (isBusy(session.id)) {
    showBanner("Wait until the session is idle.")
    return
  }
  if (!confirm("Undo this message and everything after it? Files written after this point go back to how they were.")) return
  try {
    const updated = await request("POST", `/session/${encodeURIComponent(session.id)}/revert`, session.directory, { messageID })
    if (updated?.id) applySessionInfo(updated)
    await refreshTranscript(session)
  } catch (err) {
    if (err.status === 409) showBanner("The session is still working.")
    else if (!err.offline) showBanner(err.message || "Couldn't undo that message.")
  }
}

async function restoreReverted() {
  const session = currentSession()
  if (!session?.revert?.messageID) return
  if (isBusy(session.id)) {
    showBanner("Wait until the session is idle.")
    return
  }
  try {
    const updated = await request("POST", `/session/${encodeURIComponent(session.id)}/unrevert`, session.directory)
    if (updated?.id) applySessionInfo(updated)
    await refreshTranscript(session)
  } catch (err) {
    if (err.status === 409) showBanner("The session is still working.")
    else if (!err.offline) showBanner(err.message || "Couldn't restore the session.")
  }
}

async function postPrompt(sessionId, text, directory, skill = state.skill) {
  const session = state.sessions.get(sessionId)
  const dir = session?.directory || directory || ""
  if (!dir) throw new Error("Couldn't find that session.")
  const model = splitModel(state.model)
  const body = skill
    ? { command: skill, arguments: text }
    : { parts: [{ type: "text", text }] }
  if (model) body.model = skill ? `${model.providerID}/${model.modelID}` : model
  if (state.agent) body.agent = state.agent
  if (sessionId === state.activeId) {
    const pending = {
      info: { id: `pending:${Date.now()}`, role: "user", time: { created: Date.now() } },
      parts: [{ id: `pending-part:${Date.now()}`, type: "text", text }],
    }
    state.messages.push(pending)
    state.stick = true
    markDirty(pending.info.id)
  }
  try {
    state.status.set(sessionId, { type: "busy" })
    renderComposer()
    const path = skill
      ? `/session/${encodeURIComponent(sessionId)}/command`
      : `/session/${encodeURIComponent(sessionId)}/prompt_async`
    await request("POST", path, dir, body)
  } catch (err) {
    if (sessionId === state.activeId) {
      for (const id of dropPending()) {
        $("stream").querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove()
      }
    }
    const queued = err.status === 400 && /busy/i.test(`${err.message} ${JSON.stringify(err.data || {})}`)
    if (!queued && state.status.get(sessionId)?.type === "busy") state.status.set(sessionId, { type: "idle" })
    if (queued) {
      state.queue.push({ sessionId, text })
      renderQueue()
      return
    }
    throw err
  }
}

let flushing = false
async function flushQueue(sessionId) {
  if (flushing || !sessionId || isBusy(sessionId)) return
  const item = state.queue.find((entry) => entry.sessionId === sessionId)
  if (!item) return
  flushing = true
  state.queue = state.queue.filter((entry) => entry !== item)
  renderQueue()
  try {
    await postPrompt(sessionId, item.text, undefined, item.skill || "")
  } catch (err) {
    state.queue.unshift(item)
    renderQueue()
    if (!err.offline) showBanner(err.message || "Couldn't send the queued message.")
  } finally {
    flushing = false
  }
}

async function reconcileBusy(sessionId) {
  const session = state.sessions.get(sessionId)
  const before = isBusy(sessionId)
  try {
    const list = await getJSON("/session/status", session?.directory)
    const status = list && typeof list === "object" && !Array.isArray(list) ? list[sessionId] : null
    state.status.set(sessionId, status || { type: "idle" })
  } catch {
    return isBusy(sessionId)
  }
  const after = isBusy(sessionId)
  if (before !== after) {
    scheduleSidebar()
    renderComposer()
  }
  return after
}

async function sendCurrent() {
  const text = $("input").value.trim()
  if (!text || state.unavailable || state.starting) return
  const session = currentSession()
  if (!session) {
    if (!state.home) return
    state.starting = true
    state.outgoing = text
    $("input").value = ""
    growInput()
    renderHeader()
    renderStream()
    try {
      const created = await request("POST", "/session", state.home, {})
      if (!created?.id) throw new Error("The server did not return a session.")
      if (!created.directory) created.directory = state.home
      applySessionInfo(created)
      state.activeId = created.id
      renderHeader()
      renderStream()
      await postPrompt(created.id, text, state.home, state.skill)
      await openSession(created.id)
    } catch (err) {
      $("input").value = text
      growInput()
      if (!err.offline) showBanner(err.message || "Couldn't send the message.")
    } finally {
      state.starting = false
      state.outgoing = ""
      renderHeader()
      renderStream()
      $("input").focus()
    }
    return
  }
  $("input").value = ""
  growInput()
  if (await reconcileBusy(session.id)) {
    state.queue.push({ sessionId: session.id, text, skill: state.skill || "" })
    renderQueue()
    return
  }
  try {
    await postPrompt(session.id, text)
  } catch (err) {
    $("input").value = text
    growInput()
    if (!err.offline) showBanner(err.message || "Couldn't send the message.")
  }
}

async function stopSession() {
  const session = currentSession()
  if (!session) return
  try {
    await request("POST", `/session/${encodeURIComponent(session.id)}/abort`, session.directory)
  } catch (err) {
    if (!err.offline) showBanner(err.message || "Couldn't stop the session.")
  }
}

function growInput() {
  const input = $("input")
  input.style.height = "auto"
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`
}

let folderPath = ""
let folderMode = true

function parentDir(dir) {
  const clean = cleanDir(dir)
  if (!clean || clean === "/") return ""
  const index = clean.lastIndexOf("/")
  if (index <= 0) return "/"
  return clean.slice(0, index)
}

function folderNote(text) {
  const note = $("folder-note")
  note.hidden = !text
  note.textContent = text || ""
}

function showFolderBrowser() {
  $("folder-browser").hidden = !folderMode
  $("known-project").hidden = folderMode
  $("mode-folder").setAttribute("aria-selected", folderMode ? "true" : "false")
  $("mode-known").setAttribute("aria-selected", folderMode ? "false" : "true")
  if (!folderMode) folderNote("")
}

async function loadFolder(directory) {
  const dir = cleanDir(directory) || "/"
  if (dir !== "/" && !dir.startsWith("/")) return
  folderPath = dir
  $("folder-path").textContent = dir
  $("folder-path").title = dir
  $("folder-up").disabled = !parentDir(dir)
  folderNote("")
  const list = $("folder-list")
  list.replaceChildren(el("div", "lib-row", "Loading folders…"))
  try {
    const listed = await getJSON(`/file?path=${encodeURIComponent(dir)}`, dir)
    if (folderPath !== dir) return
    const dirs = (Array.isArray(listed) ? listed : [])
      .filter((item) => item && item.type === "directory" && typeof item.absolute === "string" && item.absolute.startsWith("/") && !item.absolute.includes("\0") && item.absolute !== "/")
      .sort((a, b) => a.name.localeCompare(b.name))
    list.replaceChildren()
    if (!dirs.length) {
      list.append(el("div", "lib-row", "No folders in here. Create uses this folder."))
      return
    }
    for (const item of dirs) {
      const row = el("button", "folder-row", item.name)
      row.type = "button"
      row.title = item.absolute
      row.addEventListener("click", () => loadFolder(item.absolute))
      list.append(row)
    }
  } catch (err) {
    if (folderPath !== dir) return
    list.replaceChildren(el("div", "lib-row", err.message || "Could not open that folder."))
  }
}

function bindFolderBrowser() {
  $("mode-folder").addEventListener("click", () => {
    folderMode = true
    showFolderBrowser()
    if (!folderPath) loadFolder(state.home)
  })
  $("mode-known").addEventListener("click", () => {
    folderMode = false
    showFolderBrowser()
  })
  $("folder-up").addEventListener("click", () => {
    const parent = parentDir(folderPath)
    if (parent) loadFolder(parent)
  })
  $("project-form").addEventListener("submit", (event) => {
    if (event.submitter?.value !== "ok") return
    if (folderMode) {
      if (folderPath && folderPath !== "/") return
      event.preventDefault()
      folderNote(folderPath === "/" ? "Choose a folder inside this one." : "Open a folder first.")
      return
    }
    if ($("new-project").value) return
    event.preventDefault()
    folderNote("Choose a project.")
  })
}

function chooseProject() {
  const projects = projectOptions()
  const dialog = $("project-dialog")
  const select = $("new-project")
  select.replaceChildren()
  for (const project of projects) {
    const node = option(project.worktree, project.label)
    node.title = project.worktree
    select.append(node)
  }
  const current = selectedProject()?.worktree || ""
  select.value = [...select.options].some((item) => item.value === current) ? current : (projects[0]?.worktree || "")
  folderMode = true
  folderPath = ""
  showFolderBrowser()
  loadFolder(state.home)
  dialog.returnValue = ""
  dialog.showModal()
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "ok") {
        resolve(null)
        return
      }
      resolve(folderMode ? folderPath : select.value)
    }, { once: true })
  })
}

async function createSession(directory) {
  if (typeof directory !== "string") directory = ""
  if (!directory) {
    directory = await chooseProject()
    if (!directory) return null
  }
  if (!directory || directory === "/") {
    showBanner("Choose a project before starting a session.")
    return null
  }
  try {
    const created = await request("POST", "/session", directory, {})
    if (!created?.id) throw new Error("The server did not return a session.")
    if (!created.directory) created.directory = directory
    applySessionInfo(created)
    await openSession(created.id)
    refreshSessions()
    $("input").focus()
    return created
  } catch (err) {
    if (!err.offline) showBanner(err.message || "Couldn't create a session.")
    return null
  }
}

function showHome() {
  $("input").value = ""
  growInput()
  state.activeId = null
  state.unavailable = false
  state.messages = []
  state.loadingMessages = false
  state.loadGen += 1
  clearChanges()
  if (location.hash && location.hash !== "#/") {
    state.ignoreHash = true
    location.hash = "#/"
  }
  if (state.bannerKind === "missing" || state.bannerKind === "session-error") clearBanner()
  renderSidebar()
  renderHeader()
  renderStream()
  renderPrompts()
  loadPickers(state.home)
  if (state.home) $("input").focus()
}

async function loadHome() {
  try {
    const res = await fetch("/_home", { credentials: "same-origin" })
    if (!res.ok) return
    const data = await res.json()
    const directory = cleanDir(data?.directory)
    if (directory && directory !== "/") state.home = directory
  } catch { /* the proxy route is missing */ }
}

function startRename() {
  const session = currentSession()
  if (!session) return
  const title = $("title")
  const input = el("input", "rename-input")
  input.value = session.title || ""
  input.setAttribute("aria-label", "Session title")
  title.replaceChildren(input)
  input.focus()
  input.select()
  let done = false
  const finish = async (save) => {
    if (done) return
    done = true
    if (save) {
      const next = input.value.trim()
      if (next && next !== session.title) {
        try {
          const updated = await request("PATCH", `/session/${encodeURIComponent(session.id)}`, session.directory, { title: next })
          if (updated?.id) applySessionInfo(updated)
          else {
            session.title = next
            scheduleSidebar()
          }
        } catch (err) {
          if (!err.offline) showBanner(err.message || "Couldn't rename the session.")
        }
      }
    }
    input.remove()
    renderHeader()
  }
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault()
      finish(true)
    } else if (event.key === "Escape") {
      event.preventDefault()
      finish(false)
    }
  })
  input.addEventListener("blur", () => finish(true))
}

async function deleteSession() {
  const session = currentSession()
  if (!session) return
  const name = session.title || "this session"
  if (!confirm(`Delete “${name}”?`)) return
  try {
    await request("DELETE", `/session/${encodeURIComponent(session.id)}`, session.directory)
  } catch (err) {
    if (err.status !== 404) {
      if (!err.offline) showBanner(err.message || "Couldn't delete the session.")
      return
    }
  }
  state.sessions.delete(session.id)
  state.status.delete(session.id)
  state.permissions = state.permissions.filter((item) => item.sessionID !== session.id)
  state.activeId = null
  state.messages = []
  state.ignoreHash = true
  history.replaceState(null, "", location.pathname + location.search)
  clearBanner()
  renderSidebar()
  renderHeader()
  renderStream()
  renderPrompts()
}

