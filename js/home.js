// Home page and the message stream.
const HOME_SUGGESTIONS = [
  { label: "Disk space", text: "How much disk space is free, and what is using the most?" },
  { label: "Memory", text: "What is using the most memory right now?" },
  { label: "Services", text: "Which services are running, and which of them failed?" },
  { label: "Updates", text: "Are there system updates waiting to be installed?" },
]

function homeGreeting() {
  const hour = new Date().getHours()
  if (hour < 12) return "Good morning"
  if (hour < 17) return "Good afternoon"
  return "Good evening"
}

function renderHomeSuggest(fresh) {
  const root = $("home-suggest")
  const onHome = !currentSession() && Boolean(state.home)
  root.hidden = !onHome
  if (!onHome) return
  if (!fresh && root.childElementCount) return
  root.replaceChildren()
  HOME_SUGGESTIONS.forEach((item, index) => {
    const button = el("button", "home-chip", item.label)
    button.type = "button"
    button.style.animationDelay = `${0.22 + index * 0.06}s`
    button.addEventListener("click", () => {
      const input = $("input")
      input.value = item.text
      growInput()
      input.focus()
    })
    root.append(button)
  })
}

function paintSend(onHome) {
  const send = $("send")
  send.setAttribute("aria-label", "Send")
  const mode = onHome ? "home" : "session"
  if (send.dataset.mode === mode) return
  send.dataset.mode = mode
  if (!onHome) {
    send.textContent = "Send"
    return
  }
  const icon = svgIcon()
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", "M12 18V7M7.5 11.5 12 7l4.5 4.5")
  icon.append(path)
  send.replaceChildren(icon)
}

function thinkingNode() {
  const row = el("div", "thinking")
  row.setAttribute("role", "status")
  row.setAttribute("aria-label", "Working")
  const dots = el("span", "dots")
  dots.append(el("i"), el("i"), el("i"))
  row.append(dots, el("span", null, "Working"))
  return row
}

function assistantHasText(message) {
  return (message?.parts || []).some((part) => part?.type === "text" && String(part.text || "").trim())
}

function turnPending() {
  if (state.starting) return true
  const session = currentSession()
  if (!session || !state.messages.length) return false
  const last = state.messages[state.messages.length - 1]
  const waiting = last?.info?.role !== "assistant" || !assistantHasText(last)
  return waiting && (isBusy(session.id) || String(last?.info?.id || "").startsWith("pending:"))
}

function syncThinking(wrap) {
  if (!wrap) return
  wrap.querySelector(":scope > .thinking")?.remove()
  if (turnPending()) wrap.append(thinkingNode())
}

function outgoingCard(text) {
  const home = el("div", "home home-working")
  const article = el("article", "msg msg-user")
  article.append(el("p", "kicker", "You"))
  const body = el("div", "user-body")
  body.append(el("p", null, text))
  article.append(body)
  home.append(article, thinkingNode())
  return home
}

function renderStream() {
  const root = $("stream")
  if (!state.activeId && state.starting && state.outgoing) {
    root.replaceChildren(outgoingCard(state.outgoing))
  } else if (!state.activeId) {
    if (state.home) {
      if (!root.querySelector(".home")) {
        const home = el("div", "home")
        const logo = el("div", "logo home-logo")
        logo.setAttribute("aria-hidden", "true")
        const light = el("img", "logo-on-light")
        light.src = "/logo/mark-color.svg"
        light.alt = ""
        const dark = el("img", "logo-on-dark")
        dark.src = "/logo/mark-dark.svg"
        dark.alt = ""
        logo.append(light, dark)
        home.append(logo)
        home.append(el("h2", null, homeGreeting()))
        home.append(el("p", "mono", state.home))
        root.replaceChildren(home)
      }
    } else {
      const empty = el("div", "empty-main")
      empty.append(el("p", null, "Select a session."))
      root.replaceChildren(empty)
    }
  } else if (state.unavailable) {
    const empty = el("div", "empty-main")
    empty.append(el("p", null, "This session's project isn't available to the server."))
    root.replaceChildren(empty)
  } else if (state.loadingMessages && state.starting && state.outgoing) {
    root.replaceChildren(outgoingCard(state.outgoing))
  } else if (state.loadingMessages) {
    const empty = el("div", "empty-main")
    empty.append(el("p", null, "Loading messages…"))
    root.replaceChildren(empty)
  } else if (!state.messages.length) {
    const empty = el("div", "empty-main")
    empty.append(el("p", null, "No messages yet."))
    root.replaceChildren(empty)
  } else {
    const wrap = el("div", "thread")
    for (const message of state.messages) wrap.append(renderMessageNode(message))
    syncThinking(wrap)
    root.replaceChildren(wrap)
  }
  $("jump").hidden = state.stick || !state.activeId
  if (state.stick) root.scrollTop = root.scrollHeight
}

const dirty = new Set()
let dirtyFrame = 0
function markDirty(id) {
  if (!id) return
  dirty.add(id)
  if (dirtyFrame) return
  dirtyFrame = requestAnimationFrame(flushDirty)
}

function flushDirty() {
  dirtyFrame = 0
  const root = $("stream")
  if (!state.activeId || root.querySelector(".empty-main") || root.querySelector(".home")) {
    dirty.clear()
    renderStream()
    return
  }
  const wrap = thread()
  const stick = state.stick
  for (const id of dirty) {
    const message = state.messages.find((item) => item.info?.id === id)
    const existing = wrap.querySelector(`[data-id="${CSS.escape(id)}"]`)
    captureDetails(existing)
    if (!message) {
      existing?.remove()
      continue
    }
    const node = renderMessageNode(message)
    if (existing) existing.replaceWith(node)
    else wrap.append(node)
  }
  dirty.clear()
  syncThinking(wrap)
  if (stick) root.scrollTop = root.scrollHeight
  $("jump").hidden = stick || !state.activeId
}

