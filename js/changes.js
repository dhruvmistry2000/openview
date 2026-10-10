// File changes panel.
function clearChanges() {
  state.changesGen += 1
  state.changesOpenFile = ""
  state.changes = { loaded: false, git: false, branch: "", directory: "", sessionId: "", status: [], sessionFiles: [], patches: null }
  renderChanges()
}

function statusMark(status) {
  if (status === "added") return "A"
  if (status === "deleted") return "D"
  if (status === "modified") return "M"
  return "•"
}

function middlePath(file) {
  const text = String(file || "")
  const max = 32
  if (text.length <= max) return text
  const base = text.split("/").pop() || text
  if (base.length >= max - 1) return `…${base.slice(-(max - 1))}`
  const dir = text.slice(0, text.length - base.length)
  const keep = Math.max(1, max - base.length - 2)
  return `${dir.slice(0, keep)}…/${base}`
}

function selectedChange() {
  const key = state.changesOpenFile
  if (!key) return null
  const splitAt = key.indexOf(":")
  const source = key.slice(0, splitAt)
  const file = key.slice(splitAt + 1)
  const rows = source === "session" ? state.changes.sessionFiles : state.changes.status
  const row = rows.find((item) => item.file === file)
  return row ? { key, source, file, row } : null
}

function cachedPatch(row, source) {
  if (source === "session" && row.patch) return row.patch
  if (!state.changes.patches) return undefined
  return state.changes.patches.get(row.file) || ""
}

function changesLabel() {
  const changes = state.changes
  if (!changes.loaded) return ""
  const parts = []
  if (changes.git && changes.branch) parts.push(changes.branch)
  if (changes.git) parts.push(changes.status.length ? `${changes.status.length} changed` : "clean")
  if (changes.sessionFiles.length) parts.push(`${changes.sessionFiles.length} in this session`)
  return parts.join(" · ")
}

function renderPatch(text) {
  const pre = el("pre", "patch")
  const code = el("code")
  const lines = String(text || "").split("\n")
  const shown = lines.slice(0, 4000)
  for (const line of shown) {
    let kind = ""
    if (line.startsWith("@@")) kind = "hunk"
    else if (line.startsWith("+") && !line.startsWith("+++")) kind = "add"
    else if (line.startsWith("-") && !line.startsWith("---")) kind = "del"
    code.append(el("span", kind, `${line}\n`))
  }
  if (lines.length > shown.length) code.append(el("span", "hunk", `\n… ${lines.length - shown.length} more lines\n`))
  pre.append(code)
  return pre
}

function renderChangeGroup(title, rows, source) {
  const group = el("div")
  if (title) group.append(el("h2", "change-label", title))
  if (!rows.length) {
    group.append(el("div", "change-empty", "No uncommitted changes."))
    return group
  }
  for (const row of rows) {
    const open = state.changesOpenFile === `${source}:${row.file}`
    const line = el("button", "change-row" + (open ? " active" : ""))
    line.type = "button"
    line.setAttribute("aria-pressed", String(open))
    line.title = row.file || ""
    const mark = el("span", `change-mark mono ${row.status || ""}`, statusMark(row.status))
    const file = el("span", "change-file mono", middlePath(row.file))
    const count = el("span", "change-count mono")
    count.append(el("span", "add", `+${row.additions || 0}`))
    if (row.deletions) {
      count.append(el("span", null, " "))
      count.append(el("span", "del", `−${row.deletions}`))
    }
    line.append(mark, file, count)
    line.addEventListener("click", () => toggleDiff(row, source))
    group.append(line)
  }
  return group
}

function renderChangeDiff() {
  const box = $("changes-diff")
  const selected = selectedChange()
  if (!selected) {
    box.hidden = true
    box.replaceChildren()
    return
  }
  box.hidden = false
  box.replaceChildren()
  const patch = cachedPatch(selected.row, selected.source)
  const head = el("div", "codehead")
  const name = el("span", "mono", selected.file)
  name.title = selected.file
  head.append(name)
  if (patch) head.append(copyButton(patch))
  const block = el("div", "codeblock")
  block.append(head)
  if (state.changes.diffLoading === selected.key) block.append(el("div", "change-empty", "Loading diff…"))
  else if (patch) block.append(renderPatch(patch))
  else if (patch === "") block.append(el("div", "change-empty", "No diff for this file."))
  else if (state.changes.diffError) block.append(el("div", "change-empty", state.changes.diffError))
  else block.append(el("div", "change-empty", "Loading diff…"))
  box.append(block)
}

function renderChanges() {
  const root = $("changes")
  const session = currentSession()
  const changes = state.changes
  const useful = Boolean(session && changes.loaded && changes.directory === session.directory)
  root.hidden = !useful
  if (!useful) {
    syncChanges()
    return
  }
  $("changes-meta").textContent = changesLabel()
  const list = $("changes-list")
  const scroll = list.scrollTop
  list.replaceChildren()
  if (changes.sessionFiles.length) list.append(renderChangeGroup("This session", changes.sessionFiles, "session"))
  if (changes.git) list.append(renderChangeGroup("Modified files", changes.status, "git"))
  list.scrollTop = scroll
  renderChangeDiff()
  syncChanges()
  const selected = selectedChange()
  if (selected && !state.changes.diffError && cachedPatch(selected.row, selected.source) === undefined && state.changes.diffLoading !== selected.key) {
    ensureDiff(selected.row, selected.source)
  }
}

async function loadChanges(directory, sessionId, keep) {
  const gen = ++state.changesGen
  if (!keep) state.changesOpenFile = ""
  if (!directory) {
    state.changes = { loaded: false, git: false, branch: "", directory: "", sessionId: "", status: [], sessionFiles: [], patches: null }
    renderChanges()
    return
  }
  let git = false
  let branch = ""
  try {
    const info = await getJSON("/vcs", directory)
    if (gen !== state.changesGen) return
    if (info && typeof info.branch === "string" && info.branch) {
      git = true
      branch = info.branch
    }
  } catch { /* not a git checkout, or the route is missing */ }
  let status = []
  if (git) {
    try {
      const rows = await getJSON("/vcs/status", directory)
      if (gen !== state.changesGen) return
      if (Array.isArray(rows)) status = rows.filter((row) => row && row.file)
    } catch { /* status is optional */ }
  }
  let sessionFiles = []
  if (sessionId) {
    try {
      const rows = await getJSON(`/session/${encodeURIComponent(sessionId)}/diff`, directory)
      if (gen !== state.changesGen) return
      if (Array.isArray(rows)) sessionFiles = rows.filter((row) => row && row.file)
    } catch { /* session diff is optional */ }
  }
  if (gen !== state.changesGen) return
  const useful = git || sessionFiles.length > 0
  state.changes = {
    loaded: useful,
    git,
    branch,
    directory,
    sessionId,
    status,
    sessionFiles,
    patches: null,
    diffLoading: "",
    diffError: "",
  }
  if (state.changesOpenFile) {
    const splitAt = state.changesOpenFile.indexOf(":")
    const source = state.changesOpenFile.slice(0, splitAt)
    const file = state.changesOpenFile.slice(splitAt + 1)
    const rows = source === "session" ? sessionFiles : status
    if (!rows.some((row) => row.file === file)) state.changesOpenFile = ""
  }
  renderChanges()
}

async function ensureDiff(row, source) {
  const key = `${source}:${row.file}`
  if (cachedPatch(row, source) !== undefined || state.changes.diffLoading === key) return
  state.changes.diffLoading = key
  state.changes.diffError = ""
  renderChanges()
  const directory = state.changes.directory
  try {
    if (!state.changes.patches) {
      const rows = await getJSON("/vcs/diff?mode=git", directory)
      if (state.changes.directory !== directory) return
      const patches = new Map()
      if (Array.isArray(rows)) {
        for (const item of rows) {
          if (item?.file) patches.set(item.file, item.patch || "")
        }
      }
      state.changes.patches = patches
    }
  } catch {
    if (state.changes.directory === directory) state.changes.diffError = "Couldn't load the diff."
  } finally {
    if (state.changes.directory === directory && state.changes.diffLoading === key) {
      state.changes.diffLoading = ""
      renderChanges()
    }
  }
}

function toggleDiff(row, source) {
  const key = `${source}:${row.file}`
  if (state.changesOpenFile === key) {
    state.changesOpenFile = ""
    renderChanges()
    return
  }
  state.changesOpenFile = key
  state.changes.diffError = ""
  renderChanges()
}

