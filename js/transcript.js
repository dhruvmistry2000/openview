// Message list updates.
function sortMessages() {
  state.messages.sort((a, b) => (a.info?.time?.created || 0) - (b.info?.time?.created || 0) || String(a.info?.id || "").localeCompare(String(b.info?.id || "")))
}

function dropPending() {
  const removed = []
  state.messages = state.messages.filter((message) => {
    if (String(message.info?.id || "").startsWith("pending:")) {
      removed.push(message.info.id)
      return false
    }
    return true
  })
  return removed
}

function upsertMessageInfo(info) {
  if (!info?.id || info.sessionID !== state.activeId && info.sessionID) {
    if (info?.sessionID && info.sessionID !== state.activeId) return
  }
  if (info.sessionID && info.sessionID !== state.activeId) return
  if (info.role === "user") {
    for (const id of dropPending()) {
      thread().querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove()
    }
  }
  let message = state.messages.find((item) => item.info?.id === info.id)
  if (!message) {
    message = { info, parts: [] }
    state.messages.push(message)
    sortMessages()
  } else {
    message.info = { ...message.info, ...info }
  }
  markDirty(info.id)
}

function ensureMessage(messageID, sessionID) {
  let message = state.messages.find((item) => item.info?.id === messageID)
  if (!message) {
    message = {
      info: { id: messageID, sessionID, role: "assistant", time: { created: Date.now() } },
      parts: [],
    }
    state.messages.push(message)
    sortMessages()
  }
  return message
}

function upsertPart(part) {
  if (!part?.messageID) return
  if (part.sessionID && part.sessionID !== state.activeId) return
  const message = ensureMessage(part.messageID, part.sessionID)
  const index = message.parts.findIndex((item) => item.id === part.id)
  if (index === -1) message.parts.push(part)
  else message.parts[index] = part
  markDirty(message.info.id)
}

function applyDelta(props) {
  if (!props?.messageID || !props.partID) return
  if (props.sessionID && props.sessionID !== state.activeId) return
  const message = ensureMessage(props.messageID, props.sessionID)
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
  markDirty(message.info.id)
}

function removeMessage(messageID) {
  state.messages = state.messages.filter((item) => item.info?.id !== messageID)
  const node = $("stream").querySelector(`[data-id="${CSS.escape(messageID)}"]`)
  if (node) node.remove()
  else renderStream()
}

function removePart(messageID, partID) {
  const message = state.messages.find((item) => item.info?.id === messageID)
  if (!message) return
  message.parts = message.parts.filter((part) => part.id !== partID)
  markDirty(messageID)
}

function touchSession(id) {
  const session = state.sessions.get(id)
  if (!session) return
  session.time = { ...(session.time || {}), updated: Date.now() }
  scheduleSidebar()
}

