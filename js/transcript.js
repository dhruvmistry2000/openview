// Message list updates. Open background tabs keep their own lists.
function sortMessages() {
  sortList(state.messages)
}

function dropPending(sessionID) {
  const id = sessionID || state.activeId
  const list = id ? listFor(id) : state.messages
  if (!list) return []
  const removed = []
  const next = list.filter((message) => {
    if (String(message.info?.id || "").startsWith("pending:")) {
      removed.push(message.info.id)
      return false
    }
    return true
  })
  if (!removed.length) return removed
  assignList(id, next)
  if (id && id === state.activeId) {
    for (const pendingId of removed) {
      $("stream").querySelector(`[data-id="${CSS.escape(pendingId)}"]`)?.remove()
    }
  }
  return removed
}

function acceptsSession(sessionID) {
  if (!sessionID || sessionID === state.activeId) return true
  return state.tabs.includes(sessionID)
}

function upsertMessageInfo(info) {
  if (!info?.id || !acceptsSession(info.sessionID)) return
  const sessionID = info.sessionID || state.activeId
  if (info.role === "user") dropPending(sessionID)
  const list = listFor(sessionID)
  if (!list) return
  let message = list.find((item) => item.info?.id === info.id)
  if (!message) {
    message = { info, parts: [] }
    list.push(message)
    sortList(list)
  } else {
    message.info = { ...message.info, ...info }
  }
  if (!sessionID || sessionID === state.activeId) markDirty(info.id)
  else markUnseen(sessionID)
}

function ensureMessage(messageID, sessionID) {
  const list = listFor(sessionID)
  if (!list) return null
  let message = list.find((item) => item.info?.id === messageID)
  if (!message) {
    message = {
      info: { id: messageID, sessionID, role: "assistant", time: { created: Date.now() } },
      parts: [],
    }
    list.push(message)
    sortList(list)
  }
  return message
}

function upsertPart(part) {
  if (!part?.messageID || !acceptsSession(part.sessionID)) return
  const message = ensureMessage(part.messageID, part.sessionID)
  if (!message) return
  const index = message.parts.findIndex((item) => item.id === part.id)
  if (index === -1) message.parts.push(part)
  else message.parts[index] = part
  if (!part.sessionID || part.sessionID === state.activeId) markDirty(message.info.id)
  else markUnseen(part.sessionID)
}

function applyDelta(props) {
  if (!props?.messageID || !props.partID || !acceptsSession(props.sessionID)) return
  const message = ensureMessage(props.messageID, props.sessionID)
  if (!message) return
  let part = message.parts.find((item) => item.id === props.partID)
  if (!part) {
    part = {
      id: props.partID,
      messageID: props.messageID,
      sessionID: props.sessionID,
      type: props.field === "text" ? "text" : "reasoning",
    }
    message.parts.push(part)
  }
  const current = typeof part[props.field] === "string" ? part[props.field] : ""
  part[props.field] = current + (props.delta || "")
  if (!part.type) part.type = props.field === "text" ? "text" : "reasoning"
  if (!props.sessionID || props.sessionID === state.activeId) markDirty(message.info.id)
  else markUnseen(props.sessionID)
}

function sessionIdsFor(sessionID) {
  if (sessionID) return [sessionID]
  const ids = []
  if (state.activeId) ids.push(state.activeId)
  for (const id of state.tabs) if (!ids.includes(id)) ids.push(id)
  return ids
}

function removeMessage(messageID, sessionID) {
  for (const id of sessionIdsFor(sessionID)) {
    const list = listFor(id)
    if (!list?.some((item) => item.info?.id === messageID)) continue
    assignList(id, list.filter((item) => item.info?.id !== messageID))
    if (id !== state.activeId) continue
    const node = $("stream").querySelector(`[data-id="${CSS.escape(messageID)}"]`)
    if (node) node.remove()
    else renderStream()
  }
}

function removePart(messageID, partID, sessionID) {
  for (const id of sessionIdsFor(sessionID)) {
    const list = listFor(id)
    const message = list?.find((item) => item.info?.id === messageID)
    if (!message) continue
    message.parts = message.parts.filter((part) => part.id !== partID)
    if (id === state.activeId) markDirty(messageID)
  }
}

function touchSession(id) {
  const session = state.sessions.get(id)
  if (!session) return
  session.time = { ...(session.time || {}), updated: Date.now() }
  scheduleSidebar()
}

