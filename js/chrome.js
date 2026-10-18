// Top bar menus and the command palette.
function closeMenus() {
  for (const id of ["project-menu", "top-more-menu"]) {
    const menu = $(id)
    if (menu) menu.hidden = true
  }
  $("project-btn")?.setAttribute("aria-expanded", "false")
  $("top-more")?.setAttribute("aria-expanded", "false")
}

function toggleMenu(menuId, buttonId) {
  const menu = $(menuId)
  const willOpen = menu.hidden
  closeMenus()
  if (!willOpen) return
  menu.hidden = false
  $(buttonId).setAttribute("aria-expanded", "true")
  const selected = menu.querySelector('[aria-selected="true"]') || menu.querySelector("button")
  selected?.focus()
}

function chooseProjectFilter(value) {
  const select = $("project")
  if (![...select.options].some((item) => item.value === value)) return
  select.value = value
  closeMenus()
  select.dispatchEvent(new Event("change"))
}

function renderProjectMenu() {
  const menu = $("project-menu")
  const select = $("project")
  if (!menu || !select) return
  menu.replaceChildren()
  for (const item of select.options) {
    const button = el("button", null, item.textContent)
    button.type = "button"
    button.setAttribute("role", "option")
    button.setAttribute("aria-selected", item.value === select.value ? "true" : "false")
    if (item.title) button.title = item.title
    button.addEventListener("click", () => chooseProjectFilter(item.value))
    menu.append(button)
  }
  const add = el("button", "menu-add", "Add project…")
  add.type = "button"
  add.addEventListener("click", () => {
    closeMenus()
    createSession()
  })
  menu.append(add)
}

function shortcutLabel(key) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || "")
  return mac ? `⌘${key}` : `Ctrl+${key}`
}

function setAgent(name) {
  state.agent = name
  localStorage.setItem("oc-ui-agent", state.agent)
  renderPickers()
  renderComposer()
}

function setModel(value) {
  state.model = value
  localStorage.setItem("oc-ui-model", state.model)
  renderPickers()
}

function setSkill(name) {
  state.skill = name
  localStorage.setItem("oc-ui-skill", state.skill)
  renderPickers()
  renderComposer()
  $("input")?.focus()
}

function cycleTab(step) {
  if (state.tabs.length < 2) return
  const index = Math.max(0, state.tabs.indexOf(state.activeId))
  const next = state.tabs[(index + step + state.tabs.length) % state.tabs.length]
  if (next && next !== state.activeId) openSession(next)
}

function fuzzy(query, text) {
  const needle = query.trim().toLowerCase()
  const hay = String(text || "").toLowerCase()
  if (!needle) return 1
  let score = 0
  let at = 0
  for (const ch of needle) {
    const found = hay.indexOf(ch, at)
    if (found < 0) return 0
    score += found === at ? 3 : 1
    at = found + 1
  }
  if (hay.startsWith(needle)) score += 8
  return score
}

function paletteCatalog() {
  const items = []
  const sessions = [...state.sessions.values()].filter((session) => !session.parentID && !session.time?.archived)
  sessions.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
  for (const session of sessions) {
    items.push({
      kind: "Session",
      label: session.title || "Untitled",
      detail: session.directory || "",
      text: `${session.title || ""} ${session.directory || ""}`,
      run: () => openSession(session.id),
    })
  }
  items.push({
    kind: "Project",
    label: "All projects",
    text: "all projects",
    run: () => chooseProjectFilter("all"),
  })
  for (const project of projectOptions()) {
    items.push({
      kind: "Project",
      label: project.label,
      detail: project.worktree || "",
      text: `${project.label} ${project.worktree || ""}`,
      run: () => chooseProjectFilter(project.id),
    })
  }
  const actions = [
    ["New session", "new session create", () => createSession(), ""],
    ["Rename session", "rename", () => startRename(), ""],
    ["Delete session", "delete", () => deleteSession(), ""],
    ["Home", "home", () => showHome(), ""],
    ["Show or hide sessions", "toggle sidebar", () => $("menu").click(), ""],
    ["Show or hide changes", "toggle changes", () => { if (!$("show-changes").disabled) $("show-changes").click() }, ""],
    ["Library", "library agents skills", () => openLibrary(), ""],
    ["Settings", "settings", () => openSettings(), ""],
    ["Next tab", "next tab", () => cycleTab(1), "Alt+→"],
    ["Previous tab", "previous tab", () => cycleTab(-1), "Alt+←"],
  ]
  for (const [label, text, run, hint] of actions) items.push({ kind: "Action", label, text, hint, run })
  for (const theme of THEMES) {
    const label = theme === "system" ? "System" : theme.replace(/-/g, " ")
    items.push({ kind: "Theme", label, text: `theme ${label}`, run: () => applyTheme(theme) })
  }
  for (const agent of state.agents) {
    items.push({ kind: "Agent", label: agent.name, text: `agent ${agent.name}`, run: () => setAgent(agent.name) })
  }
  for (const model of state.models) {
    const label = `${model.providerName} / ${model.name}`
    items.push({
      kind: "Model",
      label,
      text: `model ${label}`,
      run: () => setModel(`${model.providerID}\u001f${model.modelID}`),
    })
  }
  for (const skill of state.skills) {
    items.push({
      kind: "Command",
      label: `/${skill.name}`,
      detail: skill.description || "",
      text: `command /${skill.name} ${skill.description || ""}`,
      run: () => setSkill(skill.name),
    })
  }
  for (const command of state.commands) {
    items.push({
      kind: "Command",
      label: `/${command.name}`,
      detail: command.description || "",
      text: `command /${command.name} ${command.description || ""}`,
      run: () => setSkill(command.name),
    })
  }
  return items
}

let paletteItems = []
let paletteIndex = 0

function paletteResults(query) {
  const needle = query.trim()
  const ranked = []
  let sessions = 0
  for (const item of paletteCatalog()) {
    if (!needle && item.kind === "Session" && sessions >= 8) continue
    if (!needle && (item.kind === "Theme" || item.kind === "Model" || item.kind === "Agent" || item.kind === "Command")) continue
    const score = fuzzy(needle, `${item.label} ${item.detail || ""} ${item.text || ""}`)
    if (!score) continue
    if (item.kind === "Session") sessions += 1
    ranked.push({ ...item, score })
  }
  const kindOrder = { Session: 0, Project: 1, Action: 2, Command: 3, Agent: 4, Model: 5, Theme: 6 }
  ranked.sort((a, b) => {
    if (needle) return b.score - a.score || a.label.localeCompare(b.label)
    return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9)
  })
  return ranked.slice(0, 40)
}

function renderPalette() {
  paletteItems = paletteResults($("palette-input").value)
  if (paletteIndex >= paletteItems.length) paletteIndex = Math.max(0, paletteItems.length - 1)
  const list = $("palette-list")
  list.replaceChildren()
  if (!paletteItems.length) {
    list.append(el("p", "palette-empty", "No matches"))
    return
  }
  paletteItems.forEach((item, index) => {
    const button = el("button", "pal-row")
    button.type = "button"
    button.setAttribute("role", "option")
    button.id = `palette-opt-${index}`
    button.setAttribute("aria-selected", index === paletteIndex ? "true" : "false")
    button.append(el("span", "pal-kind", item.kind))
    const text = el("span", "pal-label")
    text.append(el("span", null, item.label))
    if (item.detail) text.append(el("span", "pal-detail", item.detail))
    button.append(text)
    if (item.hint) button.append(el("kbd", null, item.hint))
    button.addEventListener("click", () => runPalette(index))
    button.addEventListener("mousemove", () => {
      paletteIndex = index
      for (const row of list.querySelectorAll(".pal-row")) row.setAttribute("aria-selected", "false")
      button.setAttribute("aria-selected", "true")
      $("palette-input").setAttribute("aria-activedescendant", button.id)
    })
    list.append(button)
  })
  const active = list.querySelector('[aria-selected="true"]')
  if (active) {
    $("palette-input").setAttribute("aria-activedescendant", active.id)
    active.scrollIntoView({ block: "nearest" })
  }
}

function runPalette(index) {
  const item = paletteItems[index]
  if (!item) return
  $("palette").close()
  item.run()
}

function openPalette() {
  closeMenus()
  const dialog = $("palette")
  if (dialog.open) return
  $("palette-input").value = ""
  paletteIndex = 0
  renderPalette()
  dialog.showModal()
  $("palette-input").focus()
}

function fillMoreMenu() {
  const menu = $("top-more-menu")
  const rows = [
    ["Library", () => openLibrary(), ""],
    ["Settings", () => openSettings(), ""],
    ["Search", () => openPalette(), shortcutLabel("K")],
  ]
  for (const [label, run, hint] of rows) {
    const button = el("button")
    button.type = "button"
    button.setAttribute("role", "menuitem")
    const name = el("span", null, label)
    button.append(name)
    if (hint) button.append(el("kbd", null, hint))
    button.addEventListener("click", () => {
      closeMenus()
      run()
    })
    menu.append(button)
  }
}

function bindChrome() {
  fillMoreMenu()
  $("palette-btn").title = `Search (${shortcutLabel("K")})`
  $("project-btn").addEventListener("click", () => toggleMenu("project-menu", "project-btn"))
  $("top-more").addEventListener("click", () => toggleMenu("top-more-menu", "top-more"))
  $("palette-btn").addEventListener("click", openPalette)
  $("palette-input").addEventListener("input", () => {
    paletteIndex = 0
    renderPalette()
  })
  $("palette-input").addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1)
      renderPalette()
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      paletteIndex = Math.max(0, paletteIndex - 1)
      renderPalette()
    } else if (event.key === "Enter") {
      event.preventDefault()
      runPalette(paletteIndex)
    }
  })
  document.addEventListener("click", (event) => {
    if (event.target.closest(".project-wrap, .more-wrap")) return
    closeMenus()
  })
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault()
      if ($("palette").open) $("palette").close()
      else openPalette()
      return
    }
    if (event.key === "Escape") closeMenus()
  })
  renderProjectMenu()
}
