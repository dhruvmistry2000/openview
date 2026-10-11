// Self-hosted model form. Writes opencode.jsonc through the proxy.
const HOSTED_PRESETS = {
  ollama: { name: "Ollama", url: "http://127.0.0.1:11434/v1" },
  lmstudio: { name: "LM Studio", url: "http://127.0.0.1:1234/v1" },
  vllm: { name: "vLLM", url: "http://127.0.0.1:8000/v1" },
}

function hostedNote(view) {
  const note = $("hosted-note")
  if (view?.skip) {
    note.textContent = view.reason || "Openview cannot write the OpenCode config from here."
    return
  }
  const where = view?.path || "~/.config/opencode/opencode.jsonc"
  note.textContent = `Saved to ${where}. Restart OpenCode, then the model shows up in the menu.`
}

function hostedResult(text, warn) {
  const node = $("hosted-result")
  node.hidden = !text
  node.classList.toggle("warn", Boolean(warn))
  node.textContent = text || ""
}

function syncHostedPreset() {
  const preset = HOSTED_PRESETS[$("hosted-preset").value]
  $("hosted-id-wrap").hidden = Boolean(preset)
  if (!preset) return
  const urls = new Set(Object.values(HOSTED_PRESETS).map((item) => item.url))
  const names = new Set(Object.values(HOSTED_PRESETS).map((item) => item.name))
  const url = $("hosted-url")
  const name = $("hosted-name")
  if (!url.value || urls.has(url.value)) url.value = preset.url
  if (!name.value || names.has(name.value)) name.value = preset.name
}

function renderHostedList(models) {
  const list = $("hosted-list")
  list.replaceChildren()
  if (!models?.length) {
    list.hidden = true
    return
  }
  list.hidden = false
  for (const item of models) {
    const row = el("div", "hosted-row")
    row.setAttribute("role", "listitem")
    const title = el("span", null, `${item.providerName} / ${item.name}`)
    title.title = `${item.providerID}/${item.modelID}`
    const make = (checked, label, key) => {
      const wrap = el("label", "check")
      const box = document.createElement("input")
      box.type = "checkbox"
      box.checked = checked
      box.setAttribute("aria-label", `${label} for ${item.name}`)
      box.addEventListener("change", () => saveHostedFlags(item, key, box))
      wrap.append(box, document.createTextNode(label))
      return wrap
    }
    const remove = el("button", "ghost danger", "Remove")
    remove.type = "button"
    remove.addEventListener("click", () => deleteHosted(item))
    row.append(
      title,
      make(item.default, "Default", "default"),
      make(item.small, "Titles", "small"),
      remove,
    )
    list.append(row)
  }
}

async function hostedPost(body, fallback = "Could not save the model") {
  const res = await fetch("/_config", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || fallback)
  return data
}

async function loadHosted() {
  hostedResult("")
  try {
    const res = await fetch("/_config", { credentials: "same-origin" })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || "Could not read the OpenCode config")
    hostedNote(data)
    renderHostedList(data.models)
    const agent = $("hosted-agent")
    agent.value = data.default_agent === "build" || data.default_agent === "plan" ? data.default_agent : ""
    if (!$("hosted-url").value) syncHostedPreset()
  } catch (err) {
    hostedResult(err.message || "Could not read the OpenCode config", true)
  }
}

async function deleteHosted(item) {
  const name = item.name || item.modelID
  if (!confirm(`Remove “${name}” from the OpenCode config?`)) return
  hostedResult("")
  try {
    const data = await hostedPost({
      remove: true,
      providerID: item.providerID,
      modelID: item.modelID,
    }, "Could not remove the model")
    if (data.skip) {
      hostedResult(data.reason, true)
      return
    }
    renderHostedList(data.models)
    hostedResult("Removed. Restart OpenCode, then reload this page.")
  } catch (err) {
    hostedResult(err.message, true)
  }
}

async function saveHostedFlags(item, key, box) {
  const body = {
    onlyFlags: true,
    providerID: item.providerID,
    modelID: item.modelID,
    [key]: box.checked,
  }
  try {
    const data = await hostedPost(body)
    if (data.skip) {
      box.checked = !box.checked
      hostedResult(data.reason, true)
      return
    }
    renderHostedList(data.models)
    hostedResult("Saved. Restart OpenCode, then reload this page.")
  } catch (err) {
    box.checked = !box.checked
    hostedResult(err.message, true)
  }
}

function optionalCount(id, label) {
  const text = $(id).value.trim()
  if (!text) return undefined
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${label} must be a whole number`)
  return Number(text)
}

async function saveHosted(event) {
  event.preventDefault()
  hostedResult("")
  let context
  let output
  try {
    context = optionalCount("hosted-context", "Context tokens")
    output = optionalCount("hosted-output", "Max output tokens")
    if ((context == null) !== (output == null)) throw new Error("Set both token fields, or leave both empty")
  } catch (err) {
    hostedResult(err.message, true)
    return
  }
  const preset = $("hosted-preset").value
  const body = {
    preset,
    providerID: preset === "other" ? $("hosted-id").value.trim() : preset,
    name: $("hosted-name").value.trim(),
    baseURL: $("hosted-url").value.trim(),
    modelID: $("hosted-model").value.trim(),
    modelName: $("hosted-label").value.trim(),
    apiKey: $("hosted-key").value,
    toolCall: $("hosted-tools").checked,
    default: $("hosted-default").checked,
    small: $("hosted-small").checked,
  }
  if (context != null) body.context = context
  if (output != null) body.output = output
  const agent = $("hosted-agent").value
  if (agent) body.defaultAgent = agent
  if (!body.modelID && !body.defaultAgent) {
    hostedResult("Add the model id from your server.", true)
    return
  }
  try {
    const data = await hostedPost(body)
    if (data.skip) {
      hostedResult(data.reason, true)
      return
    }
    hostedNote(data)
    renderHostedList(data.models)
    $("hosted-key").value = ""
    hostedResult("Saved. Restart OpenCode, then reload this page.")
  } catch (err) {
    hostedResult(err.message, true)
  }
}
