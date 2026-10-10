# Openview

A browser client for [OpenCode](https://opencode.ai). It lists sessions from every project and lets you read, send, rename, abort, and delete them from a browser, including a phone on your LAN or Tailscale.

The page is plain HTML, CSS, and JavaScript. `server.mjs` is a zero-dependency Node proxy: it serves the page and forwards everything else to `opencode serve`.

## Run

Start OpenCode’s HTTP server:

```bash
opencode serve --port 4096
```

In another terminal, from this directory:

```bash
node server.mjs
```

Open http://127.0.0.1:8080.

Node 22 or newer is required for the database listing (`node:sqlite`). The proxy itself runs on Node 18 or newer; without `node:sqlite`, session listing falls back to the HTTP API.

### Docker

OpenCode keeps running on the host. The image is only this proxy.

```bash
opencode serve --port 4096 --hostname 127.0.0.1
docker compose up --build
```

Compose uses the host network, so `OPENCODE_URL` defaults to `http://127.0.0.1:4096` and the UI defaults to `http://127.0.0.1:8080`. The database directory is mounted read-only at `/data/opencode` (`OPENCODE_DATA_DIR`, default `$HOME/.local/share/opencode`). The process still opens the file with `node:sqlite` `readOnly: true`.

`opencode serve --hostname 127.0.0.1` is not reachable from a bridge network. Host networking is what makes that bind work. To publish the UI on a user-defined network instead, run OpenCode on an address the container can route to and pass that URL:

```bash
docker build -t openview .
docker run --rm -p 127.0.0.1:8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  -e OPENCODE_URL=http://host.docker.internal:4096 \
  -e OPENCODE_DB=/data/opencode/opencode.db \
  -v "$HOME/.local/share/opencode:/data/opencode:ro" \
  openview
```

Inside the image the process binds `0.0.0.0` so Docker’s published port can connect. That prints the non-loopback warning even when `-p` is limited to `127.0.0.1`.

For a phone, LAN, or Tailscale, set a UI password and bind the host address. With Compose that is `HOST=0.0.0.0` (host networking has no separate publish address):

```bash
UI_USERNAME=opencode UI_PASSWORD='replace-me' HOST=0.0.0.0 docker compose up --build
```

Set `OPENCODE_SERVER_PASSWORD` to the same value passed to `opencode serve` when that server requires Basic auth.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | OpenCode server to proxy |
| `HOST` | `127.0.0.1` | Address this UI binds |
| `PORT` | `8080` | Port this UI binds |
| `OPENCODE_SERVER_USERNAME` | `opencode` | Basic auth username sent upstream |
| `OPENCODE_SERVER_PASSWORD` | unset | Basic auth password sent upstream |
| `UI_USERNAME` | empty | Optional username for the UI itself |
| `UI_PASSWORD` | unset | Optional password for the UI itself |
| `OPENCODE_DB` | unset | Optional path to `opencode.db` |

Leave the in-page connection settings empty when you use the proxy. Those fields are only for pointing the browser directly at OpenCode, which also needs `opencode serve --cors` for your origin.

## Phone, LAN, and Tailscale

Binding beyond loopback exposes the UI to anyone who can reach the port. Set a UI password, and set OpenCode’s own password too:

```bash
OPENCODE_SERVER_PASSWORD='replace-me' opencode serve --port 4096 --hostname 127.0.0.1

UI_USERNAME=opencode UI_PASSWORD='replace-me-too' \
  HOST=0.0.0.0 PORT=8080 \
  OPENCODE_SERVER_PASSWORD='replace-me' \
  node server.mjs
```

The process prints a warning when `HOST` is not loopback and `UI_PASSWORD` is unset. Reach the UI at `http://<lan-or-tailscale-ip>:8080`. The OpenCode server can stay on `127.0.0.1`; the proxy is the only process that needs to face the network.

## Sessions from every project

`GET /session` only returns the project selected by `?directory=` (or the server’s working directory). The sidebar does two things:

1. It loads `GET /project`, then `GET /session?directory=<worktree>` for each project, and sorts by `time.updated`. The worktree `/` is skipped. Each later call for a session sends `?directory=` from that session.
2. It also asks the proxy for `GET /_db/sessions`. That endpoint opens OpenCode’s SQLite file **read-only** (`node:sqlite`, `readOnly: true`, `PRAGMA query_only`). It never writes. Deletes, renames, and prompts still go through the OpenCode HTTP API. If the file is missing the proxy returns 404; if `node:sqlite` is missing it returns 501. The page ignores both and keeps the API list.

The database path is `OPENCODE_DB`, then `$XDG_DATA_HOME/opencode/opencode.db`, then `~/.local/share/opencode/opencode.db`, then on macOS `~/Library/Application Support/opencode/opencode.db`. If `opencode.db` is not in that directory, the newest `opencode*.db` is used (`opencode-local.db` for dev builds, `opencode.db` for release builds). Columns come from `PRAGMA table_info`, not a hard-coded schema. Root sessions only; archived rows are omitted unless `?archived=1`. `?q=` searches titles and `?limit=` caps the list.

API rows win over database rows when both exist. A database session whose project the server cannot open shows: “This session’s project isn’t available to the server.”

The header project menu defaults to **All projects**. That view lists the eight newest sessions under Recents, then each project from most sessions to fewest, with that project's sessions underneath. The chevron beside Home, Recents, or a project hides that list, and the choice is remembered. **+** on a project starts a session there. Choosing one project limits the sidebar to it. **New session** creates the session in the chosen project, and in All projects it asks which project to use.

## Home

With no session open, the page is Home: a greeting, a message box in the middle, and a few system-task suggestions. A suggestion fills the box. Sending starts a session in the home folder of the machine running the proxy (`GET /_home`) and sends that first message. While that happens the page shows your message and a working animation, and the same animation stays under the transcript until a reply begins. The greeting and the box fade in only on this page. **Home** in the header returns there. **+** on Home in the sidebar starts an empty session there. Those sessions stay listed under Home, and the project menu leaves that folder out. Recents can still include them. Inside Docker, this is the container user's home, not the host's.

## Real-time

The client prefers `GET /global/event`, one server-sent stream for every project (`{directory, payload}`). If that route is missing it opens `GET /event?directory=` per project. Streams use `fetch` and a `ReadableStream`, so auth headers work. A dropped stream reconnects after 2 seconds and reloads sessions and the open transcript.

## Changes

With a session open, changed files sit in a panel on the right, in the same place the terminal UI keeps them. The header shows the branch and how many files differ. Each row is a status letter, the file name, and the added and removed counts. Select a row to read that file’s diff. The panel slides over the page with the same control as the session list, and that choice is remembered. Closing either panel leaves the conversation where it is. A project that is not a git checkout only shows session files, and the panel stays hidden when there is nothing to report. The list refreshes when the session goes idle.

## Undo

Each of your messages has **Undo**. That reverts the session to just before that message: later messages are set aside, and files the session wrote after that point go back to how they were. **Restore** puts the messages and the files back. Undo waits until the session is idle.

## Agents and skills

**Library** in the header writes one markdown file through the proxy (`POST /_library`). OpenCode has no create API for these; it discovers files.

| Kind | This project | Every project |
| --- | --- | --- |
| Agent | `<project>/.opencode/agents/<name>.md` | `~/.config/opencode/agents/<name>.md` |
| Skill | `<project>/.opencode/skills/<name>/SKILL.md` | `~/.config/opencode/skills/<name>/SKILL.md` |

The name is lowercase words with single hyphens, and for a skill it is also the folder name. A primary agent is listed in the agent menu. A subagent is one another agent can call. The file body is the agent prompt, or the skill instructions. The description is what the model sees when deciding whether to load a skill.

Saving replaces an existing file only after a confirmation. Names cannot contain path separators. The proxy will not write into `/` or your home directory, and it will not follow a symlink out of the destination folder.

When the proxy runs in Docker it cannot see your config directory, so a global save returns the markdown to copy onto the host. A project save works only when that project directory exists inside the container.

## Known limitations

- Child sessions and archived sessions are hidden.
- The markdown renderer covers headings, lists, blockquotes, tables, links, emphasis, inline code, and fenced code. It does not render raw HTML, images, or nested lists.
- Tool output is truncated in the page. Open the tool row to read the stored text.
- Questions from the model can be answered or dismissed. There is no file upload or fork. Diff and undo are in the session view.
- A direct server URL (settings dialog) needs OpenCode’s `--cors` flag. The proxy path does not.
- The database reader can miss a session that has not been committed yet, and it cannot revive a project the running server has never opened. Those rows still appear, and opening them explains that the project is unavailable.
- Model and agent menus come from `GET /config/providers` and `GET /agent` for the open session, or for the home folder when none is open. Switching folder replaces that list. The starting choices are the build agent and Big Pickle. A project with neither configured still lets you send with the server’s defaults. New agents and skills are files written by Library; the menu refreshes after a primary agent is saved.
- Status, permissions, and agents are best-effort. A missing optional route does not blank the page.
