// Reads and updates opencode.jsonc for a self-hosted model.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { sendJson } from "./respond.mjs"

const PROVIDER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,200}$/
const NPM = "@ai-sdk/openai-compatible"
const AGENTS = new Set(["build", "plan"])
const PRESETS = {
  ollama: { id: "ollama", name: "Ollama", baseURL: "http://127.0.0.1:11434/v1" },
  lmstudio: { id: "lmstudio", name: "LM Studio", baseURL: "http://127.0.0.1:1234/v1" },
  vllm: { id: "vllm", name: "vLLM", baseURL: "http://127.0.0.1:8000/v1" },
}

function configError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(configError(413, "That request is too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function configRoot() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.resolve(base, "opencode")
}

function inDocker() {
  return fs.existsSync("/.dockerenv")
}

export function configPath() {
  const root = configRoot()
  const jsonc = path.join(root, "opencode.jsonc")
  const json = path.join(root, "opencode.json")
  if (fs.existsSync(jsonc) || !fs.existsSync(json)) return jsonc
  return json
}

function displayPath(file) {
  const home = os.homedir()
  const prefix = home.endsWith(path.sep) ? home : home + path.sep
  if (file.startsWith(prefix)) return `~/${file.slice(prefix.length)}`
  return file
}

function hasComment(text) {
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escape) escape = false
      else if (c === "\\") escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === "/" && text[i + 1] === "/") return true
    if (c === "/" && text[i + 1] === "*") return true
  }
  return false
}

function stripTrailingCommas(text) {
  let out = ""
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (escape) escape = false
      else if (c === "\\") escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === "}" || text[j] === "]") continue
    }
    out += c
  }
  return out
}

function parseConfig(text) {
  const raw = String(text || "").trim()
  if (!raw) return {}
  if (hasComment(raw)) {
    throw configError(409, "This config file has comments, so Openview will not rewrite it")
  }
  try {
    const value = JSON.parse(stripTrailingCommas(raw))
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw configError(400, "OpenCode config must be a JSON object")
    }
    return value
  } catch (err) {
    if (err.status) throw err
    throw configError(400, "OpenCode config is not valid JSON")
  }
}

function readConfig() {
  const file = configPath()
  if (!fs.existsSync(file)) return { file, config: {} }
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    throw configError(500, "Could not read the OpenCode config")
  }
  return { file, config: parseConfig(text) }
}

function writeConfig(file, config) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  let mode = 0o600
  try {
    mode = fs.statSync(file).mode & 0o777
  } catch { /* a new file stays private because it can hold an API key */ }
  const tmp = path.join(dir, `.opencode.jsonc.${process.pid}.tmp`)
  const text = `${JSON.stringify(config, null, 2)}\n`
  try {
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode })
    fs.renameSync(tmp, file)
  } catch {
    try { fs.unlinkSync(tmp) } catch { /* the temp file may already be gone */ }
    throw configError(500, "Could not write the OpenCode config")
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function cleanLine(value, label, max) {
  if (value == null || value === "") return ""
  if (typeof value !== "string") throw configError(400, `${label} must be text`)
  const text = value.trim()
  if (text.includes("\0") || /[\r\n]/.test(text)) throw configError(400, `${label} must be a single line`)
  if (text.length > max) throw configError(400, `${label} is too long`)
  return text
}

function httpUrl(value) {
  const text = cleanLine(value, "Address", 300)
  if (!text) throw configError(400, "Address is required")
  let url
  try {
    url = new URL(text)
  } catch {
    throw configError(400, "Address must be an http or https URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw configError(400, "Address must be an http or https URL")
  }
  if (url.username || url.password) throw configError(400, "Put a key in the API key field")
  if (url.hash) throw configError(400, "Address cannot include a fragment")
  return url.origin + url.pathname.replace(/\/$/, "") + url.search
}

function modelRef(providerID, modelID) {
  return `${providerID}/${modelID}`
}

function wholeNumber(value, label) {
  if (value == null || value === "") return null
  const number = typeof value === "number" ? value : Number(String(value).trim())
  if (!Number.isInteger(number) || number < 1 || number > 2_000_000) {
    throw configError(400, `${label} must be a whole number`)
  }
  return number
}

function ensureProvider(config) {
  if (config.provider == null) config.provider = {}
  if (!plainObject(config.provider)) throw configError(400, "provider in the config is not an object")
  return config.provider
}

function findModel(config, providerID, modelID) {
  const provider = config.provider?.[providerID]
  const models = provider?.models
  if (!plainObject(provider) || !plainObject(models) || !plainObject(models[modelID])) return null
  return models[modelID]
}

function applyFlags(config, providerID, modelID, payload) {
  const ref = modelRef(providerID, modelID)
  if (payload.default === true) config.model = ref
  else if (payload.default === false && config.model === ref) delete config.model
  if (payload.small === true) config.small_model = ref
  else if (payload.small === false && config.small_model === ref) delete config.small_model
}

function applyAgent(config, payload) {
  if (payload.defaultAgent == null || payload.defaultAgent === "") return
  if (!AGENTS.has(payload.defaultAgent)) throw configError(400, "Default agent must be build or plan")
  config.default_agent = payload.defaultAgent
}

function checkedModel(payload) {
  const providerID = cleanLine(payload.providerID, "Provider", 64)
  const modelID = cleanLine(payload.modelID, "Model id", 200)
  if (!PROVIDER_ID.test(providerID)) throw configError(400, "Provider id must be lowercase words with single hyphens")
  if (!MODEL_ID.test(modelID) || modelID.includes("..")) throw configError(400, "Model id has characters OpenCode cannot use")
  return { providerID, modelID }
}

function removeHosted(config, payload) {
  const { providerID, modelID } = checkedModel(payload)
  if (!findModel(config, providerID, modelID)) throw configError(404, "That model is not in the config yet")
  const providers = config.provider
  delete providers[providerID].models[modelID]
  if (Object.keys(providers[providerID].models).length === 0) delete providers[providerID]
  if (Object.keys(providers).length === 0) delete config.provider
  const ref = modelRef(providerID, modelID)
  if (config.model === ref) delete config.model
  if (config.small_model === ref) delete config.small_model
  return config
}

export function applyHosted(config, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw configError(400, "Expected JSON")
  }
  if (payload.remove === true) return removeHosted(config, payload)
  applyAgent(config, payload)
  const modelText = payload.modelID == null ? "" : String(payload.modelID).trim()
  if (!modelText && !payload.onlyFlags) return config
  if (payload.onlyFlags) {
    const { providerID, modelID } = checkedModel(payload)
    if (!findModel(config, providerID, modelID)) throw configError(404, "That model is not in the config yet")
    applyFlags(config, providerID, modelID, payload)
    return config
  }

  const preset = PRESETS[payload.preset] || null
  const providerID = preset ? preset.id : cleanLine(payload.providerID, "Provider id", 64)
  if (!providerID || !PROVIDER_ID.test(providerID)) {
    throw configError(400, "Provider id must be lowercase words with single hyphens")
  }
  const modelID = cleanLine(payload.modelID, "Model id", 200)
  if (!MODEL_ID.test(modelID) || modelID.includes("..")) {
    throw configError(400, "Model id has characters OpenCode cannot use")
  }
  const baseURL = httpUrl(payload.baseURL || preset?.baseURL || "")
  const providerName = cleanLine(payload.name, "Display name", 80) || preset?.name || providerID
  const modelName = cleanLine(payload.modelName, "Name in the menu", 80) || modelID
  const apiKey = cleanLine(payload.apiKey, "API key", 500)
  const context = wholeNumber(payload.context, "Context tokens")
  const output = wholeNumber(payload.output, "Max output tokens")
  if ((context == null) !== (output == null)) {
    throw configError(400, "Set both context tokens and max output tokens, or leave both empty")
  }

  const providers = ensureProvider(config)
  const prev = plainObject(providers[providerID]) ? providers[providerID] : {}
  const options = plainObject(prev.options) ? { ...prev.options } : {}
  options.baseURL = baseURL
  if (apiKey) options.apiKey = apiKey
  else if (payload.clearApiKey === true) delete options.apiKey

  const models = plainObject(prev.models) ? { ...prev.models } : {}
  const entry = plainObject(models[modelID]) ? { ...models[modelID] } : {}
  entry.name = modelName
  if (payload.toolCall === false) entry.tool_call = false
  else delete entry.tool_call
  if (context != null) entry.limit = { context, output }
  else delete entry.limit
  models[modelID] = entry

  providers[providerID] = {
    ...prev,
    npm: typeof prev.npm === "string" && prev.npm.trim() ? prev.npm : NPM,
    name: providerName,
    options,
    models,
  }
  if (!config.$schema) config.$schema = "https://opencode.ai/config.json"
  applyFlags(config, providerID, modelID, payload)
  return config
}

function publicView(file, config) {
  const models = []
  const providers = plainObject(config.provider) ? config.provider : {}
  for (const [providerID, provider] of Object.entries(providers)) {
    if (!plainObject(provider) || !plainObject(provider.models)) continue
    const providerName = typeof provider.name === "string" && provider.name.trim() ? provider.name.trim() : providerID
    const baseURL = typeof provider.options?.baseURL === "string" ? provider.options.baseURL : ""
    const hasApiKey = Boolean(provider.options?.apiKey)
    for (const [modelID, model] of Object.entries(provider.models)) {
      if (!plainObject(model)) continue
      const ref = modelRef(providerID, modelID)
      models.push({
        providerID,
        providerName,
        baseURL,
        hasApiKey,
        modelID,
        name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : modelID,
        toolCall: model.tool_call !== false,
        context: Number.isInteger(model.limit?.context) ? model.limit.context : null,
        output: Number.isInteger(model.limit?.output) ? model.limit.output : null,
        default: config.model === ref,
        small: config.small_model === ref,
      })
    }
  }
  models.sort((a, b) => `${a.providerName} ${a.name}`.localeCompare(`${b.providerName} ${b.name}`))
  return {
    path: displayPath(file),
    model: typeof config.model === "string" ? config.model : "",
    small_model: typeof config.small_model === "string" ? config.small_model : "",
    default_agent: typeof config.default_agent === "string" ? config.default_agent : "",
    models,
  }
}

export async function handleConfig(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, { error: "Use GET or POST" })
    return
  }
  try {
    if (req.method === "GET") {
      const { file, config } = readConfig()
      sendJson(res, 200, publicView(file, config))
      return
    }
    if (inDocker()) {
      sendJson(res, 200, {
        skip: true,
        path: "~/.config/opencode/opencode.jsonc",
        reason: "This proxy is running in Docker, so it cannot write your config directory. Edit opencode.jsonc on the host.",
        models: [],
      })
      return
    }
    const payload = JSON.parse(await readBody(req))
    const { file, config } = readConfig()
    applyHosted(config, payload)
    writeConfig(file, config)
    sendJson(res, 200, publicView(file, config))
  } catch (err) {
    const status = err.status || (err instanceof SyntaxError ? 400 : 500)
    if (status >= 500) console.error("config:", err.message)
    if (!res.headersSent) {
      sendJson(res, status, { error: status === 400 && err instanceof SyntaxError ? "Expected JSON" : (err.message || "Could not update the config") })
    }
  }
}
