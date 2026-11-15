/**
 * 契约测试（消费者侧）：project-anchor 从 work_note 提炼「索引行」的口径，
 * 必须与 dsh-work-ledger 的 WORK-NOTE-CONTRACT v1 一致。
 *
 * 这份测试的意义：索引是长期累积的产物，**少写几行没人发现**。
 * 所以把「提炼」抽成纯函数并用共享向量断言——ledger 改字段时，这里当场红，而不是几个月后发现页签空着。
 *
 * 向量文件属于另一个包。找不到就跳过（单独安装/单独检出时正常）。
 *
 * 用法：node test/contract.test.mjs
 */
import assert from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractNoteRow } from '../src/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(here, '..', '..', 'dsh-work-ledger', 'contract-fixtures', 'note-v1.json')

if (!existsSync(fixturePath)) {
  console.log('SKIP：没有找到 work-note 契约向量（独立安装时正常），跳过索引提取的契约测试')
  process.exit(0)
}

const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'))
const collapse = text => String(text ?? '').replace(/\s+/g, ' ').trim()

let checked = 0
for (const sample of fixtures.samples) {
  const row = extractNoteRow(sample.args, { time: 1792205525221 })
  assert.ok(row !== null, `[${sample.name}] 应提炼出一行索引`)
  assert.equal(row.node, sample.expect.node, `[${sample.name}] node 必须取到——它空了就是「静默少行」`)
  assert.ok(
    row.summary.startsWith(sample.expect.conclusionStartsWith),
    `[${sample.name}] summary 应以结论开头，实得：${row.summary.slice(0, 40)}`,
  )
  assert.ok(row.summary.length <= 100, `[${sample.name}] summary 应截断到 100 字`)
  assert.ok(!row.summary.includes('\n'), `[${sample.name}] summary 应压成单行`)
  assert.equal(typeof row.ts_session, 'string', `[${sample.name}] 应有会话时间戳`)
  assert.ok(row.ts_session.length > 0)

  if (typeof sample.expect.numbersCount === 'number') {
    assert.equal(row.numbers.length, sample.expect.numbersCount, `[${sample.name}] numbers 条数`)
  }
  if (typeof sample.expect.numbersCountAtLeast === 'number') {
    assert.ok(
      row.numbers.length >= sample.expect.numbersCountAtLeast,
      `[${sample.name}] numbers 至少 ${sample.expect.numbersCountAtLeast} 条，实得 ${row.numbers.length}`,
    )
  }
  // status 规则：给了就透传，没给记 unknown（索引里要能看出「不知道」）
  const expectedStatus = typeof sample.expect.status === 'string'
    ? sample.expect.status
    : (typeof sample.args.status === 'string' ? sample.args.status : 'unknown')
  assert.equal(row.status, expectedStatus, `[${sample.name}] status`)
  checked += 1
}

// 反向：没有 node 就不该污染索引（旧行为是静默 return，这里把「为什么」说清楚）
assert.equal(extractNoteRow({ conclusion: '只有结论没有节点' }, { time: 1 }), null, 'node 为空时应返回 null')
assert.equal(extractNoteRow(null, { time: 1 }), null, '参数为 null 时不应抛错')
assert.equal(extractNoteRow({ node: '   ' }, { time: 1 }), null, '纯空白节点名也应视为空')

console.log(`OK：work-note 契约 v1，索引提取侧 ${checked} 条样本全部通过（含 node 缺失的反向用例）`)
