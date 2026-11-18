/** The import template has seven required fields and one optional field. */
export const CSV_HEADERS = Object.freeze([
  '题号',
  '标题',
  '二级分类',
  '三级分类',
  '难度',
  '要做什么',
  '验收清单',
  '参考素材',
]);

const REQUIRED_HEADERS = CSV_HEADERS.slice(0, 7);

const FIELD_SOURCES = {
  id: ['id', 'caseId', '题号'],
  title: ['title', '标题'],
  category2: ['category2', '二级分类'],
  category3: ['category3', '三级分类'],
  difficulty: ['difficulty', '难度'],
  brief: ['brief', '要做什么'],
  acceptance: ['acceptance', '验收清单'],
  references: ['references', '参考素材', '参考素材（可选）'],
};

function pick(raw, keys) {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return '';
}

function cleanText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

/** Keep the three supported levels consistent when reading legacy local data. */
export function normalizeDifficulty(value) {
  const text = cleanText(value).toUpperCase();
  return ({ '低': 'D1', '中': 'D2', '高': 'D3' })[text] || text;
}

function normalizeAcceptance(value) {
  const items = Array.isArray(value) ? value : cleanText(value).split('\n');
  return items.map(cleanText).filter(Boolean);
}

function isExternalUrl(value) {
  return /^https?:\/\//i.test(value);
}

function normalizeReferenceObject(value) {
  const name = cleanText(value.name ?? value.filename ?? value.path ?? value.url);
  const url = cleanText(value.url);
  const note = cleanText(value.note ?? value.description);
  if (!name && !url) return null;
  const reference = { ...value, name: name || url };
  if (url) reference.url = url;
  else delete reference.url;
  if (note) reference.note = note;
  else delete reference.note;
  return reference;
}

function parseReferenceLine(line) {
  const source = cleanText(line);
  if (!source) return null;
  const divider = source.includes('｜') ? '｜' : source.includes('|') ? '|' : null;
  if (!divider) {
    return isExternalUrl(source) ? { name: source, url: source } : { name: source };
  }

  const parts = source.split(divider).map(cleanText);
  const name = parts[0];
  if (!name) return null;
  const reference = { name };
  if (parts.length >= 3) {
    if (parts[1]) reference.url = parts[1];
    if (parts.slice(2).join(divider)) reference.note = parts.slice(2).join(divider);
  } else if (parts[1]) {
    reference.note = parts[1];
  }
  if (!reference.url && isExternalUrl(name)) reference.url = name;
  return reference;
}

function normalizeReferences(value) {
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (typeof item === 'string') return normalizeReferences(item);
      if (item && typeof item === 'object') {
        const reference = normalizeReferenceObject(item);
        return reference ? [reference] : [];
      }
      return [];
    });
  }

  if (value && typeof value === 'object') {
    const reference = normalizeReferenceObject(value);
    return reference ? [reference] : [];
  }

  const text = cleanText(value);
  if (!text) return [];

  // JSON is accepted for lossless round trips from other systems; the template
  // also accepts one human-readable reference per line.
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return normalizeReferences(parsed);
    } catch {
      // A filename can start with '['. Fall through to plain-text parsing.
    }
  }
  return text.split('\n').map(parseReferenceLine).filter(Boolean);
}

/** Convert canonical objects or Chinese-column rows to one predictable shape. */
export function normalizeTask(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: cleanText(pick(source, FIELD_SOURCES.id)),
    title: cleanText(pick(source, FIELD_SOURCES.title)),
    category2: cleanText(pick(source, FIELD_SOURCES.category2)),
    category3: cleanText(pick(source, FIELD_SOURCES.category3)),
    difficulty: normalizeDifficulty(pick(source, FIELD_SOURCES.difficulty)),
    brief: cleanText(pick(source, FIELD_SOURCES.brief)),
    acceptance: normalizeAcceptance(pick(source, FIELD_SOURCES.acceptance)),
    references: normalizeReferences(pick(source, FIELD_SOURCES.references)),
  };
}

function existingId(item) {
  return typeof item === 'string' ? cleanText(item) : normalizeTask(item).id;
}

/** Return user-facing errors. Exclude the current task from existingTasks when editing. */
export function validateTask(raw, existingTasks = [], options = {}) {
  const task = normalizeTask(raw);
  const errors = [];
  if (!task.id) errors.push('题号不能为空');
  if (!task.title) errors.push('标题不能为空');
  if (!task.category2) errors.push('二级分类不能为空');
  if (!task.category3) errors.push('三级分类不能为空');
  if (!task.difficulty) errors.push('难度不能为空');
  else if (!['D1', 'D2', 'D3'].includes(task.difficulty)) errors.push('难度只能是 D1、D2 或 D3');
  if (!options.allowIncompleteContent) {
    if (!task.brief) errors.push('题目说明不能为空');
    if (task.acceptance.length === 0) errors.push('验收标准至少填写一项');
  }

  if (task.id) {
    const key = task.id.toLocaleLowerCase();
    if (existingTasks.some(item => existingId(item).toLocaleLowerCase() === key)) {
      errors.push('题号与已有任务重复');
    }
  }
  return errors;
}

/** Parse RFC-style CSV, including escaped quotes and quoted multiline cells. */
export function parseCsv(csvText) {
  const text = String(csvText ?? '').replace(/^\uFEFF/, '');
  if (!text) return [];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else if (char === '\r') {
        if (text[i + 1] === '\n') i += 1;
        field += '\n';
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (char === '\r' && text[i + 1] === '\n') i += 1;
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error('CSV 引号未闭合，请检查含换行或逗号的单元格');
  if (row.length > 0 || field !== '') {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function canonicalHeader(header) {
  const text = cleanText(header).replace(/\s/g, '');
  return ['参考素材（可选）', '参考素材(可选)'].includes(text) ? '参考素材' : text;
}

/** Validate a CSV without changing application data. Index is the logical CSV row. */
export function buildImportPreview(csvText, existingTasks = []) {
  let parsed;
  try {
    parsed = parseCsv(csvText);
  } catch (error) {
    return { rows: [], errors: [error.message || 'CSV 无法解析'] };
  }
  if (parsed.length === 0) return { rows: [], errors: ['文件为空'] };

  const headers = parsed[0].map(canonicalHeader);
  const errors = [];
  for (const header of REQUIRED_HEADERS) {
    if (!headers.includes(header)) errors.push(`缺少「${header}」列`);
  }
  for (const header of CSV_HEADERS) {
    if (headers.filter(item => item === header).length > 1) {
      errors.push(`「${header}」列重复`);
    }
  }

  const column = Object.fromEntries(CSV_HEADERS.map(header => [header, headers.indexOf(header)]));
  const seenTasks = [...existingTasks];
  const rows = [];
  for (let index = 1; index < parsed.length; index += 1) {
    const cells = parsed[index];
    if (cells.every(cell => cleanText(cell) === '')) continue;
    const raw = {};
    for (const header of CSV_HEADERS) {
      raw[header] = column[header] < 0 ? '' : (cells[column[header]] ?? '');
    }
    const task = normalizeTask(raw);
    const rowErrors = validateTask(task, seenTasks);
    if (cells.length > headers.length && cells.slice(headers.length).some(cell => cleanText(cell))) {
      rowErrors.push('数据列数多于表头，请检查未加引号的逗号');
    }
    rows.push({ index: index + 1, task, errors: rowErrors });
    if (task.id) seenTasks.push(task.id);
  }
  if (rows.length === 0) errors.push('没有可导入的任务行');
  return { rows, errors };
}

function csvCell(value) {
  const text = cleanText(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function referenceText(reference) {
  const name = cleanText(reference.name ?? reference.url);
  const url = cleanText(reference.url);
  const note = cleanText(reference.note);
  if (url && url !== name) return `${name}｜${url}｜${note}`;
  if (note) return `${name}｜｜${note}`;
  return name;
}

/** Export the eight import columns; assignment data is intentionally separate. */
export function toCsv(tasks) {
  const records = [CSV_HEADERS];
  for (const raw of tasks ?? []) {
    const task = normalizeTask(raw);
    records.push([
      task.id,
      task.title,
      task.category2,
      task.category3,
      task.difficulty,
      task.brief,
      task.acceptance.join('\n'),
      task.references.map(referenceText).join('\n'),
    ]);
  }
  return `\uFEFF${records.map(row => row.map(csvCell).join(',')).join('\r\n')}`;
}
