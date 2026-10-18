// Shared page state and small DOM helpers.
const BUCKETS = ["Today", "Yesterday", "This week", "Older"]
const state = {
  projects: [],
  sessions: new Map(),
  status: new Map(),
  permissions: [],
  questions: [],
  messages: [],
  queue: [],
  tabs: [],
  views: new Map(),
  homeDraft: "",
  activeId: null,
  projectFilter: "all",
  query: "",
  settings: { url: "", username: "", password: "" },
  agent: "build",
  model: "opencode\u001fbig-pickle",
  skill: "",
  agents: [],
  models: [],
  skills: [],
  commands: [],
  pickerDir: null,
  pickerGen: 0,
  apiAvailable: false,
  dbAvailable: false,
  conn: "connecting",
  dbFeed: "off",
  offline: false,
  unavailable: false,
  loadingMessages: false,
  stick: true,
  loadGen: 0,
  folded: new Set(),
  ignoreHash: false,
  detailsOpen: new Map(),
  home: "",
  listed: false,
  starting: false,
  outgoing: "",
  bannerKind: "",
  libraryKind: "agent",
  libraryAgents: [],
  librarySkills: [],
  changesGen: 0,
  changesOpenFile: "",
  changes: { loaded: false, git: false, branch: "", directory: "", sessionId: "", status: [], sessionFiles: [], patches: null },
}

const $ = (id) => document.getElementById(id)

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null && text !== false) node.textContent = text
  return node
}

function option(value, label) {
  const node = el("option", null, label)
  node.value = value
  return node
}

