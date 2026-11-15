/**
 * 工作台账的读取与折叠（插件详情页的数据源）。
 *
 * 台账有两层，缺一层就看不全：
 * - `_台账\索引.jsonl`：每调一次 `work_note` 落一行，字段是**契约**的（node/status/
 *   summary/numbers/ts_session/callId），但 `summary` 只有 100 字，且没有未决/下一步。
 * - `工作台账-<短id>.md`：dsh-work-ledger 从会话日志折叠出的全量台账，有完整结论、
 *   关键数字表（含口径）、未决、下一步、证据条数与 callId。
 *
 * 所以这里以 **md 为准、索引为补**：md 提供正文，索引提供精确时间（md 只写 HH:MM:SS）
 * 和"md 还没落盘（会话进行中）"的那些节点。两边用「节点名 + 时刻」对齐。
 *
 * 纯解析函数不碰磁盘，可以离线测；只有 {@link buildLedgerProject} 读文件。
 *
 * @module dsh-project-anchor/ledger
 */

import { loadAttachments, loadCard, loadIndexRows, loadProjects, readWorkspaceText } from './store.js'

/** 单个项目最多折叠的节点数（防止几百个节点的项目把 JSON 撑爆）。 */
export const NODES_MAX = 200
/** 单个节点最多折叠的结论数。 */
export const NOTES_MAX = 60
/** 正文字数上限（超长结论截断并标记）。 */
export const TEXT_MAX = 4000
/** 未决/下一步条数上限。 */
const LIST_MAX = 12

/** md 里的中文状态 → 与索引一致的机器状态（客户端只认这一套）。 */
const STATUS_ALIAS = {
  进行中: 'active',
  已完成: 'done',
  受阻: 'blocked',
  未开始: 'pending',
}

/**
 * 统一状态口径：md 写「已完成」，索引写 `done`，两处混用会让界面颜色乱掉。
 * @param {string} raw 原始状态。
 * @returns {string} active | done | blocked | pending | unknown。
 */
function normalizeStatus(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return 'unknown'
  return STATUS_ALIAS[text] ?? text
}

/**
 * 从会话 id 里取台账文件名用的短 id。
 * @param {string} sessionId 会话 id（`session-ecc13427-…`）。
 * @returns {string} 8 位短 id；取不到时返回空串。
 */
export function shortIdOf(sessionId) {
  return (/([0-9a-f]{8})/i.exec(String(sessionId ?? '')) ?? [])[1] ?? ''
}

/** 台账正文里的一行表格拆成单元格（去掉首尾竖线两侧的空格）。 */
function cellsOf(line) {
  return line.split('|').slice(1, -1).map(cell => cell.trim())
}

/** 去掉 markdown 的行内反引号与加粗标记，界面上不再渲染 markdown。 */
function plain(text) {
  return String(text ?? '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
}

/**
 * 解析一份 `工作台账-<短id>.md`。
 *
 * 格式由 dsh-work-ledger 的 `markdown.js` 固定：
 * ```
 * ## 1. 节点名（已完成）
 * ### 结论 1 — 22:43:07
 * <正文>
 * 关键数字：
 * | 指标 | 数值 | 口径 / 依据 |
 * 未决：…
 * 下一步：…
 * ### 证据（3 条）
 * ```
 *
 * @param {string} text 文件内容。
 * @returns {{nodes: Array<object>}} 节点数组，顺序与文件一致。
 */
export function parseLedgerMarkdown(text) {
  const nodes = []
  let node = null
  let note = null
  let mode = 'body' // body | numbers | open | next | evidence

  const flushNote = () => {
    if (node === null || note === null) return
    note.text = note.text.trim()
    if (note.text.length > TEXT_MAX) note.text = `${note.text.slice(0, TEXT_MAX)}…`
    note.open = note.open.filter(Boolean).slice(0, LIST_MAX)
    node.notes.push(note)
    note = null
  }
  const flushNode = () => {
    flushNote()
    if (node !== null && (node.notes.length > 0 || node.title !== '')) {
      node.evidence = node.evidence || 0
      nodes.push(node)
    }
    node = null
  }

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    const trimmed = line.trim()

    if (trimmed.startsWith('## ') && !trimmed.startsWith('### ')) {
      flushNode()
      const heading = trimmed.slice(3).trim()
      const numbered = /^(\d+)\.\s*(.*)$/.exec(heading)
      const statusMatch = /（([^（）]+)）\s*$/.exec(heading)
      const titleRaw = (numbered ? numbered[2] : heading).replace(/（[^（）]+）\s*$/, '').trim()
      node = {
        title: titleRaw,
        order: numbered ? Number(numbered[1]) : nodes.length + 1,
        status: statusMatch ? statusMatch[1].trim() : '',
        notes: [],
        evidence: 0,
      }
      mode = 'body'
      continue
    }

    if (trimmed.startsWith('### 结论')) {
      flushNote()
      if (node === null) continue
      const at = trimmed.split('—').slice(1).join('—').trim()
      note = { at, text: '', numbers: [], open: [], next: '' }
      mode = 'body'
      continue
    }

    if (trimmed.startsWith('### 证据')) {
      flushNote()
      if (node === null) continue
      const count = /（\s*(\d+)\s*条\s*）/.exec(trimmed)
      node.evidence = count ? Number(count[1]) : 0
      mode = 'evidence'
      continue
    }

    if (node === null) continue

    if (mode === 'evidence') {
      // 证据正文不折叠进页面（体量大、且要看请去轨迹），只留条数
      continue
    }

    if (trimmed === '关键数字：' || trimmed === '关键数字:') { mode = 'numbers'; continue }
    if (trimmed.startsWith('未决：') || trimmed.startsWith('未决:')) {
      if (note !== null) {
        const rest = trimmed.slice(3).trim()
        if (rest !== '') note.open.push(...rest.split(/[；;]/).map(plain).filter(Boolean))
      }
      mode = 'open'
      continue
    }
    if (trimmed.startsWith('下一步：') || trimmed.startsWith('下一步:')) {
      if (note !== null) note.next = plain(trimmed.slice(4))
      mode = 'next'
      continue
    }

    if (mode === 'numbers') {
      if (!trimmed.startsWith('|')) {
        if (trimmed === '') continue
        mode = 'body'
      } else {
        const cells = cellsOf(trimmed)
        if (cells.length < 2) continue
        if (cells[0] === '指标' || /^-+$/.test(cells[0].replace(/\s/g, ''))) continue
        if (note !== null) {
          note.numbers.push({ name: plain(cells[0]), value: plain(cells[1]), basis: plain(cells[2] ?? '') })
        }
        continue
      }
    }

    if (mode === 'open' || mode === 'next') {
      if (trimmed === '') { mode = 'body'; continue }
      // work_note 的未决/下一步是单行；多行时按同一栏继续收
      if (note !== null) {
        if (mode === 'open') note.open.push(...trimmed.split(/[；;]/).map(plain).filter(Boolean))
        else note.next = `${note.next}${plain(trimmed)}`
      }
      continue
    }

    if (note !== null && trimmed !== '') {
      note.text = note.text === '' ? line : `${note.text}\n${line}`
    }
  }
  flushNode()
  return { nodes }
}

/**
 * 读一个会话的台账 md。文件不存在（还没落盘）时返回 null。
 * @param {string} root 工作区根。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<object|null>} 解析结果。
 */
async function loadDoc(root, sessionId) {
  const shortId = shortIdOf(sessionId)
  if (shortId === '') return null
  const text = await readWorkspaceText(root, `工作台账-${shortId}.md`)
  if (text === null) return null
  try {
    return parseLedgerMarkdown(text)
  } catch {
    return null
  }
}

/** 从 ISO 时间串里取 HH:MM:SS（md 的结论标题只用这一段）。 */
function clockOf(iso) {
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(String(iso ?? ''))
  return match ? match[1] : ''
}

/**
 * 折叠一个项目的台账。
 *
 * 合并规则：
 * 1. 以 md 的节点为主线（有正文、有数字表、有未决/下一步），按首次出现排序；
 * 2. 索引行按「节点名 + 时刻」对上 md 结论后补精确日期；
 * 3. 对不上的索引行（会话进行中、md 尚未重新生成）作为一条只带 summary 的结论追加，
 *    保证"刚写的结论立刻能看见"。
 *
 * @param {string} root 工作区根。
 * @param {string} projectId 项目号。
 * @param {Array<object>} rows 全部索引行。
 * @param {Map<string, string>} attachments 会话 → 项目号。
 * @returns {Promise<object>} 项目台账视图。
 */
export async function buildLedgerProject(root, projectId, rows, attachments) {
  const inProject = rows.filter(row => {
    const sessionId = typeof row.session === 'string' ? row.session : ''
    const resolved = row.project ?? (sessionId ? attachments.get(sessionId) : undefined)
    return resolved === projectId
  })

  // 每个会话的 md 只读一次
  const docs = new Map()
  const warnings = []
  const sessionIds = [...new Set(inProject.map(row => row.session).filter(Boolean))]
  await Promise.all(sessionIds.map(async sessionId => {
    const doc = await loadDoc(root, sessionId)
    if (doc === null) {
      // 只对"真会话"提示：索引里还有一类人工造的会话 id（如 artifact-…），本来就没有台账 md
      if (/^session-/i.test(sessionId)) warnings.push(`会话 ${shortIdOf(sessionId) || sessionId} 的台账 md 尚未落盘`)
      return
    }
    docs.set(sessionId, doc)
  }))

  /** 索引行提供精确时间：`节点|HH:MM:SS` → ISO。 */
  const clockIndex = new Map()
  for (const row of inProject) {
    const key = `${String(row.node ?? '')}|${clockOf(row.ts_session)}`
    const ts = String(row.ts_session ?? '')
    if (!clockIndex.has(key) || ts < clockIndex.get(key)) clockIndex.set(key, ts)
  }

  /** 节点名 → 折叠中的节点。 */
  const byTitle = new Map()
  const order = []

  const ensure = title => {
    if (byTitle.has(title)) return byTitle.get(title)
    const entry = { title, status: '', order: null, notes: [], evidence: 0, sessions: new Set(), firstAt: '', lastAt: '' }
    byTitle.set(title, entry)
    order.push(title)
    return entry
  }

  const touch = (entry, iso) => {
    if (!iso) return
    if (entry.firstAt === '' || iso < entry.firstAt) entry.firstAt = iso
    if (entry.lastAt === '' || iso > entry.lastAt) entry.lastAt = iso
  }

  // 1. md 主线
  const covered = new Set()
  for (const [sessionId, doc] of docs) {
    for (const node of doc.nodes) {
      const entry = ensure(node.title)
      entry.sessions.add(sessionId)
      if (node.status !== '') entry.status = node.status
      if (entry.order === null || node.order < entry.order) entry.order = node.order
      entry.evidence = Math.max(entry.evidence, node.evidence || 0)
      for (const note of node.notes) {
        const iso = clockIndex.get(`${node.title}|${note.at}`) ?? ''
        // 用「节点名 + 时刻」精确标记这一条已被 md 覆盖，避免下面再补一遍
        covered.add(`${node.title}|${note.at}`)
        touch(entry, iso)
        entry.notes.push({
          at: iso || note.at,
          clock: note.at,
          text: note.text,
          numbers: note.numbers,
          open: note.open,
          next: note.next,
          source: 'ledger',
        })
      }
    }
  }

  // 2. 索引补漏（md 未落盘 / 该条没进 md）
  for (const row of inProject) {
    const title = String(row.node ?? '')
    if (title === '') continue
    const clock = clockOf(row.ts_session)
    if (covered.has(`${title}|${clock}`)) continue
    const entry = ensure(title)
    if (row.session) entry.sessions.add(row.session)
    if (typeof row.status === 'string' && row.status !== '') entry.status = row.status
    touch(entry, String(row.ts_session ?? ''))
    entry.notes.push({
      at: String(row.ts_session ?? ''),
      clock,
      text: String(row.summary ?? ''),
      numbers: Array.isArray(row.numbers)
        ? row.numbers.map(value => ({ name: '', value: String(value), basis: '' }))
        : [],
      open: [],
      next: '',
      source: 'index',
    })
  }

  /**
   * 会话最近一次台账活动时间。
   *
   * md 的结论标题只写 `HH:MM:SS`，精确日期要靠索引行对上；索引里没有这一条时，
   * 节点会完全没有时间（面板上时间空着、按时间倒序也排不出来）。此时用该会话的
   * 最近活动时间兜底：日期可能粗一天，但比空值可靠。
   */
  const sessionLatest = new Map()
  for (const row of inProject) {
    const sessionId = typeof row.session === 'string' ? row.session : ''
    if (sessionId === '') continue
    const ts = String(row.ts_session ?? '')
    if (ts === '') continue
    if (ts > (sessionLatest.get(sessionId) ?? '')) sessionLatest.set(sessionId, ts)
  }

  const nodes = order
    .map(title => byTitle.get(title))
    .filter(entry => entry.notes.length > 0)
    .sort((a, b) => String(a.firstAt).localeCompare(String(b.firstAt)))
    .slice(0, NODES_MAX)
    .map((entry, position) => {
      entry.notes.sort((a, b) => String(a.at).localeCompare(String(b.at)))
      const notes = entry.notes.slice(0, NOTES_MAX)
      let firstAt = entry.firstAt
      let lastAt = entry.lastAt
      if (firstAt === '' && lastAt === '') {
        let fallback = ''
        for (const sessionId of entry.sessions) {
          const value = sessionLatest.get(sessionId) ?? ''
          if (value > fallback) fallback = value
        }
        // 有兜底日期就再借 md 里的时分秒：日期用"会话最近活动"，时刻用它自己记的，
        // 这样同一天内的先后顺序仍然可信（否则两个节点会并列在同一时刻）。
        const date = fallback.slice(0, 10)
        const clocks = entry.notes
          .map(note => String(note.clock ?? ''))
          .filter(clock => /^\d{2}:\d{2}:\d{2}$/.test(clock))
          .sort()
        if (date !== '' && clocks.length > 0) {
          firstAt = `${date}T${clocks[0]}`
          lastAt = `${date}T${clocks[clocks.length - 1]}`
        } else {
          firstAt = fallback
          lastAt = fallback
        }
      }
      return {
        index: position + 1,
        title: entry.title,
        status: normalizeStatus(entry.status),
        firstAt,
        lastAt,
        evidence: entry.evidence,
        sessions: [...entry.sessions].map(id => ({ id, shortId: shortIdOf(id) })),
        noteCount: entry.notes.length,
        notes,
      }
    })

  const totals = {
    nodes: nodes.length,
    notes: nodes.reduce((sum, node) => sum + node.noteCount, 0),
    evidence: nodes.reduce((sum, node) => sum + node.evidence, 0),
    sessions: sessionIds.length,
    indexRows: inProject.length,
  }

  return { nodes, totals, warnings: [...new Set(warnings)] }
}

/**
 * 组装插件详情页要的整包数据：项目清单 + 当前项目台账。
 *
 * @param {string} root 工作区根。
 * @param {{project?: string|null, session?: string|null}} [options] 指定项目/会话。
 * @returns {Promise<object>} 视图数据。
 */
export async function buildLedgerView(root, options = {}) {
  const [projects, attachments, rows] = await Promise.all([
    loadProjects(root),
    loadAttachments(root),
    loadIndexRows(root),
  ])

  // 行归属：行自带的 project 优先，缺的用归属表补齐
  const resolved = rows.map(row => ({
    ...row,
    project: row.project ?? (typeof row.session === 'string' ? attachments.get(row.session) ?? null : null),
  }))

  const stats = new Map()
  for (const row of resolved) {
    const id = row.project ?? '(未归属)'
    const entry = stats.get(id) ?? { nodes: 0, notes: 0, lastAt: '', nodeKeys: new Set() }
    entry.notes += 1
    // 台账行是"结论行"，同一个节点会有多行；节点数按 node 去重，供项目卡片统一口径显示
    if (typeof row.node === 'string' && row.node !== '') entry.nodeKeys.add(row.node)
    const ts = String(row.ts_session ?? '')
    if (ts > entry.lastAt) entry.lastAt = ts
    stats.set(id, entry)
  }

  const requested = typeof options.project === 'string' && options.project !== '' ? options.project : null
  const sessionId = typeof options.session === 'string' && options.session !== '' ? options.session : null
  /** 本会话在归属表里的最新项目（null = 未锚定）。 */
  const attachedId = sessionId === null ? null : attachments.get(sessionId) ?? null
  const currentShort = shortIdOf(sessionId ?? '')

  // 「当前项目」的判定顺序：显式指定 → 该会话的归属 → 最近有台账行的项目。
  // 不能按登记表顺序取第一个：那是登记顺序，不是"现在在干哪个"。
  let projectId = requested
  if (projectId === null) projectId = attachedId
  if (projectId === null) {
    let best = null
    for (const [id, entry] of stats) {
      if (id === '(未归属)') continue
      if (best === null || entry.lastAt > best.lastAt) best = { id, lastAt: entry.lastAt }
    }
    projectId = best?.id ?? null
  }
  if (projectId !== null && !projects.some(item => item.id === projectId)) projectId = null
  if (projectId === null) projectId = projects[0]?.id ?? null

  const project = projects.find(item => item.id === projectId) ?? null
  const card = project === null ? null : await loadCard(root, project)

  // 未锚定时该挂哪个项目：两类证据。
  // 硬证据：本会话的台账行已经带着归属落在该项目（以前挂过）。
  // 软证据：本会话的台账结论里提到该项目名或目录名（活儿在这儿干，只是还没走过挂接）。
  // 两类都没有时，才退到"最近有台账行"，并且明确说是弱依据，别让它冒充归属。
  const sessionRows = sessionId === null
    ? []
    : resolved.filter(row => typeof row.session === 'string'
        && (row.session === sessionId || shortIdOf(row.session) === currentShort))
  const evidence = new Map()
  for (const row of sessionRows) {
    const ts = String(row.ts_session ?? '')
    if (row.project !== null) {
      const entry = evidence.get(row.project) ?? { rows: 0, mentions: 0, lastAt: '' }
      entry.rows += 1
      if (ts > entry.lastAt) entry.lastAt = ts
      evidence.set(row.project, entry)
      continue
    }
    const haystack = [row.node, row.summary, ...(Array.isArray(row.files) ? row.files : [])]
      .filter(value => typeof value === 'string' && value !== '')
      .join(' ')
    if (haystack === '') continue
    for (const item of projects) {
      const base = String(item.dir ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''
      // 用"短名/主干"匹配：项目名常带期间或用途后缀（存货核对-2026半年报、销售分析分析），
      // 台账里往往只写主干（存货核对、销售分析）。只拿整名比，这类项目永远匹配不上。
      const name = String(item.name ?? '').trim()
      const short = name.split(/[-—（(·/\s]/)[0].trim()
      const stem = short.replace(/(分析|复核|修订|测算|梳理|比对|回复|报告|明细|口径|台账)$/u, '').trim()
      const words = [name, short, stem, base]
        .filter(word => typeof word === 'string' && word.trim().length >= 3)
      const lower = haystack.toLowerCase()
      if (!words.some(word => lower.includes(word.toLowerCase()))) continue
      const entry = evidence.get(item.id) ?? { rows: 0, mentions: 0, lastAt: '' }
      entry.mentions += 1
      if (ts > entry.lastAt) entry.lastAt = ts
      evidence.set(item.id, entry)
    }
  }

  const metaOf = id => projects.find(item => item.id === id) ?? null
  let candidates = [...evidence.entries()]
    .filter(([id]) => metaOf(id) !== null)
    .sort((left, right) => (right[1].rows - left[1].rows)
      || right[1].lastAt.localeCompare(left[1].lastAt))
    .map(([id, entry]) => {
      const meta = metaOf(id)
      return {
        id, name: meta.name, period: meta.period, status: meta.status,
        rows: entry.rows + entry.mentions, lastAt: entry.lastAt,
        why: entry.rows > 0
          ? `本会话已有 ${entry.rows} 行台账落在该项目`
          : `本会话有 ${entry.mentions} 条台账结论提到该项目`,
        strong: entry.rows > 0,
      }
    })

  if (candidates.length === 0) {
    // 没有任何本会话证据时，只能给"最近有台账行"的项目，并明确标成弱证据，别让它冒充归属
    candidates = [...stats.entries()]
      .filter(([id]) => id !== '(未归属)' && metaOf(id) !== null)
      .sort((left, right) => String(right[1].lastAt).localeCompare(String(left[1].lastAt)))
      .slice(0, 3)
      .map(([id, entry]) => {
        const meta = metaOf(id)
        return {
          id, name: meta.name, period: meta.period, status: meta.status,
          rows: entry.notes, lastAt: entry.lastAt,
          why: `依据：该项目最近有台账行（${entry.lastAt ? entry.lastAt.replace('T', ' ').slice(0, 16) : '时间未知'}）`,
          strong: false,
        }
      })
  }

  const ledger = project === null
    ? { nodes: [], totals: { nodes: 0, notes: 0, evidence: 0, sessions: 0, indexRows: 0 }, warnings: [] }
    : await buildLedgerProject(root, project.id, resolved, attachments)

  return {
    generatedAt: new Date().toISOString(),
    root,
    skill: 'work_ledger',
    projects: projects.map(item => {
      const entry = stats.get(item.id)
      return {
        id: item.id,
        name: item.name,
        dir: item.dir,
        period: item.period,
        status: item.status,
        summary: item.summary ?? '',
        notes: entry?.notes ?? 0,
        nodes: entry?.nodeKeys ? entry.nodeKeys.size : 0,
        lastAt: entry?.lastAt ?? '',
      }
    }),
    unassigned: stats.get('(未归属)')?.notes ?? 0,
    current: {
      projectId,
      sessionId,
      shortId: shortIdOf(sessionId ?? ''),
      // 本会话是否真的锚定过：面板据此决定显示项目卡还是候选挂接，不能拿 projectId 冒充
      anchored: attachedId !== null,
      attachedId,
    },
    candidates,
    project: project === null
      ? null
      : {
          id: project.id,
          name: project.name,
          dir: project.dir,
          period: project.period,
          status: project.status,
          summary: project.summary ?? '',
          card: card === null ? null : {
            path: card.path,
            front: card.front,
            sections: card.sections,
            stale: card.stale,
            verifiedDays: card.verifiedDays,
          },
          ...ledger,
        },
  }
}
