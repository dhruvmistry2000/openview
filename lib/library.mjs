// Writes one agent or skill markdown file for POST /_library.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { sendJson } from "./respond.mjs"

const LIBRARY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const LIBRARY_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:@+-]*$/

function libraryError(status, message, extra) {
  const err = new Error(message)
  err.status = status
  if (extra) Object.assign(err, extra)
  return err
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(libraryError(413, "That file is too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function yamlQuote(value) {
  return JSON.stringify(String(value))
}

function configRoot() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.resolve(base, "opencode")
}

function inDocker() {
  return fs.existsSync("/.dockerenv")
}

function cleanText(value, label, max) {
  if (typeof value !== "string") throw libraryError(400, `${label} is required`)
  const text = value.replace(/\r\n/g, "\n").trim()
  if (!text) throw libraryError(400, `${label} is required`)
  if (text.includes("\0")) throw libraryError(400, `${label} contains a null character`)
  if (text.length > max) throw libraryError(400, `${label} is too long`)
  return text
}

function libraryName(value) {
  const name = cleanText(value, "Name", 64)
  if (!LIBRARY_NAME.test(name)) {
    throw libraryError(400, "Name must be lowercase letters, numbers, and single hyphens")
  }
  return name
}

function libraryMarkdown(input) {
  const kind = input.kind === "skill" ? "skill" : input.kind === "agent" ? "agent" : ""
  if (!kind) throw libraryError(400, "Choose an agent or a skill")
  const name = libraryName(input.name)
  const description = cleanText(input.description, "Description", 1024)
  const body = cleanText(input.body, "Instructions", 100_000)
  const lines = ["---"]
  if (kind === "skill") lines.push(`name: ${yamlQuote(name)}`)
  lines.push(`description: ${yamlQuote(description)}`)
  if (kind === "agent") {
    const mode = input.mode === "subagent" ? "subagent" : input.mode === "primary" ? "primary" : ""
    if (!mode) throw libraryError(400, "Choose primary or subagent")
    lines.push(`mode: ${mode}`)
    if (input.model != null && String(input.model).trim()) {
      const model = String(input.model).trim()
      if (!LIBRARY_MODEL.test(model) || model.length > 200) throw libraryError(400, "Model must look like provider/model")
      lines.push(`model: ${model}`)
    }
  }
  lines.push("---", "", body, "")
  return { kind, name, content: lines.join("\n") }
}

function projectRoot(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw libraryError(400, "Choose a project")
  }
  let real
  try {
    real = fs.realpathSync(directory)
  } catch {
    throw libraryError(400, "That project directory is not visible to this proxy")
  }
  if (!fs.statSync(real).isDirectory()) throw libraryError(400, "Choose a project directory")
  if (real === path.parse(real).root || real === os.homedir()) {
    throw libraryError(400, "Refusing to write into that directory")
  }
  return real
}

function staysInside(root, target) {
  const rel = path.relative(root, target)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function libraryTarget(kind, scope, directory, name) {
  if (scope !== "project" && scope !== "global") throw libraryError(400, "Choose where to save it")
  if (scope === "global" && inDocker()) {
    const rel = kind === "agent" ? path.join("agents", `${name}.md`) : path.join("skills", name, "SKILL.md")
    return {
      skip: true,
      path: path.join("~/.config/opencode", rel),
      reason: "This proxy is running in Docker, so it cannot write your config directory. Copy the file to that path on the host.",
    }
  }
  const root = scope === "global" ? configRoot() : projectRoot(directory)
  const rel = kind === "agent"
    ? path.join(scope === "global" ? "agents" : path.join(".opencode", "agents"), `${name}.md`)
    : path.join(scope === "global" ? "skills" : path.join(".opencode", "skills"), name, "SKILL.md")
  const target = path.resolve(root, rel)
  if (!staysInside(root, target)) throw libraryError(400, "Refusing to write outside the chosen directory")
  return { root, target }
}

function writeLibrary(input) {
  const { kind, name, content } = libraryMarkdown(input)
  const scope = input.scope
  const dest = libraryTarget(kind, scope, input.directory, name)
  if (dest.skip) return { written: false, path: dest.path, content, reason: dest.reason }
  fs.mkdirSync(path.dirname(dest.target), { recursive: true })
  const realRoot = fs.realpathSync(dest.root)
  const realParent = fs.realpathSync(path.dirname(dest.target))
  if (!staysInside(realRoot, realParent) && realParent !== realRoot) {
    throw libraryError(400, "Refusing to follow a link outside the chosen directory")
  }
  if (fs.existsSync(dest.target)) {
    const realFile = fs.realpathSync(dest.target)
    if (!staysInside(realRoot, realFile)) {
      throw libraryError(400, "Refusing to follow a link outside the chosen directory")
    }
    if (input.overwrite !== true) {
      throw libraryError(409, "A file with that name already exists", { path: dest.target, content })
    }
  }
  const flag = input.overwrite === true ? "w" : "wx"
  try {
    fs.writeFileSync(dest.target, content, { encoding: "utf8", flag, mode: 0o644 })
  } catch (err) {
    if (err.code === "EEXIST") {
      throw libraryError(409, "A file with that name already exists", { path: dest.target, content })
    }
    throw libraryError(500, "Could not write the file")
  }
  return { written: true, path: dest.target, content }
}

export async function handleLibrary(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST" })
    return
  }
  let payload
  try {
    payload = JSON.parse(await readBody(req))
  } catch (err) {
    const status = err.status || 400
    if (!res.headersSent) sendJson(res, status, { error: status === 413 ? err.message : "Expected JSON" })
    return
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    sendJson(res, 400, { error: "Expected JSON" })
    return
  }
  try {
    const result = writeLibrary(payload)
    sendJson(res, result.written ? 201 : 200, result)
  } catch (err) {
    const status = err.status || 500
    if (status >= 500) console.error("library:", err.message)
    if (!res.headersSent) {
      sendJson(res, status, { error: err.message || "Could not write the file", path: err.path, content: err.content })
    }
  }
}
