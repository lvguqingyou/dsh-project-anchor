/**
 * 视图重建：索引事实 → 可检索 Markdown（全量重建，幂等）。
 *
 * 这是 `tools\render.py` 的等价实现，移进插件是为了让"重建视图"变成一个按钮/一次工具调用，
 * 不再要求用户开终端。两边的输出格式必须一致 —— 改这里时同步改 render.py，或直接停用后者。
 *
 * @module dsh-project-anchor/render
 */

import { join } from 'node:path'

import { loadAttachments, loadIndexRows, writeWorkspaceText } from './store.js'

const LEDGER_DIR = '_台账'
const STATUS_CN = { done: '已完成', active: '进行中', blocked: '受阻', unknown: '未知' }

const HEADER = '| 日期 | 会话 | 节点 | 结论摘要 | 关键数字 | 产出 | 状态 |\n|---|---|---|---|---|---|---|'

function shortId(session) {
  const match = /([0-9a-f]{8})/i.exec(String(session ?? ''))
  return match ? match[1] : String(session ?? '?').slice(0, 8)
}

function cell(text, limit) {
  let value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (limit && value.length > limit) value = value.slice(0, limit)
  return value.replace(/\|/g, '\\|')
}

function basename(path) {
  const parts = String(path ?? '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

function formatRow(row) {
  const date = String(row.ts_session ?? '').slice(0, 10)
  const numbers = (row.numbers ?? []).slice(0, 4).map(item => cell(item)).join(' / ')
  const files = (row.files ?? []).slice(0, 3).map(basename).join('、')
  return `| ${date} | ${shortId(row.session)} | ${cell(row.node)} | ${cell(row.summary, 100)} `
    + `| ${numbers} | ${cell(files)} | ${STATUS_CN[row.status] ?? row.status ?? ''} |`
}

function section(title, rows, withHeading = true) {
  const out = []
  if (withHeading) out.push(`## ${title}（${rows.length} 行）\n`)
  out.push(HEADER)
  for (const row of rows) out.push(formatRow(row))
  out.push('')
  return out.join('\n')
}

/**
 * 全量重建两个视图文件。
 * @param {string} root 工作区根。
 * @param {{session?: object, signal?: AbortSignal}} [options] 发起重建的会话（用于解析沙箱策略）与取消信号。
 * @returns {Promise<{rows: number, projects: string[], free: number, files: string[]}>}
 */
export async function rebuildView(root, options = {}) {
  const [raw, attachments] = await Promise.all([loadIndexRows(root), loadAttachments(root)])
  if (raw.length === 0) throw new Error('索引里没有事实行，按约定不生成视图')

  // 同一 (会话, 节点) 可能被写过多次：保留摘要更长的那条
  const best = new Map()
  for (const row of raw) {
    const resolved = row.project ?? (typeof row.session === 'string' ? attachments.get(row.session) : undefined)
    const enriched = resolved === row.project ? row : { ...row, project: resolved ?? null }
    const key = `${row.session}\u0000${row.node}`
    const prev = best.get(key)
    if (!prev || String(enriched.summary ?? '').length >= String(prev.summary ?? '').length) best.set(key, enriched)
  }
  const rows = [...best.values()].sort((a, b) =>
    String(b.ts_session ?? '').localeCompare(String(a.ts_session ?? '')))

  const byProject = new Map()
  for (const row of rows) {
    const key = row.project ?? null
    if (!byProject.has(key)) byProject.set(key, [])
    byProject.get(key).push(row)
  }
  const projectKeys = [...byProject.keys()].filter(Boolean).sort()
  const freeRows = byProject.get(null) ?? []

  const now = new Date()
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} `
    + `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const sessions = new Set(rows.map(row => shortId(row.session)))

  const parts = [
    '# 索引（成果索引）',
    '',
    `> 由 \`dsh-project-anchor\` 的 \`project_rebuild\` 于 ${stamp} 全量重建，**请勿手工编辑**。`,
    `> 事实源：\`_台账\\索引.jsonl\` · 共 ${rows.length} 行 · ${byProject.size} 组 · ${sessions.size} 个会话`,
    '>',
    '> 检索：直接在本文件里 Ctrl+F 搜业务词或数字（如 `SKU-001`、`1,234.56`）。',
    '> 口径：本索引只记「做了/得出」的结论；被否决的路线、反复过程在对应 `工作台账-*.md` 正文里。',
    '',
  ]
  for (const key of projectKeys) parts.push(section(`项目 ${key}`, byProject.get(key)))
  if (freeRows.length > 0) parts.push(section('自由会话（未挂项目）', freeRows))

  const freeParts = [
    '# 自由会话（未挂项目）',
    '',
    `> 由 \`dsh-project-anchor\` 的 \`project_rebuild\` 于 ${stamp} 全量重建，**请勿手工编辑**。`,
    `> 共 ${freeRows.length} 行。`,
    '',
    section('自由会话', freeRows, false),
  ]

  const allPath = join(root, LEDGER_DIR, '索引.md')
  const freePath = join(root, LEDGER_DIR, '自由会话.md')
  // 写盘统一走宿主 fs（带当前会话沙箱策略）；失败带原因抛出，不退回 node:fs
  for (const [path, content] of [[allPath, parts.join('\n')], [freePath, freeParts.join('\n')]]) {
    const result = await writeWorkspaceText(root, path, content, {
      session: options.session,
      signal: options.signal,
    })
    if (!result.ok) throw new Error(`project_rebuild: 写 ${path} 失败（${result.error}）`)
  }

  return { rows: rows.length, projects: projectKeys, free: freeRows.length, files: [allPath, freePath] }
}
