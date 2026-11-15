/**
 * 项目锚点的数据层：读登记表、读项目卡、读写归属、统计索引。
 *
 * 所有磁盘访问都经宿主的 `ctx.fs` 服务（而不是 `node:fs`）：读走 resolve + stat +
 * readText，写走原子 `writeText` 并显式带当前会话的沙箱策略。这样在只读/受限沙箱下
 * 由宿主统一裁决，插件自己不绕过围栏。纯解析部分仍是纯函数，可以离线单独测。
 *
 * 宿主上下文由 `index.js` 在 `apply(ctx)` 开头用 {@link bindHost} 绑定一次。
 *
 * @module dsh-project-anchor/store
 */

import { join } from 'node:path'

const LEDGER_DIR = '_台账'
const REGISTRY_FILE = '项目登记表.md'
const ATTACH_FILE = '归属.jsonl'
const INDEX_FILE = '索引.jsonl'

/** 项目卡超过这个天数未核对，注入时标"可能过期"。 */
export const STALE_DAYS = 90

// ---------------------------------------------------------------- 宿主 fs 访问

/** 宿主上下文；未绑定时所有读写都明确报错，而不是退回 node:fs 偷偷写盘。 */
let hostContext = null

/**
 * 绑定宿主上下文（插件 `apply(ctx)` 开头调用一次）。
 * @param {object} ctx cordis 上下文。
 * @returns {void}
 */
export function bindHost(ctx) {
  hostContext = ctx ?? null
}

/**
 * 取宿主的文件系统服务。
 *
 * 不退回 `node:fs`：那正是本次要修掉的绕过行为。宿主没有 fs 服务时直接报错，
 * 由调用方把原因带回给模型。
 * @param {string} action 动作描述，用于错误信息。
 * @returns {object} `ctx.fs`。
 */
function hostFs(action) {
  const fs = hostContext?.get?.('fs')
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.writeText !== 'function') {
    throw new Error(`project-anchor: 宿主 fs 服务不可用，无法${action}`)
  }
  return fs
}

/**
 * 把宿主抛出的 fs 错误压成一行 "CODE: message"，保证失败原因能带回给调用方。
 * @param {unknown} error 错误。
 * @returns {string} 带原因的一行文本。
 */
function describeFsError(error) {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : ''
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message : ''
  if (code !== '' && message !== '') return `${code}: ${message}`
  return message || code || String(error)
}

/**
 * 经宿主 fs 读一个工作区内的 UTF-8 文本文件。
 *
 * 文件不存在（或不是普通文件）时返回 `null`，与原来 `readFile(...).catch(() => null)`
 * 的语义一致；真正的读错误（二进制、权限）带原因抛出，不静默吞掉。
 * @param {string} root 工作区根。
 * @param {...string} parts 相对路径分段。
 * @returns {Promise<string|null>} 文件内容或 null。
 */
export async function readWorkspaceText(root, ...parts) {
  const fs = hostFs(`读取 ${parts.join('/')}`)
  const target = await fs.resolve(join(root, ...parts), { cwd: root })
  const info = await fs.stat(target)
  if (!info || info.type !== 'file') return null
  return fs.readText(target)
}

/**
 * 解析本次写入应显式携带的沙箱策略。
 *
 * 为什么必须显式带：`writeText` 省略 `sandboxPolicy` 时，围栏后端会用部署回退策略
 * （workspaceRoot 通常不是本会话目录），合法写入也会被拒；而部署默认是只读时，
 * 插件更不能自行放宽。拿不到策略服务时按只读处理，绝不默认放行。
 * @param {object|undefined} session 发起写入的会话（`exec.agent.session`）。
 * @param {string} root 工作区根（没有会话时的兜底根）。
 * @returns {{mode: string, workspaceRoot: string}} 生效策略。
 */
function resolveWritePolicy(session, root) {
  const readOnly = { mode: 'read-only', workspaceRoot: root }
  const service = hostContext?.get?.('sandboxPolicy')
  if (!service || typeof service.resolve !== 'function') return readOnly
  const policy = session === undefined || session === null
    ? service.resolve()
    : service.resolve({ session })
  if (!policy || typeof policy.mode !== 'string') return readOnly
  return policy
}

/**
 * 经宿主 fs 原子写一个工作区文件（全量内容），并带当前沙箱策略。
 *
 * 这是本模块对外的唯一写盘出口，`render.js` 也走这里，避免两处各判断一次策略。
 * 写失败返回带原因的结果，不重试、不换路径。
 * @param {string} root 工作区根。
 * @param {string} path 目标路径（工作区内）。
 * @param {string} content 完整内容。
 * @param {{session?: object, signal?: AbortSignal, expected?: object}} [options] 会话、取消信号与写意图。
 * @returns {Promise<{ok: true, operation: string} | {ok: false, error: string}>} 写入结果。
 */
export async function writeWorkspaceText(root, path, content, options = {}) {
  try {
    const fs = hostFs(`写入 ${path}`)
    const policy = resolveWritePolicy(options.session, root)
    if (policy.mode === 'read-only') {
      return { ok: false, error: `当前沙箱为只读（read-only），拒绝写入 ${path}` }
    }
    const target = await fs.resolve(path, { cwd: root })
    const outcome = await fs.writeText(target, content, options.expected, options.signal, policy)
    return { ok: true, operation: outcome?.operation ?? 'update' }
  } catch (error) {
    return { ok: false, error: describeFsError(error) }
  }
}

/**
 * 追加一行 JSONL 事实（append-only）。
 *
 * fs 服务没有 append API，按契约自己 stat + readText + 拼接 + writeText。
 * 读到的版本作为 `replaceIfVersion` 守卫：并发追加时后来者会拿到 FS_STALE_VERSION
 * 并被拒，而不是静默覆盖别人的行。文件不存在时用 `createIfAbsent`，同样拒绝并发创建。
 * @param {string} root 工作区根。
 * @param {string[]} parts 目标相对路径分段。
 * @param {object} row 事实行。
 * @param {{session?: object, signal?: AbortSignal}} [options] 会话与取消信号。
 * @returns {Promise<{ok: boolean, error?: string}>} 追加结果。
 */
async function appendWorkspaceLine(root, parts, row, options = {}) {
  const path = join(root, ...parts)
  const label = parts.join('/')
  try {
    const fs = hostFs(`追加 ${label}`)
    const policy = resolveWritePolicy(options.session, root)
    if (policy.mode === 'read-only') {
      return { ok: false, error: `当前沙箱为只读（read-only），拒绝追加 ${label}` }
    }
    const target = await fs.resolve(path, { cwd: root })
    const info = await fs.stat(target)
    const present = info !== undefined && info !== null && info.type === 'file'
    const base = present ? await fs.readText(target) : ''
    const line = JSON.stringify(row)
    // 上一行末尾没换行（历史文件可能如此）时先补一个，避免两行粘成一行
    const content = base === '' || base.endsWith('\n') ? `${base}${line}\n` : `${base}\n${line}\n`
    const expected = present
      ? { kind: 'replaceIfVersion', version: info.version }
      : { kind: 'createIfAbsent' }
    await fs.writeText(target, content, expected, options.signal, policy)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describeFsError(error) }
  }
}

// ---------------------------------------------------------------- 解析与匹配

function stripTicks(text) {
  return String(text ?? '').replace(/^`+|`+$/g, '').trim()
}

/**
 * 本地时间的 ISO 字符串（带 +08:00 这类偏移）。
 *
 * 必须与历史行同格式：归属"取 ts 最大的一条"是按字符串比较实现的，
 * 混入 UTC 的 `...Z` 会与 `+08:00` 排序错乱。
 * @param {Date} [now] 时间。
 * @returns {string}
 */
export function localIso(now = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const hh = pad(Math.floor(Math.abs(offset) / 60))
  const mm = pad(Math.abs(offset) % 60)
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${hh}:${mm}`
}

/**
 * 解析 `_台账\项目登记表.md` 里的项目表。
 * @param {string} root 工作区根。
 * @returns {Promise<Array<{id: string, name: string, dir: string, period: string, status: string, alias: string, summary: string}>>}
 */
export async function loadProjects(root) {
  const text = await readWorkspaceText(root, LEDGER_DIR, REGISTRY_FILE)
  if (text === null) return []
  const projects = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length < 4) continue
    if (!/^P\d{4}-\d{2}$/.test(cells[0])) continue
    projects.push({
      id: cells[0],
      name: cells[1] ?? '',
      dir: stripTicks(cells[2]),
      period: cells[3] ?? '',
      status: cells[4] ?? '',
      alias: cells[5] ?? '',
      summary: cells[6] ?? '',
    })
  }
  // 同名编号在"存量归属"表里会再出现一次，按 id 去重、保留字段更全的那条
  const byId = new Map()
  for (const project of projects) {
    const prev = byId.get(project.id)
    if (!prev || project.name.length > prev.name.length) byId.set(project.id, project)
  }
  return [...byId.values()]
}

/**
 * 下一个可用项目编号。
 *
 * 编号是顺序标签，不是语义：取同年已用最大序号 +1。跨年时从 01 重开。
 * 允许调用方显式给 id（历史回填/补挂），这条只用于"顺延"。
 * @param {Array<{id: string}>} projects 已登记项目。
 * @param {Date} [now] 时间（决定年份）。
 * @returns {string} 形如 `P2026-06`。
 */
export function nextProjectId(projects, now = new Date()) {
  const year = now.getFullYear()
  const prefix = `P${year}-`
  let max = 0
  for (const project of projects ?? []) {
    const id = String(project?.id ?? '')
    if (!id.startsWith(prefix)) continue
    const seq = Number(id.slice(prefix.length))
    if (Number.isInteger(seq) && seq > max) max = seq
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`
}

/**
 * 检查工作区内的一个路径存在与否。
 *
 * 用于"登记时校验目录"：目录写错不该静默通过，但也不该拦死——返回类型让调用方决定。
 * @param {string} root 工作区根。
 * @param {...string} parts 相对路径分段。
 * @returns {Promise<'file'|'dir'|'other'|null>} 类型，不存在返回 null。
 */
export async function pathKind(root, ...parts) {
  const fs = hostFs(`检查 ${parts.join('/')}`)
  const target = await fs.resolve(join(root, ...parts), { cwd: root })
  const info = await fs.stat(target)
  if (!info) return null
  // 宿主的 FsInfo.type 是 'file' | 'directory' | 'other'，没有 'dir'。
  if (info.type === 'file') return 'file'
  if (info.type === 'directory') return 'dir'
  return 'other'
}

/** 单元格清洗：表格里不能出现裸竖线，换行会截断整张表。 */
function cell(value, fallback = '—') {
  const text = String(value ?? '').replace(/\|/g, '／').replace(/\s*\n\s*/g, ' ').trim()
  return text === '' ? fallback : text
}

/**
 * 把一个新项目追加到 `_台账\项目登记表.md` 的项目表里。
 *
 * 只追加一行、不改既有行：表格是唯一真源，改历史行等于改别人的判据。
 * 插入点选在"最后一行以 P 编号开头"之后，这样 2026-11-03 补挂之类的人工小节不会被冲散。
 * @param {string} root 工作区根。
 * @param {{id: string, name: string, dir?: string, period?: string, status?: string, alias?: string, summary?: string}} project 项目。
 * @param {{session?: object, signal?: AbortSignal}} [options] 会话与取消信号。
 * @returns {Promise<{ok: true, path: string} | {ok: false, error: string}>} 结果。
 */
export async function appendProjectRow(root, project, options = {}) {
  const relative = join(LEDGER_DIR, REGISTRY_FILE)
  const row = [
    cell(project.id),
    cell(project.name),
    cell(project.dir ? `\`${project.dir}\`` : ''),
    cell(project.period),
    cell(project.status, 'unknown'),
    cell(project.alias),
    cell(project.summary),
  ].join(' | ')
  const line = `| ${row} |`
  try {
    const fs = hostFs(`登记项目 ${project.id}`)
    const policy = resolveWritePolicy(options.session, root)
    if (policy.mode === 'read-only') {
      return { ok: false, error: `当前沙箱为只读（read-only），拒绝写入 ${relative}` }
    }
    const target = await fs.resolve(join(root, relative), { cwd: root })
    const info = await fs.stat(target)
    const present = info !== undefined && info !== null && info.type === 'file'
    const base = present ? await fs.readText(target) : ''
    const header = [
      '# 项目登记表',
      '',
      '| 编号 | 名称 | 目录 | 期间 | 状态 | 别名 | 一句话 |',
      '|---|---|---|---|---|---|---|',
    ].join('\n')
    const text = present ? base : `${header}\n`
    const lines = text.split('\n')
    // 只在「项目表」内找锚点：表后面的小节（如「存量归属」）里也有 `| P2026-01 | 19 | 8 |` 这种行，
    // 全文件里找最后一行 P 编号会把新项目插进那张汇总表，读回来就错位了。
    const heading = lines.findIndex(item => /^##\s/.test(item))
    const limit = heading === -1 ? lines.length : heading
    let anchor = -1
    for (let index = 0; index < limit; index += 1) {
      if (/^\|\s*P\d{4}-\d{2}\s*\|/.test(lines[index])) anchor = index
    }
    if (anchor === -1) {
      // 没有项目表（或表是空的）：插在第一个二级标题之前，至少不破坏结构
      anchor = heading === -1 ? lines.length - 1 : heading - 1
    }
    lines.splice(anchor + 1, 0, line)
    const content = lines.join('\n').endsWith('\n') ? lines.join('\n') : `${lines.join('\n')}\n`
    const expected = present
      ? { kind: 'replaceIfVersion', version: info.version }
      : { kind: 'createIfAbsent' }
    await fs.writeText(target, content, expected, options.signal, policy)
    return { ok: true, path: relative }
  } catch (error) {
    return { ok: false, error: describeFsError(error) }
  }
}

/**
 * 生成项目卡正文。
 *
 * 没有目录的项目也必须有卡：面板、注入、`project_status` 全靠它回答"这个项目是什么、
 * 续开点在哪"。骨架只放结构，口径/禁区留空等真做过的人填。
 * @param {object} project 项目。
 * @param {{basis?: string, now?: Date}} [options] 判定依据与时间。
 * @returns {string} markdown 正文。
 */
export function renderProjectCard(project, options = {}) {
  const today = (options.now ?? new Date()).toISOString().slice(0, 10)
  const basis = String(options.basis ?? '').trim() || '（未记录判定依据）'
  return [
    '---',
    `id: ${project.id}`,
    `name: ${project.name}`,
    `dir: ${project.dir ?? ''}`,
    `period: ${project.period ?? ''}`,
    `status: ${project.status ?? 'unknown'}`,
    `aliases: [${project.alias ?? ''}]`,
    `verified: ${today}`,
    '---',
    '',
    `# ${project.name}`,
    '',
    '## 一句话',
    '',
    String(project.summary ?? '').trim() || '（待补）',
    '',
    '## 判定依据',
    '',
    basis,
    '',
    '## 口径',
    '',
    '（待补：这个项目里数字按什么口径算，哪些是定了的）',
    '',
    '## 禁区',
    '',
    '（待补：哪些做法已经证明不行，别再试）',
    '',
    '## 续开点',
    '',
    '（待补：下次接手从哪里开始）',
    '',
    '## 历史',
    '',
    `- ${today} 建卡（project_register）`,
    '',
  ].join('\n')
}

// 去掉标点与空白，便于中文短语的 2-gram 比较
function normalizeRef(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\-_—–·,，、。./\\（）(){}[\]]/g, '')
}

function bigrams(text) {
  const cleaned = normalizeRef(text)
  const grams = new Set()
  for (let i = 0; i < cleaned.length - 1; i += 1) grams.add(cleaned.slice(i, i + 2))
  if (cleaned.length === 1) grams.add(cleaned)
  return grams
}

/**
 * 按分数给项目打分：整串命中的权重远高于字面重叠。
 * @param {object} project 项目。
 * @param {string} query 用户原话。
 * @returns {number}
 */
function scoreProject(project, query) {
  const q = normalizeRef(query)
  if (q === '') return 0
  const name = normalizeRef(project.name)
  const dir = normalizeRef(project.dir)
  const alias = normalizeRef(project.alias)
  const summary = normalizeRef(project.summary)
  if (name === q || dir === q || alias === q || project.id.toLowerCase() === q) return 1.5
  if (
    (name && (name.includes(q) || q.includes(name)))
    || (dir && (dir.includes(q) || q.includes(dir)))
    || (alias && (alias.includes(q) || q.includes(alias)))
  ) return 1.2

  const queryGrams = bigrams(query)
  if (queryGrams.size === 0) return 0
  const target = bigrams(`${project.name}${project.dir}${project.alias}${project.summary}`)
  let hit = 0
  for (const gram of queryGrams) if (target.has(gram)) hit += 1
  return (hit / queryGrams.size) * 0.9
}

/**
 * 把人类说法解析成项目：编号 / 名称 / 目录名 / 别名 / 关键词都行。
 *
 * 设计前提：**人只记业务名，不记编号**。所以这里必须接受"存货那个""答复清单"
 * 这类说法；拿不准时返回候选让人挑，而不是报错让人回去念编号。
 *
 * @param {Array<object>} projects 项目表。
 * @param {string} raw 用户说法。
 * @returns {{kind: 'none'|'detach'|'one'|'many'|'unknown', project?: object, candidates?: Array<{id: string, name: string, score: number}>}}
 */
export function resolveProjectRef(projects, raw) {
  const query = String(raw ?? '').trim()
  if (query === '') return { kind: 'none' }
  const lower = query.toLowerCase()
  if (lower === 'none' || lower === 'null' || query === '-' || query === '取消') return { kind: 'detach' }

  const exact = projects.find(project => project.id.toLowerCase() === lower)
  if (exact) return { kind: 'one', project: exact }

  const ranked = projects
    .map(project => ({ project, score: scoreProject(project, query) }))
    .filter(item => item.score > 0.15)
    .sort((a, b) => b.score - a.score)

  if (ranked.length === 0) return { kind: 'unknown' }

  const [best, second] = ranked
  const toCandidates = list => list.slice(0, 3).map(item => ({
    id: item.project.id,
    name: item.project.name,
    score: Math.round(item.score * 100) / 100,
  }))

  // 只有一个候选时不必卡高门槛："存货那个" 就属于这一类
  if (ranked.length === 1 && best.score >= 0.25) return { kind: 'one', project: best.project }

  // 一到两个字的词天然多义："采购" 同时像两个不同项目的采购主题 —— 宁可问一句
  if (normalizeRef(query).length <= 2) return { kind: 'many', candidates: toCandidates(ranked) }

  const clearLead = best.score - second.score >= 0.2
  if (best.score >= 0.6 && clearLead) return { kind: 'one', project: best.project }

  return { kind: 'many', candidates: toCandidates(ranked) }
}

/**
 * 读归属事实，返回每个会话最新的项目号。
 * @param {string} root 工作区根。
 * @returns {Promise<Map<string, string>>}
 */
export async function loadAttachments(root) {
  const latest = new Map()
  const text = await readWorkspaceText(root, LEDGER_DIR, ATTACH_FILE)
  if (text === null) return latest
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (row?.type !== 'attach' || typeof row.session !== 'string') continue
    const ts = typeof row.ts === 'string' ? row.ts : ''
    const prev = latest.get(row.session)
    if (!prev || ts >= prev.ts) latest.set(row.session, { ts, project: row.project ?? null })
  }
  const result = new Map()
  for (const [session, entry] of latest) if (entry.project) result.set(session, entry.project)
  return result
}

/**
 * 追加一条归属事实（append-only，后写的覆盖先写的）。
 * @param {string} root 工作区根。
 * @param {{session: string, project: string|null, by?: string, note?: string, conf?: string}} entry
 * @param {{session?: object, signal?: AbortSignal}} [options] 发起写入的会话（用于沙箱策略）与取消信号。
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function appendAttachment(root, entry, options = {}) {
  if (typeof entry.session !== 'string' || entry.session === '') {
    return { ok: false, error: '缺少会话 id' }
  }
  const row = {
    v: 1,
    type: 'attach',
    session: entry.session,
    project: entry.project ?? null,
    ts: entry.ts ?? localIso(),
    by: entry.by ?? 'model',
    ...(entry.conf ? { conf: entry.conf } : {}),
    ...(entry.note ? { note: entry.note } : {}),
  }
  return appendWorkspaceLine(root, [LEDGER_DIR, ATTACH_FILE], row, options)
}

/**
 * 读项目卡：front-matter + 固定章节。
 * @param {string} root 工作区根。
 * @param {{id: string, dir: string}} project 项目。
 * @returns {Promise<{path: string, front: Record<string, string>, sections: Record<string, string>, text: string, stale: boolean, verifiedDays: number|null}|null>}
 */
export async function loadCard(root, project) {
  if (!project?.id && !project?.dir) return null
  // 有目录的项目卡在 <目录>\00-说明\项目卡.md；没有目录（或目录里还没建卡）的
  // 项目卡落在 _台账\项目卡-<编号>.md —— "先建项目、目录后补"是允许的。
  const candidates = []
  if (project?.dir) candidates.push(join(project.dir, '00-说明', '项目卡.md'))
  if (project?.id) candidates.push(join(LEDGER_DIR, `项目卡-${project.id}.md`))

  let path = null
  let text = null
  for (const candidate of candidates) {
    const parts = candidate.split(/[\\/]/)
    const content = await readWorkspaceText(root, ...parts)
    if (content !== null) {
      path = join(root, ...parts)
      text = content
      break
    }
  }
  if (text === null) return null

  const front = {}
  const sections = {}
  const lines = text.split('\n')
  let index = 0
  if (lines[0]?.trim() === '---') {
    index = 1
    while (index < lines.length && lines[index].trim() !== '---') {
      const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[index])
      if (match) front[match[1]] = match[2].trim().replace(/^\[|\]$/g, '')
      index += 1
    }
    index += 1
  }

  let current = null
  const buffer = []
  const flush = () => {
    if (current && buffer.length > 0) sections[current] = buffer.join('\n').trim()
    buffer.length = 0
  }
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flush()
      current = heading[1]
      continue
    }
    if (current) buffer.push(line)
  }
  flush()

  const verified = front.verified && /^\d{4}-\d{2}-\d{2}$/.test(front.verified) ? front.verified : null
  let verifiedDays = null
  if (verified) {
    const then = new Date(`${verified}T00:00:00`)
    verifiedDays = Math.floor((Date.now() - then.getTime()) / 86400000)
  }

  return {
    path,
    front,
    sections,
    // 原文一并带出：「注入粒度＝项目卡」时整张卡就是提示词内容，
    // 由 sections 重新拼装会丢掉 front-matter 与章节之外的手写说明。
    text,
    stale: verifiedDays !== null && verifiedDays > STALE_DAYS,
    verifiedDays,
  }
}

/**
 * 统计索引行数与各项目行数。
 *
 * 历史行的 `project` 是 null（回填时还没有项目），归属靠 `归属.jsonl` 在视图层 join。
 * 所以这里必须把 attachments 传进来，否则"本项目 N 行"永远是 0。
 *
 * @param {string} root 工作区根。
 * @param {Map<string, string>} [attachments] 会话 → 项目号。
 * @returns {Promise<{rows: number, byProject: Record<string, number>, bySession: Record<string, number>}>}
 */
export async function indexStats(root, attachments = new Map()) {
  const stats = { rows: 0, byProject: {}, bySession: {}, latestByProject: {} }
  const text = await readWorkspaceText(root, LEDGER_DIR, INDEX_FILE)
  if (text === null) return stats
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let row
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (row?.type && row.type !== 'note') continue
    stats.rows += 1
    const resolved = row.project ?? (typeof row.session === 'string' ? attachments.get(row.session) : undefined)
    const project = resolved ?? '(未归属)'
    stats.byProject[project] = (stats.byProject[project] ?? 0) + 1
    const ts = String(row.ts_session ?? '')
    if (ts !== '' && (!stats.latestByProject[project] || ts > stats.latestByProject[project])) {
      stats.latestByProject[project] = ts
    }
    if (typeof row.session === 'string') {
      stats.bySession[row.session] = (stats.bySession[row.session] ?? 0) + 1
    }
  }
  return stats
}

/**
 * 取某个项目的最近 N 条索引节点（按时间倒序）。
 * @param {string} root 工作区根。
 * @param {string} projectId 项目号。
 * @param {number} limit 条数。
 * @param {Map<string, string>} [attachments] 会话 → 项目号（历史行的 project 为 null，靠它补齐）。
 * @returns {Promise<Array<{ts: string, node: string, status: string, summary: string}>>}
 */
export async function recentNodes(root, projectId, limit = 3, attachments = new Map()) {
  const text = await readWorkspaceText(root, LEDGER_DIR, INDEX_FILE)
  if (text === null) return []
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const row = JSON.parse(trimmed)
      if ((row.type ?? 'note') !== 'note') continue
      const resolved = row.project ?? (typeof row.session === 'string' ? attachments.get(row.session) : undefined)
      if (resolved !== projectId) continue
      rows.push(row)
    } catch {
      continue
    }
  }
  rows.sort((a, b) => String(b.ts_session ?? '').localeCompare(String(a.ts_session ?? '')))
  return rows.slice(0, limit).map(row => ({
    ts: String(row.ts_session ?? '').slice(0, 16),
    node: String(row.node ?? ''),
    status: String(row.status ?? ''),
    summary: String(row.summary ?? ''),
  }))
}

/**
 * 读出全部索引行（只取 note 类型）。
 * @param {string} root 工作区根。
 * @returns {Promise<Array<object>>}
 */
export async function loadIndexRows(root) {
  const text = await readWorkspaceText(root, LEDGER_DIR, INDEX_FILE)
  if (text === null) return []
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const row = JSON.parse(trimmed)
      if ((row.type ?? 'note') !== 'note') continue
      rows.push(row)
    } catch {
      continue
    }
  }
  return rows
}

/**
 * 已写入索引的 callId 集合（用于避免重启后重放历史造成重复行）。
 * @param {string} root 工作区根。
 * @returns {Promise<Set<string>>}
 */
export async function loadCallIds(root) {
  const ids = new Set()
  for (const row of await loadIndexRows(root)) {
    if (typeof row.callId === 'string' && row.callId !== '') ids.add(row.callId)
  }
  return ids
}

/**
 * 追加一行索引事实（append-only）。
 * @param {string} root 工作区根。
 * @param {object} row 事实行。
 * @param {{session?: object, signal?: AbortSignal}} [options] 发起写入的会话（用于沙箱策略）与取消信号。
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function appendIndexRow(root, row, options = {}) {
  return appendWorkspaceLine(root, [LEDGER_DIR, INDEX_FILE], row, options)
}

/**
 * 生成"项目 → 会话 → 节点"的目录，供界面展示与跳转。
 *
 * 这是页签唯一需要的数据结构：左侧项目名，右侧该项目的会话清单（带最近节点与时间），
 * 点一条会话就 `openSession(id)`。历史行的 project 可能为 null，用归属表补齐。
 *
 * @param {string} root 工作区根。
 * @returns {Promise<object>}
 */
export async function buildCatalog(root) {
  const [projects, attachments, rows] = await Promise.all([
    loadProjects(root),
    loadAttachments(root),
    loadIndexRows(root),
  ])

  const bySession = new Map()
  for (const row of rows) {
    const sessionId = typeof row.session === 'string' ? row.session : ''
    if (sessionId === '') continue
    const project = row.project ?? attachments.get(sessionId) ?? null
    const ts = String(row.ts_session ?? '')
    if (!bySession.has(sessionId)) {
      bySession.set(sessionId, { project, rows: 0, lastTs: ts, nodes: [] })
    }
    const entry = bySession.get(sessionId)
    entry.rows += 1
    if (ts > entry.lastTs) entry.lastTs = ts
    if (row.node && entry.nodes.length < 6) entry.nodes.push(String(row.node))
    if (!entry.project && project) entry.project = project
  }

  const sessionsOf = projectId => [...bySession.entries()]
    .filter(([, entry]) => entry.project === projectId)
    .map(([sessionId, entry]) => ({
      id: sessionId,
      shortId: (/([0-9a-f]{8})/i.exec(sessionId) ?? [])[1] ?? sessionId.slice(0, 8),
      rows: entry.rows,
      lastTs: entry.lastTs,
      nodes: entry.nodes,
    }))
    .sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)))

  return {
    generatedAt: localIso(),
    projects: projects.map(project => {
      const sessions = sessionsOf(project.id)
      return {
        id: project.id,
        name: project.name,
        period: project.period,
        status: project.status,
        rows: sessions.reduce((sum, item) => sum + item.rows, 0),
        sessions,
      }
    }),
    freeSessions: [...bySession.entries()]
      .filter(([, entry]) => !entry.project)
      .map(([sessionId, entry]) => ({
        id: sessionId,
        shortId: (/([0-9a-f]{8})/i.exec(sessionId) ?? [])[1] ?? sessionId.slice(0, 8),
        rows: entry.rows,
        lastTs: entry.lastTs,
        nodes: entry.nodes,
      }))
      .sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs))),
  }
}

/**
 * 从项目卡里摘出三块最影响接手的文字：已定口径、禁入区、上次停在哪。
 *
 * 为什么单独抽出来：注入摘要（已锚定）与首轮提示（未锚定、只是"像"）都要这三块，
 * 而两处字数上限不同。抽成一个函数就不会出现"摘要认得标题、提示认不得"的分叉。
 *
 * 章节名有历史差异：骨架生成器写 `## 口径`，手写的卡常写 `## 口径（已定，勿改）`
 * 或 `## 已定口径`；三种都认，否则新建的卡永远注入不出已定口径。
 * @param {object|null} card {@link loadCard} 的结果。
 * @param {{scope?: number, forbidden?: number, resume?: number}} [limits] 各块字数上限。
 * @returns {{scope: string, pending: number, forbidden: string, resume: string}} 摘录。
 */
export function cardExcerpt(card, limits = {}) {
  const empty = { scope: '', pending: 0, forbidden: '', resume: '' }
  if (!card || typeof card.sections !== 'object' || card.sections === null) return empty
  const scopeLimit = Number(limits.scope) > 0 ? Number(limits.scope) : 400
  const forbiddenLimit = Number(limits.forbidden) > 0 ? Number(limits.forbidden) : 240
  const resumeLimit = Number(limits.resume) > 0 ? Number(limits.resume) : 240

  const pick = (name, limit) => {
    const body = card.sections[name]
    if (!body) return ''
    const flat = body.split('\n').map(line => line.trim()).filter(Boolean).join(' ')
    if (flat.length <= limit) return flat
    // 在句末截断：宁可少说半句，也不要留下"…20261…"这种断词
    const cut = flat.slice(0, limit)
    const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'))
    return (at > limit * 0.5 ? cut.slice(0, at + 1) : cut) + '…'
  }

  // 口径里带「（待补）」的是尚未登记的占位：注入时不占位置，只报个数。
  // 让模型知道"这里有缺口"，而不是把占位符当成已定事实照做。
  const scopeBody = card.sections['口径（已定，勿改）'] ?? card.sections['已定口径'] ?? card.sections['口径'] ?? ''
  const scopeLines = String(scopeBody).split('\n').map(line => line.trim()).filter(Boolean)
  const settled = scopeLines.filter(line => !line.includes('（待补）'))
  const pending = scopeLines.length - settled.length
  const scope = settled.join(' ')

  return {
    scope: scope.length > scopeLimit ? `${scope.slice(0, scopeLimit)}…` : scope,
    pending,
    // 骨架叫「禁区」，用户口语叫「禁入区」。
    forbidden: pick('禁区', forbiddenLimit) || pick('禁入区', forbiddenLimit),
    resume: pick('续开点', resumeLimit),
  }
}

/**
 * 生成注入系统提示词的项目摘要。
 * @param {object} project 项目。
 * @param {object|null} card 项目卡。
 * @param {{rows: number, byProject: Record<string, number>}} stats 索引统计。
 * @param {number} rowsInProject 本项目索引行数。
 * @returns {string}
 */
export function buildHydration(project, card, stats, rowsInProject) {
  const lines = []
  lines.push(`当前项目：${project.id} ${project.name}`)
  lines.push(`期间：${project.period || '—'} ｜ 状态：${project.status || '—'} ｜ 索引：本项目 ${rowsInProject} 行 / 全局 ${stats.rows} 行`)
  const latest = stats.latestByProject?.[project.id]
  if (latest) lines.push(`索引最新节点：${latest.replace('T', ' ').slice(0, 16)}`)
  lines.push('续开点以磁盘 mtime 为准：索引只覆盖进过对话的工作，磁盘比它新即说明有未记录的改动。')

  if (!card) {
    lines.push('项目卡：未找到（`00-说明\\项目卡.md` 缺失），口径与禁区未知，动手前先确认。')
    return lines.join('\n')
  }

  if (card.stale) {
    lines.push(`⚠ 项目卡最后核对于 ${card.front.verified}（${card.verifiedDays} 天前），**可能过期**：口径与禁区需先向用户确认再采信。`)
  } else if (card.front.verified) {
    lines.push(`项目卡核对于 ${card.front.verified}（${card.verifiedDays} 天前）。`)
  }

  const excerpt = cardExcerpt(card)
  if (excerpt.scope !== '') lines.push(`口径（已定，勿改）：${excerpt.scope}`)
  if (excerpt.pending > 0) {
    lines.push(`另有 ${excerpt.pending} 条口径尚未登记（见项目卡「口径」）；涉及这些判断时先问用户，不要默认。`)
  }
  if (excerpt.forbidden !== '') lines.push(`禁区：${excerpt.forbidden}`)
  if (excerpt.resume !== '') lines.push(`续开点：${excerpt.resume}`)

  lines.push('归属：本会话已锚定该项目。产出落 `03-输出\\`，过程结论落 `04-过程\\`；`01-原始\\` 只读。')
  return lines.join('\n')
}
