/**
 * dsh-project-anchor —— 项目锚点（provider 第一批：认领 + 装载）
 *
 * 三个工具：
 * - `project_attach`  把当前会话挂到某个项目上（追加一条归属事实）
 * - `project_status`  读项目卡摘要 + 最近节点，回答"这个活干到哪了"
 * - `project_ping`    安装自检（保留，用来确认 bundle 是否真的挂上）
 *
 * 一个注入：把当前会话所属项目的摘要（期间 / 口径 / 禁区 / 续开点）写进
 * 系统提示词的运行时上下文，每轮重新解析。这样新会话不需要重新解释背景。
 *
 * @module dsh-project-anchor
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  STALE_DAYS,
  appendAttachment,
  appendIndexRow,
  appendProjectRow,
  bindHost,
  buildCatalog,
  buildHydration,
  cardExcerpt,
  indexStats,
  loadAttachments,
  loadCallIds,
  loadCard,
  loadIndexRows,
  loadProjects,
  localIso,
  nextProjectId,
  pathKind,
  recentNodes,
  renderProjectCard,
  resolveProjectRef,
  writeWorkspaceText,
} from './store.js'
import { rebuildView } from './render.js'
import { buildLedgerView } from './ledger.js'
import { buildProfile, decideMatch, messageText, rankProjects } from './match.js'
import { CONTEXT_MODES, getContextMode, normalizeContextMode, setContextMode } from './settings.js'

/** 插件名（cordis 用于日志与配置标识）。 */
export const name = 'project-anchor'

/** 必需服务：工具注册表。`systemPrompt` 通过 `ctx.get` 可选获取。 */
export const inject = ['tools']

/** 运行时上下文的注册名。 */
const CONTEXT_NAME = 'project:anchor'

/** Schemastery 由宿主在运行时按模块表提供；本地 node 直跑测试时可能取不到，此时不导出 Config。 */
const schemastery = await import('@deepseek-ai/schemastery')
  .then(module => module.default ?? module)
  .catch(() => undefined)

/**
 * 插件配置：每个键都有默认值，设置页可直接渲染成表单。
 * publishCatalog 默认关（写自定义事件会让日志读不回来，详见 publishCatalog 的注释）。
 *
 * `autoMatch` / `autoMatchTurns`：新会话开头几轮是否自动判定项目（默认开、判 3 轮）。
 * `contextMode`：注入粒度，`digest`＝期间/已定口径/禁入区/续开点四行摘要，
 * `card`＝整张项目卡。这只是初始值：页签上的开关改的是进程内的值，不落盘。
 */
export const Config = schemastery === undefined
  ? undefined
  : schemastery.object({
    publishCatalog: schemastery.boolean().default(false),
    catalogThrottleMinutes: schemastery.number().default(10),
    autoMatch: schemastery.boolean().default(true),
    autoMatchTurns: schemastery.number().default(3),
    contextMode: schemastery.string().default('digest'),
  })

/** 生效配置（apply 时从 Config 抄一份，运行期不再读 ctx 配置）。 */
const runtimeConfig = {
  autoMatch: true,
  autoMatchTurns: 3,
  contextMode: 'digest',
}

/** 缓存：让系统提示词的同步渲染也能读到数据。 */
const cache = {
  root: null,
  projects: [],
  attachments: new Map(),
  stats: { rows: 0, byProject: {} },
  refreshedAt: 0,
  loading: false,
}

/**
 * 自动判定的会话状态（每条会话一份，进程内）。
 *
 * 三个字段各有分工：`turn` 是"第几轮"（来自 turn/start 的 data.turn），
 * `analyzedSeq` 去重同一事件的重复投递，`hint` 是最近一次判出来但不敢自动挂的候选。
 */
const autoMatchState = new Map()

export function apply(ctx, config) {
  bindHost(ctx)
  if (config?.publishCatalog === true) publishCatalogEnabled = true
  const throttleMinutes = Number(config?.catalogThrottleMinutes)
  if (Number.isFinite(throttleMinutes) && throttleMinutes > 0) catalogThrottleMs = throttleMinutes * 60_000
  if (typeof config?.autoMatch === 'boolean') runtimeConfig.autoMatch = config.autoMatch
  const turns = Number(config?.autoMatchTurns)
  if (Number.isFinite(turns) && turns >= 0) runtimeConfig.autoMatchTurns = Math.floor(turns)
  // 注入粒度只在内存里：插件重载即回到这里的初始值。
  setContextMode(normalizeContextMode(config?.contextMode, runtimeConfig.contextMode))
  runtimeConfig.contextMode = getContextMode()
  registerTools(ctx)
  registerHydration(ctx)
  registerIndexWriter(ctx)
  registerCatalogProjection(ctx)
  registerLedgerRoute(ctx)
}

// ---------------------------------------------------------------- 工具

function registerTools(ctx) {
  // 面板路由与工具共用同一份实现：登记/提案只有一处逻辑。
  panelTools.register = (args, exec) => registerTool(ctx, args, exec)
  panelTools.suggest = (args, exec) => suggestTool(ctx, args, exec)

  ctx.tools.register({
    name: 'project_attach',
    description: [
      'Attach the current session to a project (appends one attribution record; later records win).',
      'Call it as soon as you can tell which project the work belongs to — do not wait to be told, and never make the user recite an id.',
      '`project` accepts whatever the user said: a name (存货核对 / 答复清单 / 销售分析), a directory name, an alias, or the P-id.',
      'If the reference is ambiguous it returns candidates instead of attaching: ask the user one short question using those names.',
      'It never moves files: it only records "this session belongs to project X" and returns the project card path.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['project'],
      properties: {
        project: {
          type: 'string',
          description: 'Project name, directory name, alias, P-id, or "取消" to detach. Natural language is expected; an id is not required.',
        },
        note: { type: 'string', description: 'Why this session belongs here (kept in the attribution record).' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: args => ({ card: 'generic', title: '锚定项目', kind: 'other',
      ...(typeof args?.project === 'string' ? { rawInput: args.project } : {}) }),
    execute: (args, exec) => attachTool(ctx, args, exec),
  })

  ctx.tools.register({
    name: 'project_register',
    description: [
      'Register a new project: append one row to `_台账\\项目登记表.md`, create its 项目卡, and (by default) attach this session to it.',
      'Use it when the user starts a line of work that will be resumed across sessions and has no project yet — a project does NOT need a directory up front; the card then lives at `_台账\\项目卡-<编号>.md`.',
      'Never call it silently: confirm the name and the one-line summary with the user first, and pass `basis` explaining why this is a separate project (which files/topics it covers).',
      'It never moves or renames files; the 目录 column is optional and may be filled in later.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'summary', 'basis'],
      properties: {
        name: { type: 'string', description: '项目名（业务语义，如「存货减值复核-2026年报」），不是目录名。' },
        summary: { type: 'string', description: '一句话说这个项目在干什么。' },
        basis: { type: 'string', description: '判定依据：哪些文件/主题/会话落在这里，为什么它是一个独立项目。' },
        dir: { type: 'string', description: '项目目录（工作区内相对路径）。可以留空：没有目录也能立项。' },
        period: { type: 'string', description: '期间，如 2023末–2026H1。' },
        status: { type: 'string', description: 'active / paused / done / unknown，默认 active。' },
        alias: { type: 'string', description: '别名，逗号分隔。' },
        id: { type: 'string', description: '显式编号（回填用）；留空则按 P<年>-NN 顺延。' },
        attach: { type: 'boolean', description: '是否顺手把当前会话挂到新项目上，默认 true。' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: args => ({ card: 'generic', title: '登记项目', kind: 'other',
      ...(typeof args?.name === 'string' ? { rawInput: args.name } : {}) }),
    execute: (args, exec) => registerTool(ctx, args, exec),
  })

  ctx.tools.register({
    name: 'project_suggest',
    description: [
      'Look at the台账 rows this session produced but never attributed, and propose groupings that look like distinct projects.',
      'Returns clusters with the node titles and files each one covers plus a basis string — never registers anything; ask the user which clusters to register, then call project_register.',
      'Works without directories: clustering uses node titles/summaries/files, not folder names.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minRows: { type: 'number', description: '每组至少几条台账结论才算候选，默认 2。' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: () => ({ card: 'generic', title: '推测项目分组', kind: 'other' }),
    execute: (args, exec) => suggestTool(ctx, args, exec),
  })

  ctx.tools.register({
    name: 'project_status',
    description: [
      'Read one project\'s card summary (period, settled conventions, no-go zones, resume point) plus its latest index nodes.',
      'Use it to answer "where did this work stop" without re-reading the project folder.',
      'Defaults to the project this session is attached to.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string', description: 'Project id; defaults to the current session\'s project.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: () => ({ card: 'generic', title: '读取项目状态', kind: 'other' }),
    execute: (args, exec) => statusTool(ctx, args, exec),
  })

  ctx.tools.register({
    name: 'project_ping',
    description: [
      'Report whether the project-anchor host plugin is live, plus the state of the local index files.',
      'Use it once after installation to confirm the bundle was loaded; it reads nothing outside the workspace.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: 'Workspace root to inspect. Defaults to the session working directory.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: () => ({ card: 'generic', title: '项目锚点自检', kind: 'other' }),
    execute: (args, exec) => ping(args, exec),
  })

  ctx.tools.register({
    name: 'project_rebuild',
    description: [
      'Rebuild the two index views (索引.md / 自由会话.md) from the append-only facts.',
      'Idempotent and cheap; call it after new conclusions land or when the user wants a fresh view.',
    ].join(' '),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    presentCall: () => ({ card: 'generic', title: '重建索引视图', kind: 'other' }),
    execute: async (args, exec) => {
      const root = resolveRoot(args, exec)
      if (!root) throw new Error('project_rebuild: 取不到工作区目录')
      const result = await rebuildView(root, { session: exec?.agent?.session })
      await refresh(ctx, root)
      await publishCatalog(exec?.agent?.session, root, true)
      return result
    },
  })
}

async function attachTool(ctx, args, exec) {
  const root = resolveRoot(args, exec)
  const session = sessionIdOf(exec)
  const raw = typeof args?.project === 'string' ? args.project.trim() : ''
  if (session === null) throw new Error('project_attach: 取不到会话 id，无法记录归属')

  await refresh(ctx, root)
  const ref = resolveProjectRef(cache.projects, raw)

  // 传 none / - / 取消 = 取消锚定：仍然追加一条记录（project: null），不改历史行。
  if (ref.kind === 'detach' || raw === '') {
    if (raw === '' && cache.projects.length > 0) {
      // 空串是"问有哪些项目"，不是"取消"——别让它误清归属
      return { attached: false, available: cache.projects.map(item => ({ id: item.id, name: item.name })) }
    }
    const cleared = await appendAttachment(root, { session, project: null, by: 'model',
      note: typeof args?.note === 'string' ? args.note : '取消锚定' },
    { session: exec?.agent?.session, signal: exec?.signal })
    if (!cleared.ok) throw new Error(`project_attach: 写归属失败（${cleared.error}）`)
    await refresh(ctx, root)
    return { attached: false, session, project: null, next: '已取消锚定；下一轮起系统提示词不再带项目摘要。' }
  }

  // 拿不准就把候选交回去，让模型去问人 —— 报错会逼人回去念编号，那正是要避免的
  if (ref.kind !== 'one') {
    return {
      attached: false,
      ambiguous: ref.kind === 'many',
      query: raw,
      candidates: ref.kind === 'many'
        ? ref.candidates
        : cache.projects.map(item => ({ id: item.id, name: item.name })),
      next: '用一句话向用户确认是哪一个（说项目名即可），再带上更明确的名字重试。',
    }
  }

  const project = ref.project
  const written = await appendAttachment(root, {
    session,
    project: project.id,
    by: 'model',
    note: typeof args?.note === 'string' ? args.note : undefined,
  }, { session: exec?.agent?.session, signal: exec?.signal })
  if (!written.ok) throw new Error(`project_attach: 写归属失败（${written.error}）`)

  await refresh(ctx, root)
  const card = await loadCard(root, project)
  await publishCatalog(exec?.agent?.session, root, true)
  return {
    attached: true,
    session,
    project: { id: project.id, name: project.name, dir: project.dir, period: project.period, status: project.status },
    card: card ? { path: card.path, verified: card.front.verified ?? null, stale: card.stale } : null,
    next: '系统提示词会在下一轮带上该项目摘要；产出仍落项目目录，本工具不移动任何文件。',
  }
}

// ---------------------------------------------------------------- 登记与分组

/** 把用户可能写进项目名的分隔符压平，避免表格被撑坏。 */
function cleanText(value, limit = 200) {
  return String(value ?? '').replace(/\|/g, '／').replace(/\s+/g, ' ').trim().slice(0, limit)
}

/**
 * `project_register`：登记一个新项目。
 *
 * 设计要点（与"只读面板"互补）：
 * - 目录不是必需的。零目录的新用户也能立项，卡落 `_台账\项目卡-<编号>.md`。
 * - `basis` 必填并写进卡里：将来有人问"这行为什么算一个项目"时，答案在卡上，不在聊天记录里。
 * - 只追加登记表一行，不改既有行；写卡与写表都带当前会话的沙箱策略。
 * @param {object} ctx 插件上下文（刷新缓存用）。
 * @param {object} args 工具入参。
 * @param {object} exec 执行上下文。
 * @returns {Promise<object>} 登记结果。
 */
async function registerTool(ctx, args, exec) {
  const root = resolveRoot(args, exec)
  if (!root) throw new Error('project_register: 取不到工作区目录')
  const name = cleanText(args?.name, 60)
  const summary = cleanText(args?.summary, 200)
  const basis = cleanText(args?.basis, 400)
  if (name === '') throw new Error('project_register: name 不能为空（用业务名，不是目录名）')
  if (summary === '') throw new Error('project_register: summary 不能为空（一句话说清这个项目在干什么）')
  if (basis === '') throw new Error('project_register: basis 不能为空（说明哪些文件/主题/会话落在这里）')

  await refresh(ctx, root)
  const existing = cache.projects
  const dir = cleanText(args?.dir, 200)
  const period = cleanText(args?.period, 40)
  const status = cleanText(args?.status, 20) || 'active'
  const alias = cleanText(args?.alias, 120)

  // 重名检查：按名字（去空白）和编号两条，目录重复也算冲突——一个目录只能属于一个项目
  const clashName = existing.find(item => String(item.name ?? '').replace(/\s+/g, '') === name.replace(/\s+/g, ''))
  if (clashName) {
    return { registered: false, reason: `已存在同名项目 ${clashName.id}`, existing: { id: clashName.id, name: clashName.name } }
  }
  if (dir !== '') {
    const clashDir = existing.find(item => String(item.dir ?? '').replace(/[\\/]+$/, '') === dir.replace(/[\\/]+$/, ''))
    if (clashDir) {
      return { registered: false, reason: `目录 ${dir} 已属于 ${clashDir.id}`, existing: { id: clashDir.id, name: clashDir.name } }
    }
    const kind = await pathKind(root, dir)
    if (kind === null) {
      return {
        registered: false,
        reason: `目录 ${dir} 不存在`,
        hint: '不带 dir 直接登记（卡会落在 _台账\\项目卡-<编号>.md），或先建目录再登记。',
      }
    }
    if (kind !== 'dir') return { registered: false, reason: `${dir} 不是目录` }
  }

  const id = cleanText(args?.id, 20) || nextProjectId(existing)
  if (!/^P\d{4}-\d{2}$/.test(id)) throw new Error(`project_register: 编号格式应为 P<年>-NN，收到 ${id}`)
  if (existing.some(item => item.id === id)) {
    return { registered: false, reason: `编号 ${id} 已被占用`, hint: '留空 id 让插件顺延，或换一个编号。' }
  }

  const project = { id, name, dir, period, status, alias, summary }
  const rowResult = await appendProjectRow(root, project, { session: exec?.agent?.session, signal: exec?.signal })
  if (!rowResult.ok) throw new Error(`project_register: 写登记表失败：${rowResult.error}`)

  const cardRelative = dir === '' ? join('_台账', `项目卡-${id}.md`) : join(dir, '00-说明', '项目卡.md')
  let cardNote = cardRelative
  let cardResult = await writeWorkspaceText(root, join(root, cardRelative), renderProjectCard(project, { basis }),
    { session: exec?.agent?.session, signal: exec?.signal })
  if (!cardResult.ok && cardRelative !== join('_台账', `项目卡-${id}.md`)) {
    // 目录里没有 00-说明 之类的情况：退回台账侧建卡，保证"有项目就有卡"
    const fallback = join('_台账', `项目卡-${id}.md`)
    const retry = await writeWorkspaceText(root, join(root, fallback), renderProjectCard(project, { basis }),
      { session: exec?.agent?.session, signal: exec?.signal })
    if (retry.ok) {
      cardNote = fallback
      cardResult = retry
    }
  }

  await refresh(ctx, root)

  const session = sessionIdOf(exec)
  let attached = false
  if (args?.attach !== false && session !== null) {
    const written = await appendAttachment(root, {
      session, project: id, by: 'model', note: `登记新项目后自动挂接：${name}`,
    }, { session: exec?.agent?.session, signal: exec?.signal })
    attached = written.ok
    if (written.ok) await refresh(ctx, root)
  }

  return {
    registered: true,
    project: { id, name, dir: dir === '' ? null : dir, period: period === '' ? null : period, status, summary },
    registry: rowResult.path,
    card: cardResult.ok ? { path: cardNote } : { path: cardNote, warning: cardResult.error },
    attached,
    next: [
      attached
        ? '本轮之后系统提示词会带上这个项目；后续产出的台账行按结论落库即可，归属靠 attach 事实。'
        : '项目已登记；需要挂接时调 project_attach（说项目名即可）。',
      dir === ''
        ? '还没有目录：业务文件留在原地也没问题，等定下来再补 dir（登记表追加一行即可）。'
        : '文件仍写在项目目录里；本工具不移动任何已有文件。',
    ],
  }
}

/** 中文/英文统一切词：连续的非字母数字汉字算一段，便于 2-gram 比较。 */
function wordsOf(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** 字符 2-gram 集合；空串返回空集合。 */
function bigramSet(text) {
  const cleaned = wordsOf(text).replace(/\s+/g, '')
  const grams = new Set()
  for (let index = 0; index < cleaned.length - 1; index += 1) grams.add(cleaned.slice(index, index + 2))
  return grams
}

/**
 * Dice 相似度：`2|A∩B| / (|A|+|B|)`。
 *
 * 不用 Jaccard：两份标题长度差得远时 Jaccard 会被长的那份压得很低
 * （实测「存货减值明细复核…」对「存货减值准备差异说明…」只有 0.33，
 * 而「销售口径拆分…」对「销售终端口径核对…」是 0.27），
 * 两句明明是同一件事却过不了阈值；Dice 对长度不敏感，同样两组是 0.50 / 0.42，
 * 跨组最高只有 0.10，分得开。
 */
function similarity(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let hit = 0
  for (const gram of left) if (right.has(gram)) hit += 1
  return (2 * hit) / (left.size + right.size)
}

/**
 * `project_suggest`：把"本会话产生但没归属"的台账行分组成候选项目。
 *
 * 刻意只提案不写库：分组靠文字相似度，必然会错一部分，错的那部分必须由人否掉。
 * 判据（`basis`）一并返回，用户确认时能看见"为什么这 4 条算一组"。
 * @param {object} ctx 插件上下文。
 * @param {object} args 工具入参。
 * @param {object} exec 执行上下文。
 * @returns {Promise<object>} 候选分组。
 */
async function suggestTool(ctx, args, exec) {
  const root = resolveRoot(args, exec)
  if (!root) throw new Error('project_suggest: 取不到工作区目录')
  const session = sessionIdOf(exec)
  await refresh(ctx, root)
  const minRows = Number.isFinite(Number(args?.minRows)) ? Math.max(2, Number(args.minRows)) : 2

  if (session === null) return { suggestions: [], reason: '取不到会话 id，无法判断哪些行属于本次会话。' }
  const short = shortIdOf(session)
  const rows = await loadIndexRows(root)
  const attachments = cache.attachments
  const mine = rows.filter(row => {
    if (row?.type !== 'note') return false
    const project = row.project ?? attachments.get(row.session) ?? null
    if (project !== null) return false
    return row.session === session || (short !== '' && String(row.session ?? '').includes(short))
  })

  if (mine.length < minRows) {
    return {
      suggestions: [],
      sessionRows: mine.length,
      minRows,
      reason: `本会话只有 ${mine.length} 条未归属的台账结论，不够分组（至少 ${minRows} 条）。`,
      hint: '继续干活，work_note 写的行会自动进索引；凑够再来看。',
    }
  }

  // 每条行取「节点名 + 摘要 + 文件名词干」作为聚类文本；
  // 节点名单独归一化——同一节点名的多条结论是同一件事的不同侧面，这是最硬的信号。
  const items = mine.map((row, index) => {
    const files = Array.isArray(row.files) ? row.files.filter(Boolean) : []
    const stems = files.map(file => String(file).split(/[\\/]/).pop() ?? '')
      .map(base => base.replace(/\.[A-Za-z0-9]+$/, '').replace(/[_\-\d]+/g, ' '))
    const text = [row.node, row.summary, ...stems].filter(Boolean).join(' ')
    const nodeKey = wordsOf(row.node).replace(/\s+/g, '').toLowerCase()
    return { index, row, files, grams: bigramSet(text), text, nodeKey }
  })

  // 贪心聚类：与簇内**任一成员**足够相似就并进去。
  // 不用"簇心并集"比较：并集会随簇变大而稀释，几轮之后两个不相关的话题也会被并进来。
  // 相似度取两者较大值：同一节点名＝1；否则看文字 Dice。
  // 只看文字不行——同一节点的三条结论摘要动辄四五句，彼此 Dice 只有 0.17，
  // 而两个不同节点因为都写「项目锚定插件-…」反而能到 0.32，纯文字会把同一件事拆开、把不相干的并上。
  const sameNode = (left, right) => left.nodeKey !== '' && left.nodeKey === right.nodeKey
  const clusters = []
  for (const item of items) {
    let best = null
    let bestScore = 0
    let bestSameNode = false
    for (const cluster of clusters) {
      for (const member of cluster.items) {
        const score = sameNode(item, member) ? 1 : similarity(item.grams, member.grams)
        if (score > bestScore) {
          bestScore = score
          best = cluster
          bestSameNode = sameNode(item, member)
        }
      }
    }
    if (best !== null && bestScore >= 0.34) {
      best.items.push(item)
      best.score = Math.max(best.score, bestScore)
      best.sameNode = best.sameNode === true || bestSameNode
    } else {
      clusters.push({ items: [item], score: 0, sameNode: false })
    }
  }

  const suggestions = clusters
    .filter(cluster => cluster.items.length >= minRows)
    .sort((left, right) => right.items.length - left.items.length)
    .map((cluster, index) => {
      const titles = cluster.items.map(item => String(item.row.node ?? '').trim()).filter(Boolean)
      const files = [...new Set(cluster.items.flatMap(item => item.files))].map(file => file.replace(root, '').replace(/^[\\/]/, ''))
      return {
        index: index + 1,
        name: suggestName(titles),
        rows: cluster.items.length,
        nodes: titles.slice(0, 8),
        files: files.slice(0, 8),
        basis: cluster.sameNode
          ? `同一节点「${titles[0] ?? ''}」下的 ${cluster.items.length} 条结论`
          : `文字 2-gram 相似度 ≥ ${(cluster.score || 0).toFixed(2)}，覆盖 ${cluster.items.length} 条台账结论`,
      }
    })

  return {
    sessionRows: mine.length,
    suggestions,
    hint: suggestions.length === 0
      ? '这些行彼此不像同一件事，先不分组也可以：同一项目可以横跨多批活，归属由 attach 决定。'
      : '把候选念给用户确认：确认哪组，就用 project_register 逐组建卡（name 用用户认可的说法，basis 直接引这里的 basis）。',
  }
}

/** 从节点标题里猜一个项目名：取最短公共前缀（≥3 字），否则用第一句。 */
function suggestName(titles) {
  const cleaned = titles.map(title => String(title ?? '').trim()).filter(Boolean)
  if (cleaned.length === 0) return '未命名分组'
  let prefix = cleaned[0]
  for (const title of cleaned.slice(1)) {
    let index = 0
    const limit = Math.min(prefix.length, title.length)
    while (index < limit && prefix[index] === title[index]) index += 1
    prefix = prefix.slice(0, index)
    if (prefix.length < 2) break
  }
  const trimmed = prefix.replace(/[-—·:：,，.、\s]+$/, '').trim()
  return trimmed.length >= 3 ? trimmed : cleaned[0].slice(0, 24)
}

function shortIdOf(sessionId) {
  return (/([0-9a-f]{8})/i.exec(String(sessionId ?? '')) ?? [])[1] ?? ''
}

async function statusTool(ctx, args, exec) {
  const root = resolveRoot(args, exec)
  const session = sessionIdOf(exec)
  await refresh(ctx, root)

  const requested = typeof args?.project === 'string' && args.project.trim() !== '' ? args.project.trim() : null
  const attached = session ? cache.attachments.get(session) ?? null : null

  // 同样接受人类说法：名称 / 目录名 / 别名 / 关键词都行，不必念编号
  if (requested !== null) {
    const ref = resolveProjectRef(cache.projects, requested)
    if (ref.kind === 'one') return describeProject(root, ref.project, attached)
    return {
      attached: false,
      matched: false,
      query: requested,
      candidates: ref.kind === 'many'
        ? ref.candidates
        : cache.projects.map(item => ({ id: item.id, name: item.name })),
      hint: '没把握对应哪个项目。用一句话向用户确认，或换一个更明确的名字再查。',
    }
  }

  if (!attached) {
    return {
      attached: false,
      session,
      available: cache.projects.map(item => ({ id: item.id, name: item.name, status: item.status })),
      hint: '本会话未锚定项目。用 project_attach 挂一个（说项目名即可），或传 project 直接查某个项目。',
    }
  }

  const project = cache.projects.find(item => item.id === attached)
  if (!project) throw new Error(`project_status: 归属里的 ${attached} 已不在登记表`)
  return describeProject(root, project, attached)
}

/**
 * 组装单个项目的状态返回体。
 * @param {string} root 工作区根。
 * @param {object} project 项目。
 * @param {string|null} attached 本会话的归属，用于标注 attached 字段。
 * @returns {Promise<object>}
 */
async function describeProject(root, project, attached) {
  const projectId = project.id
  const card = await loadCard(root, project)
  const nodes = await recentNodes(root, projectId, 5, cache.attachments)
  return {
    attached: attached === projectId,
    project: { id: project.id, name: project.name, dir: project.dir, period: project.period, status: project.status },
    card: card
      ? {
          path: card.path,
          verified: card.front.verified ?? null,
          stale: card.stale,
          staleAfterDays: STALE_DAYS,
          conventions: card.sections['口径（已定，勿改）'] ?? null,
          forbidden: card.sections['禁区'] ?? null,
          resume: card.sections['续开点'] ?? null,
        }
      : null,
    index: { rowsInProject: cache.stats.byProject[projectId] ?? 0, rowsTotal: cache.stats.rows },
    recentNodes: nodes,
  }
}

async function ping(args, exec) {
  const root = resolveRoot(args, exec)
  const result = {
    live: true,
    plugin: name,
    cwd: process.cwd(),
    profile: process.env.DSH_PROFILE ?? null,
    root,
    session: {
      found: Boolean(exec?.agent?.session),
      id: sessionIdOf(exec),
      cwd: exec?.agent?.session?.header?.cwd ?? null,
    },
    hydrated: cache.root === root && cache.projects.length > 0,
    projects: cache.projects.length,
    attachments: cache.attachments.size,
    indexRows: null,
    ledger: {
      route: ledgerRouteState,
      knownRoot: lastKnownRoot,
      probe: null,
      panel: panelProbe.slice(-8),
    },
    errors: [],
  }

  try {
    const text = await readFile(join(root, '_台账', '索引.jsonl'), 'utf8')
    result.indexRows = text.split('\n').filter(line => line.trim() !== '').length
  } catch (error) {
    result.errors.push(`index: ${error.code ?? error.message}`)
  }

  // 自测一次详情页路由：能 200 且带 project 字段，才说明前端拿得到数据
  if (ledgerRouteState.status === 'registered' && ledgerRouteState.origin) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    try {
      const response = await fetch(`${ledgerRouteState.origin}${LEDGER_ROUTE}`, { signal: controller.signal })
      const body = await response.text()
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = null
      }
      result.ledger.probe = {
        ok: response.ok && parsed !== null && typeof parsed.project !== 'undefined',
        status: response.status,
        project: parsed?.project?.name ?? null,
        nodes: parsed?.project?.totals?.nodes ?? null,
        error: parsed?.error ?? null,
      }
    } catch (error) {
      result.ledger.probe = { ok: false, status: null, error: String(error?.message ?? error) }
    } finally {
      clearTimeout(timer)
    }
  }

  return result
}

// ---------------------------------------------------------------- 装载

function registerHydration(ctx) {
  const systemPrompt = ctx.get('systemPrompt')
  if (!systemPrompt || typeof systemPrompt.context !== 'function') return

  systemPrompt.context({
    name: CONTEXT_NAME,
    order: 100,
    text: context => {
      const session = context?.agent?.session ?? context?.session ?? null
      const root = resolveRoot(undefined, { agent: { session } })
      if (!root) return ''
      // 渲染是同步的：先用手里的缓存，同时触发一次后台刷新。
      void ensureFresh(ctx, root)
      const id = sessionIdOf({ agent: { session } })
      if (!id) return ''
      const hydration = renderCached(root, id)
      if (hydration !== '') return hydration
      // 还没锚定：如果前几轮判出"像某个项目"，就把判断依据递进来，让模型在第一轮里问一句。
      return renderAutoHint(id)
    },
  })
}

function renderCached(root, sessionId) {
  if (root !== cache.root || cache.projects.length === 0) return ''
  if (!sessionId) return ''
  const projectId = cache.attachments.get(sessionId)
  if (!projectId) return ''
  const project = cache.projects.find(item => item.id === projectId)
  if (!project) return ''

  const card = cache.cards?.get(projectId) ?? null
  const rowsInProject = cache.stats.byProject[projectId] ?? 0
  const digest = buildHydration(project, card, cache.stats, rowsInProject)
  // 注入是同步的，粒度读进程内那一份（页签上的开关直接改它，无需刷新缓存）。
  const mode = getContextMode()
  if (mode !== 'card' || typeof card?.text !== 'string' || card.text.trim() === '') return digest
  // 整卡模式：摘要仍放前面（它带"卡可能过期"的判断），全文附在后面。
  return `${digest}\n\n项目卡全文（${card.path}）：\n${card.text.trim()}`
}

/**
 * 把"像某个项目"的判定写进上下文。
 *
 * 只在判出来的那一轮与下一轮里出现：再往后要么已经挂上了（走 renderCached），
 * 要么就是在干别的事——留着这段文字只会让模型每次都提一句无关项目。
 * @param {string} sessionId 会话 id。
 * @returns {string} 注入文本（无需提示时为空串）。
 */
function renderAutoHint(sessionId) {
  const state = autoMatchState.get(sessionId)
  const hint = state?.hint ?? null
  if (!hint) return renderNewProjectHint(state)
  if (state.turn - hint.turn > 1) return ''
  const others = hint.candidates
    .filter(item => item.id !== hint.project.id)
    .map(item => `${item.name}（${item.id}）`)
  const lines = []
  lines.push(`可能相关的项目：${describeProjectLine(hint.project)}`)
  lines.push(`判定依据：${hint.why}`)
  if (others.length > 0) lines.push(`并列候选：${others.join('、')}`)

  // 未锚定也要能说人话：把候选项目的期间 / 已定口径 / 禁入区 / 上次停在哪摘出来。
  // 用户要的正是"这像是 X 项目；期间＋已定口径＋禁入区＋上次停在哪"这一句
  // —— 光给项目名，模型还是没法判断该不该接。
  const card = cache.cards?.get(hint.project.id) ?? null
  const excerpt = cardExcerpt(card, { scope: 200, forbidden: 120, resume: 120 })
  const period = hint.project.period ?? ''
  if (period !== '' || excerpt.scope !== '' || excerpt.forbidden !== '' || excerpt.resume !== '') {
    lines.push('卡上写着（确认归属前先看这几行）：')
    if (period !== '') lines.push(`  期间：${period}`)
    if (excerpt.scope !== '') lines.push(`  已定口径：${excerpt.scope}`)
    if (excerpt.forbidden !== '') lines.push(`  禁入区：${excerpt.forbidden}`)
    if (excerpt.resume !== '') lines.push(`  上次停在哪：${excerpt.resume}`)
  }

  lines.push('本会话还没有锚定。如果确实是它，调 `project_attach`（项目名就行）；如果不是，忽略这段，不要追问。')
  lines.push('第一轮回复里只用一句话确认归属（例如「这像是 X 项目，我先按它的口径做」），不要长篇复述。')
  return lines.join('\n')
}

/**
 * 第四档提示：本会话干了活、但哪个已有项目都不像。
 *
 * 只出现一次（`shown` 一置就不再渲染）：这句话是"要不要建个新项目"的提醒，
 * 重复出现只会变成噪音；模型看完要么建卡、要么挂到已有项目，都不做也由它。
 * @param {object|undefined} state 会话判定状态。
 * @returns {string} 注入文本（无需提示时为空串）。
 */
function renderNewProjectHint(state) {
  const fresh = state?.newProject ?? null
  if (!fresh || fresh.shown === true) return ''
  fresh.shown = true
  const lines = []
  lines.push(`本会话还没有项目归属，现有 ${fresh.projects} 个项目都没有明确对上（本会话已有 ${fresh.rows} 条结论还没归属）。`)
  lines.push('如果这是一条新线：调 `project_register` 建一个（告诉我名字就行，目录不用先建），已经写下的结论会归到新项目下。')
  lines.push('如果其实属于某个已有项目：调 `project_attach`（项目名就行）。这段提示只出现一次。')
  return lines.join('\n')
}

/**
 * 一行项目描述：`P2026-01 存货核对-2026半年报（2023末–2026H1）`。
 * @param {{name: string, id: string, period?: string}} item 候选。
 * @returns {string} 描述。
 */
function describeProjectLine(item) {
  const period = item.period ? `，${item.period}` : ''
  return `${item.name}（${item.id}${period}）`
}

// ---------------------------------------------------------------- 界面目录

/**
 * 客户端「项目锚定」页签的数据通道。
 *
 * 为什么不用 typert：那是双端类型化 RPC，宿主侧要一份**生成器产物**形式的清单、
 * 客户端要一份 `typert.remote-client.js`，而本机没有那个生成器，手抄生成产物不值得。
 *
 * 原本想走 work-ledger 的通道：
 *   宿主 `session.append('project/catalog', …)` → 本投影折叠 → `wire` 视图 → 客户端 `useProjection`
 * 带 `wire` 这一步是对的（没有 wire 的投影不产生客户端视图，界面上什么也看不到），
 * 但 `session.append` 那一步不成立：自定义事件类型会让会话再也打不开（见
 * `PUBLISH_CATALOG_TO_LOG` 的注释）。通道待换成 webServer 路由 + 客户端 fetch。
 */
/** 上次把目录推给客户端的时间，用于 work_note 侧的节流。 */
let lastCatalogAt = 0

function registerCatalogProjection(ctx) {
  const projections = ctx.get('sessionProjections')
  if (!projections || typeof projections.register !== 'function') return
  try {
    projections.register({
      key: 'projectCatalog',
      stateSchema: { parse: value => value },
      stateVersion: 1,
      init: () => ({ catalog: null }),
      apply: (state, event) => (event?.type === 'project/catalog' ? { catalog: event.data ?? null } : state),
      wire: { viewSchema: { parse: value => value }, view: state => state },
    })
  } catch {
    // 客户端视图不可用时静默降级：工具与注入照常工作
  }
}

/**
 * 是否把目录写进会话日志（默认关）。
 *
 * 宿主读取端只认识 `SessionEventMap` 里声明过的事件类型；没声明的类型必须在信封上
 * 带 `ignorable: true` 才允许读回，否则整份日志被拒绝解释
 * （`... contains event type "project/catalog" ... unknown to this harness and not marked
 * ignorable; refusing to interpret the log`）。而 `session.append()` 写不出这个标记，
 * `appendPluginRecord()` 的私有实现 `#appendRecord` 插件也调不到、`@deepseek-ai/dsh-session`
 * 在本插件里解析不了 —— 也就是说，**插件没有受支持的"把自定义事件写进日志"的通道**。
 *
 * 代价是实打实的：2026-10-30 的 `session-1e32a0df`（seq 2506/2507）和本会话
 * （seq 22）都因为这两条事件变成"打不开的会话"。所以默认不写：页签先退化成空目录，
 * 等换成 webServer 路由 + 客户端 fetch 的通道再恢复。
 *
 * 仅用于复现问题：设 `DSH_PROJECT_ANCHOR_PUBLISH=1` 可临时打开。
 */
/** 打开"把目录写进会话日志"的紧急开关（默认关，见下方注释）。 */
let publishCatalogEnabled = process.env.DSH_PROJECT_ANCHOR_PUBLISH === '1'

/** 目录节流（毫秒）：attach / rebuild 会强制刷新，work_note 侧按此节流。 */
let catalogThrottleMs = 600000

/**
 * 把最新目录写进当前会话，客户端页签据此渲染。
 * @param {object} session 会话。
 * @param {string} root 工作区根。
 * @returns {Promise<object|null>} 目录，失败时 null。
 */
async function publishCatalog(session, root, force = false) {
  if (!publishCatalogEnabled) return null
  if (!session || typeof session.append !== 'function' || !root) return null
  // 每次 work_note 都重算目录太浪费：默认 10 分钟一次；attach / rebuild 强制刷新
  if (!force && Date.now() - lastCatalogAt < catalogThrottleMs) return null
  try {
    const catalog = await buildCatalog(root)
    session.append('project/catalog', catalog)
    lastCatalogAt = Date.now()
    return catalog
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 详情页路由

/** 插件详情页读台账的路由路径。 */
const LEDGER_ROUTE = '/project-anchor/ledger'

/** 面板「一键挂接」的写路由（POST，仅追加一条归属事实）。 */
const ATTACH_ROUTE = '/project-anchor/attach'

/** 面板「建卡」的写路由（POST，登记新项目：登记表一行 + 项目卡 + 归属）。 */
const REGISTER_ROUTE = '/project-anchor/register'

/** 面板「这几组像新项目」的读路由（GET，只提案不写库）。 */
const SUGGEST_ROUTE = '/project-anchor/suggest'

/** 注入粒度开关（GET 读当前值，POST `{contextMode}` 改；值只在内存里）。 */
const SETTINGS_ROUTE = '/project-anchor/settings'

/**
 * 面板路由要复用工具实现，避免"工具一套逻辑、路由一套逻辑"两处漂移。
 * 在 `registerTools` 里绑定；绑定前调用会拿到 null。
 */
const panelTools = { register: null, suggest: null }

/**
 * 读一个小 JSON 请求体（挂接只传两个字段，不该有体积）。
 * @param {object} req node 请求对象。
 * @param {number} [limit] 字节上限。
 * @returns {Promise<object>} 解析后的对象。
 */
function readJsonBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是 JSON：${error?.message ?? error}`))
      }
    })
    req.on('error', reject)
  })
}

/** 最近一次见到的会话工作区根；路由不带会话，只能记住上一次的正常值。 */
let lastKnownRoot = null

/**
 * 路由注册结果（`project_ping` 会带上它）。
 *
 * 为什么要留这个状态：注册写在一个 `try/catch` 里，失败是静默的——详情页只会显示
 * "取不到数据"，而外部看就是一个 404，跟"没有这条路由"完全同形，排除不了是插件没加载
 * 还是注册抛错。把结果记下来，一次 `project_ping` 就能定位。
 */
let ledgerRouteState = { status: 'pending', error: null, origin: null, at: null }

/**
 * 面板自报：详情页面板每次挂载/取数后回打一条 `?probe=`，只留在内存里。
 *
 * 为什么要这条回执：面板空白的可能有两种——slot 根本没渲染（页面没问这个 key），
 * 或渲染了但客户端报错/取数失败。两者的外部表现完全一样，而详情页没有 devtools 可看。
 * 让组件自己回打一次挂载与取数结果，`project_ping` 里就能区分，不必猜。
 */
const panelProbe = []

/** 记录一次路由注册结果。 */
function setRouteState(status, error = null, origin = null) {
  ledgerRouteState = { status, error, origin, at: new Date().toISOString() }
}

/** `getOrigin()` 在 listen 之前会 throw，这里只做展示用。 */
function safeOrigin(server) {
  try {
    const origin = typeof server.getOrigin === 'function' ? server.getOrigin() : ''
    return typeof origin === 'string' && origin !== '' ? origin : null
  } catch {
    return null
  }
}

/**
 * 只认本机请求：路由只读工作区里的台账，不该被别的网页顺手读走。
 *
 * 判据是 Host 头（浏览器发请求时一定会带），而不是 RemoteAddress——回环连接下
 * 后者可能是 `::1`、`127.0.0.1`，也可能是代理转发的地址，不可靠；而
 * DNS rebinding 恰好会让 Host 变成外部域名，所以 Host 才是这里要卡的那一环。
 * 带 Origin 的（跨站 fetch）还要求 Origin 也是本机。
 *
 * @param {object} req node 请求对象。
 * @returns {boolean} 是否本机请求。
 */
function isLocalRequest(req) {
  const loopback = host => host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  const bare = value => String(value ?? '').trim().toLowerCase().replace(/:\d+$/, '')
  if (!loopback(bare(req?.headers?.host))) return false
  const origin = req?.headers?.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      return loopback(bare(new URL(origin).host))
    } catch {
      return false
    }
  }
  return true
}

/** 回一段 JSON，并禁止任何缓存（台账随写随变）。 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * 注册插件详情页的台账路由（`plugins.bundle.config` 卡片从这里取数）。
 *
 * 为什么终于换成了 webServer 路由：`session.append('project/catalog', …)` 那条
 * 通道写不出 `ignorable: true`，会让会话打不开（见 {@link publishCatalog} 的注释），
 * 所以客户端投影一直是空的。路由是纯读、不碰会话日志，两点都绕开了。
 *
 * `webServer` 只在 web profile 存在，故用可选注入：桌面端没有该服务时静默跳过，
 * 工具与系统提示注入照常工作。
 *
 * @param {object} ctx cordis 上下文。
 * @returns {void}
 */
function registerLedgerRoute(ctx) {
  const handler = async (req, res) => {
    try {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: 'forbidden: 只接受本机请求' })
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const query = new URL(req.url, 'http://localhost').searchParams

      // 面板自报回执：条目只进内存，供 `project_ping` 查看（见 panelProbe 的注释）。
      if (query.has('probe')) {
        panelProbe.push({
          at: new Date().toISOString(),
          event: String(query.get('probe') ?? '').slice(0, 40),
          status: String(query.get('status') ?? '').slice(0, 40),
          nodes: Number(query.get('nodes') ?? 0) || 0,
          detail: String(query.get('detail') ?? '').slice(0, 200),
        })
        if (panelProbe.length > 20) panelProbe.splice(0, panelProbe.length - 20)
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
        return
      }

      const root = cache.root ?? lastKnownRoot
      if (!root) {
        sendJson(res, 409, {
          error: '工作区根未知：先在会话里干一轮活（或调 project_ping），插件才知道工作区在哪',
        })
        return
      }
      const view = await buildLedgerView(root, {
        project: query.get('project'),
        session: query.get('session'),
      })
      sendJson(res, 200, view)
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  /**
   * 面板上的「一键挂接」：把当前会话记到某个项目上。
   *
   * 为什么开这个写口：`project_attach` 是给模型用的工具，而"未锚定时给候选挂接"是
   * 使用者在面板上点的动作——总不能让用户为了挂个项目再回来说一句话。写入的仍是
   * 同一条事实（`_台账\归属.jsonl` 追加一行，`by: 'user'`），不碰任何业务文件。
   *
   * @param {object} req node 请求对象（POST，JSON 体 `{session, project}`）。
   * @param {object} res node 响应对象。
   * @returns {Promise<void>}
   */
  const attachHandler = async (req, res) => {
    try {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: 'forbidden: 只接受本机请求' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const root = cache.root ?? lastKnownRoot
      if (!root) {
        sendJson(res, 409, { error: '工作区根未知：先在会话里干一轮活（或调 project_ping）' })
        return
      }
      const body = await readJsonBody(req)
      const session = typeof body?.session === 'string' ? body.session.trim() : ''
      const project = typeof body?.project === 'string' ? body.project.trim() : ''
      if (session === '' || project === '') {
        sendJson(res, 400, { error: '需要 session 与 project' })
        return
      }
      await refresh(ctx, root)
      const meta = cache.projects.find(item => item.id === project)
      if (!meta) {
        sendJson(res, 400, { error: `登记表里没有 ${project}` })
        return
      }
      // 写盘要带这个会话的沙箱策略：不带时围栏后端用部署回退策略（workspaceRoot 往往是
      // profile 目录而不是本项目），合法写入也会被拒。只有在线会话才有 cwd，所以先查会话。
      const sessions = ctx.get('sessions')
      const liveSession = typeof sessions?.get === 'function' ? sessions.get(session) : undefined
      if (!liveSession) {
        sendJson(res, 409, { error: `找不到在线会话 ${session}：面板挂接只对在线会话生效` })
        return
      }
      const written = await appendAttachment(root, {
        session,
        project,
        by: 'user',
        conf: 'high',
        note: typeof body?.note === 'string' && body.note !== '' ? body.note.slice(0, 200) : '面板上一键挂接',
      }, { session: liveSession })
      if (!written.ok) {
        sendJson(res, 500, { error: `写归属失败：${written.error}` })
        return
      }
      await refresh(ctx, root)
      sendJson(res, 200, { ok: true, session, project, name: meta.name })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  /**
   * 面板上的「这几组像新项目」：返回本会话未归属台账行的分组提案。
   *
   * 只读：不建卡、不写归属，把判据一起返回，让按钮上的动作由人按下。
   * @param {object} req node 请求对象（GET，`?session=<id>`）。
   * @param {object} res node 响应对象。
   * @returns {Promise<void>}
   */
  const suggestHandler = async (req, res) => {
    try {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: 'forbidden: 只接受本机请求' })
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const root = cache.root ?? lastKnownRoot
      if (!root) {
        sendJson(res, 409, { error: '工作区根未知：先在会话里干一轮活（或调 project_ping）' })
        return
      }
      if (typeof panelTools.suggest !== 'function') {
        sendJson(res, 503, { error: '工具还没注册完，稍后再试' })
        return
      }
      const session = String(new URL(req.url, 'http://localhost').searchParams.get('session') ?? '').trim()
      if (session === '') {
        sendJson(res, 200, { sessionRows: 0, suggestions: [], reason: '没有会话 id，无法判断哪些行属于本次会话。' })
        return
      }
      // 在线会话优先（能带 cwd）；离线时只用一个 id 影子，够读索引就行。
      const sessions = ctx.get('sessions')
      const liveSession = typeof sessions?.get === 'function' ? sessions.get(session) : undefined
      const exec = {
        agent: { session: liveSession ?? { id: session, header: { id: session, cwd: root } } },
      }
      const result = await panelTools.suggest({ minRows: 2 }, exec)
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  /**
   * 面板上的「建卡」：用提案里的名字与依据登记一个新项目。
   *
   * 与 `project_register` 工具同一条路径（`panelTools.register`），区别只是发起者是人。
   * 需要在线会话：登记要往 `_台账` 与项目卡写盘，写盘策略得按这个会话的 cwd 算。
   * @param {object} req node 请求对象（POST，JSON 体 `{session, name, summary, basis, dir?, period?}`）。
   * @param {object} res node 响应对象。
   * @returns {Promise<void>}
   */
  const registerHandler = async (req, res) => {
    try {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: 'forbidden: 只接受本机请求' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const root = cache.root ?? lastKnownRoot
      if (!root) {
        sendJson(res, 409, { error: '工作区根未知：先在会话里干一轮活（或调 project_ping）' })
        return
      }
      if (typeof panelTools.register !== 'function') {
        sendJson(res, 503, { error: '工具还没注册完，稍后再试' })
        return
      }
      const body = await readJsonBody(req)
      const text = key => (typeof body?.[key] === 'string' ? body[key].trim() : '')
      const session = text('session')
      const name = text('name')
      if (session === '' || name === '') {
        sendJson(res, 400, { error: '需要 session 与 name' })
        return
      }
      const sessions = ctx.get('sessions')
      const liveSession = typeof sessions?.get === 'function' ? sessions.get(session) : undefined
      if (!liveSession) {
        sendJson(res, 409, { error: `找不到在线会话 ${session}：面板建卡只对在线会话生效` })
        return
      }
      const args = {
        name,
        summary: text('summary'),
        basis: text('basis'),
        attach: body?.attach !== false,
      }
      for (const key of ['dir', 'period', 'status', 'alias']) {
        if (text(key) !== '') args[key] = text(key)
      }
      const result = await panelTools.register(args, { agent: { session: liveSession } })
      sendJson(res, result?.registered === false ? 400 : 200, result)
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  /**
   * 注入粒度开关：GET 读当前值，POST `{contextMode}` 改（`digest` / `card`）。
   *
   * 为什么给人一个开关：两种粒度各有代价——四行摘要省上下文但会漏掉禁区之外的手写说明，
   * 整张卡信息全但每轮都占几百字。默认摘要，觉得不够的人自己换。
   *
   * 值只存在内存里（`settings.js`）：写工作区在浏览器请求这条路径上没有沙箱授权，
   * 会在 `workspace-write` 下被拒；一个显示偏好不值得为此绕道。
   * @param {object} req node 请求对象。
   * @param {object} res node 响应对象。
   * @returns {Promise<void>}
   */
  const settingsHandler = async (req, res) => {
    try {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: 'forbidden: 只接受本机请求' })
        return
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, { contextMode: getContextMode(), modes: CONTEXT_MODES })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      const mode = typeof body?.contextMode === 'string' ? body.contextMode.trim() : ''
      if (!CONTEXT_MODES.includes(mode)) {
        sendJson(res, 400, { error: `contextMode 只能是 ${CONTEXT_MODES.join(' / ')}` })
        return
      }
      // 注入是同步渲染的：改完立刻生效，下一轮就是新粒度。
      const applied = setContextMode(mode)
      sendJson(res, 200, { ok: true, contextMode: applied, modes: CONTEXT_MODES })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  /**
   * 真正注册一次。成功时返回 dispose（插件卸载时撤掉，HMR 重新加载才能再注册）。
   * @param {object} server webServer 服务。
   * @returns {(() => void)|undefined} 清理函数。
   */
  const attach = server => {
    if (!server || typeof server.register !== 'function') {
      setRouteState('failed', 'webServer 没有 register 方法')
      return undefined
    }
    try {
      const disposers = [
        server.register({ kind: 'exact', path: LEDGER_ROUTE, handler }),
        server.register({ kind: 'exact', path: ATTACH_ROUTE, handler: attachHandler }),
        server.register({ kind: 'exact', path: REGISTER_ROUTE, handler: registerHandler }),
        server.register({ kind: 'exact', path: SUGGEST_ROUTE, handler: suggestHandler }),
        server.register({ kind: 'exact', path: SETTINGS_ROUTE, handler: settingsHandler }),
      ].filter(item => typeof item === 'function')
      setRouteState('registered', null, safeOrigin(server))
      return disposers.length === 0 ? undefined : () => { for (const dispose of disposers) dispose() }
    } catch (error) {
      setRouteState('failed', String(error?.message ?? error), safeOrigin(server))
      return undefined
    }
  }

  // 1) 有的组合里 webServer 在 apply 时已经存在：直接注册，别等注入。
  let immediate
  try {
    immediate = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  } catch {
    immediate = undefined
  }
  if (immediate) {
    const dispose = attach(immediate)
    if (typeof dispose === 'function' && typeof ctx.effect === 'function') {
      ctx.effect(() => dispose)
    }
    return
  }

  // 2) 还没有就等它就绪（桌面端没有 web profile 时永远不会就绪，工具照常工作）。
  if (typeof ctx.inject !== 'function') {
    setRouteState('failed', '没有 ctx.inject，也不是已存在的 webServer')
    return
  }
  try {
    ctx.inject(['webServer'], scope => {
      const dispose = attach(scope?.webServer)
      if (typeof dispose === 'function' && typeof scope.effect === 'function') {
        scope.effect(() => dispose)
      }
    })
  } catch (error) {
    setRouteState('failed', `inject 失败：${String(error?.message ?? error)}`)
  }
}

// ---------------------------------------------------------------- 索引回写

/** 已落盘的 callId；首次使用时从 索引.jsonl 载入，避免重启后重放历史造成重复行。 */
const writtenCallIds = new Set()
let callIdsLoadedFor = null

/**
 * 侧听会话事件，把 `work_note` 的调用落成索引事实。
 *
 * 为什么**不用** `sessionProjections` + `onChanged`：`onChanged` 的契约是
 * "called once per **client-visible** unit whose raw view changed" ——
 * 只有带 `wire` 视图的投影才触发；本插件只需要一个写入副作用、不产生客户端视图，
 * 注册了也永远收不到回调（实测：重启后一条都不落）。而投影的 `apply` 必须是纯函数，
 * 本来就不能做 I/O。所以直接订阅事件才是正确的接缝。
 *
 * 为什么不改 `dsh-work-ledger`：P0 已验证 `work_note` 的参数 schema 是
 * `additionalProperties: false`，加字段要同时改 schema、折叠器与渲染器三处；
 * 项目是**会话级**属性，不必在每个节点上重复。
 *
 * 代价：这样得到的行没有 `files`（产出清单来自台账折叠的证据块），
 * 按文件名检索不到新行，只能靠节点名与摘要。
 */
function registerIndexWriter(ctx) {
  if (typeof ctx.on !== 'function') return
  try {
    ctx.on('session/event', (session, event) => {
      // 详情页路由没有会话可问，只能记住最近一次见到的工作区根
      if (typeof session?.header?.cwd === 'string' && session.header.cwd !== '') lastKnownRoot = session.header.cwd
      // 自动判定：turn/start 记轮次，user/message 判项目。两者都只改内存状态，
      // 真正写归属是异步的，失败不能冒泡成未处理拒绝。
      if (event?.type === 'turn/start') {
        trackTurn(session, event)
        return
      }
      // 人敲的消息是 `user/message`；子会话的提示词与排程投递走 `agent/inbox/spliced`
      // （见 dsh-agent-loop 里 `session.append("agent/inbox/spliced", splice)`），
      // 两条都要判，否则"新开一个子会话"这条路径永远不会有自动归属。
      if (event?.type === 'user/message' || event?.type === 'agent/inbox/spliced') {
        void Promise.resolve(autoMatchMessage(ctx, session, event)).catch(() => {})
        return
      }
      if (event?.type !== 'tool/call') return
      markJoinedMidSession(session)
      // 任何一次工具调用都可能顺带把目录推给界面（内部有 10 分钟节流），
      // 这样「项目锚定」页签在正常干活时就会自动有数据，不必等用户手动触发。
      void Promise.resolve(publishCatalog(session, session?.header?.cwd)).catch(() => {})
      const data = event.data ?? {}
      if (data.name === 'work_note') {
        // 监听器是同步的；异步落盘的失败不能冒泡成未处理拒绝。
        // 串成一条队列：先落盘、再判"像不像新项目"。不串行的话，两条结论几乎同时到，
        // 第二次判定可能数到只写了一条，提示就永远不出现。
        noteQueue = noteQueue
          .then(() => persistNote(session, event))
          .then(() => noteLanded(session))
          .catch(() => {})
        return
      }
      // 写文件也算「我在哪个项目里干活」的证据——不依赖模型记得调 project_attach。
      if (data.name === 'write' || data.name === 'edit') {
        void Promise.resolve(autoAttachByPath(session, event)).catch(() => {})
      }
    })
  } catch {
    // 订阅失败不该影响工具与注入：静默降级为"没有自动回写"
  }
}

// ---------------------------------------------------------------- 首条消息自动判定

/** 每条会话的判定状态上限：会话很多时只留最近的，避免 Map 无限增长。 */
const AUTO_MATCH_SESSIONS = 200

/** 建匹配档案的节流：登记表与索引不会每条消息都变。 */
const PROFILE_CACHE_MS = 60_000

let profileCache = { root: null, at: 0, profiles: [] }

/** work_note 的落盘队列：保证"写一行 → 数一行"的顺序，不并发。 */
let noteQueue = Promise.resolve()

/**
 * 取（或新建）一条会话的判定状态。
 *
 * `turn` 来自 `turn/start`（可能晚于 user/message 到达），`messages` 数真正判过的用户消息。
 * 自动挂接要求 `messages <= 1`：宁可只信"会话第一句"，也不靠 turn 的到达顺序。
 * @param {string} sessionId 会话 id。
 * @returns {{turn: number, analyzedSeq: number, messages: number, hint: object|null, newProject: object|null}} 状态。
 */
function stateOf(sessionId) {
  let state = autoMatchState.get(sessionId)
  if (state === undefined) {
    if (autoMatchState.size >= AUTO_MATCH_SESSIONS) {
      const oldest = autoMatchState.keys().next()
      if (!oldest.done) autoMatchState.delete(oldest.value)
    }
    state = { turn: 0, analyzedSeq: -1, messages: 0, hint: null, newProject: null }
    autoMatchState.set(sessionId, state)
  }
  return state
}

/**
 * 记一轮的开始。
 *
 * 用 `turn/start` 而不是数 user/message：注入的上下文、压缩摘要也走 user/message，
 * 数它们会让"前几轮"的预算提前烧完。
 * @param {object} session 会话对象。
 * @param {object} event `turn/start` 事件。
 * @returns {void}
 */
function trackTurn(session, event) {
  const sessionId = session?.id
  if (typeof sessionId !== 'string' || sessionId === '') return
  const state = stateOf(sessionId)
  const turn = Number(event?.data?.turn)
  state.turn = Number.isFinite(turn) && turn > state.turn ? turn : state.turn + 1
}

/**
 * 见到工具调用时兜一道底：如果这条会话我们一条消息都没判过、轮次也还是 0，
 * 说明插件是在会话进行中才加载的（热重载 / 宿主重启后重连），
 * 此时"turn 从 0 开始"并不代表"这是新会话"——直接把轮次顶过阈值，判定就此收手。
 * @param {object} session 会话对象。
 * @returns {void}
 */
function markJoinedMidSession(session) {
  const sessionId = session?.id
  if (typeof sessionId !== 'string' || sessionId === '') return
  const state = stateOf(sessionId)
  if (state.messages === 0 && state.turn === 0) state.turn = runtimeConfig.autoMatchTurns + 1
}

/**
 * 取一条会话写下、但还没有归属的台账行。
 *
 * 口径与 `project_suggest` 一致（`row.project ?? attachments.get(row.session)`），
 * 差别是这里不分组：用来回答"这条会话到底干了什么、像不像某个项目"。
 * @param {string} root 工作区根。
 * @param {string} sessionId 会话 id。
 * @returns {Promise<object[]>} 未归属行（按索引顺序）。
 */
async function unattributedRows(root, sessionId) {
  const rows = await loadIndexRows(root)
  const attachments = cache.attachments
  const short = shortIdOf(sessionId)
  const mine = []
  for (const row of rows) {
    if (row?.type !== 'note') continue
    const project = row.project ?? attachments.get(row.session) ?? null
    if (project !== null) continue
    if (row.session === sessionId || (short !== '' && String(row.session ?? '').includes(short))) mine.push(row)
  }
  return mine
}

/**
 * 一条台账结论落盘后：看这个会话是不是"干了活、但哪个项目都不像"。
 *
 * 触发点放在 `work_note` 而不是等下一句用户消息：真实场景里模型记完两条结论就接着干，
 * 未必再"说一句人话"；等消息会让提示永远等不到（子会话就只有一个提示词）。
 * 条件：未锚定 + 轮次仍在开头几轮 + 至少判过 1 条真人消息 + ≥2 条未归属结论。
 * @param {object} session 会话对象。
 * @returns {Promise<void>} 完成。
 */
async function noteLanded(session) {
  if (runtimeConfig.autoMatch !== true) return
  const root = session?.header?.cwd
  const sessionId = session?.id
  if (typeof root !== 'string' || root === '' || typeof sessionId !== 'string' || sessionId === '') return
  const state = stateOf(sessionId)
  if (state.newProject !== null) return
  if (state.turn > runtimeConfig.autoMatchTurns) return
  if (state.messages < 1) return
  const attachments = await loadAttachments(root)
  if (attachments.get(sessionId)) return
  const rows = await unattributedRows(root, sessionId)
  if (rows.length < 2) return
  const profiles = await buildProfiles(root)
  // 判定依据必须是"干出来的活像谁"，不是"开场白像谁"：把本会话已写结论的
  // 节点标题＋摘要拼成工作文本，重新排一次。开场白里的客套词很容易蹭到某个
  // 项目的常用词（≥0.35 的提示档），而两条结论的标题比它更能说明这是什么线。
  const work = rows
    .map(row => `${row.node ?? ''} ${row.summary ?? ''}`.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 4000)
  const ranked = work === '' ? [] : rankProjects(work, profiles)
  const decision = decideMatch(ranked, { length: work.length })
  // 只有"点名级"的证据（编号/全名/别名/目录）才够格说"这活属于已有项目"。
  // 词汇级重合（0.35~0.85）在这类干活的文本上太容易发生——两条结论里碰上一个
  // 项目的常用词就够了——那不足以压住"这像新线"这个更重要的提醒；真属于旧项目
  // 也还有提示里的第二条出路（project_attach）。
  if (decision.action === 'attach') {
    state.hint = {
      project: decision.project,
      candidates: Array.isArray(decision.candidates) ? decision.candidates : ranked.slice(0, 3),
      why: `已写下的结论像它：${decision.why}`,
      turn: state.turn,
    }
    return
  }
  state.hint = null
  state.newProject = { rows: rows.length, at: state.turn, projects: profiles.length, shown: false }
}

/**
 * 新会话开头几轮：判断"这句话在说哪个已有项目"。
 *
 * 四档结果：
 * - 高置信度（具体证据 + 明显领先）且还在第 0/1 轮 → 直接写归属（`by: 'auto-match'`）；
 * - 有点像但拿不准 → 只在上下文里留一句提示，让模型第一轮问一句；
 * - 都不像、但本会话已经干出 ≥2 条未归属结论 → 提示"这像是一条新线，要不要建卡"；
 * - 都不像、也还没干出东西 → 什么都不说。
 *
 * 为什么限制在开头几轮：会话进行到一半时，模型已经能自己调 `project_attach`，
 * 而且那时候的消息常常在讲别的项目（对比、引用），自动挂错的风险更高。
 * @param {object} ctx cordis 上下文。
 * @param {object} session 会话对象。
 * @param {object} event `user/message` 或 `agent/inbox/spliced` 事件。
 * @returns {Promise<void>} 完成。
 */
async function autoMatchMessage(ctx, session, event) {
  if (runtimeConfig.autoMatch !== true) return
  const root = session?.header?.cwd
  const sessionId = session?.id
  if (typeof root !== 'string' || root === '' || typeof sessionId !== 'string' || sessionId === '') return

  const state = stateOf(sessionId)
  // 事件可能被重放（重启后重读日志）：按 seq 去重，同一条只判一次。
  const seq = Number(event?.seq)
  if (Number.isFinite(seq)) {
    if (seq <= state.analyzedSeq) return
    state.analyzedSeq = seq
  }
  if (state.turn > runtimeConfig.autoMatchTurns) return

  const data = event?.data ?? {}
  // 压缩/注入走的是 replace 类改写；只有 append 语义的消息才是人敲进来的。
  // 这个字段在事件上（`isReplacementSurfaceEvent` 读 `event.surfaceOp`），
  // 个别路径挂在 data 上 —— 两处都看，宁严勿松。
  // `agent/inbox/spliced` 本身没有 surfaceOp 概念（它就是把消息塞进队列），跳过这项检查。
  const inbox = event?.type === 'agent/inbox/spliced'
  const surfaceOp = typeof event?.surfaceOp === 'string'
    ? event.surfaceOp
    : (typeof data.surfaceOp === 'string' ? data.surfaceOp : '')
  if (!inbox && surfaceOp !== '' && surfaceOp !== 'append') return
  // 只判"真的有人发话"：宿主的运行时上下文快照（source.kind='runtime-context'，
  // 里面就含本插件注入的那段提示）、技能目录、时间提示、子会话结束通知
  // （'subagent-settled'/'agent-instructions'）也都走这两个事件，
  // 不挡掉的话判定器会反复分析自己注入的文本，越滚越偏。
  if (inbox) {
    const inserted = Array.isArray(data?.inserted) ? data.inserted : []
    if (!inserted.some(message => message?.source?.kind === 'user')) return
  } else if (data?.source?.kind !== 'user') {
    return
  }
  const text = inbox ? inboxText(data) : messageText(data)
  if (text.length < 6) return

  const attachments = await loadAttachments(root)
  if (attachments.get(sessionId)) {
    // 已经锚定：提示清掉，判定停止（归属是事实，不再推翻）
    state.hint = null
    return
  }

  state.messages += 1

  const profiles = await buildProfiles(root)
  if (profiles.length === 0) return
  // 提示里要带候选项目的卡摘要，而卡只在 refresh 时预读进缓存；
  // 新会话第一次进来缓存还是空的，等注入那一刻再刷就晚了一轮，所以这里先刷。
  if (cache.root !== root) await refresh(ctx, root)
  const ranked = rankProjects(text, profiles)
  const decision = decideMatch(ranked, { length: text.length })

  // 只替"会话第一句"写归属：从第二句起，模型自己就能调 project_attach，
  // 而那时候的话常在对比/引用别的项目，挂错要往归属里写错一行，代价不对等。
  if (decision.action === 'attach' && state.messages <= 1 && state.turn <= 1) {
    const result = await appendAttachment(root, {
      session: sessionId,
      project: decision.project.id,
      by: 'auto-match',
      conf: 'high',
      note: `首条消息判定：${decision.why}`.slice(0, 200),
    }, { session })
    if (result.ok) {
      state.hint = null
      await refresh(ctx, root)
      await publishCatalog(session, root)
      return
    }
  }

  if (decision.action === 'attach' || decision.action === 'hint') {
    state.hint = {
      project: decision.project,
      candidates: Array.isArray(decision.candidates) ? decision.candidates : ranked.slice(0, 3),
      why: decision.why,
      turn: state.turn,
    }
    return
  }
  state.hint = null

  // 第四档：哪个已有项目都不像，但本会话确实干出了活（≥2 条未归属结论）。
  // 这时最可能的两种情况——"这是一条新线"或"模型自己该挂但没挂"——
  // 都值得让模型看见一句话；只提一次，免得每轮提醒。
  if (state.newProject === null && state.messages >= 2) {
    const rows = await unattributedRows(root, sessionId)
    if (rows.length >= 2) state.newProject = { rows: rows.length, at: state.turn, projects: profiles.length, shown: false }
  }
}

/**
 * 把 `agent/inbox/spliced` 里塞进来的消息拼成待判文本。
 *
 * 该事件的 `data.inserted` 是一个消息数组（`dsh-api-session-controller` 里的
 * `event.data.inserted` 就是按数组消费的），每条消息各自带 content 块；
 * 拼起来是为了让"一次投递多条"的路径也能被当成一句话判断。
 * @param {object} data `agent/inbox/spliced` 的 data。
 * @returns {string} 待判文本（可能是空串）。
 */
function inboxText(data) {
  const inserted = Array.isArray(data?.inserted) ? data.inserted : []
  const parts = []
  for (const message of inserted) {
    if (message?.source?.kind !== 'user') continue
    const text = messageText(message)
    if (text !== '') parts.push(text)
  }
  if (parts.length === 0) return ''
  return parts.join('\n').slice(0, 4000)
}

/**
 * 建/取所有项目的匹配档案（名称、别名、目录 + 最近节点标题与摘要）。
 * @param {string} root 工作区根。
 * @returns {Promise<object[]>} 档案列表。
 */
async function buildProfiles(root) {
  const now = Date.now()
  if (profileCache.root === root && now - profileCache.at < PROFILE_CACHE_MS) return profileCache.profiles

  const [projects, rows] = await Promise.all([loadProjects(root), loadIndexRows(root)])
  const attachments = await loadAttachments(root)
  const buckets = new Map()
  for (const row of rows) {
    const projectId = row.project ?? (typeof row.session === 'string' ? attachments.get(row.session) : undefined)
    if (typeof projectId !== 'string' || projectId === '') continue
    const bucket = buckets.get(projectId) ?? { titles: [], summaries: [] }
    if (typeof row.node === 'string' && row.node !== '') bucket.titles.push(row.node)
    if (typeof row.summary === 'string' && row.summary !== '') bucket.summaries.push(row.summary)
    buckets.set(projectId, bucket)
  }

  const profiles = []
  for (const project of projects) {
    if (typeof project?.id !== 'string' || typeof project?.name !== 'string') continue
    const bucket = buckets.get(project.id) ?? { titles: [], summaries: [] }
    // 只取最近若干条：越近的节点越能代表项目当前在干什么。
    profiles.push(buildProfile(project, bucket.titles.slice(-12), bucket.summaries.slice(-6)))
  }
  profileCache = { root, at: now, profiles }
  return profiles
}

/** 项目表缓存（避免每次写文件都读一遍登记表）。 */
let projectsCache = { root: null, at: 0, projects: [] }
const PROJECTS_CACHE_MS = 30000

/**
 * 按「产出文件落在哪个项目目录」自动归属。
 *
 * 为什么需要它：登记表写的判据优先级是「产出文件落在哪个项目目录」（high）＞主题判断（medium），
 * 但此前只有模型主动调 `project_attach` 才会落归属；模型忘了，会话就永远挂着"未锚定"。
 * 这里把那条判据做成兜底：写入路径落进某个已登记项目目录时，自动追加一条 medium 归属。
 *
 * 只在会话**还没有任何归属**时生效——已经手动挂过的，绝不覆盖。
 *
 * @param {object} session 会话对象（需要 id 与 header.cwd）。
 * @param {object} event `tool/call` 事件。
 * @returns {Promise<void>} 完成。
 */
async function autoAttachByPath(session, event) {
  const root = session?.header?.cwd
  const sessionId = session?.id
  if (!root || !sessionId) return
  let args
  try {
    args = JSON.parse(typeof event?.data?.arguments === 'string' ? event.data.arguments : '{}')
  } catch {
    return
  }
  const filePath = typeof args?.file_path === 'string' ? args.file_path : ''
  if (filePath === '') return

  const relative = filePath.replace(/\\/g, '/')
  const rootPrefix = `${String(root).replace(/\\/g, '/').replace(/\/$/, '')}/`
  if (!relative.toLowerCase().startsWith(rootPrefix.toLowerCase())) return
  const top = relative.slice(rootPrefix.length).split('/')[0]
  if (top === '' || top === undefined) return

  const projects = await loadProjectsCached(root)
  const project = projects.find(item => item.dir === top || item.name === top)
  if (project === undefined) return

  const attachments = await loadAttachments(root)
  const current = attachments.get(sessionId)
  // 已经有归属（无论挂到哪个项目）就不动：自动推断只做兜底，不跟人抢。
  if (current !== undefined && current !== null) return

  const result = await appendAttachment(root, {
    session: sessionId,
    project: project.id,
    conf: 'medium',
    by: 'auto',
    note: `产出文件落在 ${top}`,
  }, { session })
  if (result.ok) await publishCatalog(session, root)
}

/**
 * 带缓存的 `loadProjects`。
 * @param {string} root 工作区根。
 * @returns {Promise<object[]>} 项目列表。
 */
async function loadProjectsCached(root) {
  const now = Date.now()
  if (projectsCache.root === root && now - projectsCache.at < PROJECTS_CACHE_MS) return projectsCache.projects
  const projects = await loadProjects(root)
  projectsCache = { root, at: now, projects }
  return projects
}

async function persistNote(session, event) {
  const root = session?.header?.cwd
  if (!root) return
  const data = event.data ?? {}
  const callId = typeof data.callId === 'string' ? data.callId : ''

  if (callIdsLoadedFor !== root) {
    for (const id of await loadCallIds(root)) writtenCallIds.add(id)
    callIdsLoadedFor = root
  }
  if (callId === '' || writtenCallIds.has(callId)) return

  let args
  try {
    args = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}')
  } catch {
    return
  }
  const row = extractNoteRow(args, event)
  if (row === null) return

  const sessionId = session?.id ?? null
  const attachments = await loadAttachments(root)
  const project = sessionId ? attachments.get(sessionId) ?? null : null

  const result = await appendIndexRow(root, {
    v: 1,
    type: 'note',
    session: sessionId,
    project,
    ...row,
    files: [],
    ts_source: 'session_event',
    callId,
    revises: null,
    source: 'work_note',
  }, { session })
  if (!result.ok) console.warn(`[project-anchor] 写索引失败：${result.error}`)
  if (result.ok) writtenCallIds.add(callId)
  await publishCatalog(session, root)
}

/**
 * 从 `work_note` 参数里提炼一条索引事实（纯函数，不碰文件、不碰会话）。
 *
 * 为什么单独抽出来：索引的字段口径属于 **work-note 契约**的一部分，必须能被契约测试
 * 直接断言。之前这段逻辑埋在 `persistNote()` 里（它同时做去重、项目归属、落盘），
 * 结果是 ledger 改字段名时这里只会静默少行、@Test 也无从测起。
 *
 * @param {object} args 已解析的参数。
 * @param {{ time?: number }} event 事件（取时间）。
 * @returns {{ node: string, status: string, summary: string, numbers: string[], ts_session: string }|null}
 *   行字段；`node` 为空时返回 null（与旧行为一致：静默跳过，但调用方知道为什么）。
 */
export function extractNoteRow(args, event) {
  const node = typeof args?.node === 'string' ? args.node.trim() : ''
  if (node === '') return null
  const time = Number.isFinite(event?.time) ? event.time : Date.now()
  const conclusion = typeof args?.conclusion === 'string' ? args.conclusion : ''
  const numbers = Array.isArray(args?.numbers)
    ? args.numbers.map(item => String(item?.value ?? '')).filter(Boolean).slice(0, 8)
    : []
  return {
    node,
    status: typeof args?.status === 'string' ? args.status : 'unknown',
    summary: conclusion.replace(/\s+/g, ' ').trim().slice(0, 100),
    numbers,
    ts_session: localIso(new Date(time)),
  }
}

// ---------------------------------------------------------------- 内部

/**
 * 解析工作区根目录。
 *
 * 实测：宿主进程的 `process.cwd()` 是 **profile 目录**，`process.env.DSH_PROFILE`
 * 在宿主里也是 null —— 那两个变量只对 agent 的 shell 调用有效。所以 cwd 必须
 * 从会话头里取，与 dsh-work-ledger 的 `resolveCwd()` 同源。
 */
function resolveRoot(args, exec) {
  if (typeof args?.root === 'string' && args.root !== '') return args.root
  const session = exec?.agent?.session
  for (const candidate of [session?.header?.cwd, session?.cwd, session?.meta?.cwd, exec?.cwd]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return cache.root ?? null
}

function sessionIdOf(exec) {
  const session = exec?.agent?.session
  for (const candidate of [session?.id, session?.header?.id]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return null
}

async function ensureFresh(ctx, root) {
  if (cache.root === root && Date.now() - cache.refreshedAt < 5000) return
  await refresh(ctx, root)
}

/** 进行中的刷新；并发调用共用同一个 promise，避免后来的调用读到空缓存。 */
let pendingRefresh = null

async function refresh(ctx, root) {
  if (!root) return
  if (pendingRefresh) return pendingRefresh
  pendingRefresh = (async () => {
    try {
      const [projects, attachments] = await Promise.all([
        loadProjects(root),
        loadAttachments(root),
      ])
      const stats = await indexStats(root, attachments)
      cache.projects = projects
      cache.attachments = attachments
      cache.stats = stats
      cache.root = root
      cache.refreshedAt = Date.now()
      lastKnownRoot = root

      // 项目卡预读：注入是同步的，所有卡必须在渲染前就在缓存里。
      const cards = new Map()
      await Promise.all(projects.map(async project => {
        const card = await loadCard(root, project)
        if (card) cards.set(project.id, card)
      }))
      cache.cards = cards
    } catch {
      // 读失败保持旧缓存：注入退化为上一版，不影响干活
    } finally {
      pendingRefresh = null
    }
  })()
  return pendingRefresh
}
