/**
 * 插件级测试：用假 ctx 走一遍 apply()，验证「work_note 事件 → 索引行」的落盘链路没被重构改坏。
 *
 * 重点覆盖：
 * 1. 一行索引的字段对不对（node / summary / numbers / status / callId / source / ts_source）；
 * 2. 同一个 callId 重复投递只写一行（去重）；
 * 3. node 为空的事件不写行，且不抛错。
 *
 * 用法：node test/plugin.test.mjs
 */
import assert from 'node:assert'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { apply } from '../src/index.js'

/**
 * 造一个"真写磁盘"的假宿主：fs 服务按 ctx.fs 契约实现（resolve/stat/readText/writeText），
 * sandboxPolicy 返回 workspace-write。插件现在只经 ctx.fs 读写，所以假 ctx 必须带这两个服务，
 * 否则写会被 fail closed 拒绝（那正是生产行为，不是测试要测的东西）。
 * @param {string} root 工作区根。
 * @returns {object} 假 ctx。
 */
function makeHost(root) {
  const fs = {
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
  return {
    listeners,
    ctx: {
      tools: { register() {} },
      get(name) {
        if (name === 'fs') return fs
        if (name === 'sandboxPolicy') return sandboxPolicy
        return undefined
      },
      on(name, handler) {
        if (name === 'session/event') listeners.push(handler)
      },
    },
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-project-anchor-'))
mkdirSync(join(root, '_台账'), { recursive: true })
// 最小项目登记表：loadProjects 只认 |P2026-01|... 这种行
appendFileSync(join(root, '_台账', '项目登记表.md'), [
  '# 项目登记表',
  '',
  '| 编号 | 名称 | 目录 | 期间 | 状态 | 别名 | 一句话 |',
  '|---|---|---|---|---|---|---|',
  '| P2026-01 | 存货核对-2026半年报 | `存货核对半年报` | 2023末–2026H1 | active | — | 数据线 |',
  '| P2026-03 | 说明书修订 | `说明书修订` | 2026 | active | — | 文档线 |',
].join('\n'), 'utf8')

const host = makeHost(root)
const ctx = host.ctx
const listeners = host.listeners

apply(ctx)
assert.equal(listeners.length, 1, '应订阅一次 session/event')

const session = { id: 'session-plugin-test', header: { cwd: root } }
const emit = (data, time = 1792205525221) => {
  for (const listener of listeners) listener(session, { type: 'tool/call', time, data })
}
const flush = () => new Promise(resolve => setTimeout(resolve, 50))

const indexFile = join(root, '_台账', '索引.jsonl')

try {
  emit({
    callId: 'c1',
    name: 'work_note',
    arguments: JSON.stringify({
      node: '样表算术复核',
      conclusion: '两处合计比例算错：样表列 63.31%，按 1,234.56/1,956.42 应为 63.10%。',
      status: 'active',
      numbers: [
        { name: '样表', value: '63.31%', basis: '表列值' },
        { name: '应为', value: '63.10%', basis: '1,234.56/1,956.42' },
      ],
    }),
  })
  await flush()
  assert.ok(existsSync(indexFile), '应写出 索引.jsonl')
  const rows = readFileSync(indexFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.length, 1, `应写一行，实得 ${rows.length}`)
  const row = rows[0]
  assert.equal(row.type, 'note')
  assert.equal(row.node, '样表算术复核')
  assert.ok(row.summary.startsWith('两处合计比例算错'), `summary 实得：${row.summary}`)
  assert.equal(row.status, 'active')
  assert.deepEqual(row.numbers, ['63.31%', '63.10%'], 'numbers 只取 value（当前格式）')
  assert.equal(row.callId, 'c1')
  assert.equal(row.source, 'work_note')
  assert.equal(row.ts_source, 'session_event')
  assert.equal(row.session, 'session-plugin-test')
  assert.equal(typeof row.ts_session, 'string')

  // 去重：同一个 callId 再来一次不应重复写
  emit({ callId: 'c1', name: 'work_note', arguments: JSON.stringify({ node: '同一调用重投', conclusion: '不该落盘' }) })
  await flush()
  assert.equal(readFileSync(indexFile, 'utf8').trim().split('\n').length, 1, '同一 callId 应去重')

  // node 为空：不写、不抛
  emit({ callId: 'c2', name: 'work_note', arguments: JSON.stringify({ conclusion: '只有结论' }) })
  await flush()
  assert.equal(readFileSync(indexFile, 'utf8').trim().split('\n').length, 1, 'node 为空不应写行')

  // 非 work_note 调用：不写索引行
  emit({ callId: 'c3', name: 'pwsh', arguments: '{"command":"ls"}' })
  await flush()
  assert.equal(readFileSync(indexFile, 'utf8').trim().split('\n').length, 1, '其他工具不应写行')

  console.log('OK：work_note → 索引行 的落盘、去重、空节点与忽略其他工具全部通过')
} finally {
  rmSync(root, { recursive: true, force: true })
}

// —— 自动归属：写进项目目录时自己挂上，不依赖模型记得调 project_attach ——
{
  const autoRoot = mkdtempSync(join(tmpdir(), 'dsh-anchor-auto-'))
  mkdirSync(join(autoRoot, '_台账'), { recursive: true })
  appendFileSync(join(autoRoot, '_台账', '项目登记表.md'), [
    '| 编号 | 名称 | 目录 | 期间 | 状态 | 别名 | 一句话 |',
    '|---|---|---|---|---|---|---|',
    '| P2026-01 | 存货核对-2026半年报 | `存货核对半年报` | 2023末–2026H1 | active | — | 数据线 |',
  ].join('\n'), 'utf8')

  const autoHost = makeHost(autoRoot)
  const autoListeners = autoHost.listeners
  apply(autoHost.ctx)
  const autoEmit = (data, sessionId) => {
    for (const listener of autoListeners) listener({ id: sessionId, header: { cwd: autoRoot } }, { type: 'tool/call', time: Date.now(), data })
  }
  const attachFile = join(autoRoot, '_台账', '归属.jsonl')

  try {
    // 1. 写进项目目录 → 自动挂上 P2026-01
    autoEmit({
      callId: 'w1', name: 'write',
      arguments: JSON.stringify({ file_path: join(autoRoot, '存货核对半年报', '交付件', '底稿.xlsx') }),
    }, 'session-auto-1')
    await flush()
    assert.ok(existsSync(attachFile), '应写出 归属.jsonl')
    const rows = readFileSync(attachFile, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(rows.length, 1, `应只有一条归属，实得 ${rows.length}`)
    assert.equal(rows[0].project, 'P2026-01')
    assert.equal(rows[0].by, 'auto')
    assert.equal(rows[0].conf, 'medium')
    assert.ok(rows[0].note.includes('存货核对半年报'), `说明应写明目录，实得 ${rows[0].note}`)

    // 2. 再写一次同目录：不重复追加
    autoEmit({
      callId: 'w2', name: 'edit',
      arguments: JSON.stringify({ file_path: join(autoRoot, '存货核对半年报', '交付件', '底稿.xlsx') }),
    }, 'session-auto-1')
    await flush()
    assert.equal(readFileSync(attachFile, 'utf8').trim().split('\n').length, 1, '已归属的会话不应重复追加')

    // 3. 写到 _scratch：不归属
    autoEmit({
      callId: 'w3', name: 'write',
      arguments: JSON.stringify({ file_path: join(autoRoot, '_scratch', 'x.py') }),
    }, 'session-auto-2')
    await flush()
    assert.equal(readFileSync(attachFile, 'utf8').trim().split('\n').length, 1, '_scratch 不属于任何项目')

    console.log('OK：写进项目目录自动归属（去重、忽略 _scratch）通过')
  } finally {
    rmSync(autoRoot, { recursive: true, force: true })
  }
}
