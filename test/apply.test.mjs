/**
 * 插件级测试：用假 ctx 走一遍 apply()，验证「首条消息 → 自动挂接 / 只提示 / 注入粒度」整条链路。
 *
 * 与 test/plugin.test.mjs 同一套假宿主（ctx.fs + sandboxPolicy + webServer + systemPrompt），
 * 这里盯的是 P5 新功能：
 * 1. 点名首条消息 → `_台账\归属.jsonl` 追加 by:'auto-match' 的行，注入切到项目摘要；
 * 2. 只提主题词 → 不写归属，注入里出现"可能相关的项目"提示；
 * 3. 无关句 → 既不写归属也不提示；
 * 4. 设置路由把 contextMode 切成 card 后，注入带上项目卡全文。
 *
 * 为什么非要走 apply()：判定器单测（test/match.test.mjs）只测打分，
 * 而"事件顺序 / 注入时机 / 路由注册"这些问题只在装配层才暴露
 * （本文件就是在装配层抓到 `describeProjectLine(hint)` 传错对象、
 * `buildHydration` 认不出「口径」章节名两个真 bug 的）。
 *
 * 用法：node test/apply.test.mjs
 */
import assert from 'node:assert'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply } from '../src/index.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-auto-match-'))
mkdirSync(join(root, '_台账'), { recursive: true })
mkdirSync(join(root, '存货核对半年报', '00-说明'), { recursive: true })
writeFileSync(join(root, '存货核对半年报', '00-说明', '项目卡.md'), [
  '---',
  'name: 存货核对-2026半年报',
  'period: 2023末–2026H1',
  '---',
  '',
  '## 期间',
  '2023末–2026H1',
  '',
  '## 口径（已定，勿改）',
  '跌价准备按期末数计提。',
  '',
  '## 禁区',
  '不改历史申报数。',
  '',
  '## 续开点',
  '等用户确认重算结果。',
].join('\n'), 'utf8')
appendFileSync(join(root, '_台账', '项目登记表.md'), [
  '# 项目登记表',
  '',
  '| 编号 | 名称 | 目录 | 期间 | 状态 | 别名 | 一句话 |',
  '|---|---|---|---|---|---|---|',
  '| P2026-01 | 存货核对-2026半年报 | `存货核对半年报` | 2023末–2026H1 | active | 存货那个 | 数据线：采购量价 / 存货减值 |',
  '| P2026-02 | 答复清单-2026半年报 | `答复清单` | 2023–2026H1 | active | — | 首轮答复第 3 题 |',
].join('\n'), 'utf8')
appendFileSync(join(root, '_台账', '索引.jsonl'), [
  JSON.stringify({ v: 1, type: 'index', session: 'session-old-1', project: 'P2026-01', node: '存货减值复核与结转口径确认', conclusion: '跌价准备按期末数计提，成本结转用加权平均。', ts: '2026-11-01T10:00:00+08:00' }),
  JSON.stringify({ v: 1, type: 'index', session: 'session-old-2', project: 'P2026-02', node: '首轮答复第 3 题口径', conclusion: '答复清单里的数据一致性要先对。', ts: '2026-11-02T10:00:00+08:00' }),
].join('\n') + '\n', 'utf8')

// ---------------------------------------------------------------- 假宿主
const fsService = {
  async resolve(path, options = {}) {
    const absolute = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') ? path : join(options.cwd ?? process.cwd(), path)
    return { targetKey: absolute, displayPath: absolute }
  },
  async stat(target) {
    try {
      const info = statSync(target.targetKey)
      return { type: info.isFile() ? 'file' : 'directory', size: info.size, version: `${info.mtimeMs}:${info.size}` }
    } catch {
      return undefined
    }
  },
  async readText(target) {
    return readFileSync(target.targetKey, 'utf8')
  },
  async writeText(target, content, expected) {
    const present = existsSync(target.targetKey)
    if (expected?.kind === 'createIfAbsent' && present) {
      const error = new Error(`文件已存在：${target.targetKey}`)
      error.code = 'FS_ALREADY_EXISTS'
      throw error
    }
    if (expected?.kind === 'replaceIfVersion' && present) {
      const info = statSync(target.targetKey)
      if (`${info.mtimeMs}:${info.size}` !== expected.version) {
        const error = new Error(`版本已变化：${target.targetKey}`)
        error.code = 'FS_STALE_VERSION'
        throw error
      }
    }
    mkdirSync(dirname(target.targetKey), { recursive: true })
    writeFileSync(target.targetKey, content, 'utf8')
    return { operation: present ? 'update' : 'create' }
  },
}
const sandboxPolicy = { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) }
const listeners = []
const contexts = []
const routes = new Map()
const webServer = {
  register({ path, handler }) {
    routes.set(path, handler)
    return () => routes.delete(path)
  },
  getOrigin() {
    return 'http://127.0.0.1:1'
  },
}
const toolsByName = []
const ctx = {
  tools: { register(tool) { toolsByName.push(tool) } },
  get(name) {
    if (name === 'fs') return fsService
    if (name === 'sandboxPolicy') return sandboxPolicy
    if (name === 'webServer') return webServer
    if (name === 'systemPrompt') return { context(registration) { contexts.push(registration) } }
    return undefined
  },
  on(name, handler) {
    if (name === 'session/event') listeners.push(handler)
  },
}

apply(ctx)
assert.equal(listeners.length, 1, '应只订阅一次 session/event')
assert.ok(contexts.length === 1, '应注册一次 systemPrompt.context')

/** 取注入文本（模拟宿主在每轮请求前调用）。 */
const injected = sessionId => {
  const text = contexts[0].text
  return typeof text === 'function' ? text({ agent: { session: { id: sessionId, header: { cwd: root } } } }) : ''
}

const emit = (sessionId, type, data) => {
  const session = { id: sessionId, header: { cwd: root } }
  // 真实的用户消息都带 source.kind='user'；注入快照是 'runtime-context'。
  // 判定器只认真人发言，所以这里默认补上（场景 3.7 专门测不补的情形）。
  const payload = type === 'user/message' && data.source === undefined
    ? { ...data, source: { kind: 'user' } }
    : data
  for (const listener of listeners) listener(session, { type, seq: payload.seq, data: payload })
}
const settle = () => new Promise(resolve => setTimeout(resolve, 60))
const attachRows = () => {
  const path = join(root, '_台账', '归属.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

// ---------------------------------------------------------------- 场景 1：点名 → 自动挂接
const first = 'session-auto-1'
emit(first, 'turn/start', { turn: 1, seq: 1 })
emit(first, 'user/message', { seq: 2, content: [{ type: 'text', text: '接着做存货核对，把跌价准备的计提比例按期末数重算一遍' }] })
await settle()
const rows1 = attachRows()
assert.equal(rows1.length, 1, '点名首条消息应写一行归属')
assert.equal(rows1[0].project, 'P2026-01')
assert.equal(rows1[0].by, 'auto-match')
assert.equal(rows1[0].conf, 'high')
assert.ok(rows1[0].note.startsWith('首条消息判定：'), `归属备注应带判定依据：${rows1[0].note}`)
const injected1 = injected(first)
assert.ok(injected1.includes('存货核对-2026半年报'), `锚定后注入应带项目名：\n${injected1}`)
assert.ok(injected1.includes('跌价准备按期末数计提'), `锚定后注入应带已定口径：\n${injected1}`)
assert.ok(!injected1.includes('项目卡全文'), `默认摘要模式不该带卡全文：\n${injected1}`)
console.log('场景 1 通过：点名 → 自动挂接 + 注入项目摘要')
console.log('  归属行 =', JSON.stringify(rows1[0]))
console.log('  注入 =', injected1.split('\n').slice(0, 3).join(' / '))

// ---------------------------------------------------------------- 场景 2：只提词 → 只提示
const second = 'session-auto-2'
emit(second, 'turn/start', { turn: 1, seq: 11 })
emit(second, 'user/message', { seq: 12, content: [{ type: 'text', text: '这几个合计比例跟减值准备对不上，先核一下再往下走' }] })
await settle()
assert.equal(attachRows().length, 1, '提示档不该再写归属行')
const injected2 = injected(second)
assert.ok(injected2.includes('可能相关的项目'), `提示档注入应带候选：\n${injected2}`)
assert.ok(injected2.includes('P2026-01'), `提示档注入应带编号：\n${injected2}`)
// 未锚定也要带得上手信息：光给项目名，模型没法判断该不该接。
assert.ok(injected2.includes('期间：2023末–2026H1'), `提示档应带期间：\n${injected2}`)
assert.ok(injected2.includes('已定口径：跌价准备按期末数计提。'), `提示档应带已定口径：\n${injected2}`)
assert.ok(injected2.includes('禁入区：不改历史申报数。'), `提示档应带禁入区：\n${injected2}`)
assert.ok(injected2.includes('上次停在哪：等用户确认重算结果。'), `提示档应带续开点：\n${injected2}`)
assert.ok(injected2.includes('本会话还没有锚定'), '提示档应说明尚未锚定')
console.log('场景 2 通过：只提主题词 → 不写归属，只给一句提示')
console.log('  注入 =', injected2.split('\n').slice(0, 2).join(' / '))

// ---------------------------------------------------------------- 场景 3：无关句 → 沉默
const third = 'session-auto-3'
emit(third, 'turn/start', { turn: 1, seq: 21 })
emit(third, 'user/message', { seq: 22, content: [{ type: 'text', text: '今天天气不错，页签颜色改成蓝色吧' }] })
await settle()
assert.equal(attachRows().length, 1, '无关句不该写归属行')
assert.equal(injected(third), '', `无关句不该注入任何内容：\n${injected(third)}`)
console.log('场景 3 通过：无关句 → 既不挂接也不提示')

// ---------------------------------------------------------------- 场景 3.5：第二句才点名 → 只提示不挂接
const fourth = 'session-auto-4'
emit(fourth, 'turn/start', { turn: 1, seq: 31 })
emit(fourth, 'user/message', { seq: 32, content: [{ type: 'text', text: '先随便聊聊，等会儿再说正事，今天先不开始' }] })
await settle()
emit(fourth, 'turn/start', { turn: 2, seq: 33 })
emit(fourth, 'user/message', { seq: 34, content: [{ type: 'text', text: '存货核对那个项目的口径再确认一下' }] })
await settle()
assert.equal(attachRows().length, 1, '第二句点名不该替用户写归属行')
assert.ok(injected(fourth).includes('可能相关的项目'), `第二句点名应只给提示：\n${injected(fourth)}`)
console.log('场景 3.5 通过：第二句才点名 → 只提示，不写归属')

// ---------------------------------------------------------------- 场景 3.6：inbox 投递的首条
// 子会话（subagent）与排程投递不走 user/message，而是 `agent/inbox/spliced`
// （dsh-agent-loop 里 `session.append("agent/inbox/spliced", splice)`）。
// 这条路径漏判的话，"新开一个子会话干活"永远不会有自动归属。
const fifth = 'session-auto-5'
emit(fifth, 'turn/start', { turn: 1, seq: 41 })
emit(fifth, 'agent/inbox/spliced', {
  seq: 42,
  inserted: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '接着答复清单那条线，首轮答复第 3 题再对一遍' }] }],
})
await settle()
const inboxRow = attachRows().find(row => row.session === fifth)
assert.ok(inboxRow, `inbox 投递的首条也应写一行归属：${JSON.stringify(attachRows())}`)
assert.equal(inboxRow.project, 'P2026-02')
assert.equal(inboxRow.by, 'auto-match')
assert.ok(injected(fifth).includes('答复清单-2026半年报'), `inbox 挂接后注入应带项目名：\n${injected(fifth)}`)
console.log('场景 3.6 通过：agent/inbox/spliced 首条 → 同样自动挂接')

// ---------------------------------------------------------------- 场景 3.7：注入快照不该被当成用户发言
// 宿主的运行时上下文快照（source.kind='runtime-context'）里含本插件上一轮注入的提示，
// 若把它当用户输入再判一次，就会"分析自己写的提示"→ 越滚越偏（实测踩过）。
const sixth = 'session-auto-6'
emit(sixth, 'turn/start', { turn: 1, seq: 51 })
emit(sixth, 'user/message', {
  seq: 52,
  source: { kind: 'runtime-context', form: 'snapshot' },
  content: [{ type: 'text', text: '可能相关的项目：存货核对-2026半年报（P2026-01）判定依据：提到了项目编号 P2026-01' }],
})
await settle()
assert.equal(attachRows().filter(row => row.session === sixth).length, 0, '注入快照不该写归属')
assert.equal(injected(sixth), '', `注入快照不该触发提示：\n${injected(sixth)}`)
console.log('场景 3.7 通过：运行时上下文快照不被当成用户发言')

// ---------------------------------------------------------------- 场景 3.8：插件在会话中途才加载
// 热重载后内存状态清空，若把一个已经在干活的会话当成"第一句"，
// 下一句话就可能被写错归属。见到工具调用却一条消息都没判过 ⇒ 不是新会话。
const seventh = 'session-auto-7'
emit(seventh, 'tool/call', { seq: 61, name: 'read', callId: 'call-1', arguments: {} })
emit(seventh, 'user/message', { seq: 62, content: [{ type: 'text', text: '存货核对那个项目接着往下做' }] })
await settle()
assert.equal(attachRows().filter(row => row.session === seventh).length, 0, '中途加载的会话不该写归属')
assert.equal(injected(seventh), '', `中途加载的会话不该提示：\n${injected(seventh)}`)
console.log('场景 3.8 通过：插件在会话中途加载时不误判')

// ---------------------------------------------------------------- 场景 6：干了活但都不像 → 提醒建新项目
// 用户 m01967 的追问直接暴露的缺口：老会话在"哪个项目都不像"时彻底沉默，
// 于是模型既不知道"该挂一个"，也不知道"该建一个"。这里补第四档提示。
const eighth = 'session-new-1'
appendFileSync(join(root, '_台账', '索引.jsonl'), [
  JSON.stringify({ v: 1, type: 'note', session: eighth, project: null, node: '猫咪投喂排班', conclusion: '早晚各喂一次，水每天换。', ts: '2026-11-15T09:00:00+08:00' }),
  JSON.stringify({ v: 1, type: 'note', session: eighth, project: null, node: '猫咪疫苗提醒', conclusion: '下月打第二针。', ts: '2026-11-15T09:05:00+08:00' }),
].join('\n') + '\n', 'utf8')
emit(eighth, 'turn/start', { turn: 1, seq: 71 })
emit(eighth, 'user/message', { seq: 72, content: [{ type: 'text', text: '帮我管一下家里的猫，早晚各喂一次' }] })
await settle()
assert.equal(injected(eighth), '', `第一句还不够（只判过 1 条消息），不该提建新项目：\n${injected(eighth)}`)
emit(eighth, 'turn/start', { turn: 2, seq: 73 })
emit(eighth, 'user/message', { seq: 74, content: [{ type: 'text', text: '疫苗下月再打第二针，先记着' }] })
await settle()
const newHint = injected(eighth)
assert.ok(newHint.includes('本会话还没有项目归属'), `两轮都不像、且有 2 条未归属结论时应提示建新项目：\n${newHint}`)
assert.ok(newHint.includes('project_register'), `提示应告诉模型用 project_register 建卡：\n${newHint}`)
assert.ok(newHint.includes('2 条结论还没归属'), `提示应带上未归属行数：\n${newHint}`)
assert.equal(attachRows().filter(row => row.session === eighth).length, 0, '提示档不该替用户写归属')
assert.equal(injected(eighth), '', '这段提示只应出现一次')
console.log('场景 6 通过：都不像且已产出结论 → 提醒建新项目，且只提一次')

// ---------------------------------------------------------------- 场景 6.5：只发一句话，靠 work_note 触发
// 真实模型记完两条结论常常不再发"人话"，等第二句用户消息会等不到提示。
const ninth = 'session-new-2'
emit(ninth, 'turn/start', { turn: 1, seq: 81 })
emit(ninth, 'user/message', { seq: 82, content: [{ type: 'text', text: '帮我记两件家里的事，别读文件' }] })
await settle()
assert.equal(injected(ninth), '', '还没写下结论时不该提建新项目')
const note = (callId, node) => emit(ninth, 'tool/call', {
  seq: 83,
  callId,
  name: 'work_note',
  arguments: JSON.stringify({ node, conclusion: '一句话结论', numbers: [], files: [] }),
})
note('call-np-1', '阳台浇花排班')
note('call-np-2', '快递收货时间')
await settle()
const noteHint = injected(ninth)
assert.ok(noteHint.includes('本会话还没有项目归属'), `work_note 落盘后应提示建新项目：\n${noteHint}`)
assert.equal(attachRows().filter(row => row.session === ninth).length, 0, 'work_note 触发的提示也不该写归属')
console.log('场景 6.5 通过：只有一句话 + 两条 work_note → 也提示建新项目')

// ---------------------------------------------------------------- 场景 4：切 card 粒度
const settingsHandler = routes.get('/project-anchor/settings')
assert.ok(typeof settingsHandler === 'function', '应注册设置路由')
const request = (method, body) => {
  const payload = typeof body === 'string' ? body : ''
  const request_ = {
    method,
    url: '/project-anchor/settings',
    headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:1', 'content-length': String(Buffer.byteLength(payload)) },
    on(event, handler) {
      if (event === 'data' && payload !== '') handler(Buffer.from(payload, 'utf8'))
      if (event === 'end') handler()
      return request_
    },
  }
  let status = 0
  let text = ''
  const response = {
    writeHead(code) { status = code; return response },
    end(chunk) { text = String(chunk ?? ''); return response },
    setHeader() { return response },
  }
  return Promise.resolve(settingsHandler(request_, response, body)).then(() => ({ status, payload: text }))
}
const getResult = await request('GET')
assert.equal(getResult.status, 200, `GET 设置应 200：${getResult.payload}`)
const before = JSON.parse(getResult.payload)
assert.equal(before.contextMode, 'digest')
assert.deepEqual(before.modes, ['digest', 'card'])
const postResult = await request('POST', JSON.stringify({ contextMode: 'card' }))
assert.equal(postResult.status, 200, `POST 设置应 200：${postResult.payload}`)
assert.equal(JSON.parse(postResult.payload).contextMode, 'card')
// 设置只在内存里：不该在工作区留下任何文件（浏览器请求那条路径没有沙箱授权）。
assert.equal(existsSync(join(root, '_台账', '项目锚定-设置.json')), false, '设置不该落盘')
const getAgain = await request('GET')
assert.equal(JSON.parse(getAgain.payload).contextMode, 'card', 'GET 应读到刚改的内存值')
const injected1Card = injected(first)
assert.ok(injected1Card.includes('项目卡全文'), `card 模式注入应带卡全文：\n${injected1Card}`)
assert.ok(injected1Card.includes('## 续开点') || injected1Card.includes('续开点'), 'card 模式应带上卡里的续开点')
console.log('场景 4 通过：设置路由切 card → 注入带项目卡全文')
console.log('  注入长度 =', injected1Card.length, '字')

// ---------------------------------------------------------------- 场景 5：登记带目录的项目
const registerToolEntry = toolsByName.find(item => item.name === 'project_register')
assert.ok(registerToolEntry, `应注册 project_register 工具，实得 ${toolsByName.map(item => item.name).join('/')}`)
mkdirSync(join(root, '新项目目录'), { recursive: true })
const registerExec = { agent: { session: { id: 'session-reg-1', header: { cwd: root } } } }
const registered = await registerToolEntry.execute(
  { name: '临时项目', summary: '验证登记带目录', basis: '测试用：本行只验证目录校验', dir: '新项目目录', period: '2026-11' },
  registerExec,
)
assert.equal(registered.registered, true, `带目录登记应成功：${JSON.stringify(registered)}`)
assert.equal(registered.project.dir, '新项目目录')
assert.ok(existsSync(join(root, '新项目目录', '00-说明', '项目卡.md')), '带目录时卡应落在目录内')
const rejected = await registerToolEntry.execute({ name: '另一个项目', summary: 'x', basis: 'y', dir: '不存在的目录' }, registerExec)
assert.equal(rejected.registered, false, '不存在的目录应被拒')
assert.ok(String(rejected.reason).includes('不存在'), `拒绝原因应说明目录不存在：${JSON.stringify(rejected)}`)
console.log('场景 5 通过：登记带目录（FsInfo.type=directory）→ 建成；不存在的目录被拒')

rmSync(root, { recursive: true, force: true })
console.log('\n全部通过（临时工作区已删除）')