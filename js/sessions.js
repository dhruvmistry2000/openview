// Session list, project filter, and the header.
function loadLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem("oc-ui-settings") || "{}")
    state.settings = {
      url: typeof raw.url === "string" ? raw.url : "",
      username: typeof raw.username === "string" ? raw.username : "",
      password: typeof raw.password === "string" ? raw.password : "",
    }
  } catch {
    state.settings = { url: "", username: "", password: "" }
  }
  if (localStorage.getItem("oc-ui-picker") !== "1") {
    localStorage.setItem("oc-ui-agent", "build")
    localStorage.setItem("oc-ui-model", "opencode\u001fbig-pickle")
    localStorage.setItem("oc-ui-picker", "1")
  }
  state.agent = localStorage.getItem("oc-ui-agent") || "build"
  state.model = localStorage.getItem("oc-ui-model") || "opencode\u001fbig-pickle"
  try {
    const folded = JSON.parse(localStorage.getItem("oc-ui-folded") || "[]")
    state.folded = new Set(Array.isArray(folded) ? folded.filter((item) => typeof item === "string") : [])
  } catch {
    state.folded = new Set()
  }
  if (localStorage.getItem("oc-ui-sidebar") === "closed") $("app").classList.add("sidebar-collapsed")
  if (localStorage.getItem("oc-ui-changes") === "closed") $("app").classList.add("changes-collapsed")
}

function projectLabel(dir) {
  const parts = String(dir || "").replace(/\/+$/, "").split("/").filter(Boolean)
  if (!parts.length) return "Unknown project"
  return parts.slice(-2).join("/")
}

function cleanDir(value) {
  return String(value || "").replace(/\/+$/, "")
}

function isHomeDir(directory) {
  const home = cleanDir(state.home)
  const dir = cleanDir(directory)
  return Boolean(home && dir === home)
}

function projectOptions() {
  const map = new Map()
  for (const project of state.projects) {
    if (!project.worktree || project.worktree === "/" || isHomeDir(project.worktree)) continue
    map.set(project.id, {
      id: project.id,
      worktree: project.worktree,
      label: projectLabel(project.worktree),
    })
  }
  for (const session of state.sessions.values()) {
    if (!session.directory || session.directory === "/" || isHomeDir(session.directory)) continue
    const known = [...map.values()].some((project) => project.id === session.projectID || project.worktree === session.directory)
    if (known) continue
    const id = session.projectID || session.directory
    if (!map.has(id)) map.set(id, { id, worktree: session.directory, label: projectLabel(session.directory) })
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label))
}

function selectedProject() {
  if (state.projectFilter === "all") return null
  return projectOptions().find((project) => project.id === state.projectFilter) || null
}

function currentSession() {
  return state.activeId ? state.sessions.get(state.activeId) || null : null
}

function normalizeApi(session) {
  return {
    id: session.id,
    title: session.title || "Untitled",
    directory: session.directory || "",
    projectID: session.projectID,
    parentID: session.parentID || undefined,
    time: session.time || { created: 0, updated: 0 },
    revert: session.revert?.messageID ? { messageID: session.revert.messageID } : null,
    fromApi: true,
  }
}

function mergeDb(map, row) {
  if (!row?.id) return
  const existing = map.get(row.id)
  if (existing?.fromApi) {
    existing.fromDb = true
    return
  }
  map.set(row.id, {
    id: row.id,
    title: row.title || existing?.title || "Untitled",
    directory: row.directory || existing?.directory || "",
    projectID: row.projectId || existing?.projectID,
    parentID: row.parentId || undefined,
    time: {
      created: row.time?.created || existing?.time?.created || 0,
      updated: row.time?.updated || existing?.time?.updated || 0,
      archived: row.archived || existing?.time?.archived,
    },
    fromDb: true,
    fromApi: false,
  })
}

function applySessionInfo(info) {
  if (!info?.id) return
  const prev = state.sessions.get(info.id) || {}
  const next = normalizeApi(info)
  if (!next.directory && prev.directory) next.directory = prev.directory
  next.fromDb = Boolean(prev.fromDb)
  next.unavailable = false
  const revertChanged = (prev.revert?.messageID || "") !== (next.revert?.messageID || "")
  state.sessions.set(info.id, next)
  scheduleSidebar()
  if (info.id === state.activeId) {
    renderHeader()
    renderRevertBar()
    if (revertChanged) renderStream()
  }
}

function isBusy(id) {
  const status = state.status.get(id)
  return Boolean(status && status.type && status.type !== "idle")
}

function bucketOf(ts) {
  if (!ts) return "Older"
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= start) return "Today"
  if (ts >= start - 86400000) return "Yesterday"
  const monday = start - ((now.getDay() + 6) % 7) * 86400000
  if (ts >= monday) return "This week"
  return "Older"
}

function relTime(ts) {
  if (!ts) return ""
  const seconds = Math.round((Date.now() - ts) / 1000)
  if (Math.abs(seconds) < 15) return "just now"
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function visibleSessions() {
  const query = state.query.trim().toLowerCase()
  const project = selectedProject()
  const list = []
  for (const session of state.sessions.values()) {
    if (session.parentID) continue
    if (session.time?.archived) continue
    if (project && session.projectID !== project.id && session.directory !== project.worktree) continue
    if (query) {
      const hay = `${session.title || ""} ${session.directory || ""}`.toLowerCase()
      if (!hay.includes(query)) continue
    }
    list.push(session)
  }
  list.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
  return list
}

function sessionButton(session) {
  const button = el("button", "session" + (session.id === state.activeId ? " active" : ""))
  button.type = "button"
  button.dataset.id = session.id
  const dot = el("i", isBusy(session.id) ? "dot busy" : "dot")
  dot.setAttribute("aria-hidden", "true")
  button.append(dot)
  const text = el("span", "session-text")
  text.append(el("span", "session-title", session.title || "Untitled"))
  if (state.permissions.some((item) => item.sessionID === session.id)) {
    text.append(el("span", "needs", " permission"))
  }
  button.append(text)
  const time = el("time", "session-time", relTime(session.time?.updated))
  if (session.time?.updated) time.dateTime = new Date(session.time.updated).toISOString()
  time.title = session.directory || ""
  button.append(time)
  button.addEventListener("click", () => {
    closeDrawer()
    openSession(session.id)
  })
  return button
}

function appendBuckets(parent, sessions) {
  const buckets = new Map(BUCKETS.map((name) => [name, []]))
  for (const session of sessions) buckets.get(bucketOf(session.time?.updated)).push(session)
  for (const name of BUCKETS) {
    const items = buckets.get(name)
    if (!items.length) continue
    const block = el("div", "bucket")
    block.append(el("h3", null, name))
    for (const session of items) block.append(sessionButton(session))
    parent.append(block)
  }
}

let sideFrame = 0
function scheduleSidebar() {
  if (sideFrame) return
  sideFrame = requestAnimationFrame(() => {
    sideFrame = 0
    renderSidebar()
    renderHeader()
    renderFooter()
  })
}

function projectGroups(sessions) {
  const groups = new Map()
  for (const session of sessions) {
    const directory = session.directory || ""
    const key = directory || session.projectID || projectLabel(directory)
    if (!groups.has(key)) {
      groups.set(key, {
        label: projectLabel(directory),
        directory,
        sessions: [],
        newest: 0,
      })
    }
    const group = groups.get(key)
    group.sessions.push(session)
    group.newest = Math.max(group.newest, session.time?.updated || 0)
  }
  return [...groups.values()].sort((a, b) => b.sessions.length - a.sessions.length || b.newest - a.newest || a.label.localeCompare(b.label))
}

function foldMark() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("width", "14")
  svg.setAttribute("height", "14")
  svg.setAttribute("aria-hidden", "true")
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", "M6 9l6 6 6-6")
  path.setAttribute("fill", "none")
  path.setAttribute("stroke", "currentColor")
  path.setAttribute("stroke-width", "1.75")
  path.setAttribute("stroke-linecap", "round")
  path.setAttribute("stroke-linejoin", "round")
  svg.append(path)
  return svg
}

function toggleFold(key) {
  if (state.folded.has(key)) state.folded.delete(key)
  else state.folded.add(key)
  localStorage.setItem("oc-ui-folded", JSON.stringify([...state.folded]))
  renderSidebar()
  $("session-list").querySelector(`[data-fold="${CSS.escape(key)}"]`)?.focus()
}

function foldButton(label, key) {
  const open = !state.folded.has(key)
  const fold = el("button", "group-fold")
  fold.type = "button"
  fold.dataset.fold = key
  fold.setAttribute("aria-expanded", open ? "true" : "false")
  fold.setAttribute("aria-label", `${open ? "Hide" : "Show"} sessions in ${label}`)
  fold.append(foldMark())
  fold.addEventListener("click", () => toggleFold(key))
  return fold
}

function projectHead(label, directory, foldKey) {
  const key = foldKey || cleanDir(directory) || label
  const head = el("div", "group-head")
  const heading = el("h2", null, label)
  heading.title = directory || label
  heading.addEventListener("click", () => toggleFold(key))
  head.append(foldButton(label, key), heading)
  if (!directory || directory === "/") return head
  const add = el("button", "group-add", "+")
  add.type = "button"
  add.setAttribute("aria-label", `New session in ${label}`)
  add.title = `New session in ${label}`
  add.addEventListener("click", () => {
    closeDrawer()
    createSession(directory)
  })
  head.append(add)
  return head
}

function renderSidebar() {
  const list = $("session-list")
  const top = list.scrollTop
  const frag = document.createDocumentFragment()
  const sessions = visibleSessions()
  if (state.projectFilter === "all" && state.home) {
    const mine = sessions.filter((session) => isHomeDir(session.directory))
    const section = el("section", "group")
    section.append(projectHead("Home", state.home))
    if (!state.folded.has(cleanDir(state.home))) {
      if (!mine.length && state.listed && !state.query) section.append(el("p", "empty", "No sessions yet"))
      for (const session of mine) section.append(sessionButton(session))
    }
    frag.append(section)
  }
  const projectSessions = sessions.filter((session) => !isHomeDir(session.directory))
  if (!sessions.length && !(state.projectFilter === "all" && state.home)) {
    frag.append(el("p", "empty", state.query ? "No matching sessions" : "No sessions"))
  } else if (state.projectFilter === "all") {
    if (sessions.length) {
      const recent = el("section", "group")
      recent.append(projectHead("Recents", "", "recents"))
      if (!state.folded.has("recents")) {
        for (const session of sessions.slice(0, 8)) recent.append(sessionButton(session))
      }
      frag.append(recent)
    } else if (state.query) {
      frag.append(el("p", "empty", "No matching sessions"))
    }
    const groups = projectGroups(projectSessions)
    if (groups.length) {
      frag.append(el("h2", "section-label", "Projects"))
      for (const group of groups) {
        const section = el("section", "group")
        section.append(projectHead(group.label, group.directory))
        if (!state.folded.has(cleanDir(group.directory) || group.label)) {
          for (const session of group.sessions) section.append(sessionButton(session))
        }
        frag.append(section)
      }
    }
  } else {
    const project = selectedProject()
    const section = el("section", "group")
    const key = project ? (cleanDir(project.worktree) || project.label) : ""
    if (project) section.append(projectHead(project.label, project.worktree))
    if (!key || !state.folded.has(key)) appendBuckets(section, sessions)
    frag.append(section)
  }
  list.replaceChildren(frag)
  list.scrollTop = top
  renderFooter()
}

function sessionCount() {
  const project = selectedProject()
  let count = 0
  for (const session of state.sessions.values()) {
    if (session.parentID || session.time?.archived) continue
    if (project && session.projectID !== project.id && session.directory !== project.worktree) continue
    count += 1
  }
  return count
}

function renderFooter() {
  const foot = $("side-foot")
  const sources = []
  if (state.apiAvailable) sources.push("API")
  if (state.dbAvailable) sources.push("DB")
  const conn = state.conn === "live" ? "live" : state.conn === "offline" ? "offline" : state.conn === "reconnecting" ? "reconnecting" : "connecting"
  foot.replaceChildren(
    el("i", "dot " + (state.conn === "live" ? "ok" : "wait")),
    el("span", null, `${sessionCount()} sessions · ${sources.join(" + ") || "—"} · ${conn}`),
  )
}

function renderProjectSelect() {
  const select = $("project")
  const options = projectOptions()
  const signature = ["all", ...options.map((project) => `${project.id}:${project.label}`)].join("|")
  if (select.dataset.signature !== signature) {
    select.replaceChildren(option("all", "All projects"))
    for (const project of options) {
      const node = option(project.id, project.label)
      node.title = project.worktree
      select.append(node)
    }
    select.dataset.signature = signature
  }
  const wanted = [...select.options].some((item) => item.value === state.projectFilter) ? state.projectFilter : "all"
  state.projectFilter = wanted
  select.value = wanted
}

function renderRevertBar() {
  const session = currentSession()
  $("revert-bar").hidden = !session?.revert?.messageID
}

function renderHeader() {
  const session = currentSession()
  const onHome = !session && Boolean(state.home)
  renderRevertBar()
  const title = $("title")
  if (title.querySelector("input")) return
  title.textContent = session ? (session.title || "Untitled") : "Openview"
  $("session-bar").hidden = !session
  const enteredHome = onHome && !$("main").classList.contains("home-view")
  $("main").classList.toggle("home-view", onHome)
  $("main").classList.toggle("is-sending", Boolean(state.starting))
  $("composer").hidden = !session && !onHome
  renderHomeSuggest(enteredHome)
  $("home-btn").hidden = !state.home
  if (onHome) $("home-btn").setAttribute("aria-current", "page")
  else $("home-btn").removeAttribute("aria-current")
  const path = $("path")
  path.textContent = session?.directory || ""
  path.title = session?.directory || ""
  const busy = session && isBusy(session.id)
  if (busy) path.textContent = (session.directory ? session.directory + " · " : "") + "working"
  $("rename").hidden = !session
  $("delete").hidden = !session
  renderChanges()
  renderComposer()
}

