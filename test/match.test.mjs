/**
 * 判定器的行为测试：这条消息该挂上、该提示、还是别吭声。
 *
 * 为什么要单独测：这段逻辑会**写归属**（`_台账\归属.jsonl` 追加一行），
 * 挂错了比不挂更糟——会话从此一直带着错的项目上下文，而且它不会自己恢复。
 * 所以这里的用例只覆盖判据本身，不碰文件、不碰会话。
 *
 * 用法：node test/match.test.mjs
 */
import assert from 'node:assert'
import { buildProfile, decideMatch, messageText, rankProjects, scoreProfile } from '../src/match.js'

const projects = [
  {
    id: 'P2026-01',
    name: '存货核对-2026半年报',
    dir: '存货核对半年报',
    alias: '存货那个,存货减值',
    period: '2023末–2026H1',
    status: 'active',
    summary: '存货进销存勾稽与跌价复核',
  },
  {
    id: 'P2026-02',
    name: '答复清单-2026半年报',
    dir: '答复清单',
    alias: '清单,首轮答复',
    period: '2026H1',
    status: 'active',
    summary: '首轮答复的口径与数据核对',
  },
  {
    id: 'P2026-03',
    name: '说明书修订',
    dir: '说明书修订',
    alias: '',
    period: '2026',
    status: 'active',
    summary: '招股说明书的文字与附注修订',
  },
]

const titles = {
  'P2026-01': ['存货减值复核与结转口径确认', '样表合计比例算错'],
  'P2026-02': ['首轮答复第 3 题口径', '答复清单数据一致性核对'],
  'P2026-03': ['说明书附注期初数修订'],
}

const profiles = projects.map(project => buildProfile(project, titles[project.id] ?? []))

// —— 1. 点名项目：具体证据，应该直接挂 ——
{
  const text = '帮我继续做存货核对那个，把 样表的合计比例重新算一遍'
  const ranked = rankProjects(text, profiles)
  const decision = decideMatch(ranked, { length: text.length })
  assert.equal(decision.action, 'attach', `点名项目名应直接挂，实得 ${decision.action}（${ranked.map(i => `${i.name}:${i.score}`).join(', ')}）`)
  assert.equal(decision.project.id, 'P2026-01')
}

// —— 2. 提到编号：最强证据 ——
{
  const decision = decideMatch(rankProjects('P2026-03 那边的附注再对一遍', profiles), { length: 40 })
  assert.equal(decision.action, 'attach')
  assert.equal(decision.project.id, 'P2026-03')
}

// —— 3. 只提词汇、不点名：够像但不够具体，只提示 ——
{
  const text = '这几个合计比例跟跌价准备对不上，先核一下再往下走'
  const ranked = rankProjects(text, profiles)
  const decision = decideMatch(ranked, { length: text.length })
  assert.equal(decision.action, 'hint', `词汇重合只应提示，实得 ${decision.action}`)
  assert.equal(decision.project.id, 'P2026-01')
}

// —— 4. 两个项目共用名称片段：并列，宁可不挂 ——
{
  const decisions = decideMatch(rankProjects('半年报的存货核对和答复清单都在手上，先做哪个', profiles), { length: 40 })
  assert.notEqual(decisions.action, 'attach', '多家并列时不该自动挂')
}

// —— 5. 完全无关的话：不吭声 ——
{
  const decision = decideMatch(rankProjects('今天天气不错，帮我把这个插件的页签改个颜色', profiles), { length: 40 })
  assert.equal(decision.action, 'none', `无关消息不该提示，实得 ${decision.action}`)
}

// —— 6. 超长文本（多半是注入的摘要）：即使命中也不挂 ——
{
  const long = `${'存货核对-2026半年报 的上下文。'.repeat(120)}`
  const decision = decideMatch(rankProjects(long, profiles), { length: long.length })
  assert.notEqual(decision.action, 'attach', '超长文本不该自动挂')
}

// —— 7. 消息文本提取：只取 text 块 ——
{
  assert.equal(messageText({ content: [{ type: 'text', text: '你好' }, { type: 'image' }] }), '你好')
  assert.equal(messageText({ content: [] }), '')
  assert.equal(messageText(null), '')
}

// —— 8. 打分单调性：点名高于词汇重合 ——
{
  const named = scoreProfile('做存货核对-2026半年报', profiles[0]).score
  const vague = scoreProfile('存货减值那个表', profiles[0]).score
  assert.ok(named > vague, `点名分应高于模糊分（${named} vs ${vague}）`)
  assert.ok(named >= 0.85, `点名应达到自动挂接门槛，实得 ${named}`)
}

// —— 9. 领先度边界：0.88 vs 0.80 必须判挂接（浮点尾差不许把 0.08 判成 0.0799） ——
// 且"领先"只跟同级（强证据）竞争者比：词汇级的第二名不许把点名的第一句顶掉。
{
  const boundary = decideMatch([
    { id: 'X', name: 'X', period: '', score: 0.88, evidence: 'name', why: '整名命中' },
    { id: 'Y', name: 'Y', period: '', score: 0.8, evidence: 'lexical', why: '词命中' },
  ], { length: 30 })
  assert.equal(boundary.action, 'attach', `0.88-0.80 恰为 0.08，应判挂接，实得 ${boundary.action}`)
  const lexicalRival = decideMatch([
    { id: 'X', name: 'X', period: '', score: 0.88, evidence: 'name', why: '整名命中' },
    { id: 'Y', name: 'Y', period: '', score: 0.81, evidence: 'lexical', why: '词命中' },
  ], { length: 30 })
  assert.equal(lexicalRival.action, 'attach', `词汇级竞争者不该拦下点名挂接，实得 ${lexicalRival.action}`)
  const strongRival = decideMatch([
    { id: 'X', name: 'X', period: '', score: 0.88, evidence: 'name', why: '整名命中' },
    { id: 'Y', name: 'Y', period: '', score: 0.88, evidence: 'name', why: '整名命中' },
  ], { length: 30 })
  assert.equal(strongRival.action, 'hint', `两个项目都被点名时应只提示，实得 ${strongRival.action}`)
}

// —— 10. 单个词撞上别人的历史语料：不构成提示 ——
// 真实踩过：本插件开发项目的摘要里抄了被测业务词，于是「帮我想个键盘名字」里的"名字"
// 单命中就出了提示。判据要求至少两个词、且至少一个落在主线词上。
{
  const noisy = buildProfile({
    id: 'P9999-06',
    name: '插件开发项目',
    period: '2026-11',
    status: 'active',
    dir: '',
    alias: '',
    summary: '开发一个插件',
  }, ['第四档实测与两个真 bug'], ['提示里写了「告诉我名字就行」'])
  const profile = [noisy]
  const decision = decideMatch(rankProjects('今天天气不错，帮我想个键盘名字', profile), { length: 16 })
  assert.equal(decision.action, 'none', `单词巧合不该提示，实得 ${decision.action}（${JSON.stringify(rankProjects('今天天气不错，帮我想个键盘名字', profile))}）`)
}

// —— 11. 旁述词权重只有主线词的 0.4：抄了别人关键词的项目抢不走提示 ——
{
  const owner = buildProfile({
    id: 'P0001-01', name: '存货核对-2026半年报', period: '2026H1', status: 'active',
    dir: '存货核对半年报', alias: '存货减值', summary: '存货核对与减值复核',
  }, ['存货减值复核与结转口径确认', '样表合计比例算错'], [])
  const quoter = buildProfile({
    id: 'P0001-06', name: '插件开发项目', period: '2026-11', status: 'active',
    dir: '', alias: '', summary: '开发一个插件',
  }, ['第四档实测'], ['存货减值复核的样本、合计比例算错的那张表'])
  const ranked = rankProjects('存货减值复核与成本结转口径这几张表都要重算', [owner, quoter])
  assert.equal(ranked[0]?.id, 'P0001-01', `主线项目应排在抄词的项目前面，实得 ${ranked.map(i => `${i.id}:${i.score}:${i.evidence}`).join(', ')}`)
  const decision = decideMatch(ranked, { length: 30 })
  assert.ok(decision.action !== 'attach' || decision.project.id === 'P0001-01', '若给出项目，必须是主线项目')
}

// —— 12. 半通用词 + 泛动词都不够提示 ——
// 实测踩过：「写两条 work_note（猫粮采购 / 猫砂补充）后自查」被"采购"（在多个项目语料里
// 都出现）和"补充"（动作词）凑成对采购分析项目的提示。词汇档要求权重 ≥ LEXICAL_FLOOR。
{
  const buyer = buildProfile({
    id: 'P2026-04', name: '采购分析', period: '2026H1', status: 'active',
    dir: '采购分析', alias: '', summary: '闪存采购量价与供应商结构',
  }, ['供应商结构那张表重算'], ['采购量价口径'])
  for (const text of ['写两条 work_note（猫粮采购 / 猫砂补充）后自查', '这个项目接下来怎么办？']) {
    const decision = decideMatch(rankProjects(text, [buyer]), { length: text.length })
    assert.equal(decision.action, 'none', `「${text}」不该提示，实得 ${decision.action}`)
  }
}

// —— 13. 两个项目各被点名一半（其中一个说的是长名字的前三字）：只提示，不挂 ——
// 实测踩过：「存货核对和说明书这两条线今天都要交」——「说明书」不是「说明书修订」的
// 完整片段，于是只认出 P2026-01 一个强证据，自动挂到了它头上。长名字补 3 字前缀后，
// 两边都是强证据，领先度为 0，降级成提示。
{
  const pair = [
    buildProfile({
      id: 'P2026-01', name: '存货核对-2026半年报', period: '2023末–2026H1', status: 'active',
      dir: '存货核对半年报', alias: '存货那个,存货减值', summary: '存货核对与减值复核',
    }, ['存货减值复核与结转口径确认'], []),
    buildProfile({
      id: 'P2026-03', name: '说明书修订', period: '2026', status: 'active',
      dir: '说明书修订', alias: '', summary: '说明书附注与报表修订',
    }, ['说明书附注期初数修订'], []),
  ]
  const text = '存货核对和说明书这两条线今天都要交，先别动文件'
  const decision = decideMatch(rankProjects(text, pair), { length: text.length })
  assert.equal(decision.action, 'hint', `两个项目都被点名时应只提示，实得 ${decision.action}`)
  assert.equal(decision.candidates?.length, 2, `应给出两个候选，实得 ${JSON.stringify(decision.candidates)}`)
}

// —— 14. 跨标点切出来的"词"不算词 ——
// 实测踩过：「今天的活先记两条」里的"的活"在本插件开发项目的摘要里出现过，
// idf 判它稀有，于是单靠这一个伪词就把闲聊判成了提示。切词边界上出现虚词的 gram 一律不计分。
{
  const dev = buildProfile({
    id: 'P2026-06', name: '插件开发项目', period: '2026-11', status: 'active',
    dir: '', alias: '', summary: '判定依据是干出来的活',
  }, ['第四档实测与两个真 bug'], ['把活拆成两段'])
  const text = '今天的活先记两条：搭子说的那个汇总口径，还有分摊那块。'
  const ranked = rankProjects(text, [dev])
  assert.equal(ranked.length, 0, `伪词不该计分，实得 ${ranked.map(i => `${i.id}:${i.score}:${i.why}`).join(', ')}`)
}

console.log('OK：项目判定（点名挂接 / 编号 / 词汇提示 / 并列不挂 / 无关沉默 / 超长降级 / 领先度边界 / 单词巧合 / 旁述词 / 半通用词 / 长名字前缀 / 伪词）全部通过')
