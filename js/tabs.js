// Open sessions as tabs. Each tab keeps its own transcript, draft, and scroll position.
const TABS_KEY = "oc-ui-tabs"
let tabShown = null

function blankView() {
  return {
    messages: [],
    stick: true,
    scroll: 0,
    draft: "",
    loaded: false,
    loading: false,
    unavailable: false,
    banner: "",
    bannerKind: "",
    unseen: false,
    stale: false,
    gen: 0,
  }
}

function ensureView(id) {
  let view = state.views.get(id)
  if (!view) {
    view = blankView()
    state.views.set(id, view)
  }
  return view
}

function loadTabs() {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) || "[]")
    const ids = Array.isArray(raw) ? raw.filter((id) => typeof id === "string" && id) : []
    state.tabs = [...new Set(ids)]
  } catch {
    state.tabs = []
  }
  for (const id of state.tabs) ensureView(id)
}

function saveTabs() {
  localStorage.setItem(TABS_KEY, JSON.stringify(state.tabs))
}

function rememberTab(id) {
  if (!id) return ensureView(id)
  if (!state.tabs.includes(id)) state.tabs.push(id)
  saveTabs()
  return ensureView(id)
}

function beginLoad(id) {
  const view = ensureView(id)
  view.gen += 1
  return view.gen
}

function loadCurrent(id, gen) {
  const view = state.views.get(id)
  return Boolean(view && view.gen === gen)
}

function setMessages(list) {
  state.messages = list
  if (!state.activeId) return
  const view = state.views.get(state.activeId)
  if (view) view.messages = list
}

function listFor(sessionID) {
  if (!sessionID || sessionID === state.activeId) return state.messages
  if (!state.tabs.includes(sessionID)) return null
  return ensureView(sessionID).messages
}

function assignList(sessionID, list) {
  if (!sessionID || sessionID === state.activeId) setMessages(list)
  else ensureView(sessionID).messages = list
}

function sortList(list) {
  list.sort((a, b) => (a.info?.time?.created || 0) - (b.info?.time?.created || 0) || String(a.info?.id || "").localeCompare(String(b.info?.id || "")))
}

function commitLoaded(id, gen, messages) {
  const view = state.views.get(id)
  if (!view || view.gen !== gen) return "stale"
  const prevLast = view.messages.at(-1)?.info?.id || ""
  const nextLast = messages.at(-1)?.info?.id || ""
  const changed = view.messages.length !== messages.length || prevLast !== nextLast
  view.messages = messages
  view.loaded = true
  view.loading = false
  view.unavailable = false
  view.stale = false
  if (state.activeId === id) {
    state.messages = messages
    state.loadingMessages = false
    state.unavailable = false
    return "active"
  }
  if (changed) {
    view.unseen = true
    renderTabs()
  }
  return "background"
}

function bannerText() {
  const banner = $("banner")
  if (!banner || banner.hidden) return ""
  return banner.querySelector("span")?.textContent || ""
}

function stashActive() {
  const input = $("input")
  if (!state.activeId) {
    if (input) state.homeDraft = input.value
    return
  }
  const view = ensureView(state.activeId)
  view.messages = state.messages
  view.stick = state.stick
  view.scroll = $("stream").scrollTop
  view.draft = input ? input.value : ""
  view.loading = state.loadingMessages
  view.unavailable = state.unavailable
  view.bannerKind = state.bannerKind || ""
  view.banner = view.bannerKind ? bannerText() : ""
}

function restoreDraft(text) {
  const input = $("input")
  if (!input) return
  input.value = text || ""
  growInput()
}

function placeScroll(view) {
  const root = $("stream")
  if (state.stick) root.scrollTop = root.scrollHeight
  else root.scrollTop = view?.scroll || 0
}

function closeTab(id) {
  const index = state.tabs.indexOf(id)
  if (index === -1) return
  const wasActive = state.activeId === id
  state.tabs.splice(index, 1)
  state.views.delete(id)
  saveTabs()
  if (!wasActive) {
    renderTabs()
    renderSidebar()
    return
  }
  const next = state.tabs[index] || state.tabs[index - 1] || null
  state.activeId = null
  state.messages = []
  state.loadingMessages = false
  state.unavailable = false
  if (next) openSession(next)
  else showHome()
}

function markUnseen(sessionID) {
  if (!sessionID || sessionID === state.activeId || !state.tabs.includes(sessionID)) return
  const view = ensureView(sessionID)
  if (view.unseen) return
  view.unseen = true
  renderTabs()
}

function markTabsStale() {
  for (const id of state.tabs) {
    if (id === state.activeId) continue
    const view = state.views.get(id)
    if (view?.loaded) view.stale = true
  }
}

function renderTabs() {
  const bar = $("tabbar")
  const root = $("tabs")
  if (!bar || !root) return
  bar.hidden = state.tabs.length === 0
  root.replaceChildren()
  for (const id of state.tabs) {
    const session = state.sessions.get(id)
    const view = state.views.get(id)
    const title = session?.title || "Untitled"
    const tab = el("div", "tab" + (id === state.activeId ? " active" : ""))
    tab.setAttribute("role", "tab")
    tab.id = `tab-${id}`
    tab.setAttribute("aria-selected", id === state.activeId ? "true" : "false")
    const main = el("button", "tab-main")
    main.type = "button"
    main.title = session?.directory || title
    const needsAnswer = state.permissions.some((item) => item.sessionID === id) || state.questions.some((item) => item.sessionID === id)
    if (isBusy(id)) main.append(el("i", "dot busy"))
    else if (needsAnswer) main.append(el("i", "dot wait"))
    else if (view?.unseen && id !== state.activeId) main.append(el("i", "dot unseen"))
    main.append(el("span", "tab-title", title))
    main.addEventListener("click", () => {
      if (id !== state.activeId) openSession(id)
    })
    main.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return
      const index = state.tabs.indexOf(id)
      const next = event.key === "ArrowRight" ? state.tabs[index + 1] : state.tabs[index - 1]
      if (!next) return
      event.preventDefault()
      openSession(next)
    })
    const close = el("button", "tab-close", "×")
    close.type = "button"
    close.setAttribute("aria-label", `Close ${title}`)
    close.addEventListener("click", (event) => {
      event.stopPropagation()
      closeTab(id)
    })
    tab.addEventListener("mousedown", (event) => {
      if (event.button === 1) event.preventDefault()
    })
    tab.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return
      event.preventDefault()
      closeTab(id)
    })
    tab.append(main, close)
    root.append(tab)
  }
  if (state.activeId && state.activeId !== tabShown) {
    tabShown = state.activeId
    requestAnimationFrame(() => {
      root.querySelector(".tab.active")?.scrollIntoView({ inline: "nearest", block: "nearest" })
    })
  }
  if (!state.activeId) tabShown = null
}
