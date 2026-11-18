import {
  CSV_HEADERS,
  normalizeTask,
  normalizeDifficulty,
  validateTask,
  buildImportPreview,
  toCsv,
} from './model.mjs';
import {
  loadTasks,
  saveTasks,
  putAttachment,
  deleteAttachment,
} from './storage.mjs';

import { SAMPLE_TASK, DEMO_ROWS } from './demo-data.mjs';

const SHEET_META_KEY = 'forge-delivery-frontend:sheet-meta:v1';
const DEFAULT_SHEET_META = {
  name: '3D 场景任务演示',
  customer: '示例项目',
  description: '题目、验收和参考素材集中管理；分配信息独立记录。',
  fellowTaskType: '3D Blender',
  taskType: '',
  configVersion: '',
  makingMethod: '',
  tags: ['Running', 'Done'],
};

function loadSheetMeta() {
  try {
    const stored = JSON.parse(localStorage.getItem(SHEET_META_KEY) || 'null');
    if (!stored || typeof stored !== 'object') return { ...DEFAULT_SHEET_META };
    return {
      ...DEFAULT_SHEET_META,
      ...stored,
      tags: Array.isArray(stored.tags) ? stored.tags.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()) : [...DEFAULT_SHEET_META.tags],
    };
  } catch {
    return { ...DEFAULT_SHEET_META };
  }
}

function saveSheetMeta(meta) {
  localStorage.setItem(SHEET_META_KEY, JSON.stringify(meta));
}

function escapeHtml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, character => map[character]);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function downloadText(name, content, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if (typeof document !== 'undefined') {
  const dom = {
    rows: document.getElementById('task-rows'),
    count: document.getElementById('task-count'),
    incompleteToggle: document.getElementById('incomplete-toggle'),
    search: document.getElementById('search'),
    assignmentFilter: document.getElementById('filter-assignment'),
    difficultyFilter: document.getElementById('filter-difficulty'),
    tagFilter: document.getElementById('filter-tag'),
    selectAll: document.getElementById('select-all'),
    empty: document.getElementById('empty-state'),
    bulk: document.getElementById('bulk-actions'),
    selectionCount: document.getElementById('selection-count'),
    content: document.getElementById('content'),
    drawer: document.getElementById('drawer'),
    drawerBody: document.getElementById('drawer-body'),
    drawerFooter: document.getElementById('drawer-footer'),
    overlay: document.getElementById('overlay'),
    dialogTitle: document.getElementById('dialog-title'),
    dialogEyebrow: document.getElementById('dialog-eyebrow'),
    dialogBody: document.getElementById('dialog-body'),
    dialogFooter: document.getElementById('dialog-footer'),
    toast: document.getElementById('toast'),
  };

  let tasks = loadTasks();
  if (!tasks) {
    tasks = [structuredClone(SAMPLE_TASK), ...structuredClone(DEMO_ROWS)];
    try { saveTasks(tasks); } catch { /* The demo still works in memory. */ }
  }
  let sheetMeta = loadSheetMeta();
  let selected = new Set();
  let onlyIncomplete = false;
  let editingId = null;
  let draftReferences = [];
  let assigningIds = [];
  let ownerIds = [];
  let dialogMode = '';
  let importCsvFile = null;
  let importAssetFiles = [];
  let importPreview = null;
  let feishuPreview = null;
  let toastTimer;

  document.querySelector('#drawer .drawer-header strong').textContent = '编辑子项';
  dom.drawer.setAttribute('aria-label', '编辑子项');

  function renderSheetHeader() {
    document.getElementById('sheet-name').textContent = sheetMeta.name || '未命名数据单';
    document.getElementById('sheet-customer').textContent = sheetMeta.customer || '未填写客户';
    document.getElementById('sheet-description').textContent = sheetMeta.description || '暂无说明';
    document.getElementById('sheet-task-type').textContent = sheetMeta.fellowTaskType || '未配置 Fellow 任务类型';
  }

  function workflowOf(task) {
    const workflow = task?.workflow && typeof task.workflow === 'object' ? task.workflow : {};
    return {
      ...workflow,
      directory: String(workflow.directory || ''),
      note: String(workflow.note || ''),
      taskCategory: String(workflow.taskCategory || ''),
      productionOwner: String(workflow.productionOwner || ''),
      reviewOwner: String(workflow.reviewOwner || ''),
      fellowStatus: String(workflow.fellowStatus || ''),
      tag: String(workflow.tag || ''),
      linkedTasks: Array.isArray(workflow.linkedTasks) ? workflow.linkedTasks : [],
      fellowTasks: Array.isArray(workflow.fellowTasks) ? workflow.fellowTasks : [],
      reviewHistory: Array.isArray(workflow.reviewHistory) ? workflow.reviewHistory : [],
    };
  }

  function toast(message) {
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { dom.toast.hidden = true; }, 3600);
  }

  function persist() {
    try {
      saveTasks(tasks);
      return true;
    } catch {
      toast('本地保存失败，请检查浏览器存储空间');
      return false;
    }
  }

  function assignmentState(task) {
    if (!task.assignment?.supplier) return 'unassigned';
    return task.assignment.taskVersion === task.version ? 'assigned' : 'outdated';
  }

  function productionOwnerMarkup(task, workflow) {
    const supplier = task.assignment?.supplier || '';
    const owner = supplier || workflow.productionOwner;
    if (!owner) return '<span class="muted">未安排生产负责人</span>';
    const state = assignmentState(task);
    const badge = supplier && state === 'outdated'
      ? '<span class="badge badge-amber production-owner-state">题目待同步</span>'
      : '';
    return '<span class="production-owner-name">' + escapeHtml(owner) + '</span>' + badge;
  }

  function missingContent(task) {
    const missing = [];
    if (!String(task.brief || '').trim()) missing.push('题目说明');
    if (!Array.isArray(task.acceptance) || !task.acceptance.some(item => String(item || '').trim())) missing.push('验收标准');
    return missing;
  }

  function visibleTasks() {
    const query = dom.search.value.trim().toLocaleLowerCase();
    const assignment = dom.assignmentFilter.value;
    const difficulty = dom.difficultyFilter.value;
    const tag = dom.tagFilter.value;
    return tasks.filter(task => {
      const workflow = workflowOf(task);
      const text = [task.id, task.title, task.category2, task.category3, workflow.directory, workflow.note, workflow.taskCategory, workflow.productionOwner, workflow.reviewOwner, workflow.tag, task.assignment?.supplier].join(' ').toLocaleLowerCase();
      return (!query || text.includes(query))
        && (assignment === 'all' || assignmentState(task) === assignment)
        && (difficulty === 'all' || normalizeDifficulty(task.difficulty) === difficulty)
        && (tag === 'all' || (tag === 'none' ? !workflow.tag : workflow.tag === tag))
        && (!onlyIncomplete || missingContent(task).length > 0);
    });
  }

  function renderList() {
    const selectedDifficulty = dom.difficultyFilter.value;
    const selectedTag = dom.tagFilter.value;
    dom.difficultyFilter.innerHTML = '<option value="all">全部难度</option><option value="D1">D1</option><option value="D2">D2</option><option value="D3">D3</option>';
    dom.difficultyFilter.value = ['D1', 'D2', 'D3'].includes(selectedDifficulty) ? selectedDifficulty : 'all';
    const tagValues = [...new Set([...sheetMeta.tags, ...tasks.map(task => workflowOf(task).tag)].filter(Boolean))];
    dom.tagFilter.innerHTML = '<option value="all">全部 Tag</option><option value="none">无 Tag</option>' + tagValues.map(value => '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>').join('');
    dom.tagFilter.value = selectedTag === 'none' || tagValues.includes(selectedTag) ? selectedTag : 'all';
    const incompleteCount = tasks.filter(task => missingContent(task).length > 0).length;
    if (incompleteCount === 0) onlyIncomplete = false;
    const visible = visibleTasks();
    const tableWrap = dom.rows.closest('.table-wrap');
    const previousScroll = tableWrap?.scrollLeft || 0;
    dom.count.textContent = tasks.length + ' 个子项';
    dom.incompleteToggle.textContent = onlyIncomplete ? '只看待补 · ' + incompleteCount + ' 项 ×' : '待补全 ' + incompleteCount + ' 项';
    dom.incompleteToggle.classList.toggle('has-missing', incompleteCount > 0);
    dom.incompleteToggle.setAttribute('aria-pressed', String(onlyIncomplete));
    dom.incompleteToggle.disabled = incompleteCount === 0;
    dom.rows.innerHTML = visible.map(task => {
      const checked = selected.has(task.id) ? ' checked' : '';
      const rowClass = editingId === task.id ? ' class="is-selected"' : '';
      const workflow = workflowOf(task);
      const availableTags = [...new Set([...tagValues, workflow.tag].filter(Boolean))];
      const tagChoices = '<option value="">无 Tag</option>' + availableTags.map(value => '<option value="' + escapeHtml(value) + '"' + (value === workflow.tag ? ' selected' : '') + '>' + escapeHtml(value) + '</option>').join('');
      const linkedTasks = workflow.linkedTasks.length;
      const missing = missingContent(task);
      const alertMarkup = missing.length ? '<div class="content-alerts">' + missing.map(label => '<button class="content-alert-chip" type="button" data-action="edit-missing" data-id="' + escapeHtml(task.id) + '" data-field="' + (label === '题目说明' ? 'brief' : 'acceptance') + '" aria-label="补充 ' + escapeHtml(task.id) + ' 的' + label + '">缺' + label + '</button>').join('') + '</div>' : '';
      return [
        '<tr data-task-row="' + escapeHtml(task.id) + '"' + rowClass + '>',
        '<td class="row-select"><input type="checkbox" data-action="select" data-id="' + escapeHtml(task.id) + '" aria-label="选择 ' + escapeHtml(task.id) + '"' + checked + '></td>',
        '<td><span class="task-id">' + escapeHtml(task.id) + '</span><button class="task-title task-title-button" type="button" data-action="edit" data-id="' + escapeHtml(task.id) + '">' + escapeHtml(task.title) + '</button>' + alertMarkup + '</td>',
        '<td>' + escapeHtml(task.category2 || '—') + ' / ' + escapeHtml(task.category3 || '—') + '</td>',
        '<td><span class="difficulty-code">' + escapeHtml(normalizeDifficulty(task.difficulty) || '—') + '</span></td>',
        '<td>' + productionOwnerMarkup(task, workflow) + '</td>',
        '<td>' + escapeHtml(workflow.reviewOwner || '—') + '</td>',
        '<td>' + (workflow.fellowStatus ? '<span class="badge badge-gray">' + escapeHtml(workflow.fellowStatus) + '</span>' : '<span class="subtle">—</span>') + '</td>',
        '<td><select class="tag-select" data-action="tag-change" data-id="' + escapeHtml(task.id) + '" aria-label="设置 ' + escapeHtml(task.id) + ' 的 Tag">' + tagChoices + '</select></td>',
        '<td><div class="row-actions"><button class="btn btn-secondary" type="button" data-action="edit" data-id="' + escapeHtml(task.id) + '">编辑</button><button class="btn btn-quiet" type="button" data-action="review" data-id="' + escapeHtml(task.id) + '"' + (linkedTasks ? '' : ' disabled title="暂无关联 Forge 任务"') + '>去审核</button><button class="btn btn-quiet" type="button" data-action="review-history" data-id="' + escapeHtml(task.id) + '">查看审核记录</button></div></td>',
        '</tr>',
      ].join('');
    }).join('');
    if (tableWrap) tableWrap.scrollLeft = previousScroll;
    dom.empty.hidden = visible.length > 0;
    if (visible.length === 0) {
      dom.empty.querySelector('strong').textContent = tasks.length === 0 ? '还没有题目' : '没有符合条件的题目';
      dom.empty.querySelector('p').textContent = tasks.length === 0
        ? '新建单条题目，或导入包含 8 个字段的 CSV。'
        : '试试调整搜索词或筛选条件。';
      dom.empty.querySelector('button').hidden = tasks.length > 0;
    }
    dom.selectAll.checked = visible.length > 0 && visible.every(task => selected.has(task.id));
    dom.selectAll.indeterminate = visible.some(task => selected.has(task.id)) && !dom.selectAll.checked;
    dom.bulk.hidden = selected.size === 0;
    dom.selectionCount.textContent = '已选 ' + selected.size + ' 项';
  }

  function closeDrawer() {
    dom.drawer.hidden = true;
    dom.drawer.classList.remove('drawer-inline');
    dom.content.classList.remove('content-with-drawer');
    dom.drawerBody.innerHTML = '';
    dom.drawerFooter.innerHTML = '';
    editingId = null;
    draftReferences = [];
    renderList();
  }

  function closeDialog() {
    dom.overlay.hidden = true;
    dialogMode = '';
    dom.dialogBody.innerHTML = '';
    dom.dialogFooter.innerHTML = '';
    document.body.style.overflow = '';
  }

  function openDialog(mode, title, eyebrow, body, footer) {
    dialogMode = mode;
    dom.dialogTitle.textContent = title;
    dom.dialogEyebrow.textContent = eyebrow;
    dom.dialogBody.innerHTML = body;
    dom.dialogFooter.innerHTML = footer;
    dom.overlay.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function formMarkup(task = null) {
    const item = task || { id: '', title: '', category2: '', category3: '', difficulty: '', brief: '', acceptance: [], references: [] };
    const readonly = task ? ' readonly' : '';
    const difficulty = normalizeDifficulty(item.difficulty);
    const missing = missingContent(item);
    const difficultyChoices = ['D1', 'D2', 'D3'].map(value => '<option value="' + value + '"' + (difficulty === value ? ' selected' : '') + '>' + value + '</option>').join('');
    return [
      '<form id="task-form" novalidate><div id="form-errors" hidden></div><div class="field-grid">',
      '<label class="field"><span class="field-label">题号 <span class="required">*</span></span><input class="input" name="id" value="' + escapeHtml(item.id) + '" placeholder="如 DEMO-010"' + readonly + ' required><span class="field-help">' + (task ? '题号创建后固定，确保任务映射稳定。' : '同一数据单内不可重复。') + '</span></label>',
      '<label class="field"><span class="field-label">标题 <span class="required">*</span></span><input class="input" name="title" value="' + escapeHtml(item.title) + '" placeholder="简洁描述题目" required></label>',
      '<label class="field"><span class="field-label">二级分类 <span class="required">*</span></span><input class="input" name="category2" value="' + escapeHtml(item.category2) + '" placeholder="如 场景制作" required></label>',
      '<label class="field"><span class="field-label">三级分类 <span class="required">*</span></span><input class="input" name="category3" value="' + escapeHtml(item.category3) + '" placeholder="如 海岸主题" required></label>',
      '<label class="field"><span class="field-label">难度 <span class="required">*</span></span><select class="select" name="difficulty" required><option value=""' + (difficulty ? '' : ' selected') + '>请选择难度</option>' + difficultyChoices + '</select></label>',
      '<label class="field field-full' + (missing.includes('题目说明') ? ' is-missing' : '') + '"><span class="field-label">题目说明（要做什么） <span class="required">*</span></span><textarea class="textarea" name="brief" rows="9" required placeholder="写明目标、结构、连接、参数和制作边界">' + escapeHtml(item.brief) + '</textarea><span class="field-help">必填；按段落写清制作目标和重点。Fellow 会按原文显示。</span></label>',
      '<label class="field field-full' + (missing.includes('验收标准') ? ' is-missing' : '') + '"><span class="field-label">验收标准（验收清单） <span class="required">*</span></span><textarea class="textarea" name="acceptance" rows="5" required placeholder="每行一项验收标准">' + escapeHtml(item.acceptance.join('\n')) + '</textarea><span class="field-help">必填；每行一项可检查的验收标准。</span></label>',
      '<div class="field field-full"><span class="field-label">参考素材 <span class="muted">可选</span></span><div class="upload-zone"><div><strong>上传图片、视频或文件</strong><p>可为每份素材补充用途说明。</p></div><button class="btn btn-secondary" type="button" data-action="choose-reference">选择文件</button><input id="reference-files" type="file" multiple hidden></div><div id="draft-references"></div><div class="reference-link-row"><input id="reference-url" class="input" type="url" placeholder="或粘贴参考素材链接（https://…）"><button class="btn btn-secondary" type="button" data-action="add-reference-url">添加链接</button></div></div>',
      '</div></form>',
    ].join('');
  }

  function workflowMarkup(task = null) {
    const workflow = workflowOf(task);
    const assignedSupplier = task?.assignment?.supplier || '';
    const effectiveProductionOwner = assignedSupplier || workflow.productionOwner;
    const tagValues = [...new Set([...sheetMeta.tags, workflow.tag].filter(Boolean))];
    const tagChoices = '<option value="">无 Tag</option>' + tagValues.map(value => '<option value="' + escapeHtml(value) + '"' + (value === workflow.tag ? ' selected' : '') + '>' + escapeHtml(value) + '</option>').join('');
    const linkedText = workflow.linkedTasks.length
      ? workflow.linkedTasks.map(item => escapeHtml(typeof item === 'string' ? item : item?.name || item?.id || item?.url || '关联任务')).join('<br>')
      : '暂无关联 Forge 任务';
    const fellowText = workflow.fellowTasks.length
      ? workflow.fellowTasks.map(item => escapeHtml(typeof item === 'string' ? item : item?.name || item?.id || item?.url || 'Fellow 任务')).join('<br>')
      : '暂无历史 Fellow 任务';
    return [
      '<form id="workflow-form"><section class="detail-section workflow-section"><h3>原数据单信息</h3>',
      '<p class="field-help">供应商指派会显示在生产负责人中；编辑题面不会清空负责人、Tag 或审核记录。</p>',
      '<div class="field-grid">',
      '<label class="field"><span class="field-label">目录</span><input class="input" name="directory" value="' + escapeHtml(workflow.directory) + '" placeholder="原数据单目录"></label>',
      '<label class="field"><span class="field-label">任务分类</span><input class="input" name="taskCategory" value="' + escapeHtml(workflow.taskCategory) + '" placeholder="如 Image2Blender"></label>',
      '<label class="field field-full"><span class="field-label">说明 / 备注</span><textarea class="textarea" name="note" rows="3" placeholder="原子项说明">' + escapeHtml(workflow.note) + '</textarea></label>',
      '<label class="field"><span class="field-label">生产负责人</span><input class="input" name="productionOwner" value="' + escapeHtml(effectiveProductionOwner) + '" placeholder="未安排"' + (assignedSupplier ? ' readonly' : '') + '><span class="field-help">' + (assignedSupplier ? '已分配到 Fellow；请用“指派供应商”调整生产负责人。' : '指派供应商后会自动显示在这里。') + '</span></label>',
      '<label class="field"><span class="field-label">审核负责人</span><input class="input" name="reviewOwner" value="' + escapeHtml(workflow.reviewOwner) + '" placeholder="未安排"></label>',
      '<label class="field"><span class="field-label">Tag</span><select class="select" name="tag">' + tagChoices + '</select></label>',
      '<label class="field"><span class="field-label">Fellow 状态 <span class="muted">只读</span></span><input class="input" value="' + escapeHtml(workflow.fellowStatus || '—') + '" readonly><span class="field-help">正式系统由 Fellow 同步，本地原型不推断状态。</span></label>',
      '</div><div class="legacy-link-summary"><div><strong>关联 Forge 任务</strong><p>' + linkedText + '</p></div><div><strong>历史 Fellow 任务</strong><p>' + fellowText + '</p></div></div>',
      '</section></form>',
    ].join('');
  }

  function renderDraftReferences() {
    const target = document.getElementById('draft-references');
    if (!target) return;
    target.innerHTML = draftReferences.length
      ? '<ul class="uploaded-list">' + draftReferences.map((reference, index) => [
        '<li class="reference-editor-item"><div class="reference-editor-main"><strong>' + escapeHtml(reference.name || '未命名素材') + '</strong>',
        '<input class="input" type="text" data-reference-note="' + index + '" aria-label="' + escapeHtml(reference.name || '素材') + '的用途说明" placeholder="用途说明，如仅供风格参考" value="' + escapeHtml(reference.note || '') + '"></div>',
        '<button class="btn btn-quiet" type="button" data-action="remove-reference" data-index="' + index + '">移除</button></li>',
      ].join('')).join('') + '</ul>'
      : '<p class="field-help">未上传参考素材时，此题仍可保存。</p>';
  }

  function showFormErrors(errors) {
    const target = document.getElementById('form-errors');
    if (!target) return;
    target.hidden = errors.length === 0;
    target.className = errors.length ? 'validation-error' : '';
    target.innerHTML = errors.length ? '<strong>请先修正以下问题：</strong><ul>' + errors.map(error => '<li>' + escapeHtml(error) + '</li>').join('') + '</ul>' : '';
    if (errors.length) target.scrollIntoView({ block: 'nearest' });
  }

  function openEditor(id) {
    closeDialog();
    const task = tasks.find(item => item.id === id);
    if (!task) return;
    const missing = missingContent(task);
    editingId = id;
    draftReferences = task.references.map(reference => ({ ...reference }));
    dom.drawerBody.innerHTML = [
      '<div class="drawer-kicker">' + escapeHtml(task.id) + ' · 版本 ' + (task.version || 1) + '</div>',
      '<h2 class="drawer-title">配置题目字段</h2>',
      (missing.length ? '<p class="drawer-missing-note">待补充：' + missing.join('、') + '。保存草稿后仍会在列表提醒，补齐前不能指派供应商。</p>' : ''),
      '<p class="field-help">Forge 配置题目内容和原有子项信息；Fellow 展示给供应商阅读的完整题目。</p>',
      formMarkup(task),
      workflowMarkup(task),
      '<section class="detail-section"><h3>分配记录</h3><dl class="detail-grid"><dt>状态</dt><dd>' + (assignmentState(task) === 'outdated' ? '待同步' : task.assignment?.supplier ? '已分配' : '未分配') + '</dd><dt>供应商</dt><dd>' + escapeHtml(task.assignment?.supplier || '—') + '</dd><dt>分配题目版本</dt><dd>' + escapeHtml(task.assignment?.taskVersion || '—') + '</dd></dl></section>',
    ].join('');
    dom.drawerFooter.innerHTML = [
      '<button class="btn btn-danger footer-left" type="button" data-action="delete-task" data-id="' + escapeHtml(id) + '">删除</button>',
      '<button class="btn btn-secondary" type="button" data-action="assign-one" data-id="' + escapeHtml(id) + '"' + (missing.length ? ' disabled title="请先补齐题目说明和验收标准"' : '') + '>指派供应商</button>',
      '<button class="btn btn-secondary" type="button" data-action="review-history" data-id="' + escapeHtml(id) + '">审核记录</button>',
      '<button class="btn btn-secondary" type="button" data-action="open-fellow" data-id="' + escapeHtml(id) + '">预览已保存版本 ↗</button>',
      '<button class="btn btn-primary" type="button" data-action="save-task">保存字段</button>',
    ].join('');
    dom.drawer.hidden = false;
    dom.drawer.classList.add('drawer-inline');
    dom.content.classList.add('content-with-drawer');
    renderDraftReferences();
    renderList();
  }

  function openCreate() {
    closeDrawer();
    draftReferences = [];
    openDialog('create', '新建题目', 'Forge · 字段配置', formMarkup() + workflowMarkup(), [
      '<button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button>',
      '<button class="btn btn-primary" type="button" data-action="save-task">保存题目</button>',
    ].join(''));
    renderDraftReferences();
  }

  async function saveTaskForm() {
    const form = document.getElementById('task-form');
    if (!form) return;
    const input = new FormData(form);
    const raw = {
      id: input.get('id'),
      title: input.get('title'),
      category2: input.get('category2'),
      category3: input.get('category3'),
      difficulty: input.get('difficulty'),
      brief: input.get('brief'),
      acceptance: input.get('acceptance'),
      references: draftReferences.map(reference => ({ name: reference.name, note: reference.note })),
    };
    const current = editingId ? tasks.find(item => item.id === editingId) : null;
    const workflowForm = document.getElementById('workflow-form');
    const workflowInput = workflowForm ? new FormData(workflowForm) : null;
    const workflow = {
      ...workflowOf(current),
      directory: workflowInput?.get('directory')?.toString().trim() || '',
      note: workflowInput?.get('note')?.toString().trim() || '',
      taskCategory: workflowInput?.get('taskCategory')?.toString().trim() || '',
      productionOwner: current?.assignment?.supplier || workflowInput?.get('productionOwner')?.toString().trim() || '',
      reviewOwner: workflowInput?.get('reviewOwner')?.toString().trim() || '',
      tag: workflowInput?.get('tag')?.toString().trim() || '',
    };
    const errors = validateTask(raw, tasks.filter(item => item.id !== editingId));
    showFormErrors(errors);
    if (errors.length) return;
    const references = [];
    try {
      for (const reference of draftReferences) {
        if (reference.file) {
          const asset = await putAttachment(reference.file);
          references.push({ ...asset, note: reference.note || '' });
        } else {
          references.push({ ...reference });
        }
      }
    } catch (error) {
      showFormErrors([error.message || '参考素材保存失败']);
      return;
    }
    const canonical = normalizeTask({ ...raw, references });
    const changed = !current || JSON.stringify(normalizeTask(current)) !== JSON.stringify(canonical);
    const task = {
      ...(current || {}),
      ...canonical,
      version: current ? (current.version || 1) + (changed ? 1 : 0) : 1,
      assignment: current?.assignment || null,
      workflow,
    };
    const previousTasks = tasks;
    if (current) {
      tasks = tasks.map(item => item.id === editingId ? task : item);
    } else {
      tasks = [...tasks, task];
    }
    if (!persist()) {
      tasks = previousTasks;
      showFormErrors(['题目未保存，请检查浏览器存储空间']);
      return;
    }
    closeDialog();
    toast(current ? '题目字段已保存' : '题目已创建');
    openEditor(task.id);
  }

  function openAssignment(ids) {
    assigningIds = ids.filter(id => tasks.some(task => task.id === id));
    if (assigningIds.length === 0) return;
    const incomplete = tasks.filter(task => assigningIds.includes(task.id) && missingContent(task).length > 0);
    if (incomplete.length) {
      openEditor(incomplete[0].id);
      toast('有 ' + incomplete.length + ' 项缺少题目说明或验收标准，请先补齐再指派');
      return;
    }
    const current = assigningIds.length === 1 ? tasks.find(task => task.id === assigningIds[0])?.assignment?.supplier || '' : '';
    openDialog('assignment', '指派供应商', 'Forge · 分配记录', [
      '<p class="field-help">将 ' + assigningIds.length + ' 个题目指派给同一供应商，并同步显示为生产负责人。分配时记录当前题目版本；字段之后修改会标记为“待同步”。</p>',
      '<form id="assignment-form"><label class="field"><span class="field-label">供应商 <span class="required">*</span></span><input class="input" name="supplier" value="' + escapeHtml(current) + '" placeholder="输入供应商名称" required></label></form>',
      '<div id="assignment-errors" class="validation-error" hidden></div>',
    ].join(''), [
      '<button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button>',
      '<button class="btn btn-primary" type="button" data-action="save-assignment">确认指派</button>',
    ].join(''));
  }

  function saveAssignmentForm() {
    const supplier = new FormData(document.getElementById('assignment-form')).get('supplier')?.toString().trim() || '';
    const errors = document.getElementById('assignment-errors');
    const incomplete = tasks.filter(task => assigningIds.includes(task.id) && missingContent(task).length > 0);
    if (incomplete.length) {
      errors.textContent = '有 ' + incomplete.length + ' 项缺少题目说明或验收标准，请先补齐再指派';
      errors.hidden = false;
      return;
    }
    if (!supplier) {
      errors.textContent = '请输入供应商名称';
      errors.hidden = false;
      return;
    }
    const previousTasks = tasks;
    tasks = tasks.map(task => assigningIds.includes(task.id)
      ? { ...task, assignment: { supplier, taskVersion: task.version || 1, assignedAt: new Date().toISOString() }, workflow: { ...workflowOf(task), productionOwner: supplier } }
      : task);
    if (!persist()) {
      tasks = previousTasks;
      errors.textContent = '分配未保存，请检查浏览器存储空间';
      errors.hidden = false;
      return;
    }
    selected.clear();
    closeDialog();
    if (editingId) openEditor(editingId);
    else renderList();
    toast('已指派 ' + assigningIds.length + ' 个题目');
  }

  function openOwnerAssignment(ids) {
    ownerIds = ids.filter(id => tasks.some(task => task.id === id));
    if (!ownerIds.length) return;
    openDialog('owners', '批量指派负责人', 'Forge · 原数据单字段', [
      '<p class="field-help">只更新勾选的负责人字段；未勾选的字段保持原值。已分配给供应商的任务，其生产负责人请通过“批量指派供应商”调整；审核负责人仍可单独修改。</p>',
      '<form id="owner-form" class="owner-form">',
      '<label class="field"><span class="field-label"><input type="checkbox" name="setProduction"> 更新生产负责人</span><input class="input" name="productionOwner" placeholder="输入生产负责人"></label>',
      '<label class="field"><span class="field-label"><input type="checkbox" name="setReview"> 更新审核负责人</span><input class="input" name="reviewOwner" placeholder="输入审核负责人"></label>',
      '</form><div id="owner-errors" class="validation-error" hidden></div>',
    ].join(''), [
      '<button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button>',
      '<button class="btn btn-primary" type="button" data-action="save-owners">确认指派 ' + ownerIds.length + ' 项</button>',
    ].join(''));
  }

  function saveOwnerAssignment() {
    const form = new FormData(document.getElementById('owner-form'));
    const setProduction = form.has('setProduction');
    const setReview = form.has('setReview');
    const errors = document.getElementById('owner-errors');
    if (!setProduction && !setReview) {
      errors.textContent = '请至少勾选一个负责人字段';
      errors.hidden = false;
      return;
    }
    const assigned = tasks.filter(task => ownerIds.includes(task.id) && task.assignment?.supplier);
    if (setProduction && assigned.length) {
      errors.textContent = '所选任务中有 ' + assigned.length + ' 项已分配供应商。请用“批量指派供应商”调整生产负责人，或仅修改审核负责人。';
      errors.hidden = false;
      return;
    }
    const productionOwner = form.get('productionOwner')?.toString().trim() || '';
    const reviewOwner = form.get('reviewOwner')?.toString().trim() || '';
    const previousTasks = tasks;
    tasks = tasks.map(task => ownerIds.includes(task.id) ? {
      ...task,
      workflow: {
        ...workflowOf(task),
        ...(setProduction ? { productionOwner } : {}),
        ...(setReview ? { reviewOwner } : {}),
      },
    } : task);
    if (!persist()) {
      tasks = previousTasks;
      errors.textContent = '负责人未保存，请检查浏览器存储空间';
      errors.hidden = false;
      return;
    }
    selected.clear();
    closeDialog();
    if (editingId) openEditor(editingId);
    else renderList();
    toast('已更新 ' + ownerIds.length + ' 个子项的负责人');
  }

  function openSheetEditor() {
    openDialog('sheet', '编辑数据单', 'Forge · 公共属性', [
      '<form id="sheet-form" class="field-grid">',
      '<label class="field"><span class="field-label">数据单名称 <span class="required">*</span></span><input class="input" name="name" value="' + escapeHtml(sheetMeta.name) + '" required></label>',
      '<label class="field"><span class="field-label">客户 / 需求方</span><input class="input" name="customer" value="' + escapeHtml(sheetMeta.customer) + '"></label>',
      '<label class="field field-full"><span class="field-label">说明</span><textarea class="textarea" name="description" rows="3">' + escapeHtml(sheetMeta.description) + '</textarea></label>',
      '<label class="field"><span class="field-label">Fellow 任务类型</span><input class="input" name="fellowTaskType" value="' + escapeHtml(sheetMeta.fellowTaskType) + '"></label>',
      '<label class="field"><span class="field-label">任务类型</span><input class="input" name="taskType" value="' + escapeHtml(sheetMeta.taskType) + '"></label>',
      '<label class="field"><span class="field-label">配置版本</span><input class="input" name="configVersion" value="' + escapeHtml(sheetMeta.configVersion) + '"></label>',
      '<label class="field"><span class="field-label">制作方式</span><input class="input" name="makingMethod" value="' + escapeHtml(sheetMeta.makingMethod) + '"></label>',
      '</form><div id="sheet-errors" class="validation-error" hidden></div>',
    ].join(''), [
      '<button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button>',
      '<button class="btn btn-primary" type="button" data-action="save-sheet">保存数据单</button>',
    ].join(''));
  }

  function saveSheetForm() {
    const form = new FormData(document.getElementById('sheet-form'));
    const name = form.get('name')?.toString().trim() || '';
    if (!name) {
      const errors = document.getElementById('sheet-errors');
      errors.textContent = '数据单名称不能为空';
      errors.hidden = false;
      return;
    }
    const next = { ...sheetMeta, name };
    for (const key of ['customer', 'description', 'fellowTaskType', 'taskType', 'configVersion', 'makingMethod']) {
      next[key] = form.get(key)?.toString().trim() || '';
    }
    try { saveSheetMeta(next); }
    catch { toast('数据单信息保存失败'); return; }
    sheetMeta = next;
    renderSheetHeader();
    closeDialog();
    toast('数据单信息已保存');
  }

  function openTagManager() {
    const usedTags = [...new Set(tasks.map(task => workflowOf(task).tag).filter(Boolean))];
    openDialog('tags', '管理 Tag', 'Forge · 人工状态', [
      '<p class="field-help">每行一个 Tag。已经用于子项的 Tag 会保留，避免历史标记丢失。</p>',
      '<label class="field"><span class="field-label">可选 Tag</span><textarea id="tag-options" class="textarea" rows="7">' + escapeHtml(sheetMeta.tags.join('\n')) + '</textarea></label>',
      '<p class="field-help">使用中：' + escapeHtml(usedTags.join('、') || '无') + '</p>',
    ].join(''), [
      '<button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button>',
      '<button class="btn btn-primary" type="button" data-action="save-tags">保存 Tag</button>',
    ].join(''));
  }

  function saveTags() {
    const entered = document.getElementById('tag-options').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const used = tasks.map(task => workflowOf(task).tag).filter(Boolean);
    const next = { ...sheetMeta, tags: [...new Set([...entered, ...used])] };
    try { saveSheetMeta(next); }
    catch { toast('Tag 设置保存失败'); return; }
    sheetMeta = next;
    closeDialog();
    renderList();
    toast('Tag 选项已保存');
  }

  function openTagStats() {
    const counts = new Map();
    for (const task of tasks) {
      const tag = workflowOf(task).tag || '无 Tag';
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    openDialog('tag-stats', 'Tag 统计', 'Forge · 当前数据单', [
      '<p class="field-help">统计当前本地数据单的所有子项；Tag 与 Fellow 状态分别计算。</p>',
      '<div class="tag-stats">' + [...counts].map(([tag, count]) => '<div><strong>' + escapeHtml(tag) + '</strong><span>' + count + ' 项</span></div>').join('') + '</div>',
    ].join(''), '<button class="btn btn-primary" type="button" data-action="close-dialog">关闭</button>');
  }

  function openExportAll() {
    openDialog('export-all', '统一导出', 'Forge · 本地演示', [
      '<p>导出数据单公共属性、题目 8 字段、原有负责人／Fellow 状态／Tag、供应商分配和审核记录的 JSON 元数据。</p>',
      '<p class="field-help">本地上传的图片二进制保存在浏览器 IndexedDB，不包含在此 JSON 中。正式 Forge 的完整文件包导出需要服务端实现。</p>',
    ].join(''), [
      '<button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button>',
      '<button class="btn btn-primary" type="button" data-action="download-all">导出元数据 JSON</button>',
    ].join(''));
  }

  function openReviewHistory(id) {
    const task = tasks.find(item => item.id === id);
    if (!task) return;
    const history = workflowOf(task).reviewHistory;
    const entries = history.length ? history.map(item => {
      if (typeof item === 'string') return '<li>' + escapeHtml(item) + '</li>';
      const label = [item?.at || item?.time, item?.reviewer, item?.result || item?.status].filter(Boolean).join(' · ');
      return '<li><strong>' + escapeHtml(label || '审核记录') + '</strong>' + (item?.note ? '<p>' + escapeHtml(item.note) + '</p>' : '') + '</li>';
    }).join('') : '<li class="history-empty">暂无审核记录；本地原型不会生成虚构审核结果。</li>';
    openDialog('review-history', '查看审核记录', id, '<ol class="review-history">' + entries + '</ol>', '<button class="btn btn-primary" type="button" data-action="close-dialog">关闭</button>');
  }

  function openReview(id) {
    const task = tasks.find(item => item.id === id);
    if (!task) return;
    const linked = workflowOf(task).linkedTasks;
    if (!linked.length) { toast('当前子项没有关联 Forge 任务'); return; }
    openDialog('review', '关联任务审核', id, [
      '<p class="field-help">以下是已关联的 Forge 任务。正式审核仍需在 Forge 后端完成，本地原型只展示关联信息。</p>',
      '<ul class="review-history">' + linked.map(item => '<li>' + escapeHtml(typeof item === 'string' ? item : item?.name || item?.id || item?.url || '关联任务') + '</li>').join('') + '</ul>',
    ].join(''), '<button class="btn btn-primary" type="button" data-action="close-dialog">关闭</button>');
  }

  function openImport() {
    closeDrawer();
    importCsvFile = null;
    importAssetFiles = [];
    importPreview = null;
    openDialog('import', '批量导入题目', 'Forge · 8 字段模板', [
      '<p class="field-help">从飞书导出 CSV 后上传。前 7 列必填；参考素材可选，若填写文件名，请同时选择对应素材文件。</p>',
      '<div class="field-grid"><label class="field"><span class="field-label">任务表 CSV</span><input id="import-csv" class="input" type="file" accept=".csv,text/csv"></label>',
      '<label class="field"><span class="field-label">参考素材文件 <span class="muted">可选</span></span><input id="import-assets" class="input" type="file" multiple></label></div>',
      '<div class="detail-section"><h3>导入字段</h3><p class="field-help">' + CSV_HEADERS.map(escapeHtml).join(' · ') + '</p></div>',
      '<div id="import-errors" class="validation-error" hidden></div>',
    ].join(''), [
      '<button class="btn btn-quiet footer-left" type="button" data-action="download-template">下载 CSV 模板</button>',
      '<button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button>',
      '<button class="btn btn-primary" type="button" data-action="check-import">校验并预览</button>',
    ].join(''));
  }

  function openFeishuImport() {
    closeDrawer();
    feishuPreview = null;
    openDialog('feishu-import', '从飞书链接导入', 'Forge · 交互原型', [
      '<div class="feishu-import-intro"><strong>预览飞书文档导入流程</strong><p>公开原型仅演示字段映射、校验和确认导入。这里不会读取真实飞书文档；点击“预览示例”后展示固定示例题目。</p></div>',
      '<div class="field-grid">',
      '<label class="field field-full"><span class="field-label">飞书文档链接 <span class="muted">可选</span></span><input id="feishu-url" class="input" type="url" placeholder="https://your-domain.feishu.cn/wiki/..."><span class="field-help">仅记录链接，不会访问链接或提取其中的文字、图片。</span></label>',
      '<label class="field"><span class="field-label">二级分类 <span class="required">*</span></span><input id="feishu-category2" class="input" value="场景制作" required><span class="field-help">演示导入时应用到示例题目。</span></label>',
      '</div><div id="feishu-import-errors" class="validation-error" hidden></div>',
    ].join(''), [
      '<button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button>',
      '<button class="btn btn-primary" type="button" data-action="check-feishu-import">预览示例</button>',
    ].join(''));
  }

  function feishuImportErrors() {
    if (!feishuPreview) return ['请先预览示例'];
    return feishuPreview.rows.flatMap(row => row.errors.map(error => `${row.task.id || `第 ${row.index} 行`}：${error}`));
  }

  async function checkFeishuImport() {
    const errorBox = document.getElementById('feishu-import-errors');
    const category2 = document.getElementById('feishu-category2')?.value.trim();
    const sourceUrl = document.getElementById('feishu-url')?.value.trim() || '';
    if (!category2) {
      errorBox.textContent = '请填写二级分类';
      errorBox.hidden = false;
      return;
    }
    if (sourceUrl && !safeHttpUrl(sourceUrl)) {
      errorBox.textContent = '飞书文档链接需要以 http 或 https 开头';
      errorBox.hidden = false;
      return;
    }
    let suffix = 1;
    while (tasks.some(task => task.id === `FEISHU-DEMO-${suffix}`)) suffix += 1;
    const task = normalizeTask({
      ...SAMPLE_TASK,
      id: `FEISHU-DEMO-${suffix}`,
      title: `${SAMPLE_TASK.title}（导入示例）`,
      category2,
    });
    feishuPreview = {
      sourceUrl,
      rows: [{ index: 1, task, errors: validateTask(task, tasks), warnings: [] }],
    };
    const errors = feishuImportErrors();
    dom.dialogBody.innerHTML = [
      '<div class="validation-ok"><strong>示例预览：1 道题，1 张示意参考图</strong></div>',
      '<p class="field-help">这是固定示例数据，不代表所填飞书链接的实际内容。正式功能需接入飞书授权和文档解析服务。</p>',
      '<div class="import-preview"><table><thead><tr><th>题号 / 标题</th><th>题目分类</th><th>难度</th><th>参考素材</th><th>校验</th></tr></thead><tbody>',
      '<tr><td><strong>' + escapeHtml(task.id) + '</strong><br>' + escapeHtml(task.title) + '<details class="feishu-row-detail"><summary>查看题目说明与验收清单</summary><strong>要做什么</strong><pre>' + escapeHtml(task.brief) + '</pre><strong>验收清单</strong><pre>' + escapeHtml(task.acceptance.join('\n')) + '</pre></details></td><td>' + escapeHtml(task.category2 + ' / ' + task.category3) + '</td><td>' + escapeHtml(task.difficulty) + '</td><td>1 张示意参考图</td><td>' + (errors.length ? '<span class="badge badge-red">' + escapeHtml(errors.join('；')) + '</span>' : '<span class="badge badge-green">通过</span>') + '</td></tr>',
      '</tbody></table></div>',
    ].join('');
    dom.dialogFooter.innerHTML = [
      '<button class="btn btn-secondary footer-left" type="button" data-action="import-feishu">返回</button>',
      '<button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button>',
      '<button class="btn btn-primary" type="button" data-action="confirm-feishu-import"' + (errors.length ? ' disabled' : '') + '>导入示例题目</button>',
    ].join('');
  }

  async function confirmFeishuImport() {
    if (!feishuPreview || feishuImportErrors().length) return;
    const row = feishuPreview.rows[0];
    const imported = {
      ...row.task,
      version: 1,
      assignment: null,
      source: feishuPreview.sourceUrl ? { type: 'feishu-demo', url: feishuPreview.sourceUrl } : null,
    };
    const previousTasks = tasks;
    tasks = [...tasks, imported];
    if (!persist()) { tasks = previousTasks; return; }
    closeDialog();
    renderList();
    toast('示例题目已导入，仅保存在此浏览器');
    openEditor(imported.id);
  }

  function importErrors() {
    if (!importPreview) return ['请先选择 CSV 文件'];
    const errors = [...importPreview.errors];
    for (const row of importPreview.rows) {
      if (row.errors.length) errors.push('第 ' + row.index + ' 行：' + row.errors.join('；'));
    }
    return errors;
  }

  async function checkImport() {
    const errorBox = document.getElementById('import-errors');
    if (!importCsvFile) {
      errorBox.textContent = '请选择任务表 CSV';
      errorBox.hidden = false;
      return;
    }
    try {
      importPreview = buildImportPreview(await importCsvFile.text(), tasks);
      const fileNames = new Map(importAssetFiles.map(file => [file.name.toLocaleLowerCase(), file]));
      for (const row of importPreview.rows) {
        for (const reference of row.task.references) {
          if (!reference.url && !fileNames.has(reference.name.toLocaleLowerCase())) {
            row.errors.push('未找到参考素材文件：' + reference.name);
          }
        }
      }
      const errors = importErrors();
      dom.dialogBody.innerHTML = [
        '<div class="' + (errors.length ? 'validation-error' : 'validation-ok') + '">' + (errors.length
          ? '<strong>发现 ' + errors.length + ' 个问题，修正 CSV 或素材后重新导入。</strong>'
          : '<strong>字段与素材校验通过，可导入 ' + importPreview.rows.length + ' 个题目。</strong>') + '</div>',
        '<div class="import-preview"><table><thead><tr><th>行号</th><th>题号</th><th>标题</th><th>分类</th><th>难度</th><th>素材</th><th>校验</th></tr></thead><tbody>',
        importPreview.rows.map(row => '<tr><td>' + row.index + '</td><td>' + escapeHtml(row.task.id) + '</td><td>' + escapeHtml(row.task.title) + '</td><td>' + escapeHtml(row.task.category2) + ' / ' + escapeHtml(row.task.category3) + '</td><td>' + escapeHtml(row.task.difficulty) + '</td><td>' + row.task.references.length + '</td><td>' + (row.errors.length ? '<span class="badge badge-red">' + escapeHtml(row.errors.join('；')) + '</span>' : '<span class="badge badge-green">通过</span>') + '</td></tr>').join(''),
        '</tbody></table></div>',
        importPreview.errors.length ? '<div class="validation-error">' + importPreview.errors.map(escapeHtml).join('；') + '</div>' : '',
        '<p class="field-help">完整“要做什么”与验收清单会在 Fellow 作为供应商页面展示。</p>',
      ].join('');
      dom.dialogFooter.innerHTML = [
        '<button class="btn btn-secondary footer-left" type="button" data-action="import">返回重新选择</button>',
        '<button class="btn btn-secondary" type="button" data-action="close-dialog">取消</button>',
        '<button class="btn btn-primary" type="button" data-action="confirm-import"' + (errors.length ? ' disabled' : '') + '>确认导入</button>',
      ].join('');
    } catch (error) {
      errorBox.textContent = error.message || '无法读取 CSV 文件';
      errorBox.hidden = false;
    }
  }

  async function confirmImport() {
    if (!importPreview || importErrors().length) return;
    const files = new Map(importAssetFiles.map(file => [file.name.toLocaleLowerCase(), file]));
    const assetCache = new Map();
    const imported = [];
    try {
      for (const row of importPreview.rows) {
        const references = [];
        for (const reference of row.task.references) {
          if (reference.url) {
            references.push(reference);
          } else {
            const key = reference.name.toLocaleLowerCase();
            let asset = assetCache.get(key);
            if (!asset) {
              asset = await putAttachment(files.get(key));
              assetCache.set(key, asset);
            }
            references.push({ ...asset, note: reference.note || '' });
          }
        }
        imported.push({ ...normalizeTask({ ...row.task, references }), version: 1, assignment: null });
      }
    } catch (error) {
      dom.dialogBody.insertAdjacentHTML('afterbegin', '<div class="validation-error">' + escapeHtml(error.message || '参考素材保存失败') + '</div>');
      return;
    }
    const previousTasks = tasks;
    tasks = [...tasks, ...imported];
    if (!persist()) {
      tasks = previousTasks;
      dom.dialogBody.insertAdjacentHTML('afterbegin', '<div class="validation-error">导入未保存，请检查浏览器存储空间</div>');
      return;
    }
    closeDialog();
    renderList();
    toast('已导入 ' + imported.length + ' 个题目');
    if (imported[0]) openEditor(imported[0].id);
  }

  async function deleteTask(id) {
    const task = tasks.find(item => item.id === id);
    if (!task || !window.confirm('删除题目 ' + id + '？此操作只影响本地演示数据。')) return;
    const previousTasks = tasks;
    tasks = tasks.filter(item => item.id !== id);
    if (!persist()) {
      tasks = previousTasks;
      return;
    }
    selected.delete(id);
    for (const reference of task.references) {
      if (reference.id && !tasks.some(item => item.references.some(other => other.id === reference.id))) {
        try { await deleteAttachment(reference.id); } catch { /* Metadata deletion can still succeed. */ }
      }
    }
    closeDrawer();
    toast('题目已删除');
  }

  function openFellow(id) {
    const url = new URL('./fellow.html', window.location.href);
    url.searchParams.set('task', id);
    window.open(url.href, '_blank', 'noopener');
  }

  document.addEventListener('click', async event => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) {
      const row = event.target.closest('[data-task-row]');
      if (row && !event.target.closest('input,button,a')) openEditor(row.dataset.taskRow);
      return;
    }
    const action = trigger.dataset.action;
    const id = trigger.dataset.id;
    if (action === 'create') openCreate();
    else if (action === 'edit') openEditor(id);
    else if (action === 'edit-missing') {
      const fieldName = trigger.dataset.field;
      openEditor(id);
      const field = dom.drawerBody.querySelector('#task-form [name="' + fieldName + '"]');
      field?.scrollIntoView({ block: 'center' });
      field?.focus({ preventScroll: true });
    }
    else if (action === 'toggle-incomplete') { onlyIncomplete = !onlyIncomplete; renderList(); }
    else if (action === 'close-drawer') closeDrawer();
    else if (action === 'close-dialog') closeDialog();
    else if (action === 'save-task') await saveTaskForm();
    else if (action === 'edit-sheet') openSheetEditor();
    else if (action === 'save-sheet') saveSheetForm();
    else if (action === 'manage-tags') openTagManager();
    else if (action === 'save-tags') saveTags();
    else if (action === 'tag-stats') openTagStats();
    else if (action === 'export-all') openExportAll();
    else if (action === 'download-all') {
      downloadText('forge-delivery-metadata.json', JSON.stringify({ sheet: sheetMeta, tasks }, null, 2), 'application/json;charset=utf-8');
      closeDialog();
    }
    else if (action === 'import') openImport();
    else if (action === 'import-feishu') openFeishuImport();
    else if (action === 'check-import') await checkImport();
    else if (action === 'confirm-import') await confirmImport();
    else if (action === 'check-feishu-import') await checkFeishuImport();
    else if (action === 'confirm-feishu-import') await confirmFeishuImport();
    else if (action === 'download-template') downloadText('forge-8-fields-template.csv', toCsv([]));
    else if (action === 'export') downloadText('forge-delivery-tasks.csv', toCsv(tasks));
    else if (action === 'choose-reference') document.getElementById('reference-files')?.click();
    else if (action === 'add-reference-url') {
      const input = document.getElementById('reference-url');
      const url = safeHttpUrl(input?.value);
      if (!url) { toast('请填写 http 或 https 参考链接'); return; }
      draftReferences.push({ name: url, url, note: '' });
      input.value = '';
      renderDraftReferences();
    }
    else if (action === 'remove-reference') {
      draftReferences.splice(Number(trigger.dataset.index), 1);
      renderDraftReferences();
    }
    else if (action === 'assign-one') openAssignment([id]);
    else if (action === 'bulk-assign') openAssignment([...selected]);
    else if (action === 'save-assignment') saveAssignmentForm();
    else if (action === 'bulk-owners') openOwnerAssignment([...selected]);
    else if (action === 'save-owners') saveOwnerAssignment();
    else if (action === 'review-history') openReviewHistory(id);
    else if (action === 'review') openReview(id);
    else if (action === 'clear-selection') { selected.clear(); renderList(); }
    else if (action === 'delete-task') await deleteTask(id);
    else if (action === 'open-fellow') openFellow(id);
  });

  document.addEventListener('change', event => {
    if (event.target.id === 'filter-assignment' || event.target.id === 'filter-difficulty' || event.target.id === 'filter-tag') renderList();
    if (event.target.dataset.action === 'tag-change') {
      const id = event.target.dataset.id;
      const tag = event.target.value;
      const previousTasks = tasks;
      tasks = tasks.map(task => task.id === id ? { ...task, workflow: { ...workflowOf(task), tag } } : task);
      if (!persist()) tasks = previousTasks;
      else if (editingId === id) {
        const drawerTag = dom.drawerBody.querySelector('#workflow-form select[name="tag"]');
        if (drawerTag) drawerTag.value = tag;
      }
      renderList();
    }
    if (event.target.id === 'select-all') {
      for (const task of visibleTasks()) {
        if (event.target.checked) selected.add(task.id);
        else selected.delete(task.id);
      }
      renderList();
    }
    if (event.target.dataset.action === 'select') {
      if (event.target.checked) selected.add(event.target.dataset.id);
      else selected.delete(event.target.dataset.id);
      renderList();
    }
    if (event.target.id === 'reference-files') {
      for (const file of event.target.files || []) draftReferences.push({ name: file.name, note: '', file });
      renderDraftReferences();
    }
    if (event.target.id === 'import-csv') importCsvFile = event.target.files?.[0] || null;
    if (event.target.id === 'import-assets') importAssetFiles = [...(event.target.files || [])];
  });

  document.addEventListener('input', event => {
    if (event.target.id === 'search') renderList();
    if (event.target.dataset.referenceNote !== undefined) {
      const reference = draftReferences[Number(event.target.dataset.referenceNote)];
      if (reference) reference.note = event.target.value;
    }
  });

  document.addEventListener('submit', event => {
    if (event.target.id === 'task-form') { event.preventDefault(); saveTaskForm(); }
    if (event.target.id === 'workflow-form') { event.preventDefault(); saveTaskForm(); }
    if (event.target.id === 'assignment-form') { event.preventDefault(); saveAssignmentForm(); }
    if (event.target.id === 'owner-form') { event.preventDefault(); saveOwnerAssignment(); }
    if (event.target.id === 'sheet-form') { event.preventDefault(); saveSheetForm(); }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!dom.overlay.hidden) closeDialog();
      else if (!dom.drawer.hidden) closeDrawer();
    }
  });

  dom.overlay.addEventListener('click', event => {
    if (event.target === dom.overlay) closeDialog();
  });

  renderSheetHeader();
  renderList();
}
