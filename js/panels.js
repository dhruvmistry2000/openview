// Opening and closing the side panels.
function openSettings() {
  $("set-url").value = state.settings.url
  $("set-user").value = state.settings.username
  $("set-pass").value = state.settings.password
  const dialog = $("settings-dialog")
  if (!dialog.open) dialog.showModal()
  loadHosted()
}

function sidebarNarrow() {
  return window.matchMedia("(max-width: 760px)").matches
}

function syncSidebar() {
  const sidebar = $("sidebar")
  const collapsed = $("app").classList.contains("sidebar-collapsed")
  const expanded = sidebarNarrow() ? sidebar.classList.contains("open") : !collapsed
  sidebar.inert = !expanded
  $("menu").setAttribute("aria-expanded", expanded ? "true" : "false")
  $("menu").setAttribute("aria-label", expanded ? "Hide sessions" : "Show sessions")
  syncScrim()
}

function changesCollapsed() {
  return $("app").classList.contains("changes-collapsed")
}

function syncChanges() {
  const panel = $("changes")
  const narrow = sidebarNarrow()
  const collapsed = changesCollapsed()
  const expanded = !panel.hidden && (narrow ? panel.classList.contains("open") : !collapsed)
  panel.inert = !expanded
  const show = $("show-changes")
  show.hidden = false
  show.disabled = panel.hidden
  const label = panel.hidden ? "No changes to show" : (expanded ? "Hide changes" : "Show changes")
  show.setAttribute("aria-expanded", expanded ? "true" : "false")
  show.setAttribute("aria-label", label)
  show.title = label
  syncScrim()
}

function rememberChanges(collapsed) {
  $("app").classList.toggle("changes-collapsed", collapsed)
  localStorage.setItem("oc-ui-changes", collapsed ? "closed" : "open")
  if (collapsed) $("changes").classList.remove("open")
  syncChanges()
}

function collapseChanges() {
  rememberChanges(true)
  if (!$("show-changes").hidden) $("show-changes").focus()
}

function expandChanges() {
  if ($("changes").hidden) return
  if (sidebarNarrow()) {
    $("sidebar").classList.remove("open")
    $("changes").classList.add("open")
    syncSidebar()
    syncChanges()
    return
  }
  rememberChanges(false)
}

function rememberSidebar(collapsed) {
  $("app").classList.toggle("sidebar-collapsed", collapsed)
  localStorage.setItem("oc-ui-sidebar", collapsed ? "closed" : "open")
  syncSidebar()
}

function syncScrim() {
  if (!sidebarNarrow()) {
    $("scrim").classList.remove("show")
    return
  }
  const open = $("sidebar").classList.contains("open") || $("changes").classList.contains("open")
  $("scrim").classList.toggle("show", open)
}

function closeDrawer() {
  $("sidebar").classList.remove("open")
  $("changes").classList.remove("open")
  syncSidebar()
  syncChanges()
}

function openDrawer() {
  $("changes").classList.remove("open")
  $("sidebar").classList.add("open")
  syncSidebar()
  syncChanges()
  $("search").focus()
}

function collapseSidebar() {
  rememberSidebar(true)
  closeDrawer()
  $("menu").focus()
}

function expandSidebar() {
  if (sidebarNarrow()) {
    openDrawer()
    return
  }
  rememberSidebar(false)
  $("search").focus()
}

