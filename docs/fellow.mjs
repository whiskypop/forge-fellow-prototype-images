import { loadTasks, saveTasks, getAttachment } from './storage.mjs';
import { SAMPLE_TASK, DEMO_ROWS } from './demo-data.mjs';
import { normalizeDifficulty } from './model.mjs';

const loading = document.getElementById('loading');
const listView = document.getElementById('list-view');
const detailView = document.getElementById('detail-view');
const missing = document.getElementById('missing');
const objectUrls = [];
let allTasks = loadTasks();
if (!allTasks) {
  allTasks = [structuredClone(SAMPLE_TASK), ...structuredClone(DEMO_ROWS)];
  try { saveTasks(allTasks); } catch { /* The public demo still works in memory. */ }
}
const assignedTasks = allTasks.filter(task => task && task.assignment?.supplier);
let currentFilter = 'all';

function setText(id, value) {
  document.getElementById(id).textContent = String(value ?? '');
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = String(value);
  return node;
}

function showOnly(view) {
  loading.hidden = true;
  listView.hidden = view !== listView;
  detailView.hidden = view !== detailView;
  missing.hidden = view !== missing;
}

function showMissing(message) {
  setText('missing-detail', message);
  document.title = '未找到任务 · Fellow';
  showOnly(missing);
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function attachmentKind(type, ...names) {
  const mime = String(type || '').toLowerCase();
  const filenames = names.map(name => String(name || '').trim().toLowerCase());
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (filenames.some(name => /\.(png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/.test(name))) return 'image';
  if (filenames.some(name => /\.(mp4|webm|mov|m4v)(?:[?#]|$)/.test(name))) return 'video';
  return 'file';
}

function isMediaReference(reference) {
  if (reference && typeof reference === 'object' && reference.sample === true) return true;
  const item = reference && typeof reference === 'object' ? reference : { name: String(reference ?? '') };
  const kind = attachmentKind(item.type, item.name || item.filename || item.path, item.url);
  return kind === 'image' || kind === 'video';
}

function assignmentState(task) {
  if (!task.assignment?.supplier) return 'preview';
  return task.assignment.taskVersion === task.version ? 'current' : 'updated';
}

function versionLabel(task) {
  return '版本 ' + (Number.isInteger(task.version) ? task.version : 1);
}

function renderList() {
  const suppliers = [...new Set(assignedTasks.map(task => task.assignment.supplier))];
  setText('viewer-name', suppliers.length === 1 ? suppliers[0] : '专家视角');
  setText('count-all', assignedTasks.length);
  setText('count-current', assignedTasks.filter(task => assignmentState(task) === 'current').length);
  setText('count-updated', assignedTasks.filter(task => assignmentState(task) === 'updated').length);

  const search = document.getElementById('task-search').value.trim().toLocaleLowerCase();
  const visible = assignedTasks.filter(task => {
    if (currentFilter !== 'all' && assignmentState(task) !== currentFilter) return false;
    const haystack = [task.id, task.title, task.category2, task.category3].join(' ').toLocaleLowerCase();
    return !search || haystack.includes(search);
  });

  const rows = document.getElementById('task-rows');
  rows.replaceChildren();
  for (const task of visible) {
    const row = element('a', 'task-row');
    row.href = './fellow.html?task=' + encodeURIComponent(task.id);
    row.setAttribute('role', 'row');

    const nameCell = element('span', 'task-name-cell');
    nameCell.setAttribute('role', 'cell');
    nameCell.append(element('strong', 'row-title', task.title), element('span', 'row-id', task.id));
    if (Array.isArray(task.references) && task.references.some(isMediaReference)) {
      nameCell.append(element('span', 'reference-required-chip', '参考素材首轮必用'));
    }

    const categoryCell = element('span', 'category-cell');
    categoryCell.setAttribute('role', 'cell');
    categoryCell.append(element('span', '', [task.category2, task.category3].filter(Boolean).join(' · ')), element('span', 'difficulty-chip', '难度 · ' + (normalizeDifficulty(task.difficulty) || '待定')));

    const state = assignmentState(task);
    const statusCell = element('span', 'status-cell');
    statusCell.setAttribute('role', 'cell');
    statusCell.append(element('span', 'row-status ' + (state === 'updated' ? 'is-updated' : 'is-current'), state === 'updated' ? '题目有更新' : '待交付'));

    const versionCell = element('span', 'version-cell', versionLabel(task));
    versionCell.setAttribute('role', 'cell');
    row.append(nameCell, categoryCell, statusCell, versionCell);
    rows.append(row);
  }

  const empty = document.getElementById('list-empty');
  empty.hidden = visible.length > 0;
  if (visible.length === 0) {
    empty.textContent = assignedTasks.length === 0
      ? '暂无已分配的任务。请先在 Forge 配置题目并完成分配。'
      : '没有符合当前筛选条件的任务。';
  }
  document.title = '我的 Task · Fellow';
  showOnly(listView);
}

async function renderReference(reference) {
  const item = reference && typeof reference === 'object' ? reference : { name: String(reference ?? '') };
  const name = String(item.name || item.filename || item.path || '参考素材');
  const note = String(item.note || item.description || '');
  const remoteUrl = safeExternalUrl(item.url);
  const kind = attachmentKind(item.type, name, remoteUrl);
  const card = element('article', 'reference-card');
  const thumb = element('div', 'reference-thumb');
  const body = element('div', 'reference-body');
  let localUrl = null;

  if (item.sample === true) {
    thumb.classList.add('sample');
    thumb.setAttribute('role', 'img');
    thumb.setAttribute('aria-label', name);
  } else if (item.id) {
    try {
      const blob = await getAttachment(item.id);
      if (blob instanceof Blob) {
        localUrl = URL.createObjectURL(blob);
        objectUrls.push(localUrl);
      }
    } catch {
      // Keep the name and description visible if browser storage is unavailable.
    }
  }

  const mediaUrl = localUrl || remoteUrl;
  if (!item.sample && mediaUrl && kind === 'image') {
    const image = document.createElement('img');
    image.src = mediaUrl;
    image.alt = name;
    image.loading = 'lazy';
    thumb.append(image);
  } else if (!item.sample && mediaUrl && kind === 'video') {
    const video = document.createElement('video');
    video.src = mediaUrl;
    video.controls = true;
    video.preload = 'metadata';
    video.setAttribute('aria-label', name);
    thumb.append(video);
  } else if (!item.sample) {
    thumb.textContent = item.id && !localUrl ? '本地素材暂不可读取' : kind === 'image' ? '图片参考' : kind === 'video' ? '视频参考' : '文件参考';
  }

  body.append(element('strong', 'reference-name', name));
  if (note) body.append(element('p', 'reference-note', note));
  if (mediaUrl) {
    const link = element('a', 'reference-link', localUrl ? '打开／下载素材 ↗' : '打开参考素材 ↗');
    link.href = mediaUrl;
    if (localUrl) link.download = name;
    else { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    body.append(link);
  }
  card.append(thumb, body);
  return card;
}

async function renderTask(task) {
  const state = assignmentState(task);
  const supplier = task.assignment?.supplier || '尚未分配';
  const items = Array.isArray(task.references) ? task.references : [];
  const mediaCount = items.filter(isMediaReference).length;
  setText('viewer-name', supplier);
  setText('task-id', task.id);
  setText('task-title', task.title);
  setText('category-inline', [task.category2, task.category3].filter(Boolean).join(' · '));
  setText('assignment-inline', supplier);
  setText('category2', task.category2);
  setText('category3', task.category3);
  setText('difficulty', normalizeDifficulty(task.difficulty));
  setText('task-version', versionLabel(task));
  setText('brief', task.brief);
  document.title = task.id + ' ' + task.title + ' · Fellow';

  const status = document.getElementById('task-status');
  status.className = 'status-badge ' + state;
  status.textContent = state === 'current' ? '待交付' : state === 'updated' ? '题目有更新' : '题目预览';
  setText('status-notice', state === 'current'
    ? '已分配给 ' + supplier + '。请在交付前核对题面、验收清单和参考素材。'
    : state === 'updated'
      ? '分配后题目已有更新。本地原型展示最新内容；正式交付请以平台发布的版本为准。'
      : '这是尚未分配题目的本地预览；正式 Fellow 仅向获分配的专家展示。');
  document.getElementById('reference-requirement').hidden = mediaCount === 0;
  document.getElementById('reference-instructions').hidden = mediaCount === 0;
  setText('reference-media-count', mediaCount + ' 项参考图片或视频');

  const acceptance = document.getElementById('acceptance');
  acceptance.replaceChildren();
  const checks = Array.isArray(task.acceptance) ? task.acceptance : String(task.acceptance || '').split(/\r?\n/);
  for (const check of checks.map(item => String(item ?? '').trim()).filter(Boolean)) {
    acceptance.append(element('li', '', check));
  }

  const references = document.getElementById('references');
  references.replaceChildren();
  setText('reference-count', items.length + ' 项');
  if (items.length === 0) {
    references.append(element('div', 'reference-empty', '本题未提供参考素材；请以题面与验收清单为准。'));
  } else {
    for (const item of items) references.append(await renderReference(item));
  }
  showOnly(detailView);
}

function bindListControls() {
  document.getElementById('task-search').addEventListener('input', renderList);
  for (const button of document.querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => {
      currentFilter = button.dataset.filter;
      for (const tab of document.querySelectorAll('[data-filter]')) {
        tab.classList.toggle('is-active', tab === button);
      }
      renderList();
    });
  }
}

async function main() {
  bindListControls();
  const id = new URLSearchParams(location.search).get('task')?.trim();
  if (!id) { renderList(); return; }
  const task = allTasks.find(item => String(item?.id || '').toLocaleLowerCase() === id.toLocaleLowerCase());
  if (!task) {
    showMissing('当前浏览器没有题号 ' + id + ' 的任务数据。请从 Forge 配置页打开预览，或联系任务分配方核对链接。');
    return;
  }
  await renderTask(task);
}

window.addEventListener('pagehide', () => {
  for (const url of objectUrls) URL.revokeObjectURL(url);
});
main().catch(() => showMissing('任务说明暂时无法读取，请稍后重试或联系任务分配方。'));
