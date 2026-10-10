// Agent and model menus, and refreshing the session list.
function renderPickers() {
  const agent = $("agent")
  const model = $("model")
  agent.replaceChildren(option("", "Default agent"))
  for (const item of state.agents) agent.append(option(item.name, item.name))
  agent.value = [...agent.options].some((item) => item.value === state.agent) ? state.agent : ""
  model.replaceChildren(option("", "Default model"))
  for (const item of state.models) {
    model.append(option(`${item.providerID}\u001f${item.modelID}`, `${item.providerName} / ${item.name}`))
  }
  if (state.model && ![...model.options].some((item) => item.value === state.model)) {
    model.append(option(state.model, state.model.replace("\u001f", " / ")))
  }
  model.value = [...model.options].some((item) => item.value === state.model) ? state.model : ""
}

function settlePickerChoice() {
  const names = state.agents.map((item) => item.name)
  if (names.length && !names.includes(state.agent)) {
    state.agent = names.includes("build") ? "build" : ""
    localStorage.setItem("oc-ui-agent", state.agent)
  }
  const ids = state.models.map((item) => `${item.providerID}\u001f${item.modelID}`)
  const preferred = "opencode\u001fbig-pickle"
  if (ids.length && !ids.includes(state.model)) {
    state.model = ids.includes(preferred) ? preferred : ""
    localStorage.setItem("oc-ui-model", state.model)
  }
}

function pickerDirectory() {
  const session = currentSession()
  if (session?.directory && session.directory !== "/") return session.directory
  const selected = selectedProject()
  if (selected?.worktree) return selected.worktree
  return state.home || ""
}

async function loadPickers(directory) {
  const dir = directory || pickerDirectory()
  if (dir && dir === state.pickerDir && (state.agents.length || state.models.length)) return
  const gen = state.pickerGen + 1
  state.pickerGen = gen
  state.pickerDir = dir || null
  let agents = []
  let models = []
  try {
    const listed = await getJSON("/agent", dir || undefined)
    if (Array.isArray(listed)) {
      agents = listed.filter((agent) => agent && agent.hidden !== true && agent.mode !== "subagent" && agent.name)
    }
  } catch { /* this folder has no agent list */ }
  try {
    const config = await getJSON("/config/providers", dir || undefined)
    for (const provider of config?.providers || []) {
      for (const model of Object.values(provider.models || {})) {
        if (!model?.id) continue
        models.push({
          providerID: model.providerID || provider.id,
          modelID: model.id,
          name: model.name || model.id,
          providerName: provider.name || provider.id,
        })
      }
    }
    models.sort((a, b) => `${a.providerName} ${a.name}`.localeCompare(`${b.providerName} ${b.name}`))
  } catch { /* this folder has no model list */ }
  if (gen !== state.pickerGen) return
  state.agents = agents
  state.models = models
  settlePickerChoice()
  renderPickers()
}

async function loadStatuses() {
  const dirs = new Set()
  for (const project of state.projects) if (project.worktree && project.worktree !== "/") dirs.add(project.worktree)
  if (state.home) dirs.add(state.home)
  const active = currentSession()
  if (active?.directory && active.directory !== "/") dirs.add(active.directory)
  const targets = dirs.size ? [...dirs] : [undefined]
  const results = await Promise.allSettled(targets.map((dir) => getJSON("/session/status", dir)))
  const status = new Map()
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) continue
    for (const [id, value] of Object.entries(result.value)) status.set(id, value)
  }
  state.status = status
}

async function refreshSessions() {
  const seenAtStart = new Set(state.sessions.keys())
  const next = new Map()
  let api = false
  let projects = []
  try {
    const listed = await getJSON("/project")
    if (Array.isArray(listed)) projects = listed.filter((project) => project && project.worktree && project.worktree !== "/")
  } catch (err) {
    if (err.offline || err.status === 401) renderFooter()
  }
  state.projects = projects
  if (state.home && !projects.some((project) => isHomeDir(project.worktree))) {
    try {
      const listed = await getJSON("/session", state.home)
      if (Array.isArray(listed)) {
        api = true
        for (const session of listed) if (session?.id) next.set(session.id, normalizeApi(session))
      }
    } catch { /* home has no sessions yet */ }
  }
  if (projects.length) {
    const results = await Promise.allSettled(projects.map((project) => getJSON("/session", project.worktree)))
    for (const result of results) {
      if (result.status !== "fulfilled" || !Array.isArray(result.value)) continue
      api = true
      for (const session of result.value) {
        if (session?.id) next.set(session.id, normalizeApi(session))
      }
    }
  }
  if (!api) {
    try {
      const listed = await getJSON("/session")
      if (Array.isArray(listed)) {
        api = true
        for (const session of listed) if (session?.id) next.set(session.id, normalizeApi(session))
      }
    } catch { /* optional when /project is missing */ }
  }
  let db = false
  try {
    const rows = await getJSON("/_db/sessions?limit=10000")
    if (Array.isArray(rows)) {
      db = true
      for (const row of rows) mergeDb(next, row)
    }
  } catch { /* 404/501: stay on the API list */ }
  for (const [id, session] of state.sessions) {
    if (!seenAtStart.has(id) && !next.has(id)) next.set(id, session)
  }
  if (state.activeId && !next.has(state.activeId) && state.sessions.has(state.activeId)) {
    next.set(state.activeId, state.sessions.get(state.activeId))
  }
  state.sessions = next
  state.apiAvailable = api
  state.dbAvailable = db
  state.listed = true
  try { await loadStatuses() } catch { /* status is optional */ }
  renderProjectSelect()
  renderSidebar()
  renderHeader()
}

async function searchDb(query) {
  if (!query) return
  try {
    const rows = await getJSON(`/_db/sessions?limit=200&q=${encodeURIComponent(query)}`)
    if (!Array.isArray(rows)) return
    state.dbAvailable = true
    let added = false
    for (const row of rows) {
      if (!state.sessions.has(row.id)) {
        mergeDb(state.sessions, row)
        added = true
      }
    }
    if (added) renderSidebar()
  } catch { /* database listing is optional */ }
}

