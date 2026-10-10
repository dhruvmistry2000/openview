// Permission and question cards.
function patternText(value) {
  if (!value) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "string" ? item : (item?.pattern || item?.path || item?.title || JSON.stringify(item))).join("\n")
  }
  return JSON.stringify(value)
}

function normalizePermission(raw) {
  if (!raw) return null
  const id = raw.id || raw.requestID
  if (!id) return null
  return {
    id,
    sessionID: raw.sessionID,
    permission: raw.permission || raw.action || "permission",
    patterns: raw.patterns || raw.resources || [],
    metadata: raw.metadata || {},
  }
}

function upsertPermission(raw) {
  const item = normalizePermission(raw)
  if (!item) return
  const index = state.permissions.findIndex((entry) => entry.id === item.id)
  if (index === -1) state.permissions.push(item)
  else state.permissions[index] = { ...state.permissions[index], ...item }
  renderPrompts()
  scheduleSidebar()
}

function removePermission(id) {
  if (!id) return
  state.permissions = state.permissions.filter((item) => item.id !== id)
  renderPrompts()
  scheduleSidebar()
}

async function loadPermissions() {
  const dirs = []
  for (const project of state.projects) dirs.push(project.worktree)
  if (state.home && !dirs.some((dir) => isHomeDir(dir))) dirs.push(state.home)
  const pull = async (dir) => {
    try {
      const list = await getJSON("/permission", dir)
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }
  const batches = await Promise.all([pull(undefined), ...dirs.map((dir) => pull(dir))])
  const map = new Map()
  for (const batch of batches) {
    for (const item of batch) {
      const normalized = normalizePermission(item)
      if (normalized) map.set(normalized.id, normalized)
    }
  }
  state.permissions = [...map.values()]
  renderPrompts()
}

async function loadQuestions() {
  try {
    const list = await getJSON("/question")
    state.questions = Array.isArray(list) ? list.filter((item) => item?.id) : []
  } catch {
    /* optional */
  }
  renderPrompts()
}

function renderPrompts() {
  const root = $("prompts")
  root.replaceChildren()
  const sessionId = state.activeId
  for (const item of state.permissions) {
    if (sessionId && item.sessionID && item.sessionID !== sessionId) continue
    const card = el("div", "card")
    card.append(el("h3", null, item.permission || "Permission"))
    const patterns = patternText(item.patterns)
    if (patterns) card.append(el("p", "patterns mono", patterns))
    const actions = el("div", "card-actions")
    for (const [reply, label] of [["once", "Allow once"], ["always", "Always allow"], ["reject", "Reject"]]) {
      const button = el("button", reply === "reject" ? "ghost danger" : "ghost", label)
      button.type = "button"
      button.addEventListener("click", () => replyPermission(item, reply))
      actions.append(button)
    }
    card.append(actions)
    root.append(card)
  }
  for (const item of state.questions) {
    if (sessionId && item.sessionID && item.sessionID !== sessionId) continue
    root.append(questionCard(item))
  }
}

function questionCard(item) {
  const card = el("div", "card")
  card.append(el("h3", null, "Question"))
  const questions = Array.isArray(item.questions) ? item.questions : []
  const picks = questions.map(() => new Set())
  questions.forEach((question, index) => {
    const block = el("div", "q-block")
    block.append(el("strong", null, question.header || question.question || "Question"))
    if (question.question && question.question !== question.header) block.append(el("p", null, question.question))
    const row = el("div", "card-actions")
    for (const choice of question.options || []) {
      const button = el("button", "ghost", choice.label)
      button.type = "button"
      button.title = choice.description || ""
      button.addEventListener("click", () => {
        if (question.multiple) {
          if (picks[index].has(choice.label)) picks[index].delete(choice.label)
          else picks[index].add(choice.label)
          button.setAttribute("aria-pressed", picks[index].has(choice.label) ? "true" : "false")
        } else {
          picks[index].clear()
          picks[index].add(choice.label)
          for (const child of row.querySelectorAll("button")) child.setAttribute("aria-pressed", "false")
          button.setAttribute("aria-pressed", "true")
        }
      })
      row.append(button)
    }
    if (question.custom) {
      const input = el("input", "q-custom")
      input.placeholder = "Your own answer"
      input.addEventListener("input", () => {
        picks[index].custom = input.value
      })
      block.append(input)
    }
    block.append(row)
    card.append(block)
  })
  const actions = el("div", "card-actions")
  const send = el("button", "ghost", "Reply")
  send.type = "button"
  send.addEventListener("click", () => replyQuestion(item, questions, picks))
  const dismiss = el("button", "ghost danger", "Dismiss")
  dismiss.type = "button"
  dismiss.addEventListener("click", () => rejectQuestion(item))
  actions.append(send, dismiss)
  card.append(actions)
  return card
}

async function replyPermission(item, reply) {
  const session = state.sessions.get(item.sessionID) || currentSession()
  const directory = session?.directory
  try {
    await request("POST", `/permission/${encodeURIComponent(item.id)}/reply`, directory, { reply })
    removePermission(item.id)
  } catch (err) {
    if (err.status === 404 || err.status === 405 || err.status === 400) {
      try {
        await request(
          "POST",
          `/session/${encodeURIComponent(item.sessionID)}/permissions/${encodeURIComponent(item.id)}`,
          directory,
          { response: reply },
        )
        removePermission(item.id)
        return
      } catch (fallback) {
        showBanner(fallback.message || "Couldn't reply to the permission")
        return
      }
    }
    showBanner(err.message || "Couldn't reply to the permission")
  }
}

async function replyQuestion(item, questions, picks) {
  const session = state.sessions.get(item.sessionID) || currentSession()
  const answers = questions.map((question, index) => {
    const selected = [...picks[index]]
    if (picks[index].custom) selected.push(picks[index].custom)
    if (!selected.length && question.options?.[0]) selected.push(question.options[0].label)
    return selected
  })
  try {
    await request("POST", `/question/${encodeURIComponent(item.id)}/reply`, session?.directory, { answers })
    state.questions = state.questions.filter((entry) => entry.id !== item.id)
    renderPrompts()
  } catch (err) {
    showBanner(err.message || "Couldn't reply to the question")
  }
}

async function rejectQuestion(item) {
  const session = state.sessions.get(item.sessionID) || currentSession()
  try {
    await request("POST", `/question/${encodeURIComponent(item.id)}/reject`, session?.directory)
    state.questions = state.questions.filter((entry) => entry.id !== item.id)
    renderPrompts()
  } catch (err) {
    showBanner(err.message || "Couldn't dismiss the question")
  }
}

