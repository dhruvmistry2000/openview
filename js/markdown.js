// Transcript rendering.
function appendInline(parent, text) {
  const source = String(text ?? "")
  let index = 0
  while (index < source.length) {
    if (source[index] === "`") {
      const end = source.indexOf("`", index + 1)
      if (end > index) {
        parent.append(el("code", null, source.slice(index + 1, end)))
        index = end + 1
        continue
      }
    }
    if (source.startsWith("**", index)) {
      const end = source.indexOf("**", index + 2)
      if (end > index + 1) {
        const strong = el("strong")
        appendInline(strong, source.slice(index + 2, end))
        parent.append(strong)
        index = end + 2
        continue
      }
    }
    if (source[index] === "*" && source[index + 1] !== "*") {
      const startOk = index === 0 || /\W/.test(source[index - 1])
      const end = source.indexOf("*", index + 1)
      const endOk = end > index + 1 && (end === source.length - 1 || /\W/.test(source[end + 1] || " "))
      if (startOk && endOk) {
        const em = el("em")
        appendInline(em, source.slice(index + 1, end))
        parent.append(em)
        index = end + 1
        continue
      }
    }
    if (source[index] === "[") {
      const close = source.indexOf("]", index + 1)
      if (close > index && source[close + 1] === "(") {
        const end = source.indexOf(")", close + 2)
        if (end > close) {
          const label = source.slice(index + 1, close)
          const href = source.slice(close + 2, end).trim()
          if (/^(https?:|mailto:)/i.test(href)) {
            const link = el("a")
            link.href = href
            link.target = "_blank"
            link.rel = "noreferrer noopener"
            appendInline(link, label)
            parent.append(link)
          } else {
            parent.append(document.createTextNode(source.slice(index, end + 1)))
          }
          index = end + 1
          continue
        }
      }
    }
    let next = index + 1
    while (next < source.length && source[next] !== "`" && source[next] !== "*" && source[next] !== "[") next++
    parent.append(document.createTextNode(source.slice(index, next)))
    index = next
  }
}

function isTable(lines, index) {
  if (!lines[index] || !lines[index].includes("|") || index + 1 >= lines.length) return false
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])
}

function splitRow(line) {
  let text = line.trim()
  if (text.startsWith("|")) text = text.slice(1)
  if (text.endsWith("|")) text = text.slice(0, -1)
  return text.split("|").map((cell) => cell.trim())
}

function renderTable(rows) {
  const table = el("table")
  const head = el("thead")
  const headRow = el("tr")
  for (const cell of splitRow(rows[0])) {
    const th = el("th")
    appendInline(th, cell)
    headRow.append(th)
  }
  head.append(headRow)
  table.append(head)
  const body = el("tbody")
  for (const line of rows.slice(2)) {
    if (!line.trim()) continue
    const tr = el("tr")
    for (const cell of splitRow(line)) {
      const td = el("td")
      appendInline(td, cell)
      tr.append(td)
    }
    body.append(tr)
  }
  table.append(body)
  return table
}

function isBlockStart(lines, index) {
  const line = lines[index]
  if (!line || !line.trim()) return true
  return line.startsWith("```")
    || /^\s*#{1,6}\s+/.test(line)
    || /^\s*>\s?/.test(line)
    || /^\s*([-*+]|\d+\.)\s+/.test(line)
    || isTable(lines, index)
}

function svgIcon() {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  node.setAttribute("viewBox", "0 0 24 24")
  node.setAttribute("width", "16")
  node.setAttribute("height", "16")
  node.setAttribute("aria-hidden", "true")
  node.setAttribute("fill", "none")
  node.setAttribute("stroke", "currentColor")
  node.setAttribute("stroke-width", "1.75")
  node.setAttribute("stroke-linecap", "round")
  node.setAttribute("stroke-linejoin", "round")
  return node
}

function copyButton(text) {
  const button = el("button", "icon-btn")
  button.type = "button"
  button.setAttribute("aria-label", "Copy code")
  const copy = svgIcon()
  copy.classList.add("copy-glyph")
  for (const box of [{ x: "8", y: "8" }, { x: "4.5", y: "4.5" }]) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect")
    rect.setAttribute("x", box.x)
    rect.setAttribute("y", box.y)
    rect.setAttribute("width", "11")
    rect.setAttribute("height", "11")
    rect.setAttribute("rx", "1.5")
    copy.append(rect)
  }
  const check = svgIcon()
  check.classList.add("ok-glyph")
  const mark = document.createElementNS("http://www.w3.org/2000/svg", "path")
  mark.setAttribute("d", "M6.5 12.5 10 16l7.5-8")
  check.append(mark)
  button.append(copy, check)
  button.addEventListener("click", () => copyCode(text, button))
  return button
}

function copyCode(text, button) {
  const done = () => {
    button.classList.add("copied")
    button.setAttribute("aria-label", "Copied")
    setTimeout(() => {
      button.classList.remove("copied")
      button.setAttribute("aria-label", "Copy code")
    }, 1400)
  }
  const fallback = () => {
    const area = el("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.left = "-9999px"
    document.body.append(area)
    area.select()
    const ok = document.execCommand("copy")
    area.remove()
    if (ok) done()
  }
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, fallback)
    return
  }
  fallback()
}

function renderMarkdown(container, source) {
  container.replaceChildren()
  const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n")
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim()
      const body = []
      index += 1
      while (index < lines.length && !lines[index].startsWith("```")) {
        body.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      const text = body.join("\n")
      const wrap = el("div", "codeblock")
      const head = el("div", "codehead")
      head.append(el("span", "mono", lang || ""))
      head.append(copyButton(text))
      wrap.append(head)
      const pre = el("pre")
      pre.append(el("code", null, text))
      wrap.append(pre)
      container.append(wrap)
      continue
    }
    if (isTable(lines, index)) {
      const rows = []
      while (index < lines.length && lines[index].includes("|")) {
        rows.push(lines[index])
        index += 1
      }
      container.append(renderTable(rows))
      continue
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/)
    if (heading) {
      const node = el("h" + heading[1].length)
      appendInline(node, heading[2])
      container.append(node)
      index += 1
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const body = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ""))
        index += 1
      }
      const quote = el("blockquote")
      renderMarkdown(quote, body.join("\n"))
      container.append(quote)
      continue
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const list = el(ordered ? "ol" : "ul")
      while (index < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[index])) {
        const item = el("li")
        appendInline(item, lines[index].replace(/^\s*([-*+]|\d+\.)\s+/, ""))
        list.append(item)
        index += 1
      }
      container.append(list)
      continue
    }
    if (!line.trim()) {
      index += 1
      continue
    }
    const body = [line]
    index += 1
    while (index < lines.length && !isBlockStart(lines, index)) {
      body.push(lines[index])
      index += 1
    }
    const paragraph = el("p")
    appendInline(paragraph, body.join(" "))
    container.append(paragraph)
  }
}

function toolSummary(part) {
  const toolState = part.state || {}
  const input = toolState.input || {}
  const raw = toolState.title || input.command || input.filePath || input.path || input.pattern || input.query || input.url || input.description || ""
  return String(raw).replace(/\s+/g, " ").trim()
}

function pretty(value) {
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function truncate(text, limit) {
  const value = String(text ?? "")
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n… (${value.length - limit} more characters)`
}

function captureDetails(node) {
  if (!node) return
  for (const details of node.querySelectorAll("details[data-part]")) {
    state.detailsOpen.set(details.dataset.part, details.open)
  }
}

function renderPart(part) {
  if (!part || part.ignored) return null
  if (part.type === "text") {
    const block = el("div", "md")
    renderMarkdown(block, part.text || "")
    return block
  }
  if (part.type === "reasoning") {
    const details = el("details", "reason")
    details.dataset.part = part.id || ""
    if (part.id && state.detailsOpen.get(part.id)) details.open = true
    const summary = el("summary")
    summary.append(el("span", "fold-label", "Thinking"))
    details.append(summary)
    const block = el("div", "md")
    renderMarkdown(block, part.text || "")
    details.append(block)
    return details
  }
  if (part.type === "tool") {
    const toolState = part.state || {}
    const details = el("details", "tool")
    details.dataset.part = part.id || ""
    if (part.id && state.detailsOpen.get(part.id)) details.open = true
    const summary = el("summary")
    const name = part.tool || "tool"
    const one = toolSummary(part)
    summary.append(el("i", "dot " + (toolState.status || "pending")))
    summary.append(el("span", "tool-sum", one || name))
    if (one) summary.append(el("span", "tool-name", name))
    details.append(summary)
    if (toolState.input && typeof toolState.input === "object" && Object.keys(toolState.input).length) {
      const pre = el("pre", "tool-in")
      pre.append(el("code", null, pretty(toolState.input)))
      details.append(pre)
    }
    const output = toolState.status === "error" ? toolState.error : toolState.output
    if (output) {
      const pre = el("pre", "tool-out" + (toolState.status === "error" ? " is-error" : ""))
      pre.append(el("code", null, truncate(output, 4000)))
      details.append(pre)
    }
    return details
  }
  if (part.type === "file") return el("div", "note mono", part.filename || part.url || "file")
  if (part.type === "subtask") return el("div", "note", part.description || part.prompt || "Subtask")
  if (part.type === "compaction") return el("div", "note", "Compaction")
  if (part.type === "retry") return el("div", "note", errorText(part.error) || "Retrying")
  if (part.type === "patch") return el("div", "note mono", (part.files || []).join(", "))
  if (part.type === "agent") return el("div", "note", part.name || "Agent")
  return null
}

function formatCost(value) {
  if (typeof value !== "number" || !(value > 0)) return ""
  if (value < 0.0001) return "<$0.0001"
  return "$" + value.toFixed(value < 0.01 ? 4 : 2)
}

function revertCut() {
  const id = currentSession()?.revert?.messageID
  if (!id) return -1
  return state.messages.findIndex((item) => item.info?.id === id)
}

function renderMessageNode(message) {
  const info = message.info || {}
  const role = info.role || "assistant"
  const cut = revertCut()
  const undone = cut !== -1 && state.messages.indexOf(message) >= cut
  const article = el("article", "msg msg-" + role)
  article.dataset.id = info.id || ""
  if (undone) article.classList.add("reverted")
  if (role === "user") {
    article.append(el("p", "kicker", "You"))
    const body = el("div", "user-body")
    let any = false
    for (const part of message.parts || []) {
      if (part?.type === "text") {
        const block = el("div", "md")
        renderMarkdown(block, part.text || "")
        body.append(block)
        any = true
      } else {
        const node = renderPart(part)
        if (node) {
          body.append(node)
          any = true
        }
      }
    }
    if (!any) body.append(el("p", null, ""))
    article.append(body)
    if (undone) {
      const note = el("p", "kicker", "Undone")
      note.style.marginTop = "6px"
      article.append(note)
    } else if (String(info.id || "").startsWith("msg")) {
      const actions = el("div", "msg-actions")
      const undo = el("button", "ghost", "Undo")
      undo.type = "button"
      undo.title = "Undo this message and everything after it"
      undo.addEventListener("click", () => revertTo(info.id))
      actions.append(undo)
      article.append(actions)
    }
    return article
  }
  for (const part of message.parts || []) {
    const node = renderPart(part)
    if (node) article.append(node)
  }
  if (info.error) article.append(el("div", "msg-error", errorText(info.error)))
  const bits = []
  const model = [info.providerID, info.modelID].filter(Boolean).join("/")
  if (model) bits.push(model)
  if (info.tokens) {
    const input = Number(info.tokens.input) || 0
    const output = Number(info.tokens.output) || 0
    if (input || output) bits.push(`${input.toLocaleString()} in · ${output.toLocaleString()} out`)
  }
  const cost = formatCost(info.cost)
  if (cost) bits.push(cost)
  if (bits.length) article.append(el("footer", "msg-foot mono", bits.join("  ·  ")))
  return article
}

function thread() {
  let node = $("stream").querySelector(".thread")
  if (!node) {
    node = el("div", "thread")
    $("stream").replaceChildren(node)
  }
  return node
}

