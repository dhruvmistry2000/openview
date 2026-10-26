// Requests to the proxy and to OpenCode.
function basicAuth(user, pass) {
  const bytes = new TextEncoder().encode(`${user}:${pass}`)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

function withDir(path, directory) {
  const url = new URL(path, "http://local.invalid")
  if (directory) url.searchParams.set("directory", directory)
  return url.pathname + url.search
}

function errorText(err) {
  if (!err) return ""
  if (typeof err === "string") return err
  if (typeof err.data?.message === "string") return err.data.message
  if (typeof err.message === "string" && err.name) return `${err.name}: ${err.message}`
  if (typeof err.message === "string") return err.message
  try { return JSON.stringify(err) } catch { return "Request failed" }
}

function showLimitDialog(text) {
  try {
    const dialog = document.getElementById("limit-dialog")
    const msg = document.getElementById("limit-message")
    const closeBtn = document.getElementById("limit-close")
    if (!dialog) return false
    if (msg) msg.textContent = text || "You've reached your usage limit. Please check your plan or try again later."
    if (closeBtn) {
      closeBtn.onclick = () => dialog.close()
    }
    if (!dialog.open) dialog.showModal()
    return true
  } catch {
    return false
  }
}

function isLimitError(err, status, data) {
  if (status === 429) return true
  if (status === 402 || status === 403) {
    const txt = String((typeof data === "string" ? data : errorText(data) || err?.message || "")).toLowerCase()
    if (txt.includes("limit") || txt.includes("quota") || txt.includes("credit") || txt.includes("usage") || txt.includes("billing") || txt.includes("exceed") || txt.includes("rate")) return true
  }
  const txt = String((typeof data === "string" ? data : errorText(data) || err?.message || "")).toLowerCase()
  return txt.includes("usage limit") || txt.includes("rate limit") || txt.includes("quota exceeded") || txt.includes("limit exceeded") || txt.includes("out of credits") || txt.includes("insufficient credits") || txt.includes("exceeded your") || txt.includes("plan limit")
}

function showBanner(text, kind = "info") {
  state.bannerKind = kind
  const banner = $("banner")
  const shown = String(text || "")
  const clipped = shown.length > 500 ? `${shown.slice(0, 500)}…` : shown
  if (state.activeId) {
    const view = state.views.get(state.activeId)
    if (view) {
      view.banner = clipped
      view.bannerKind = kind
    }
  }
  banner.hidden = false
  banner.replaceChildren(el("span", null, clipped))
  const dismiss = el("button", "text-btn", "Dismiss")
  dismiss.type = "button"
  dismiss.addEventListener("click", clearBanner)
  banner.append(dismiss)
}

function clearBanner() {
  state.bannerKind = ""
  if (state.activeId) {
    const view = state.views.get(state.activeId)
    if (view) {
      view.banner = ""
      view.bannerKind = ""
    }
  }
  const banner = $("banner")
  banner.hidden = true
  banner.replaceChildren()
}

async function apiFetch(path, opts = {}) {
  const base = state.settings.url.replace(/\/$/, "")
  const url = /^https?:\/\//.test(path) ? path : base + path
  const headers = new Headers(opts.headers || {})
  if (state.settings.url && (state.settings.username || state.settings.password)) {
    headers.set("authorization", basicAuth(state.settings.username, state.settings.password))
  }
  const hasBody = opts.body !== undefined
  if (hasBody && !headers.has("content-type")) headers.set("content-type", "application/json")
  let res
  try {
    res = await fetch(url, {
      method: opts.method || "GET",
      headers,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      credentials: "same-origin",
    })
  } catch (err) {
    if (err.name === "AbortError") throw err
    state.offline = true
    state.conn = "offline"
    showBanner("Can't reach the server", "offline")
    renderFooter()
    const wrapped = new Error("Can't reach the server")
    wrapped.offline = true
    throw wrapped
  }
  if (state.offline) {
    state.offline = false
    if (state.bannerKind === "offline") clearBanner()
    if (state.conn === "offline") state.conn = "live"
    renderFooter()
  }
  if (res.status === 401) {
    showBanner("The server refused these credentials.", "auth")
    openSettings()
    const err = new Error("Unauthorized")
    err.status = 401
    throw err
  }
  return res
}

async function request(method, path, directory, body) {
  const res = await apiFetch(withDir(path, directory), { method, body })
  if (res.status === 204) return null
  const text = await res.text()
  let data = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }
  if (!res.ok) {
    const msg = typeof data === "string" && data ? data : errorText(data) || `${res.status}`
    if (isLimitError(null, res.status, data) || isLimitError(null, res.status, msg)) {
      showLimitDialog(msg)
    }
    const err = new Error(msg)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

function getJSON(path, directory) {
  return request("GET", path, directory)
}

