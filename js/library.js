// Agent and skill library.
const LIBRARY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function libraryDirectory() {
  return $("lib-project").value || pickerDirectory()
}

function libraryPath() {
  const name = $("lib-name").value.trim() || "name"
  const skill = state.libraryKind === "skill"
  const file = skill ? `skills/${name}/SKILL.md` : `agents/${name}.md`
  if ($("lib-scope").value === "global") return `~/.config/opencode/${file}`
  const dir = $("lib-project").value
  return `${dir ? projectLabel(dir) : "project"}/.opencode/${file}`
}

function syncLibraryForm() {
  const skill = state.libraryKind === "skill"
  $("lib-tab-agent").setAttribute("aria-selected", String(!skill))
  $("lib-tab-skill").setAttribute("aria-selected", String(skill))
  $("lib-mode-wrap").hidden = skill
  $("lib-body").placeholder = skill ? "Steps to follow once this skill is loaded." : "How this agent should work."
  $("lib-project-wrap").hidden = $("lib-scope").value === "global"
  const name = $("lib-name").value.trim()
  const path = $("lib-path")
  const invalid = name && (!LIBRARY_NAME.test(name) || name.length > 64)
  path.classList.toggle("warn", Boolean(invalid))
  path.classList.toggle("mono", !invalid)
  path.textContent = invalid ? "Lowercase letters, numbers, and single hyphens." : libraryPath()
}

function shortLocation(location, directory) {
  const value = String(location || "")
  if (!value || value === "<built-in>") return "Built in"
  if (directory && value.startsWith(directory)) return "This project"
  if (value.includes("/.config/opencode/")) return "Every project"
  const parts = value.split("/").filter(Boolean)
  return parts.slice(-3, -1).join("/") || value
}

function renderLibraryList() {
  const list = $("lib-list")
  const projectScope = $("lib-scope").value === "project"
  const directory = projectScope ? $("lib-project").value : ""
  const rows = []
  if (state.libraryKind === "agent") {
    for (const agent of state.libraryAgents) {
      if (!agent?.name || agent.hidden || agent.native) continue
      rows.push({ name: agent.name, meta: agent.mode || "agent" })
    }
  } else {
    for (const skill of state.librarySkills) {
      if (!skill?.name) continue
      const where = shortLocation(skill.location, directory)
      if (where === "Built in") continue
      if (projectScope && where !== "This project") continue
      if (!projectScope && where === "This project") continue
      rows.push({ name: skill.name, meta: where })
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  list.replaceChildren()
  if (!rows.length) {
    list.append(el("div", "lib-row", projectScope ? "Nothing in this project yet." : "Nothing saved for every project yet."))
    return
  }
  for (const row of rows) {
    const line = el("div", "lib-row")
    line.setAttribute("role", "listitem")
    line.append(el("span", null, row.name), el("span", null, row.meta))
    list.append(line)
  }
}

function fillLibraryProjects() {
  const select = $("lib-project")
  const preferred = currentSession()?.directory || selectedProject()?.worktree || select.value || ""
  select.replaceChildren(option("", "Choose a project"))
  for (const project of projectOptions()) select.append(option(project.worktree, project.label))
  if (preferred && [...select.options].some((item) => item.value === preferred)) select.value = preferred
}

async function loadLibrary() {
  const dir = $("lib-scope").value === "project" ? $("lib-project").value : libraryDirectory()
  if ($("lib-scope").value === "project" && !dir) {
    state.libraryAgents = []
    state.librarySkills = []
    const list = $("lib-list")
    list.replaceChildren(el("div", "lib-row", "Choose a project to see what is already loaded."))
    return
  }
  try {
    const agents = await getJSON("/agent", dir || undefined)
    state.libraryAgents = Array.isArray(agents) ? agents : []
  } catch {
    state.libraryAgents = []
  }
  try {
    const skills = await getJSON("/skill", dir || undefined)
    state.librarySkills = Array.isArray(skills) ? skills : []
  } catch {
    state.librarySkills = []
  }
  renderLibraryList()
}

function openLibrary() {
  fillLibraryProjects()
  $("lib-result").hidden = true
  $("lib-result").replaceChildren()
  syncLibraryForm()
  const dialog = $("library-dialog")
  if (!dialog.open) dialog.showModal()
  loadLibrary()
}

function showLibraryResult(message, isError, extra) {
  const box = $("lib-result")
  box.hidden = false
  box.replaceChildren(el("p", isError ? "hint warn" : "hint", message))
  if (!extra?.content) return
  const head = el("div", "codehead")
  head.append(el("span", null, extra.path || "file"), copyButton(extra.content))
  const pre = el("pre")
  pre.append(el("code", null, extra.content))
  const block = el("div", "codeblock")
  block.append(head, pre)
  box.append(block)
}

async function postLibrary(body) {
  const res = await fetch("/_library", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = { error: text } }
  }
  if (res.status === 409) {
    const err = new Error(data?.error || "A file with that name already exists")
    err.status = 409
    err.data = data
    throw err
  }
  if (!res.ok) throw new Error(data?.error || `Could not save (${res.status})`)
  return data
}

async function saveLibrary(event) {
  event.preventDefault()
  const name = $("lib-name").value.trim()
  const description = $("lib-desc").value.trim()
  const body = $("lib-body").value.trim()
  const scope = $("lib-scope").value
  const directory = scope === "project" ? $("lib-project").value : ""
  if (!LIBRARY_NAME.test(name) || name.length > 64) {
    showLibraryResult("Use a lowercase name with single hyphens, up to 64 characters.", true)
    return
  }
  if (!description || description.length > 1024) {
    showLibraryResult("Add a description of what this is for, up to 1024 characters.", true)
    return
  }
  if (!body) {
    showLibraryResult("Add the instructions.", true)
    return
  }
  if (scope === "project" && !directory) {
    showLibraryResult("Choose a project. The project list is empty until a session is loaded.", true)
    return
  }
  const payload = {
    kind: state.libraryKind,
    scope,
    directory,
    name,
    description,
    body,
    mode: $("lib-mode").value,
  }
  const button = $("lib-save")
  button.disabled = true
  try {
    let data
    try {
      data = await postLibrary(payload)
    } catch (err) {
      if (err.status !== 409) throw err
      if (!confirm("A file with that name already exists. Replace it?")) {
        showLibraryResult(err.message, true, err.data)
        return
      }
      data = await postLibrary({ ...payload, overwrite: true })
    }
    if (data?.written) {
      showLibraryResult(`Saved ${data.path}. OpenCode reads it on the next turn.`, false)
      state.pickerDir = null
      loadPickers(directory || pickerDirectory())
      loadLibrary()
    } else {
      showLibraryResult(data?.reason || "The file was not written. Copy it to the path above.", true, data)
    }
  } catch (err) {
    showLibraryResult(err.message || "Could not save the file", true)
  } finally {
    button.disabled = false
  }
}

