// Event wiring and startup.
const THEMES = [
  "system", "light", "dark", "nord",
  "catppuccin-latte", "catppuccin-frappe", "catppuccin-macchiato", "catppuccin-mocha",
  "dracula", "gruvbox", "gruvbox-light", "tokyonight",
  "rose-pine", "rose-pine-dawn", "solarized", "solarized-light", "one-dark",
]
const THEME_COLOR = {
  light: "#F3F4F6",
  dark: "#14161A",
  nord: "#2E3440",
  "catppuccin-latte": "#EFF1F5",
  "catppuccin-frappe": "#303446",
  "catppuccin-macchiato": "#24273A",
  "catppuccin-mocha": "#1E1E2E",
  dracula: "#282A36",
  gruvbox: "#282828",
  "gruvbox-light": "#FBF1C7",
  tokyonight: "#1A1B26",
  "rose-pine": "#191724",
  "rose-pine-dawn": "#FAF4ED",
  solarized: "#002B36",
  "solarized-light": "#FDF6E3",
  "one-dark": "#282C34",
}

function savedTheme() {
  const theme = localStorage.getItem("oc-ui-theme") || "system"
  return THEMES.includes(theme) ? theme : "system"
}

function paintThemeColor(theme) {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches
  const color = theme === "system" ? (dark ? THEME_COLOR.dark : THEME_COLOR.light) : THEME_COLOR[theme]
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = color
}

function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = "system"
  if (theme === "system") delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  localStorage.setItem("oc-ui-theme", theme)
  paintThemeColor(theme)
  const select = $("theme")
  if (select && select.value !== theme) select.value = theme
}

function bind() {
  $("project").addEventListener("change", () => {
    state.projectFilter = $("project").value || "all"
    renderSidebar()
    loadPickers(pickerDirectory())
  })
  let searchTimer = 0
  $("search").addEventListener("input", () => {
    state.query = $("search").value
    renderSidebar()
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => searchDb(state.query.trim()), 250)
  })
  $("new-session").addEventListener("click", createSession)
  $("new-project-btn").addEventListener("click", createSession)
  bindFolderBrowser()
  $("home-btn").addEventListener("click", showHome)
  $("menu").addEventListener("click", () => {
    if (sidebarNarrow()) {
      if ($("sidebar").classList.contains("open")) closeDrawer()
      else openDrawer()
      return
    }
    if ($("app").classList.contains("sidebar-collapsed")) expandSidebar()
    else collapseSidebar()
  })
  window.matchMedia("(max-width: 760px)").addEventListener("change", () => {
    syncSidebar()
    syncChanges()
  })
  syncSidebar()
  syncChanges()
  $("show-changes").addEventListener("click", () => {
    if ($("changes").hidden) return
    if (sidebarNarrow()) {
      if ($("changes").classList.contains("open")) {
        $("changes").classList.remove("open")
        syncChanges()
      } else expandChanges()
      return
    }
    if (changesCollapsed()) expandChanges()
    else collapseChanges()
  })
  $("scrim").addEventListener("click", closeDrawer)
  $("library-btn").addEventListener("click", openLibrary)
  $("lib-tab-agent").addEventListener("click", () => {
    state.libraryKind = "agent"
    syncLibraryForm()
    renderLibraryList()
  })
  $("lib-tab-skill").addEventListener("click", () => {
    state.libraryKind = "skill"
    syncLibraryForm()
    renderLibraryList()
  })
  $("lib-scope").addEventListener("change", () => {
    syncLibraryForm()
    loadLibrary()
  })
  $("lib-project").addEventListener("change", () => {
    syncLibraryForm()
    loadLibrary()
  })
  $("lib-name").addEventListener("input", () => {
    $("lib-result").hidden = true
    syncLibraryForm()
  })
  $("lib-desc").addEventListener("input", () => { $("lib-result").hidden = true })
  $("lib-body").addEventListener("input", () => { $("lib-result").hidden = true })
  $("lib-close").addEventListener("click", () => $("library-dialog").close())
  $("library-form").addEventListener("submit", saveLibrary)
  $("revert-restore").addEventListener("click", restoreReverted)
  $("settings-btn").addEventListener("click", openSettings)
  $("theme").addEventListener("change", () => applyTheme($("theme").value))
  applyTheme(savedTheme())
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (savedTheme() === "system") paintThemeColor("system")
  })
  $("hosted-preset").addEventListener("change", syncHostedPreset)
  $("hosted-form").addEventListener("submit", saveHosted)
  $("settings-dialog").addEventListener("close", () => {
    if ($("settings-dialog").returnValue !== "save") return
    state.settings = {
      url: $("set-url").value.trim(),
      username: $("set-user").value,
      password: $("set-pass").value,
    }
    localStorage.setItem("oc-ui-settings", JSON.stringify(state.settings))
    state.pickerDir = null
    refreshSessions().then(() => {
      loadPickers()
      connectEvents()
      if (state.activeId) openSession(state.activeId)
    })
  })
  $("rename").addEventListener("click", startRename)
  $("delete").addEventListener("click", deleteSession)
  $("agent").addEventListener("change", () => {
    state.agent = $("agent").value
    localStorage.setItem("oc-ui-agent", state.agent)
  })
  $("model").addEventListener("change", () => {
    state.model = $("model").value
    localStorage.setItem("oc-ui-model", state.model)
  })
  $("skill").addEventListener("change", () => {
    state.skill = $("skill").value
    localStorage.setItem("oc-ui-skill", state.skill)
    renderComposer()
  })
  $("composer").addEventListener("submit", (event) => {
    event.preventDefault()
    sendCurrent()
  })
  $("stop").addEventListener("click", stopSession)
  $("input").addEventListener("input", growInput)
  $("input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
    const coarse = window.matchMedia("(pointer: coarse)").matches
    if (coarse && !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    sendCurrent()
  })
  $("stream").addEventListener("scroll", () => {
    state.stick = nearBottom()
    $("jump").hidden = state.stick || !state.activeId
  }, { passive: true })
  $("jump").addEventListener("click", () => {
    state.stick = true
    $("stream").scrollTop = $("stream").scrollHeight
    $("jump").hidden = true
  })
  $("stream").addEventListener("toggle", (event) => {
    const details = event.target
    if (details instanceof HTMLDetailsElement && details.dataset.part) {
      state.detailsOpen.set(details.dataset.part, details.open)
    }
  }, true)
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer()
  })
  window.addEventListener("hashchange", () => {
    if (state.ignoreHash) {
      state.ignoreHash = false
      return
    }
    const id = sessionFromHash()
    if (id && id !== state.activeId) openSession(id)
    else if (!id && state.activeId) showHome()
  })
}

async function main() {
  loadLocal()
  bind()
  await loadHome()
  renderProjectSelect()
  renderPickers()
  renderHeader()
  renderStream()
  renderFooter()
  await refreshSessions()
  await Promise.allSettled([loadPickers(), loadPermissions(), loadQuestions()])
  connectEvents()
  connectDbEvents()
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return
    if (state.conn !== "live" || Date.now() - lastEventAt > 20000) connectEvents()
    if (state.dbFeed !== "live") connectDbEvents()
    resync()
  })
  window.addEventListener("online", () => {
    connectEvents()
    connectDbEvents()
    resync()
  })
  const deep = sessionFromHash()
  if (deep) await openSession(deep)
  setInterval(() => {
    if (state.conn === "live" && Date.now() - lastEventAt > 45000) {
      connectEvents()
      resync()
    }
  }, 10000)
  setInterval(() => {
    refreshSessions().then(() => { if (state.activeId) flushQueue(state.activeId) }).catch(() => {})
  }, 60000)
  setInterval(() => { renderSidebar() }, 30000)
}

main()
