import { escapeHtml, renderTestTextInput } from './render-utils.js';
import { createHistory, restoreSnapshot, saveSnapshot } from './history.js';
import { removeConnection } from './graph-editing.js';
import { serializeConflictCopy } from './conflict-copy.js';
import { parseRuleDraft, serializeRuleDraft } from './rule-transfer.js';
import { shouldIncludeTypedValue } from './typed-input.js';
import { applySaveSuccess } from './save-coordination.js';

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const state = {
  projects: [], project: null, ruleset: null, graph: null, revision: 0,
  editGeneration: 0,
  inspectorCollapsed: false,
  mobileTab: 'canvas',
  view: 'dashboard', selectedNodeId: null, selectedEdgeId: null, dirty: false, connectionSource: null,
  recovered: false,
  connectionPointer: null, drag: null, zoom: 1, offset: { x: 0, y: 0 },
  testInput: {}, result: null, errors: [], saveState: 'saved',
  history: createHistory(),
};
let toastTimer;
let autosaveTimer;
let retryTimer;

function clearAutosaveTimers() {
  clearTimeout(autosaveTimer);
  clearTimeout(retryTimer);
}

function scheduleAutosave() {
  if (state.view !== 'editor' || !state.ruleset || state.saveState === 'conflict') return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (state.view === 'editor' && state.dirty && state.saveState !== 'saving' && state.saveState !== 'conflict') {
      saveDraft({ isAutosave: true });
    }
  }, 1800);
}

const safeSvgNumber = (value) => Number.isFinite(value) ? String(value) : '0';
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const operatorLabels = { eq: 'equals', neq: 'does not equal', gt: 'is greater than', gte: 'is at least', lt: 'is less than', lte: 'is at most' };
const operatorsFor = (type) => type === 'number' || type === 'date'
  ? ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] : ['eq', 'neq'];

function showToast(message, kind = 'info') {
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3200);
}

function createRecordDialog(title, description) {
  const dialog = document.createElement('dialog');
  dialog.className = 'name-dialog record-dialog';
  const form = document.createElement('form');
  form.method = 'dialog';
  form.className = 'name-dialog-form';
  const kicker = document.createElement('div');
  kicker.className = 'dialog-kicker';
  kicker.textContent = 'LOCAL WORKSPACE RECORDS';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const note = document.createElement('p');
  note.textContent = description;
  const content = document.createElement('div');
  content.className = 'record-dialog-content';
  const actions = document.createElement('div');
  actions.className = 'dialog-actions';
  const close = document.createElement('button');
  close.className = 'button button-outline';
  close.textContent = 'Close';
  actions.append(close);
  form.append(kicker, heading, note, content, actions);
  dialog.append(form);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, content };
}

async function showVersionHistory() {
  const { versions } = await api(`/api/rulesets/${encodeURIComponent(state.ruleset.id)}/versions`);
  const { content } = createRecordDialog('Saved versions', 'These immutable graph snapshots belong to this local workspace.');
  if (!versions.length) {
    const empty = document.createElement('p');
    empty.className = 'panel-empty';
    empty.textContent = 'No saved versions yet.';
    content.append(empty);
    return;
  }
  for (const version of versions) {
    const row = document.createElement('div');
    row.className = 'record-row';
    const detail = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = `Version ${version.versionNumber} · revision ${version.sourceRevision}`;
    const hash = document.createElement('small');
    hash.textContent = `SHA-256 consistency hash ${version.graphHash.slice(0, 16)}… · ${new Date(version.createdAt).toLocaleString()}`;
    detail.append(name, hash);
    const replay = document.createElement('button');
    replay.className = 'button button-outline';
    replay.textContent = 'Replay';
    replay.addEventListener('click', () => {
      document.querySelector('dialog.name-dialog[open]')?.close();
      replayVersion(version.id).catch((error) => showToast(`Could not load saved version: ${error.message}`, 'error'));
    });
    row.append(detail, replay);
    content.append(row);
  }
}

async function replayVersion(versionId) {
  const { version } = await api(`/api/rulesets/${encodeURIComponent(state.ruleset.id)}/versions/${encodeURIComponent(versionId)}`);
  const { content } = createRecordDialog(`Replay version ${version.versionNumber}`, `Test the saved graph from revision ${version.sourceRevision}.`);
  const controls = new Map();
  for (const field of version.graph.schema) {
    const label = document.createElement('label');
    label.className = 'test-field';
    const caption = document.createElement('span');
    caption.textContent = `${field.name}${field.required === false ? ' (optional)' : ''} · ${field.type}`;
    let control;
    if (field.type === 'enum' || field.type === 'boolean') {
      control = document.createElement('select');
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'Choose…';
      control.append(empty);
      const options = field.type === 'boolean' ? [['true', 'True'], ['false', 'False']] : field.options.map((item) => [item, item]);
      for (const [value, text] of options) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        control.append(option);
      }
    } else {
      control = document.createElement('input');
      control.type = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text';
    }
    control.className = 'form-control';
    controls.set(field.name, { control, type: field.type });
    label.append(caption, control);
    content.append(label);
  }
  const output = document.createElement('pre');
  output.className = 'replay-result';
  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'button button-primary';
  run.textContent = 'Evaluate saved version';
  run.addEventListener('click', async () => {
    const input = {};
    for (const [name, { control, type }] of controls) {
      const field = version.graph.schema.find((item) => item.name === name);
      if (field && shouldIncludeTypedValue(field, control.value)) input[name] = parseTypedValue(control, type);
    }
    try {
      const result = await api(`/api/rulesets/${encodeURIComponent(state.ruleset.id)}/versions/${encodeURIComponent(version.id)}/evaluate`, { method: 'POST', body: JSON.stringify({ input }) });
      output.textContent = JSON.stringify(result.ok ? { result: result.result, trace: result.trace } : { errors: result.errors }, null, 2);
    } catch (error) { output.textContent = error.message; }
  });
  content.append(run, output);
}

async function showProjectActivity() {
  const { events } = await api(`/api/projects/${encodeURIComponent(state.project.id)}/audit`);
  const { content } = createRecordDialog('Project activity', 'Local event history; actor is recorded as “local workspace”.');
  if (!events.length) {
    const empty = document.createElement('p');
    empty.className = 'panel-empty';
    empty.textContent = 'No activity recorded yet.';
    content.append(empty);
    return;
  }
  for (const event of events) {
    const row = document.createElement('div');
    row.className = 'record-row record-row-activity';
    const detail = document.createElement('div');
    const type = document.createElement('strong');
    type.textContent = event.type;
    const when = document.createElement('small');
    when.textContent = `${event.actor} · ${new Date(event.occurredAt).toLocaleString()} · ${JSON.stringify(event.details)}`;
    detail.append(type, when);
    row.append(detail);
    content.append(row);
  }
}

function askForName(kind) {
  return new Promise((resolveName) => {
    const project = kind === 'project';
    const dialog = document.createElement('dialog');
    dialog.className = 'name-dialog';
    dialog.innerHTML = `<form method="dialog" class="name-dialog-form"><div class="dialog-kicker">NEW ${project ? 'PROJECT' : 'RULE SET'}</div><h2>${project ? 'Create a project' : 'Create a rule set'}</h2><p>${project ? 'Choose a clear name for this rules workspace.' : 'Give this decision flow a name.'}</p><label for="new-name">Name</label><input id="new-name" name="name" class="form-control" maxlength="80" required autocomplete="off"/><div class="dialog-actions"><button class="button button-outline" value="cancel">Cancel</button><button class="button button-primary" value="create">Create</button></div></form>`;
    let resolved = false;
    const finish = (value) => { if (!resolved) { resolved = true; resolveName(value); } };
    dialog.querySelector('form').addEventListener('submit', (event) => {
      if (event.submitter?.value !== 'create') { finish(null); return; }
      event.preventDefault();
      const name = dialog.querySelector('#new-name').value.trim();
      if (!name) { dialog.querySelector('#new-name').focus(); return; }
      finish(name);
      dialog.close();
    });
    dialog.addEventListener('close', () => { finish(null); dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
    requestAnimationFrame(() => dialog.querySelector('#new-name').focus());
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    const error = new Error(data.error?.message || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = data.error?.code;
    throw error;
  }
  return data;
}

function markDirty() {
  state.editGeneration++;
  state.dirty = true;
  if (state.saveState !== 'conflict' && state.saveState !== 'saving') {
    state.saveState = 'unsaved';
  }
  state.result = null;
  state.errors = [];
  renderEditorHeaderState();
  scheduleAutosave();
}

function checkpointHistory(group = null) {
  saveSnapshot(state.history, state.graph, group);
  renderHistoryButtons();
}

function checkpointSnapshot(snapshot) {
  if (!snapshot) return;
  saveSnapshot(state.history, snapshot);
  renderHistoryButtons();
}

function renderHistoryButtons() {
  const undo = document.querySelector('#undo-button');
  const redo = document.querySelector('#redo-button');
  if (undo) undo.disabled = state.history.undo.length === 0;
  if (redo) redo.disabled = state.history.redo.length === 0;
}

function resetHistory() {
  state.history = createHistory();
}

function applyHistory(direction) {
  const graph = restoreSnapshot(state.history, state.graph, direction);
  if (!graph) return;
  state.graph = graph;
  state.result = null;
  state.errors = [];
  markDirty();
  render();
}

function renderEditorHeaderState() {
  const status = document.querySelector('#save-status');
  const button = document.querySelector('#save-button');
  const versionButton = document.querySelector('#version-button');
  if (status) {
    if (state.saveState === 'saving') {
      status.textContent = 'Saving…';
    } else if (state.saveState === 'conflict') {
      status.innerHTML = 'Revision conflict · local draft retained <button class="text-button" data-action="download-conflict">Download local copy</button><button class="text-button" data-action="reload-ruleset">Reload server copy</button>';
    } else if (state.saveState === 'error') {
      status.innerHTML = 'Save failed · Draft preserved <button class="text-button" data-action="retry-save">Retry save</button>';
    } else if (state.dirty) {
      status.textContent = 'Unsaved changes';
    } else {
      status.innerHTML = `Saved · <button type="button" class="version-tag" data-action="versions" title="View version history">v${escapeHtml(String(state.revision))}</button>`;
    }
    status.dataset.state = state.dirty ? state.saveState : 'saved';
  }
  if (button) button.disabled = !state.dirty || state.saveState === 'saving';
  if (versionButton) versionButton.disabled = state.dirty || state.saveState === 'saving';
  renderHistoryButtons();
}

async function loadProjects() {
  const data = await api('/api/projects');
  state.projects = data.projects;
}

async function openProject(projectId) {
  if (!confirmDiscard()) return;
  clearAutosaveTimers();
  const data = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  state.project = data.project;
  state.ruleset = null;
  state.graph = null;
  state.view = 'project';
  state.dirty = false;
  state.result = null;
  render();
}

async function openRuleset(rulesetId) {
  if (!confirmDiscard()) return;
  clearAutosaveTimers();
  const data = await api(`/api/rulesets/${encodeURIComponent(rulesetId)}`);
  state.ruleset = data.ruleset;
  state.graph = structuredClone(data.ruleset.graph);
  state.revision = data.ruleset.revision;
  state.view = 'editor';
  state.selectedNodeId = state.graph.nodes[0]?.id ?? null;
  state.dirty = false;
  state.result = null;
  state.errors = [];
  state.testInput = {};
  resetHistory();
  state.zoom = 1;
  state.offset = { x: 0, y: 0 };
  render();
}

function confirmDiscard() {
  return !state.dirty || window.confirm('Discard your unsaved changes?');
}

function render() {
  if (state.view === 'dashboard') renderDashboard();
  else if (state.view === 'project') renderProject();
  else renderEditor();
}

function renderFloatingPillNav() {
  const isDashboard = state.view === 'dashboard';
  const isProject = state.view === 'project';
  const isEditor = state.view === 'editor';

  const navItems = [
    { id: 'projects', label: 'Projects', action: 'dashboard', count: state.projects?.length, active: isDashboard }
  ];
  if (state.project) {
    navItems.push({
      id: 'rulesets',
      label: 'Rule sets',
      action: 'back-project',
      count: state.project.rulesets?.length,
      active: isProject
    });
  }
  if (isEditor && state.ruleset) {
    navItems.push({
      id: 'canvas',
      label: 'Canvas',
      action: 'stay-canvas',
      count: undefined,
      active: true
    });
  }
  if (state.project) {
    navItems.push({
      id: 'activity',
      label: 'Activity',
      action: 'activity',
      count: undefined,
      active: false
    });
  }

  return `<nav class="floating-pill-nav" aria-label="Workbench navigation">
    ${navItems.map((item) => `
      <button type="button" class="pill-nav-item ${item.active ? 'is-active' : ''}" data-action="${item.action}" title="${escapeHtml(item.label)}">
        <span>${escapeHtml(item.label)}</span>
        ${item.count !== undefined ? `<span class="pill-nav-badge">${escapeHtml(String(item.count))}</span>` : ''}
      </button>
    `).join('')}
  </nav>`;
}

function shell(content, active = 'projects') {
  const isDashboard = state.view === 'dashboard';
  const isProject = state.view === 'project';
  const isEditor = state.view === 'editor';

  return `<div class="app-shell-unified">
    <header class="top-nav">
      <div class="top-nav-left">
        <button class="brand" data-action="dashboard" aria-label="RuleCanvas home">
          <span class="brand-mark">R</span>
          <span class="brand-text">
            <span class="brand-name">RuleCanvas</span>
            <span class="brand-subtitle">by ENNORM</span>
          </span>
        </button>
        <span class="nav-divider" aria-hidden="true">/</span>
        <div class="nav-trail">
          ${isDashboard
            ? '<span class="nav-trail-active">Projects</span>'
            : isProject
            ? `<span class="nav-trail-active">${escapeHtml(state.project?.name)}</span>`
            : `<button class="nav-trail-link" data-action="back-project" title="Back to ${escapeHtml(state.project?.name)}">${escapeHtml(state.project?.name)}</button><span class="nav-trail-sep">›</span><input id="ruleset-name" class="topbar-ruleset-input" value="${escapeHtml(state.ruleset?.name)}" maxlength="80" aria-label="Rule set name" title="Click to rename rule set"/>`
          }
        </div>
      </div>
      <div class="top-nav-center">
        ${renderFloatingPillNav()}
      </div>
      <div class="top-nav-right">
        ${isEditor ? `
          <div class="editor-header-actions">
            <div class="history-actions">
              <button id="undo-button" class="history-button" data-action="undo" aria-label="Undo" title="Undo (Ctrl+Z)" disabled>↶</button>
              <button id="redo-button" class="history-button" data-action="redo" aria-label="Redo" title="Redo (Ctrl+Y)" disabled>↷</button>
            </div>
            <span id="save-status" class="save-status" data-state="${state.dirty ? 'unsaved' : 'saved'}">${state.dirty ? 'Unsaved changes' : `Saved · <button type="button" class="version-tag" data-action="versions" title="View version history">v${state.revision}</button>`}</span>
            <button id="validate-button" class="button button-outline button-sm" data-action="validate" title="Validate graph">Validate</button>
            <button class="button button-outline button-sm" data-action="export-draft" title="Export draft JSON">Export</button>
            <button class="button button-outline button-sm" data-action="import-draft" title="Import draft JSON">Import</button>
            <button id="version-button" class="button button-outline button-sm" data-action="create-version" ${state.dirty ? 'disabled' : ''}>Save version</button>
            <button id="save-button" class="button button-primary button-sm" data-action="save" ${state.dirty ? '' : 'disabled'}>Save draft</button>
            <input id="import-draft-file" class="file-input-hidden" type="file" accept="application/json,.json" aria-label="Choose a RuleCanvas draft JSON file"/>
          </div>
        ` : `
          <span class="local-badge"><i class="status-dot"></i> Local workspace</span>
          <button class="icon-button" aria-label="Help" title="Help" data-action="help">?</button>
          <span class="avatar avatar-small">R</span>
        `}
      </div>
    </header>
    ${state.recovered ? '<div class="recovery-banner" role="alert"><strong>Previous local checkpoint loaded.</strong> The latest saved change may be missing. The damaged file is preserved beside the data file; create or save a project to repair it.</div>' : ''}
    <main class="main-content">
      ${content}
    </main>
  </div>`;
}

function renderDashboard() {
  app.innerHTML = shell(`<section class="page-wrap">
    <div class="page-heading"><div><p class="eyebrow">RULE WORKSPACE</p><h1>Your projects</h1><p class="lede">Create a home for your rules, decisions, and test runs.</p></div><button class="button button-primary" data-action="new-project"><span class="plus">+</span> New project</button></div>
    <div class="section-row"><div><h2>All projects <span class="count-pill">${state.projects.length}</span></h2><p class="section-note">Projects are stored in your local workspace.</p></div><div class="search-box"><span>⌕</span><input id="project-search" type="search" placeholder="Search projects" aria-label="Search projects"></div></div>
    <div class="project-grid" id="project-grid">${state.projects.length ? state.projects.map((project) => `<button class="project-card" data-project="${escapeHtml(project.id)}"><div class="project-card-top"><span class="project-symbol">${escapeHtml(project.name.slice(0, 1).toUpperCase())}</span><span class="card-arrow">↗</span></div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.rulesetCount)} rulesets · Updated ${new Date(project.updatedAt).toLocaleDateString()}</p><div class="project-card-bottom"><span class="status-dot"></span> Active workspace</div></button>`).join('') : `<div class="empty-state"><div class="empty-illustration"><span class="empty-node">IF</span><span class="empty-line"></span><span class="empty-node empty-node-out">THEN</span></div><h3>Your first project starts here</h3><p>Keep a set of related rules together, then build and test decisions on a visual canvas.</p><button class="button button-secondary" data-action="new-project">Create a project</button></div>`}</div>
    <div class="info-strip"><span class="info-mark">i</span><p><strong>RuleCanvas is running locally.</strong> Project data stays in a JSON file in this checkout. Sign-in, shared access, and remote backups are not part of this implementation yet.</p></div>
  </section>`);
}

function renderProject() {
  const rulesets = state.project.rulesets ?? [];
  app.innerHTML = shell(`<section class="page-wrap project-page">
    <button class="back-link" data-action="dashboard">← All projects</button>
    <div class="page-heading project-heading"><div><p class="eyebrow">PROJECT</p><h1>${escapeHtml(state.project.name)}</h1><p class="lede">Create a rule set and shape the path from input to outcome.</p></div><div class="project-heading-actions"><button class="button button-outline" data-action="activity">Activity</button><button class="button button-primary" data-action="new-ruleset"><span class="plus">+</span> New rule set</button></div></div>
    <div class="section-row"><div><h2>Rule sets <span class="count-pill">${rulesets.length}</span></h2><p class="section-note">Drafts can be edited and saved as you work.</p></div></div>
    <div class="ruleset-list">${rulesets.length ? rulesets.map((ruleset) => `<button class="ruleset-card" data-ruleset="${escapeHtml(ruleset.id)}"><span class="ruleset-icon">◇</span><span class="ruleset-main"><strong>${escapeHtml(ruleset.name)}</strong><small>${escapeHtml(ruleset.status === 'versioned' ? `Version ${ruleset.latestVersionNumber} saved` : 'Draft')} · Revision ${ruleset.revision} · ${ruleset.versionCount} saved version${ruleset.versionCount === 1 ? '' : 's'} · Updated ${new Date(ruleset.updatedAt).toLocaleString()}</small></span><span class="ruleset-arrow">→</span></button>`).join('') : `<div class="empty-inline"><span class="empty-inline-icon">◇</span><div><strong>No rule sets yet</strong><p>Create one to open the graph editor.</p></div><button class="button button-secondary" data-action="new-ruleset">Create rule set</button></div>`}</div>
  </section>`);
}

function getNodeLabel(node) {
  if (node.type === 'start') return 'Start';
  if (node.type === 'outcome') return node.label || 'Outcome';
  if (node.type === 'group') return `${String(node.operator || 'and').toUpperCase()} group`;
  const field = state.graph.schema.find((item) => item.id === node.fieldId);
  return field?.name || 'Condition';
}

function outputPort(node, port) {
  if (node.type === 'start') return { x: node.x + 240, y: node.y + 65 };
  return { x: node.x + 240, y: node.y + (port === 'true' ? 65 : 101) };
}

function inputPort(node) { return { x: node.x, y: node.y + 65 }; }

function edgePath(edge) {
  const source = state.graph.nodes.find((node) => node.id === edge.from);
  const target = state.graph.nodes.find((node) => node.id === edge.to);
  if (!source || !target) return '';
  const start = outputPort(source, edge.fromPort);
  const end = inputPort(target);
  const pull = Math.max(50, Math.abs(end.x - start.x) * 0.45);
  return `M ${start.x} ${start.y} C ${start.x + pull} ${start.y}, ${end.x - pull} ${end.y}, ${end.x} ${end.y}`;
}

function renderCanvasMarkup() {
  const edgeSvg = state.graph.edges.map((edge) => {
    const source = state.graph.nodes.find((node) => node.id === edge.from);
    return `<g class="edge-group${state.selectedEdgeId === edge.id ? ' is-selected' : ''}" data-edge="${escapeHtml(edge.id)}" tabindex="0" role="button" aria-pressed="${state.selectedEdgeId === edge.id}" aria-label="Connection from ${escapeHtml(source ? getNodeLabel(source) : 'missing node')}; select to remove"><path class="edge-path" d="${escapeHtml(edgePath(edge))}" marker-end="url(#arrow)"/></g>`;
  }).join('');
  const nodeSvg = state.graph.nodes.map((node) => {
    const selected = state.selectedNodeId === node.id;
    const isBranch = node.type === 'condition' || node.type === 'group';
    const subtitle = node.type === 'group'
      ? `${String(node.operator || 'and').toUpperCase()} · ${(node.terms ?? []).length} terms`
      : node.type === 'condition'
      ? `${escapeHtml(operatorLabels[node.operator] || 'choose operator')} ${escapeHtml(String(node.value ?? 'value'))}`
      : node.type === 'outcome' ? `Result · ${escapeHtml(JSON.stringify(node.result ?? null))}` : 'Entry point';
    const typeLabel = node.type === 'group' ? 'LOGIC GROUP' : node.type === 'condition' ? 'CONDITION' : node.type === 'outcome' ? 'OUTCOME' : 'START';
    const safeType = ['start', 'condition', 'group', 'outcome'].includes(node.type) ? node.type : 'unknown';
    const className = `graph-node node-${safeType}${selected ? ' is-selected' : ''}`;
    return `<g class="${className}" data-node="${escapeHtml(node.id)}" transform="translate(${escapeHtml(safeSvgNumber(Number(node.x)))} ${escapeHtml(safeSvgNumber(Number(node.y)))})" tabindex="0" role="group" aria-label="${escapeHtml(typeLabel)}: ${escapeHtml(getNodeLabel(node))}">
      <rect class="node-surface" width="240" height="130" rx="14"/>
      ${node.type !== 'start' ? `<circle class="port port-in" data-port-kind="in" data-node="${escapeHtml(node.id)}" cx="0" cy="65" r="7" tabindex="0" role="button" aria-label="Connect into ${escapeHtml(getNodeLabel(node))}"/>` : ''}
      <rect class="node-accent accent-${safeType}" x="14" y="14" width="28" height="28" rx="8"/>
      <text class="node-glyph" x="28" y="33" text-anchor="middle">${node.type === 'start' ? '↗' : node.type === 'group' ? (node.operator === 'or' ? '∨' : '∧') : node.type === 'condition' ? '?' : '✓'}</text>
      <text class="node-kind" x="50" y="24">${typeLabel}</text>
      <text class="node-title" x="50" y="40">${escapeHtml(getNodeLabel(node))}</text>
      <line class="node-divider" x1="14" y1="52" x2="226" y2="52"/>
      <text class="node-subtitle" x="14" y="76">${subtitle.length > 30 ? `${subtitle.slice(0, 29)}…` : subtitle}</text>
      <text class="node-hint" x="14" y="98">${node.type === 'condition' ? escapeHtml(state.graph.schema.find((field) => field.id === node.fieldId)?.type ?? 'input') : node.type === 'group' ? 'Nested logic' : node.type === 'outcome' ? 'Terminal result' : 'Connect to a node'}</text>
      ${node.type === 'start' ? `<circle class="port port-out" data-port-kind="out" data-node="${escapeHtml(node.id)}" data-port="next" cx="240" cy="65" r="7" tabindex="0" role="button" aria-label="Connect from start"/>` : ''}
      ${isBranch ? `<circle class="port port-out port-yes" data-port-kind="out" data-node="${escapeHtml(node.id)}" data-port="true" cx="240" cy="65" r="7" tabindex="0" role="button" aria-label="Connect true branch from ${escapeHtml(getNodeLabel(node))}"/><circle class="port port-out port-no" data-port-kind="out" data-node="${escapeHtml(node.id)}" data-port="false" cx="240" cy="101" r="7" tabindex="0" role="button" aria-label="Connect false branch from ${escapeHtml(getNodeLabel(node))}"/><text class="branch-label branch-yes" x="252" y="69">Yes</text><text class="branch-label branch-no" x="252" y="105">No</text>` : ''}
    </g>`;
  }).join('');
  let draftLine = '';
  if (state.connectionPointer && state.connectionSource) {
    const source = state.graph.nodes.find((node) => node.id === state.connectionSource.nodeId);
    if (source) {
      const start = outputPort(source, state.connectionSource.port);
      draftLine = `<path class="edge-path edge-draft" d="M ${escapeHtml(safeSvgNumber(Number(start.x)))} ${escapeHtml(safeSvgNumber(Number(start.y)))} L ${escapeHtml(safeSvgNumber(Number(state.connectionPointer.x)))} ${escapeHtml(safeSvgNumber(Number(state.connectionPointer.y)))}"/>`;
    }
  }
  return `<svg id="graph-canvas" class="graph-canvas" viewBox="0 0 1200 780" aria-label="Interactive rule graph canvas" role="application">
    <defs><pattern id="dot-grid" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1" fill="#dfe8e4"/></pattern><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8ca69b"/></marker></defs>
    <rect class="canvas-bg" width="1200" height="780" fill="url(#dot-grid)"/>
    <g id="graph-content" transform="translate(${escapeHtml(safeSvgNumber(state.offset.x))} ${escapeHtml(safeSvgNumber(state.offset.y))}) scale(${escapeHtml(safeSvgNumber(state.zoom))})">${edgeSvg}${draftLine}${nodeSvg}</g>
  </svg>`;
}

function renderSchema() {
  return `<div class="schema-section"><div class="panel-heading"><div><h3>Input fields</h3><p>Typed values available to rules</p></div><button class="mini-button" data-action="add-field" aria-label="Add input field" title="Add input field">+</button></div>
    ${state.graph.schema.length ? `<div class="field-list">${state.graph.schema.map((field) => `<div class="field-editor"><div class="field-row"><span class="field-type-badge type-${escapeHtml(field.type)}">${escapeHtml(field.type.slice(0, 1).toUpperCase())}</span><input class="field-name-input" data-field-id="${escapeHtml(field.id)}" data-field-prop="name" aria-label="Input field name" value="${escapeHtml(field.name)}"/><button class="tiny-remove" data-remove-field="${escapeHtml(field.id)}" aria-label="Remove ${escapeHtml(field.name)}">×</button></div><div class="field-meta-row"><select class="field-type-select" data-field-id="${escapeHtml(field.id)}" data-field-prop="type" aria-label="Type for ${escapeHtml(field.name)}">${['string', 'number', 'boolean', 'date', 'enum'].map((type) => `<option value="${type}" ${field.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select><label class="required-toggle"><input type="checkbox" data-field-id="${escapeHtml(field.id)}" data-field-prop="required" ${field.required === false ? '' : 'checked'}/> Required</label></div>${field.type === 'enum' ? `<input class="field-options-input" data-field-id="${escapeHtml(field.id)}" data-field-prop="options" aria-label="Comma separated options for ${escapeHtml(field.name)}" value="${escapeHtml((field.options ?? []).join(', '))}" placeholder="Option A, Option B"/>` : ''}</div>`).join('')}</div>` : `<p class="panel-empty">Add a typed field to use in a condition.</p>`}
  </div>`;
}

function defaultTermValue(field) {
  if (field?.type === 'number') return 0;
  if (field?.type === 'boolean') return true;
  if (field?.type === 'date') return '2026-01-01';
  if (field?.type === 'enum') return field.options?.[0] ?? '';
  return '';
}

function renderGroupTerm(term, path, depth = 0, budget = { remaining: 2048 }) {
  if (depth > 16) return '<div class="logic-term">Nested logic exceeds the supported depth of 16.</div>';
  if (budget.remaining <= 0) return '<div class="logic-term">Expression display limit reached; validate the graph for details.</div>';
  budget.remaining--;
  if (!term || typeof term !== 'object') return '<div class="logic-term">Invalid logic term.</div>';
  if (term.type === 'group') {
    const terms = Array.isArray(term.terms) ? term.terms : [];
    const children = terms.slice(0, 128).map((child, index) => renderGroupTerm(child, path ? `${path}.${index}` : String(index), depth + 1, budget)).join('');
    const depthClass = `logic-depth-${depth % 3}`;
    return `<div class="logic-term logic-subgroup ${depthClass}"><div class="logic-term-heading"><span class="group-depth-badge">${depth === 0 ? 'ROOT' : `DEPTH ${depth}`}</span><div class="operator-toggle-group mini"><button type="button" class="operator-toggle-btn ${term.operator === 'and' ? 'is-active is-and' : ''}" data-group-set-op="and" data-group-path="${path}">AND</button><button type="button" class="operator-toggle-btn ${term.operator === 'or' ? 'is-active is-or' : ''}" data-group-set-op="or" data-group-path="${path}">OR</button></div><select class="form-control logic-operator" data-group-path="${path}" data-group-prop="operator" aria-label="Nested group operator"><option value="and" ${term.operator === 'and' ? 'selected' : ''}>All (AND)</option><option value="or" ${term.operator === 'or' ? 'selected' : ''}>Any (OR)</option></select><div class="logic-term-actions"><button type="button" class="tiny-remove button-group-add" data-group-action="add-condition" data-group-path="${path}" aria-label="Add condition to nested group">+ Cond</button><button type="button" class="tiny-remove button-group-add group-sub-add" data-group-action="add-group" data-group-path="${path}" aria-label="Add nested group">+ Group</button><button type="button" class="tiny-remove group-remove-btn" data-group-action="remove-term" data-group-path="${path}" aria-label="Remove nested group" ${!groupTermRemovable(path) ? 'disabled' : ''}>×</button></div></div><div class="logic-term-children">${children}${terms.length > 128 ? '<p class="field-hint">This group exceeds the 128-term editor limit.</p>' : ''}</div></div>`;
  }
  const fieldExists = state.graph.schema.some((item) => item.id === term.fieldId);
  const field = fieldExists ? state.graph.schema.find((item) => item.id === term.fieldId) : null;
  const operators = field ? operatorsFor(field.type) : [];
  const type = field?.type;
  let valueControl = `<input class="form-control logic-value" data-group-path="${path}" data-group-prop="value" type="${type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}" value="${escapeHtml(term.value ?? '')}" aria-label="Condition value"/>`;
  if (type === 'boolean') valueControl = `<select class="form-control logic-value" data-group-path="${path}" data-group-prop="value" aria-label="Condition value"><option value="true" ${term.value === true ? 'selected' : ''}>True</option><option value="false" ${term.value === false ? 'selected' : ''}>False</option></select>`;
  if (type === 'enum') valueControl = `<select class="form-control logic-value" data-group-path="${path}" data-group-prop="value" aria-label="Condition value">${(field.options ?? []).map((option) => `<option value="${escapeHtml(option)}" ${term.value === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select>`;
  const missingOption = !fieldExists ? `<option value="" disabled selected>Missing field (select replacement)</option>` : '';
  const termClass = `logic-term logic-leaf${!fieldExists ? ' is-invalid' : ''}`;
  return `<div class="${termClass}"><select class="form-control logic-field ${!fieldExists ? 'is-invalid' : ''}" data-group-path="${path}" data-group-prop="fieldId" aria-label="Condition field">${missingOption}${state.graph.schema.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === field?.id ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.type)}</option>`).join('')}</select><select class="form-control logic-operator" data-group-path="${path}" data-group-prop="operator" aria-label="Condition operator">${operators.map((operator) => `<option value="${operator}" ${term.operator === operator ? 'selected' : ''}>${escapeHtml(operatorLabels[operator])}</option>`).join('')}</select>${valueControl}<button class="tiny-remove" data-group-action="remove-term" data-group-path="${path}" aria-label="Remove condition" ${!groupTermRemovable(path) ? 'disabled' : ''}>×</button></div>`;
}

function groupPath(path) {
  const node = state.graph.nodes.find((item) => item.id === state.selectedNodeId);
  if (!node || node.type !== 'group') return null;
  const indexes = path.split('.').filter(Boolean).map(Number);
  const index = indexes.pop();
  let parent = { terms: node.terms };
  for (const part of indexes) parent = parent?.terms?.[part];
  if (!Number.isInteger(index) || !Array.isArray(parent?.terms) || !parent.terms[index]) return null;
  return { node, parent, index, term: parent.terms[index], root: indexes.length === 0 };
}

function groupTermRemovable(path) {
  const target = groupPath(path);
  return Boolean(target && target.parent.terms.length > 2);
}

function makeGroupTerm(type = 'condition') {
  const field = state.graph.schema[0];
  const leaf = () => ({ type: 'condition', fieldId: field.id, operator: 'eq', value: defaultTermValue(field) });
  return type === 'group' ? { type: 'group', operator: 'and', terms: [leaf(), leaf()] } : leaf();
}

function addGroupTerm(action, path = '') {
  const node = state.graph.nodes.find((item) => item.id === state.selectedNodeId);
  if (!node || node.type !== 'group') return;
  if (!state.graph.schema.length) { showToast('Add an input field before adding a group condition.', 'error'); return; }
  let terms = node.terms;
  for (const index of path.split('.').filter(Boolean).map(Number)) terms = terms?.[index]?.terms;
  if (!Array.isArray(terms)) return;
  if (action === 'remove-term') {
    const target = groupPath(path);
    if (!target || target.parent.terms.length <= 2) return;
    checkpointHistory();
    target.parent.terms.splice(target.index, 1);
  } else {
    checkpointHistory();
    terms.push(makeGroupTerm(action === 'add-group' ? 'group' : 'condition'));
  }
  state.result = null;
  markDirty(); render();
}

function updateGroupControl(control) {
  const path = control.dataset.groupPath;
  const prop = control.dataset.groupProp;
  const target = groupPath(path);
  if (!target || !prop) return;
  let next = control.value;
  if (prop === 'fieldId') {
    const field = state.graph.schema.find((item) => item.id === next);
    if (!field) return;
    target.term.fieldId = field.id;
    target.term.operator = 'eq';
    target.term.value = defaultTermValue(field);
  } else if (prop === 'value') {
    const field = state.graph.schema.find((item) => item.id === target.term.fieldId);
    if (!field) return;
    next = parseTypedValue(control, field.type);
    target.term.value = next;
  } else target.term[prop] = next;
  state.result = null;
  markDirty(); render();
}

function renderGroupInspector(node) {
  const terms = Array.isArray(node.terms) ? node.terms : [];
  const budget = { remaining: 2048 };
  const rendered = terms.slice(0, 128).map((term, index) => renderGroupTerm(term, String(index), 0, budget)).join('');
  return `<div class="inspector-content">
    <div class="selected-label"><span class="kind-dot kind-condition"></span>LOGIC GROUP</div>
    <h3>Combine conditions</h3>
    <p class="inspector-copy">Each group applies its operator to the listed terms. Nest groups to set explicit AND/OR precedence.</p>
    <label class="form-label" for="root-group-operator">Group operator</label>
    <div class="operator-toggle-group">
      <button type="button" class="operator-toggle-btn ${node.operator === 'and' ? 'is-active is-and' : ''}" data-group-set-op="and" data-group-path="" aria-label="Set root group operator to ALL (AND)">ALL (AND)</button>
      <button type="button" class="operator-toggle-btn ${node.operator === 'or' ? 'is-active is-or' : ''}" data-group-set-op="or" data-group-path="" aria-label="Set root group operator to ANY (OR)">ANY (OR)</button>
    </div>
    <select id="root-group-operator" class="form-control sr-only" aria-label="Root group operator"><option value="and" ${node.operator === 'and' ? 'selected' : ''}>All terms (AND)</option><option value="or" ${node.operator === 'or' ? 'selected' : ''}>Any term (OR)</option></select>
    <div class="logic-group-terms">${rendered}${terms.length > 128 ? '<p class="field-hint">This group exceeds the 128-term editor limit.</p>' : ''}</div>
    <div class="logic-add-actions">
      <button class="button button-outline" data-group-action="add-condition" data-group-path="">+ Add condition</button>
      <button class="button button-outline" data-group-action="add-group" data-group-path="">+ Add nested group</button>
    </div>
    <div class="branch-note"><span class="branch-yes-dot"></span>Yes follows the true port <span class="branch-no-dot"></span>No follows the false port</div>
    <button class="button button-danger-soft button-wide" data-action="delete-node">Delete node</button>
  </div>`;
}

function renderInspector() {
  const node = state.graph.nodes.find((item) => item.id === state.selectedNodeId);
  if (!node) return `<div class="inspector-empty"><span class="inspector-empty-mark">◇</span><strong>Select a node</strong><p>Choose a node on the canvas to edit its rule or outcome.</p></div>`;
  if (node.type === 'start') return `<div class="inspector-content"><div class="selected-label"><span class="kind-dot kind-start"></span>START NODE</div><h3>Entry point</h3><p class="inspector-copy">Every evaluation begins here. Connect the next port to a condition or outcome node.</p></div>`;
  if (node.type === 'outcome') return `<div class="inspector-content"><div class="selected-label"><span class="kind-dot kind-outcome"></span>OUTCOME NODE</div><label class="form-label" for="outcome-label">Outcome name</label><input id="outcome-label" class="form-control" value="${escapeHtml(node.label)}" maxlength="60"/><label class="form-label" for="outcome-result">Result value (JSON)</label><textarea id="outcome-result" class="form-control code-input" rows="4">${escapeHtml(JSON.stringify(node.result ?? null, null, 2))}</textarea><p class="field-hint">The value returned when a path reaches this outcome.</p><button class="button button-danger-soft button-wide" data-action="delete-node">Delete node</button></div>`;
  if (node.type === 'group') return renderGroupInspector(node);
  const fieldExists = state.graph.schema.some((item) => item.id === node.fieldId);
  const field = fieldExists ? state.graph.schema.find((item) => item.id === node.fieldId) : null;
  const ops = field ? operatorsFor(field.type) : [];
  const value = node.value ?? '';
  const inputType = field?.type === 'number' ? 'number' : field?.type === 'date' ? 'date' : 'text';
  let valueControl = `<input id="condition-value" class="form-control" type="${inputType}" value="${escapeHtml(value)}"/>`;
  if (field?.type === 'boolean') valueControl = `<select id="condition-value" class="form-control"><option value="true" ${node.value === true ? 'selected' : ''}>True</option><option value="false" ${node.value === false ? 'selected' : ''}>False</option></select>`;
  if (field?.type === 'enum') valueControl = `<select id="condition-value" class="form-control">${(field.options ?? []).map((option) => `<option value="${escapeHtml(option)}" ${node.value === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select>`;
  const missingOption = !fieldExists ? `<option value="" disabled selected>Missing field (select replacement)</option>` : '';
  return `<div class="inspector-content"><div class="selected-label"><span class="kind-dot kind-condition"></span>CONDITION NODE</div><label class="form-label" for="condition-field">Input field</label><select id="condition-field" class="form-control ${!fieldExists ? 'is-invalid' : ''}">${missingOption}${state.graph.schema.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === node.fieldId ? 'selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.type)}</option>`).join('')}</select>${field?.type === 'enum' ? `<p class="field-hint">Options: ${escapeHtml((field.options ?? []).join(', '))}</p>` : ''}<label class="form-label" for="condition-operator">Operator</label><select id="condition-operator" class="form-control">${ops.map((operator) => `<option value="${operator}" ${node.operator === operator ? 'selected' : ''}>${operatorLabels[operator]}</option>`).join('')}</select><label class="form-label" for="condition-value">Compare to</label>${valueControl}<div class="branch-note"><span class="branch-yes-dot"></span>Yes follows the true port <span class="branch-no-dot"></span>No follows the false port</div><button class="button button-danger-soft button-wide" data-action="delete-node">Delete node</button></div>`;
}

function renderGroupTraceTerm(term) {
  if (term.type === 'group') return `<span class="trace-group">${escapeHtml(term.operator.toUpperCase())} (${term.terms.map(renderGroupTraceTerm).join(' · ')})</span>`;
  return `${escapeHtml(term.field)} ${escapeHtml(operatorLabels[term.operator] ?? term.operator)} ${escapeHtml(JSON.stringify(term.expected))} ${term.matched ? '✓' : '×'}`;
}

function renderTraceEntry(entry) {
  if (entry.kind === 'condition') return `${escapeHtml(entry.field)} ${escapeHtml(operatorLabels[entry.operator])} ${escapeHtml(JSON.stringify(entry.expected))} → <b>${entry.branch === 'true' ? 'Yes' : 'No'}</b>`;
  if (entry.kind === 'group') return `<span>${escapeHtml(entry.operator.toUpperCase())} (${entry.terms.map(renderGroupTraceTerm).join(' · ')}) → <b>${entry.branch === 'true' ? 'Yes' : 'No'}</b></span>`;
  return escapeHtml(entry.label);
}

function renderTestPanel() {
  const fields = state.graph.schema;
  const inputs = fields.map((field) => {
    const raw = state.testInput[field.name];
    const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'boolean' ? 'boolean' : field.type;
    const control = field.type === 'boolean'
      ? `<select data-test-field="${escapeHtml(field.name)}" class="form-control"><option value="">Choose…</option><option value="true" ${raw === true ? 'selected' : ''}>True</option><option value="false" ${raw === false ? 'selected' : ''}>False</option></select>`
      : field.type === 'enum'
        ? `<select data-test-field="${escapeHtml(field.name)}" class="form-control"><option value="">Choose…</option>${(field.options ?? []).map((option) => `<option value="${escapeHtml(option)}" ${raw === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select>`
        : renderTestTextInput({
          name: field.name,
          type: type === 'string' ? 'text' : type,
          value: raw ?? '',
          placeholder: field.type === 'date' ? 'YYYY-MM-DD' : `Enter ${String(field.name).toLowerCase()}`,
        });
    return `<label class="test-field"><span>${escapeHtml(field.name)} ${field.required === false ? '<small>optional</small>' : ''}</span>${control}</label>`;
  }).join('');
  let result = '';
  if (state.result) {
    result = state.result.ok
      ? `<div class="evaluation-result is-success"><div class="result-outcome"><span class="result-check">✓</span><span><small>DECISION</small><strong>${escapeHtml(state.result.trace.at(-1)?.label)}</strong></span><code>${escapeHtml(JSON.stringify(state.result.result))}</code></div><ol class="trace-list">${state.result.trace.map((entry) => `<li><span class="trace-index">${escapeHtml(entry.nodeId)}</span><span>${renderTraceEntry(entry)}</span></li>`).join('')}</ol></div>`
      : `<div class="evaluation-result is-error"><strong>Could not evaluate</strong><ul>${state.result.errors.map((error) => `<li>${escapeHtml(error.message)}</li>`).join('')}</ul></div>`;
  }
  return `<div class="test-panel"><div class="panel-heading"><div><h3>Test a decision</h3><p>Try sample input without changing the saved graph.</p></div></div>${fields.length ? `<div class="test-fields">${inputs}</div>` : `<p class="panel-empty">No input fields needed for unconditional rules, or add fields to test conditions.</p>`}<div class="test-actions"><button class="button button-primary button-wide" data-action="evaluate">Run test <span>→</span></button><button class="text-button" data-action="clear-test">Clear</button></div>${result}</div>`;
}

function renderValidation() {
  if (!state.errors.length) return '';
  return `<div class="validation-banner ${state.errors.some((error) => error.code === 'graph.unreachable' || error.code === 'graph.cycle') ? 'is-error' : ''}"><div class="validation-title">${state.errors.length} item${state.errors.length === 1 ? '' : 's'} to review</div><ul>${state.errors.map((error) => `<li>${escapeHtml(error.message)}${error.termPath ? ` (term ${escapeHtml(error.termPath)})` : ''}${error.nodeId ? ` <button class="error-link" data-focus-node="${escapeHtml(error.nodeId)}">Select node</button>` : ''}</li>`).join('')}</ul></div>`;
}

function renderEditor() {
  app.innerHTML = shell(`<section class="editor-page">
    <div class="mobile-tab-bar">
      <button type="button" class="mobile-tab-btn ${state.mobileTab === 'canvas' ? 'is-active' : ''}" data-mobile-tab="canvas">◇ Canvas</button>
      <button type="button" class="mobile-tab-btn ${state.mobileTab === 'build' ? 'is-active' : ''}" data-mobile-tab="build">▦ Build & Fields (${state.graph.schema.length})</button>
      <button type="button" class="mobile-tab-btn ${state.mobileTab === 'properties' ? 'is-active' : ''}" data-mobile-tab="properties">⚙ Properties & Test</button>
    </div>
    <div class="editor-workspace ${state.inspectorCollapsed ? 'inspector-collapsed' : ''} mobile-view-${state.mobileTab || 'canvas'}">
      <aside class="editor-left">
        <div class="panel-heading">
          <div>
            <h3>Build</h3>
            <p>Drag or click to add nodes</p>
          </div>
        </div>
        <div class="palette-group">
          <span class="palette-label">NODE TYPES</span>
          <button class="palette-card" draggable="true" data-add-node="condition">
            <span class="palette-symbol palette-condition">?</span>
            <span><strong>Condition</strong><small>Compare an input value</small></span>
            <span class="palette-plus">+</span>
          </button>
          <button class="palette-card" draggable="true" data-add-node="group">
            <span class="palette-symbol palette-group-symbol">∧</span>
            <span><strong>Logic group</strong><small>Combine tests using AND / OR</small></span>
            <span class="palette-plus">+</span>
          </button>
          <button class="palette-card" draggable="true" data-add-node="outcome">
            <span class="palette-symbol palette-outcome">✓</span>
            <span><strong>Outcome</strong><small>Return a terminal decision</small></span>
            <span class="palette-plus">+</span>
          </button>
        </div>
        ${renderSchema()}
        <div class="left-help">
          <span class="help-icon">⌘</span>
          <span>Drag nodes onto canvas or use toolbar pills. Connect ports to branch. Press Esc to cancel.</span>
        </div>
      </aside>
      <section class="canvas-area">
        <div class="canvas-topline">
          <div class="canvas-quick-add">
            <span class="quick-add-label">Add:</span>
            <button type="button" class="quick-pill pill-condition" data-add-node="condition" title="Add condition node">
              <span class="quick-pill-glyph">?</span> Condition
            </button>
            <button type="button" class="quick-pill pill-group" data-add-node="group" title="Add logic group node">
              <span class="quick-pill-glyph">∧</span> Logic group
            </button>
            <button type="button" class="quick-pill pill-outcome" data-add-node="outcome" title="Add outcome node">
              <span class="quick-pill-glyph">✓</span> Outcome
            </button>
          </div>
          <div class="canvas-stats">
            <span>${state.graph.nodes.length} nodes · ${state.graph.edges.length} connections</span>
          </div>
          <div class="canvas-tools">
            <button class="canvas-tool" data-action="zoom-out" aria-label="Zoom out" title="Zoom out">−</button>
            <span class="zoom-label">${Math.round(state.zoom * 100)}%</span>
            <button class="canvas-tool" data-action="zoom-in" aria-label="Zoom in" title="Zoom in">+</button>
            <button class="canvas-tool fit-tool" data-action="fit" title="Fit graph">Fit</button>
            <button id="delete-edge-button" class="canvas-tool" data-action="delete-edge" title="Select a connection to remove" aria-label="Delete selected connection" ${state.selectedEdgeId ? '' : 'disabled'}>Remove link</button>
            <button class="collapse-toggle-btn" data-action="toggle-inspector" aria-label="${state.inspectorCollapsed ? 'Expand properties' : 'Collapse properties'}" title="${state.inspectorCollapsed ? 'Expand properties' : 'Collapse properties'}">${state.inspectorCollapsed ? '⇤' : '⇥'}</button>
          </div>
        </div>
        <div class="canvas-viewport" id="canvas-viewport">
          ${renderCanvasMarkup()}
          <div class="canvas-hint">
            <span class="hint-key">Esc</span> Cancel link
            <span class="hint-divider">·</span> Hold Space to pan canvas
          </div>
        </div>
        ${renderValidation()}
      </section>
      <aside class="editor-right ${state.inspectorCollapsed ? 'is-collapsed' : ''}">
        <div id="inspector-panel" class="inspector-panel">
          ${state.inspectorCollapsed ? `
            <div class="inspector-collapsed-strip">
              <button class="collapse-toggle-btn" data-action="toggle-inspector" aria-label="Expand inspector panel" title="Expand inspector panel">⇤</button>
              <span class="inspector-vertical-title">PROPERTIES</span>
            </div>
          ` : `
            <div class="panel-heading">
              <div>
                <h3>Properties</h3>
                <p>Configure selected node</p>
              </div>
              <button class="collapse-toggle-btn" data-action="toggle-inspector" aria-label="Collapse inspector panel" title="Collapse inspector panel">⇥</button>
            </div>
            ${renderInspector()}
          `}
        </div>
        ${state.inspectorCollapsed ? '' : renderTestPanel()}
      </aside>
    </div>
  </section>`);
  attachCanvasEvents();
  renderHistoryButtons();
}

function parseTypedValue(input, type) {
  if (type === 'number') {
    if (input.value === '' || input.value === null || input.value === undefined) return null;
    const num = Number(input.value);
    return Number.isFinite(num) ? num : null;
  }
  if (type === 'boolean') return input.value === 'true';
  return input.value;
}

function newNode(type, point = null) {
  checkpointHistory();
  const conditionCount = state.graph.nodes.filter((node) => node.type === 'condition').length;
  const outcomeCount = state.graph.nodes.filter((node) => node.type === 'outcome').length;
  const centerX = point?.x ?? (type === 'condition' || type === 'group' ? 360 + (conditionCount + state.graph.nodes.filter((node) => node.type === 'group').length) * 285 : 710);
  const centerY = point?.y ?? (type === 'condition' || type === 'group' ? 205 + (conditionCount % 2) * 170 : 135 + outcomeCount * 220);
  const position = { x: Math.max(24, Math.min(960, Math.round(centerX))), y: Math.max(24, Math.min(625, Math.round(centerY))) };
  if (type === 'condition' || type === 'group') {
    let field = state.graph.schema[0];
    if (!field) {
      field = { id: id('field'), name: 'New input', type: 'string', required: true };
      state.graph.schema.push(field);
      showToast('Added a text input field for this condition. Edit its type in Input fields.', 'success');
    }
    const leaf = () => ({ type: 'condition', fieldId: field.id, operator: 'eq', value: defaultTermValue(field) });
    const node = type === 'group'
      ? { id: id('node'), type, ...position, operator: 'and', terms: [leaf(), leaf()] }
      : { id: id('node'), type, ...position, fieldId: field.id, operator: 'eq', value: defaultTermValue(field) };
    state.graph.nodes.push(node);
    state.selectedNodeId = node.id;
  } else {
    const node = { id: id('node'), type, ...position, label: 'Outcome', result: 'approved' };
    state.graph.nodes.push(node);
    state.selectedNodeId = node.id;
  }
  markDirty(); render();
}

function addField() {
  const index = state.graph.schema.length + 1;
  checkpointHistory();
  state.graph.schema.push({ id: id('field'), name: `Input ${index}`, type: 'string', required: true });
  markDirty(); render();
}

function updateField(fieldId, updates) {
  const field = state.graph.schema.find((item) => item.id === fieldId);
  if (!field) return;
  if (Object.entries(updates).every(([key, value]) => field[key] === value)) return;
  checkpointHistory();
  Object.assign(field, updates);
  const normalizeLeaf = (term) => {
    if (term.type === 'group') { term.terms?.forEach(normalizeLeaf); return; }
    if (term.fieldId !== field.id) return;
    if (!operatorsFor(field.type).includes(term.operator)) term.operator = 'eq';
    if (field.type === 'number' && typeof term.value !== 'number') term.value = 0;
    else if (field.type === 'boolean' && typeof term.value !== 'boolean') term.value = true;
    else if (field.type === 'date' && (typeof term.value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(term.value))) term.value = '2026-01-01';
    else if (field.type === 'enum' && !field.options?.includes(term.value)) term.value = field.options?.[0] ?? '';
    else if ((field.type === 'string' || field.type === 'enum') && typeof term.value !== 'string') term.value = '';
    else if (term.value === undefined) term.value = defaultTermValue(field);
  };
  for (const node of state.graph.nodes) {
    if (node.type === 'group') {
      const pending = Array.isArray(node.terms) ? node.terms.slice(0, 2048) : [];
      let visited = 0;
      while (pending.length && visited++ < 2048) {
        const term = pending.pop();
        if (!term || typeof term !== 'object') continue;
        if (term.type === 'group') {
          if (Array.isArray(term.terms)) pending.push(...term.terms.slice(0, Math.max(0, 2048 - visited - pending.length)));
        }
        else normalizeLeaf(term);
      }
      continue;
    }
    if (node.type !== 'condition' || node.fieldId !== field.id) continue;
    const allowed = operatorsFor(field.type);
    if (!allowed.includes(node.operator)) node.operator = 'eq';
    if (field.type === 'number' && typeof node.value !== 'number') node.value = 0;
    else if (field.type === 'boolean' && typeof node.value !== 'boolean') node.value = true;
    else if (field.type === 'date' && typeof node.value !== 'string') node.value = '2026-01-01';
    else if (field.type === 'enum' && !field.options?.includes(node.value)) node.value = field.options?.[0] ?? '';
    else if ((field.type === 'string' || field.type === 'enum') && typeof node.value !== 'string') node.value = '';
  }
  markDirty(); render();
}

function portCompatible(source, target) {
  if (!source || !target || source.nodeId === target.nodeId || target.port !== 'in') return false;
  const from = state.graph.nodes.find((node) => node.id === source.nodeId);
  const to = state.graph.nodes.find((node) => node.id === target.nodeId);
  if (!from || !to || !['condition', 'group', 'outcome'].includes(to.type)) return false;
  if (from.type === 'start' && source.port !== 'next') return false;
  if (['condition', 'group'].includes(from.type) && !['true', 'false'].includes(source.port)) return false;
  if (!['start', 'condition', 'group'].includes(from.type)) return false;
  if (state.graph.edges.some((edge) => edge.from === from.id && edge.fromPort === source.port)) return false;
  if (state.graph.edges.some((edge) => edge.to === to.id)) return false;
  return true;
}

function completeConnection(target) {
  if (!portCompatible(state.connectionSource, target)) {
    showToast('That connection is incompatible or a branch is already connected.', 'error');
    return false;
  }
  checkpointHistory();
  state.graph.edges.push({
    id: id('edge'), from: state.connectionSource.nodeId, fromPort: state.connectionSource.port,
    to: target.nodeId, toPort: target.port,
  });
  state.connectionSource = null;
  state.connectionPointer = null;
  state.result = null;
  markDirty();
  return true;
}

function svgPoint(event) {
  const svg = document.querySelector('#graph-canvas');
  const point = svg.createSVGPoint();
  point.x = event.clientX; point.y = event.clientY;
  const matrix = document.querySelector('#graph-content').getScreenCTM().inverse();
  const local = point.matrixTransform(matrix);
  return { x: local.x, y: local.y };
}

function attachCanvasEvents() {
  const svg = document.querySelector('#graph-canvas');
  if (!svg) return;
  let spacePan = false;
  let panOrigin = null;
  svg.addEventListener('pointerdown', (event) => {
    const port = event.target.closest('[data-port-kind]');
    if (port?.dataset.portKind === 'out') {
      event.preventDefault(); event.stopPropagation();
      state.connectionSource = { nodeId: port.dataset.node, port: port.dataset.port };
      state.connectionPointer = svgPoint(event);
      svg.setPointerCapture(event.pointerId);
      renderCanvas();
      return;
    }
    if (port?.dataset.portKind === 'in') {
      event.preventDefault(); event.stopPropagation();
      if (state.connectionSource) {
        if (completeConnection({ nodeId: port.dataset.node, port: 'in' })) render();
      } else showToast('Select an output port first.', 'info');
      return;
    }
    const group = event.target.closest('[data-node]');
    if (group) {
      const nodeId = group.dataset.node;
      state.selectedNodeId = nodeId;
      const node = state.graph.nodes.find((item) => item.id === nodeId);
      if (event.button === 0 && !event.target.closest('[data-port-kind]')) {
        const point = svgPoint(event);
        state.drag = { nodeId, dx: point.x - node.x, dy: point.y - node.y, before: structuredClone(state.graph), moved: false };
        svg.setPointerCapture(event.pointerId);
      }
      renderInspectorPanel();
      renderCanvas();
      return;
    }
    if (event.target.classList.contains('canvas-bg') || event.target.classList.contains('canvas-grid')) {
      if (event.button === 1 || spacePan) {
        panOrigin = { x: event.clientX, y: event.clientY, ox: state.offset.x, oy: state.offset.y };
        svg.setPointerCapture(event.pointerId);
      } else if (state.connectionSource) {
        state.connectionSource = null; state.connectionPointer = null; renderCanvas();
      }
    }
  });
  svg.addEventListener('pointermove', (event) => {
    if (state.drag) {
      const point = svgPoint(event);
      const node = state.graph.nodes.find((item) => item.id === state.drag.nodeId);
      if (node) {
        node.x = Math.max(16, Math.round(point.x - state.drag.dx));
        node.y = Math.max(20, Math.round(point.y - state.drag.dy));
        state.drag.moved = true;
        renderCanvas();
      }
    } else if (state.connectionSource) {
      state.connectionPointer = svgPoint(event); renderCanvas();
    } else if (panOrigin) {
      state.offset.x = panOrigin.ox + (event.clientX - panOrigin.x) * 1200 / svg.getBoundingClientRect().width;
      state.offset.y = panOrigin.oy + (event.clientY - panOrigin.y) * 780 / svg.getBoundingClientRect().height;
      renderCanvas();
    }
  });
  svg.addEventListener('pointerup', (event) => {
    if (state.drag) {
      const moved = state.drag.moved;
      const before = state.drag.before;
      state.drag = null;
      if (moved) { checkpointSnapshot(before); markDirty(); render(); }
      return;
    }
    if (state.connectionSource) {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-port-kind="in"]');
      if (target && completeConnection({ nodeId: target.dataset.node, port: 'in' })) render();
      else { state.connectionPointer = null; renderCanvas(); }
    }
    panOrigin = null;
  });
  svg.addEventListener('pointercancel', () => {
    if (state.drag?.moved) state.graph = state.drag.before;
    state.drag = null; state.connectionPointer = null; panOrigin = null; renderCanvas();
  });
  svg.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      const edge = event.target.closest('[data-edge]');
      if (edge) {
        event.preventDefault();
        selectEdge(edge.dataset.edge);
        return;
      }
      const port = event.target.closest('[data-port-kind]');
      if (!port) return;
      event.preventDefault();
      if (port.dataset.portKind === 'out') {
        state.connectionSource = { nodeId: port.dataset.node, port: port.dataset.port };
        showToast('Output selected. Tab to an input port and press Enter to connect.', 'info');
      } else if (state.connectionSource && completeConnection({ nodeId: port.dataset.node, port: 'in' })) render();
    }
  });
  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    state.zoom = Math.max(0.45, Math.min(1.6, state.zoom * (event.deltaY < 0 ? 1.08 : 0.92)));
    renderCanvas(); updateZoomLabel();
  }, { passive: false });
  const keyDown = (event) => { if (event.code === 'Space') { spacePan = true; event.preventDefault(); } };
  const keyUp = (event) => { if (event.code === 'Space') spacePan = false; };
  svg.addEventListener('keydown', keyDown);
  svg.addEventListener('keyup', keyUp);
  svg.addEventListener('focusout', (event) => { if (!svg.contains(event.relatedTarget)) spacePan = false; });
}

function renderCanvas() {
  const currentSvg = document.querySelector('#graph-canvas');
  if (!currentSvg) return;
  const template = document.createElement('template');
  template.innerHTML = renderCanvasMarkup();
  currentSvg.innerHTML = template.content.querySelector('#graph-canvas').innerHTML;
}

function renderInspectorPanel() {
  const panel = document.querySelector('#inspector-panel');
  if (!panel) return;
  if (state.inspectorCollapsed) {
    panel.innerHTML = `<div class="inspector-collapsed-strip"><button class="collapse-toggle-btn" data-action="toggle-inspector" aria-label="Expand inspector panel" title="Expand inspector panel">⇤</button><span class="inspector-vertical-title">PROPERTIES</span></div>`;
  } else {
    panel.innerHTML = `<div class="panel-heading"><div><h3>Properties</h3><p>Edit the selected node</p></div><button class="collapse-toggle-btn" data-action="toggle-inspector" aria-label="Collapse inspector panel" title="Collapse inspector panel">⇥</button></div>${renderInspector()}`;
  }
}

function updateZoomLabel() {
  const label = document.querySelector('.zoom-label');
  if (label) label.textContent = `${Math.round(state.zoom * 100)}%`;
}

let inFlightSave = null;

async function saveDraft({ isAutosave = false } = {}) {
  if (!state.dirty || state.saveState === 'conflict') return;
  if (inFlightSave) {
    scheduleAutosave();
    return inFlightSave;
  }
  const invalidResult = document.querySelector('#outcome-result:invalid');
  if (invalidResult) {
    if (!isAutosave) invalidResult.reportValidity();
    return;
  }
  clearAutosaveTimers();

  const targetRulesetId = state.ruleset?.id;
  const targetProjectId = state.project?.id;
  const targetRevision = state.revision;
  const savedGeneration = state.editGeneration;
  const snapshotGraph = structuredClone(state.graph);
  const snapshotName = document.querySelector('#ruleset-name')?.value ?? state.ruleset?.name;

  state.saveState = 'saving';
  renderEditorHeaderState();

  const runSave = async () => {
    try {
      const data = await api(`/api/rulesets/${encodeURIComponent(targetRulesetId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          expectedRevision: targetRevision,
          name: snapshotName,
          graph: snapshotGraph,
        }),
      });

      const outcome = applySaveSuccess({
        state,
        targetRulesetId,
        targetProjectId,
        savedGeneration,
        newRevision: data.ruleset.revision,
        serverGraph: data.ruleset.graph,
      });

      if (state.project && state.project.id === targetProjectId) {
        try {
          const projectData = await api(`/api/projects/${encodeURIComponent(targetProjectId)}`);
          if (state.project && state.project.id === targetProjectId) {
            state.project = projectData.project;
          }
        } catch {
          // Non-fatal if project refresh fails
        }
      }

      if (outcome.viewChanged) return;

      if (outcome.shouldRerunSave) {
        renderEditorHeaderState();
        scheduleAutosave();
        return;
      }

      showToast(isAutosave ? 'Draft autosaved.' : 'Draft saved to this workspace.', 'success');
      if (isAutosave) {
        renderEditorHeaderState();
      } else {
        render();
      }
    } catch (error) {
      if (state.view === 'editor' && state.ruleset?.id === targetRulesetId) {
        state.saveState = error.status === 409 ? 'conflict' : 'error';
        renderEditorHeaderState();
        if (error.status === 409) {
          showToast('This draft changed elsewhere. Reload it before continuing.', 'error');
          const status = document.querySelector('#save-status');
          if (status) {
            status.innerHTML = 'Revision conflict · local draft retained <button class="text-button" data-action="download-conflict">Download local copy</button><button class="text-button" data-action="reload-ruleset">Reload server copy</button>';
          }
        } else {
          showToast(`Could not save: ${error.message}. Draft preserved locally.`, 'error');
          const status = document.querySelector('#save-status');
          if (status) {
            status.innerHTML = 'Save failed · Draft preserved <button class="text-button" data-action="retry-save">Retry save</button>';
          }
          if (isAutosave) {
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => {
              if (state.dirty && state.saveState === 'error') {
                saveDraft({ isAutosave: true });
              }
            }, 5000);
          }
        }
      }
    } finally {
      inFlightSave = null;
    }
  };

  inFlightSave = runSave();
  return inFlightSave;
}

async function validateDraft() {
  const invalidResult = document.querySelector('#outcome-result:invalid');
  if (invalidResult) { invalidResult.reportValidity(); return; }
  try {
    const data = await api(`/api/rulesets/${encodeURIComponent(state.ruleset.id)}/validate`, { method: 'POST', body: JSON.stringify({ graph: state.graph }) });
    state.errors = data.errors;
    if (data.valid) showToast('Graph is valid and every path reaches an outcome.', 'success');
    else showToast(`Review ${data.errors.length} graph issue${data.errors.length === 1 ? '' : 's'}.`, 'error');
    render();
  } catch (error) { showToast(`Could not validate: ${error.message}`, 'error'); }
}

async function evaluateDraft() {
  if (state.dirty) { showToast('Save the draft before running a decision test.', 'error'); return; }
  const input = {};
  document.querySelectorAll('[data-test-field]').forEach((control) => {
    const field = state.graph.schema.find((item) => item.name === control.dataset.testField);
    if (!field || !shouldIncludeTypedValue(field, control.value)) return;
    const val = parseTypedValue(control, field.type);
    if (val !== null || field.type === 'string') {
      input[control.dataset.testField] = val;
    }
  });
  try {
    state.result = await api(`/api/rulesets/${encodeURIComponent(state.ruleset.id)}/evaluate`, { method: 'POST', body: JSON.stringify({ input }) });
    render();
  } catch (error) { showToast(`Could not run decision test: ${error.message}`, 'error'); }
}

function deleteSelectedNode() {
  const nodeId = state.selectedNodeId;
  if (!nodeId || state.graph.nodes.find((item) => item.id === nodeId)?.type === 'start') {
    showToast('The start node is required.', 'error'); return;
  }
  if (!window.confirm('Delete this node and its connected links? You can undo this change.')) return;
  checkpointHistory();
  state.graph.nodes = state.graph.nodes.filter((node) => node.id !== nodeId);
  state.graph.edges = state.graph.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
  state.selectedEdgeId = null;
  state.selectedNodeId = null;
  markDirty(); render();
}

function deleteSelectedEdge() {
  if (!state.selectedEdgeId) return;
  const previous = structuredClone(state.graph);
  if (!removeConnection(state.graph, state.selectedEdgeId)) return;
  state.selectedEdgeId = null;
  checkpointSnapshot(previous);
  markDirty(); render();
}

function selectEdge(edgeId) {
  state.selectedEdgeId = edgeId;
  state.selectedNodeId = null;
  renderCanvas();
  renderInspectorPanel();
  const selected = [...document.querySelectorAll('#graph-canvas [data-edge]')].find((item) => item.dataset.edge === edgeId);
  selected?.focus({ preventScroll: true });
  const deleteButton = document.querySelector('#delete-edge-button');
  if (deleteButton) deleteButton.disabled = false;
}

app.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  const projectButton = event.target.closest('[data-project]');
  const rulesetButton = event.target.closest('[data-ruleset]');
  const addNodeButton = event.target.closest('[data-add-node]');
  const removeFieldButton = event.target.closest('[data-remove-field]');
  const focusNodeButton = event.target.closest('[data-focus-node]');
  const groupActionButton = event.target.closest('[data-group-action]');
  const groupOpBtn = event.target.closest('[data-group-set-op]');
  if (groupOpBtn) {
    const op = groupOpBtn.dataset.groupSetOp;
    const path = groupOpBtn.dataset.groupPath;
    const node = state.graph?.nodes?.find((item) => item.id === state.selectedNodeId);
    if (node && node.type === 'group') {
      if (!path) {
        if (node.operator !== op) {
          checkpointHistory();
          node.operator = op;
          state.result = null;
          markDirty();
          render();
        }
      } else {
        const target = groupPath(path);
        if (target && target.term && target.term.type === 'group' && target.term.operator !== op) {
          checkpointHistory();
          target.term.operator = op;
          state.result = null;
          markDirty();
          render();
        }
      }
    }
    return;
  }
  const mobileTabBtn = event.target.closest('[data-mobile-tab]');
  if (mobileTabBtn) {
    state.mobileTab = mobileTabBtn.dataset.mobileTab;
    render();
    return;
  }
  if (projectButton) { await openProject(projectButton.dataset.project); return; }
  if (rulesetButton) { await openRuleset(rulesetButton.dataset.ruleset); return; }
  if (addNodeButton) { newNode(addNodeButton.dataset.addNode); return; }
  if (removeFieldButton) {
    if (!window.confirm('Remove this input field? Conditions using it will need an update.')) return;
    checkpointHistory();
    state.graph.schema = state.graph.schema.filter((field) => field.id !== removeFieldButton.dataset.removeField);
    markDirty(); render(); return;
  }
  if (focusNodeButton) { state.selectedNodeId = focusNodeButton.dataset.focusNode; render(); return; }
  if (groupActionButton) { addGroupTerm(groupActionButton.dataset.groupAction, groupActionButton.dataset.groupPath); return; }
  if (!action) return;
  try {
    if (action === 'add-field') addField();
    else if (action === 'toggle-inspector') {
      state.inspectorCollapsed = !state.inspectorCollapsed;
      render();
    } else if (action === 'stay-canvas') {
      // Already viewing editor canvas
    }
    else if (action === 'retry-save') await saveDraft();
    else if (action === 'dashboard') {
      if (!confirmDiscard()) return;
      clearAutosaveTimers();
      await loadProjects(); state.project = null; state.ruleset = null; state.graph = null; state.view = 'dashboard'; render();
    } else if (action === 'new-project') {
      const name = await askForName('project');
      if (!name) return;
      const data = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
      state.recovered = false;
      showToast('Project created.', 'success'); await openProject(data.project.id); await loadProjects();
    } else if (action === 'new-ruleset') {
      const name = await askForName('ruleset');
      if (!name) return;
      const data = await api(`/api/projects/${encodeURIComponent(state.project.id)}/rulesets`, { method: 'POST', body: JSON.stringify({ name }) });
      state.recovered = false;
      await openRuleset(data.ruleset.id);
    } else if (action === 'back-project') await openProject(state.project.id);
    else if (action === 'save') await saveDraft();
    else if (action === 'create-version') {
      if (state.dirty) { showToast('Save the draft before creating a version.', 'error'); return; }
      const data = await api(`/api/rulesets/${encodeURIComponent(state.ruleset.id)}/versions`, { method: 'POST', body: JSON.stringify({ expectedRevision: state.revision }) });
      state.recovered = false;
      showToast(`Saved immutable version ${data.version.versionNumber}.`, 'success');
      render();
    } else if (action === 'versions') await showVersionHistory();
    else if (action === 'import-draft') document.querySelector('#import-draft-file')?.click();
    else if (action === 'export-draft') exportDraft();
    else if (action === 'activity') await showProjectActivity();
    else if (action === 'undo') applyHistory('undo');
    else if (action === 'redo') applyHistory('redo');
    else if (action === 'validate') await validateDraft();
    else if (action === 'evaluate') await evaluateDraft();
    else if (action === 'clear-test') { state.result = null; state.testInput = {}; render(); }
    else if (action === 'delete-node') deleteSelectedNode();
    else if (action === 'delete-edge') deleteSelectedEdge();
    else if (action === 'zoom-in') { state.zoom = Math.min(1.6, state.zoom * 1.12); renderCanvas(); updateZoomLabel(); }
    else if (action === 'zoom-out') { state.zoom = Math.max(0.45, state.zoom / 1.12); renderCanvas(); updateZoomLabel(); }
    else if (action === 'fit') { state.zoom = 0.8; state.offset = { x: 0, y: 0 }; renderCanvas(); updateZoomLabel(); }
    else if (action === 'reload-ruleset') await openRuleset(state.ruleset.id);
    else if (action === 'download-conflict') downloadConflictCopy();
    else if (action === 'reload') window.location.reload();
    else if (action === 'help') showToast('Create nodes, connect output ports to input ports, then save and validate the graph.', 'info');
  } catch (error) { showToast(error.message, 'error'); }
});

app.addEventListener('dragstart', (event) => {
  const paletteButton = event.target.closest('[data-add-node]');
  if (!paletteButton || !event.dataTransfer) return;
  event.dataTransfer.setData('application/x-rulecanvas-node', paletteButton.dataset.addNode);
  event.dataTransfer.effectAllowed = 'copy';
});

app.addEventListener('dragover', (event) => {
  if (event.target.closest('#canvas-viewport') && event.dataTransfer?.types.includes('application/x-rulecanvas-node')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
});

app.addEventListener('drop', (event) => {
  const viewport = event.target.closest('#canvas-viewport');
  const type = event.dataTransfer?.getData('application/x-rulecanvas-node');
  if (!viewport || !['condition', 'group', 'outcome'].includes(type)) return;
  event.preventDefault();
  newNode(type, svgPoint(event));
});

app.addEventListener('input', (event) => {
  if (event.target.dataset.fieldProp === 'name') {
    const field = state.graph?.schema.find((item) => item.id === event.target.dataset.fieldId);
    if (field && field.name !== event.target.value) {
      checkpointHistory(`field-name:${field.id}`);
      const oldName = field.name;
      field.name = event.target.value;
      if (oldName in state.testInput) {
        state.testInput[field.name] = state.testInput[oldName];
        delete state.testInput[oldName];
      }
      markDirty();
    }
    return;
  }
  if (event.target.id === 'project-search') {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('[data-project]').forEach((card) => { card.hidden = !card.textContent.toLowerCase().includes(query); });
    return;
  }
  if (event.target.id === 'ruleset-name') { state.ruleset.name = event.target.value; markDirty(); return; }
  const testField = event.target.dataset.testField;
  if (testField) {
    const field = state.graph.schema.find((item) => item.name === testField);
    if (field) state.testInput[testField] = parseTypedValue(event.target, field.type);
    return;
  }
  if (event.target.id === 'outcome-label') {
    const node = state.graph.nodes.find((item) => item.id === state.selectedNodeId);
    if (node && node.label !== event.target.value) {
      checkpointHistory(`outcome-label:${node.id}`);
      node.label = event.target.value;
      markDirty(); renderCanvas();
    }
    return;
  }
  if (event.target.id === 'outcome-result') {
    const node = state.graph.nodes.find((item) => item.id === state.selectedNodeId);
    if (!node) return;
    try {
      const nextResult = JSON.parse(event.target.value);
      if (JSON.stringify(node.result) !== JSON.stringify(nextResult)) {
        checkpointHistory(`outcome-result:${node.id}`);
        node.result = nextResult;
        markDirty(); renderCanvas();
      }
      event.target.setCustomValidity('');
    }
    catch { event.target.setCustomValidity('Use valid JSON to return a structured value.'); }
    return;
  }
});

app.addEventListener('change', (event) => {
  if (event.target.id === 'import-draft-file') {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) importDraftFile(file).catch((error) => showToast(`Could not import draft: ${error.message}`, 'error'));
    return;
  }
  const testField = event.target.dataset.testField;
  if (testField) {
    const field = state.graph.schema.find((item) => item.name === testField);
    if (field) state.testInput[testField] = parseTypedValue(event.target, field.type);
    return;
  }
  const field = event.target.dataset.fieldId && state.graph.schema.find((item) => item.id === event.target.dataset.fieldId);
  if (field) {
    const prop = event.target.dataset.fieldProp;
    if (prop === 'name') {
      const oldName = field.name;
      field.name = event.target.value.trim();
      if (oldName in state.testInput) {
        state.testInput[field.name] = state.testInput[oldName];
        delete state.testInput[oldName];
      }
      markDirty(); render();
    }
    if (prop === 'type') {
      const type = event.target.value;
      updateField(field.id, { type, options: type === 'enum' ? ['Option A', 'Option B'] : undefined });
    }
    if (prop === 'required') updateField(field.id, { required: event.target.checked });
    if (prop === 'options') updateField(field.id, { options: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) });
    return;
  }
  if (event.target.id === 'root-group-operator') {
    const node = state.graph.nodes.find((item) => item.id === state.selectedNodeId && item.type === 'group');
    if (node && node.operator !== event.target.value) { checkpointHistory(); node.operator = event.target.value; state.result = null; markDirty(); render(); }
    return;
  }
  if (event.target.dataset.groupProp) { checkpointHistory(); updateGroupControl(event.target); return; }
  if (event.target.id === 'condition-field') {
    const node = state.graph.nodes.find((item) => item.id === state.selectedNodeId);
    const targetField = state.graph.schema.find((item) => item.id === event.target.value);
    if (node && targetField) {
      checkpointHistory();
      node.fieldId = targetField.id;
      node.operator = 'eq';
      node.value = targetField.type === 'number' ? 0 : targetField.type === 'boolean' ? true : targetField.type === 'enum' ? targetField.options?.[0] ?? '' : targetField.type === 'date' ? '2026-01-01' : '';
      markDirty(); render();
    }
  }
  if (event.target.id === 'condition-operator') {
    const node = state.graph.nodes.find((item) => item.id === state.selectedNodeId);
    if (node && node.operator !== event.target.value) { checkpointHistory(); node.operator = event.target.value; markDirty(); render(); }
  }
  if (event.target.id === 'condition-value') {
    const node = state.graph.nodes.find((item) => item.id === state.selectedNodeId);
    const field = state.graph.schema.find((item) => item.id === node?.fieldId);
    const value = field ? parseTypedValue(event.target, field.type) : undefined;
    if (node && field && node.value !== value) {
      checkpointHistory(`condition-value:${node.id}`);
      node.value = value; markDirty(); render();
    }
  }
});

app.addEventListener('change', (event) => {
  if (event.target.id === 'outcome-result') {
    const node = state.graph.nodes.find((item) => item.id === state.selectedNodeId);
    if (!node) return;
    try { node.result = JSON.parse(event.target.value); event.target.setCustomValidity(''); markDirty(); renderCanvas(); }
    catch { showToast('Outcome result must be valid JSON.', 'error'); }
  }
});

app.addEventListener('click', (event) => {
  const edge = event.target.closest('[data-edge]');
  if (edge) {
    selectEdge(edge.dataset.edge);
    return;
  }
  const node = event.target.closest('[data-node]');
  if (node && !event.target.closest('[data-port-kind]')) {
    state.selectedNodeId = node.dataset.node;
    state.selectedEdgeId = null;
    const deleteButton = document.querySelector('#delete-edge-button');
    if (deleteButton) deleteButton.disabled = true;
    if (state.view === 'editor') renderInspectorPanel();
  }
});

app.addEventListener('keydown', (event) => {
  const editingText = event.target.matches('input, textarea, select, [contenteditable="true"]');
  if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    applyHistory(event.shiftKey ? 'redo' : 'undo');
    return;
  }
  if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    applyHistory('redo');
    return;
  }
  if (event.key === 'Escape' && state.connectionSource) {
    state.connectionSource = null; state.connectionPointer = null; renderCanvas();
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && state.view === 'editor') {
    const tag = document.activeElement?.tagName;
    if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) { event.preventDefault(); if (state.selectedEdgeId) deleteSelectedEdge(); else deleteSelectedNode(); }
  }
});

async function boot() {
  try {
    await loadProjects();
    render();
    api('/api/health').then(({ recovered }) => {
      if (recovered) { state.recovered = true; render(); }
    }).catch(() => {});
  }
  catch (error) { app.innerHTML = `<main class="fatal-state"><h1>Workspace unavailable</h1><p>${escapeHtml(error.message)}</p><button class="button button-secondary" data-action="reload">Try again</button></main>`; }
}

function downloadConflictCopy() {
  const json = serializeConflictCopy({
    rulesetId: state.ruleset.id,
    name: document.querySelector('#ruleset-name')?.value ?? state.ruleset.name,
    expectedRevision: state.revision,
    graph: state.graph,
  });
  const objectUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `rulecanvas-conflict-${state.ruleset.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  showToast('Downloaded the unsaved local draft copy.', 'success');
}

function exportDraft() {
  const json = serializeRuleDraft({
    rulesetId: state.ruleset.id,
    name: document.querySelector('#ruleset-name')?.value ?? state.ruleset.name,
    revision: state.revision,
    graph: state.graph,
  });
  const objectUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `rulecanvas-draft-${state.ruleset.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  showToast('Exported the current local draft.', 'success');
}

async function importDraftFile(file) {
  if (file.size > 1_000_000) throw new Error('Draft file is larger than 1 MB.');
  const imported = parseRuleDraft(await file.text());
  const validation = await api(`/api/rulesets/${encodeURIComponent(state.ruleset.id)}/validate`, {
    method: 'POST', body: JSON.stringify({ graph: imported.graph }),
  });
  if (!validation.valid) {
    state.errors = validation.errors;
    render();
    showToast(`Import rejected: resolve ${validation.errors.length} graph issue${validation.errors.length === 1 ? '' : 's'} first.`, 'error');
    return;
  }
  if (!confirmDiscard()) return;
  checkpointHistory();
  state.graph = structuredClone(imported.graph);
  state.selectedNodeId = state.graph.nodes.find((node) => node.type !== 'start')?.id ?? 'start';
  state.selectedEdgeId = null;
  state.testInput = {};
  state.result = null;
  state.errors = [];
  markDirty();
  render();
  showToast('Imported a valid graph. Save draft to keep it in this workspace.', 'success');
}

window.addEventListener('beforeunload', (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

boot();
