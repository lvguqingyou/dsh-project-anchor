/**
 * 首条消息的项目判定：把「用户这句话在说什么事」对到已登记项目上。
 *
 * 为什么不能直接用 `resolveProjectRef`：那个函数假设输入是**一句项目名**
 * （"存货那个""答复清单"），阈值是按短字符串调的；新会话的第一条消息通常是
 * 一整段工作描述（"把存货减值那张表的口径改成……"），2-gram 命中率会被长句稀释，
 * 整串 includes 又几乎不可能命中。
 *
 * 所以这里换一套证据：**命中越具体，权重越高**，并且给每种命中打上来源标签。
 * 自动挂接只认"具体"的那几种（编号/项目名/别名/目录/跨项目唯一的名称片段），
 * 词汇重合只能算出提示——猜错的代价是往 `归属.jsonl` 里写错一行，不值得冒险。
 *
 * 纯函数，不碰文件与会话，测试直接喂字符串。
 */

/** 归一化时剔掉的标点与空白（保留中文、字母、数字）。 */
const STRIP = /[\s\u3000,，。、；;：:！!？?（）()【】\[\]{}<>《》〈〉「」『』""'“”‘’·\-—_/\\|~`+=*&^%$#@]/g

/** 名称/目录里的分隔符：项目名常写成「业务线-期间」「a／b」。 */
const SEGMENT = /[-－—_/\\·、,，\s（）()]+/

/** 自动挂接只认这些证据：它们是"这句话在点名这个项目"，不是"词汇面上像"。 */
const STRONG_EVIDENCE = new Set(['id', 'name', 'alias', 'dir'])


/**
 * 纯虚词字符：一个 gram 的两个字都落在这里时算噪音。
 *
 * 不做这层过滤的话，"对不""的话""这是"会在每个项目的语料里都出现，
 * 变成人人有份的假信号（idf 会把它们压低，但不如直接不看）。
 */
const FUNCTION_CHARS = new Set([...'的了是在我和你这那个上下有与就不把被要对会能吗呢吧啊也很再先都还于为之所以及等其但却而则若因帮请先来去个'])

/**
 * 与"哪个项目"无关的泛词：出现它们只说明"在说工作/在说这个系统"。
 *
 * 有些泛词（"会话""项目"）只在某一个项目的语料里出现过一两次，df 过滤挡不住，
 * 却足以把一句"新会话第一句话"凑成提示 —— 所以按词表直接排除。
 */
const GENERIC_WORDS = [
  '项目', '会话', '台账', '文件', '结论', '工作', '记录', '内容', '任务', '数据', '表格',
  '摘要', '上下文', '问题', '情况', '一下', '继续', '开始', '结束', '现在', '已经',
  '可以', '需要', '东西', '事情', '部分', '相关', '处理', '完成', '确认', '检查', '整理',
  '看看', '这个', '那个', '什么', '怎么', '如何', '是否', '后续', '然后', '所以', '但是',
  '如果', '以及', '或者', '还是', '就是', '不是', '没有', '不会', '不能', '可能', '应该',
  '一定', '马上', '立刻', '上下', '左右', '时候', '地方', '方面', '方式', '方法', '结果',
  '原因', '基础', '基本', '主要', '重要', '实际', '具体', '一般', '通常', '所有', '每个',
  '各种', '这些', '那些', '我们', '你们', '他们', '自己', '别人', '今天', '明天', '昨天',
  '目前', '当前', '最近', '以后', '之前', '之后', '接着', '往下', '以前', '开头', '结尾',
  // 动作词：它们出现在节点标题里，只说明"在干活"，不说明"在哪个项目的活"。
  // 实测踩过：「猫砂补充」里的"补充"命中了销售分析项目的标题，给出错误提示。
  '补充', '补全', '完善', '梳理', '核对', '复核', '重算', '统计', '汇总', '提交',
  '修改', '调整', '更新', '添加', '增加', '补上', '写进', '写个', '写入', '导出',
  '生成', '查看', '对比', '比较', '分析', '复盘', '收尾', '推进', '落地', '自查',
  '发一份', '走一遍', '过一遍', '先做', '再做', '看一下', '核对一下',
]

/**
 * 泛词拆成的 2-gram 集合（在 {@link bigrams} 定义之后填充）。
 * @type {Set<string>}
 */
const GENERIC_GRAMS = new Set()

/**
 * 是否泛词 gram。
 * @param {string} gram 2-gram。
 * @returns {boolean} 是则 true。
 */
function isGenericGram(gram) {
  return GENERIC_GRAMS.has(gram)
}

/**
 * 只能当句子粘合剂的字：一侧出现就说明这个 gram 不是词。
 *
 * 实测踩过：「今天的活先记两条」里的「的活」在某个项目的摘要里出现过，
 * idf 判它很稀有，于是单靠一个「的活」就把闲聊判成了提示。
 * 两个字的边界一旦出现这类字，这个 gram 就是切词切歪了的产物，不是词。
 */
const PARTICLE_CHARS = new Set([
  '的', '了', '着', '过', '吗', '呢', '吧', '啊', '呀', '嘛',
  '是', '我', '你', '他', '她', '它', '这', '那', '哪', '个', '们',
  '就', '才', '也', '都', '很', '太', '更', '最', '不', '没', '别',
  '和', '与', '及', '而', '但', '或', '且', '把', '被', '于', '以', '之', '其', '为',
])

/**
 * 是否纯虚词 gram：两个字都落在 {@link FUNCTION_CHARS}，或任一侧是 {@link PARTICLE_CHARS}。
 * @param {string} gram 2-gram。
 * @returns {boolean} 是则 true。
 */
function isNoiseGram(gram) {
  if (gram[0] !== undefined && PARTICLE_CHARS.has(gram[0])) return true
  if (gram[1] !== undefined && PARTICLE_CHARS.has(gram[1])) return true
  for (const char of gram) if (!FUNCTION_CHARS.has(char)) return false
  return true
}

/** 汉字。判定只看汉字 gram：英文片段（"summary"→su/mp、路径、代码）会把不相干的话拉到同一条线上。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/

/**
 * gram 是不是"两个汉字"。
 *
 * 只要求"含一个汉字"不够：像是「了「」「目」」这种跨标点的片段会混进来，
 * 而「第一」「本会」这类由常见字凑成的片段又会命中任何长文本。
 * @param {string} gram 2-gram。
 * @returns {boolean} 两个字都是汉字则 true。
 */
function hasCjk(gram) {
  return gram.length === 2 && CJK.test(gram[0]) && CJK.test(gram[1])
}

/** 与判定无关的 gram 判断：虚词、泛词、非汉字片段都不计分。 */
function isStopGram(gram) {
  return !hasCjk(gram) || isNoiseGram(gram) || isGenericGram(gram)
}

/**
 * 归一化：小写 + 去掉标点空白。
 *
 * 两侧都得走这同一套，否则「P2026-01」与「p2026 01」对不上。
 * @param {unknown} value 原文。
 * @returns {string} 归一化后的串。
 */
export function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(STRIP, '')
}

/**
 * 2-gram 集合（单字段也收进去，否则"表""账"这类单字永远匹配不到）。
 * @param {unknown} value 原文。
 * @returns {Set<string>} gram 集合。
 */
export function bigrams(value) {
  const set = new Set()
  const text = normalizeText(value)
  for (let index = 0; index + 1 < text.length; index += 1) set.add(text.slice(index, index + 2))
  if (text.length === 1) set.add(text)
  return set
}

// 泛词表在 bigrams 定义之后展开成 gram 集合（模块加载时执行一次）。
for (const word of GENERIC_WORDS) for (const gram of bigrams(word)) GENERIC_GRAMS.add(gram)

/**
 * 按分隔符切出可独立命中的片段。
 * @param {unknown} value 原文（项目名或别名）。
 * @param {number} minLength 片段最短长度（归一化后）。
 * @returns {string[]} 归一化后的片段。
 */
function segmentsOf(value, minLength) {
  const seen = new Set()
  for (const part of String(value ?? '').split(SEGMENT)) {
    const segment = normalizeText(part)
    if (segment.length >= minLength) seen.add(segment)
  }
  return [...seen]
}

/**
 * 把一条消息里的文本块拼起来。
 *
 * `user/message` 事件的 `data` 本身就是 message 记录（见 dsh-session 的
 * `deriveEventMessage`），内容在 `content` 数组里；图片/附件块不参与判定。
 * @param {object} message message 记录。
 * @returns {string} 纯文本。
 */
export function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * 给项目建一份匹配档案（每轮只建一次，之后对每条消息复用）。
 * @param {{id: string, name: string, dir?: string, alias?: string, summary?: string, period?: string}} project 项目行。
 * @param {string[]} titles 该项目的最近节点标题（词汇来源）。
 * @param {string[]} summaries 该项目的最近节点摘要（词汇来源）。
 * @returns {object} 档案。
 */
export function buildProfile(project, titles = [], summaries = []) {
  // 名称片段只留含汉字的：纯英文片段（项目名里的 "project"、"data"）
  // 太像日常词，任何一句英文提示都会命中——实测里测试提示词里的 "NEW-PROJECT"
  // 就把会话挂到了这个插件项目上。要指认它，请写全名或编号。
  //
  // 长名字再补一个 3 字前缀：「说明书修订」被说成「说明书」时，
  // 整名和整片段都命不中，句子会被判成"只提了另一个项目"然后自动挂过去。
  // 前缀是这条路上唯一能认出"两个项目都点名了"的信号。
  const nameSegments = [
    ...new Set(
      segmentsOf(project.name, 3)
        .filter(segment => CJK.test(segment))
        .flatMap(segment => (segment.length >= 5 ? [segment, segment.slice(0, 3)] : [segment])),
    ),
  ]
  const aliasSegments = segmentsOf(project.alias, 2).filter(segment => CJK.test(segment))
  // 词汇库分两层：**主线词**（节点标题、项目名/别名片段、一句话）与**旁述词**（节点摘要）。
  // 分层的理由：一个项目"在讲什么"看标题，"顺带提到过什么"看摘要。
  // 不分层的话，一个把别家关键词抄进结论的项目会变成"什么都像"——
  // 本插件自己的开发项目就踩过：它的摘要里全是被测试的业务词，于是任何一句话都像它。
  const titleGrams = new Set()
  for (const text of [...titles, project.summary, ...nameSegments, ...aliasSegments]) {
    for (const gram of bigrams(text)) titleGrams.add(gram)
  }
  const summaryGrams = new Set()
  for (const text of summaries) {
    for (const gram of bigrams(text)) if (!titleGrams.has(gram)) summaryGrams.add(gram)
  }
  // 判据仍是"这个词在**别的项目**里出不出得现"（见 rankProjects 的 idf 权重），
  // 「这个项目平时在说哪些词」只需要一个近似，不需要分词的精度。
  const corpusGrams = new Set([...titleGrams, ...summaryGrams])
  return {
    id: project.id,
    name: project.name,
    period: project.period ?? '',
    status: project.status ?? '',
    idNorm: normalizeText(project.id),
    nameNorm: normalizeText(project.name),
    nameSegments,
    aliasSegments,
    dirNorm: project.dir ? normalizeText(project.dir) : '',
    dir: project.dir ?? '',
    corpusGrams,
    titleGrams,
    summaryGrams,
  }
}

/**
 * 一条消息对一个项目打分。
 * @param {string} text 消息正文（原文）。
 * @param {object} profile {@link buildProfile} 的产物。
 * @param {{idf?: (gram: string) => number}} [context] 全局词权重（缺省时按"人人都有"处理）。
 * @returns {{score: number, evidence: string, why: string}} 分数、证据类型与一句理由。
 */
export function scoreProfile(text, profile, context = {}) {
  const textNorm = normalizeText(text)
  if (textNorm === '') return { score: 0, evidence: 'none', why: '' }

  let best = { score: 0, evidence: 'none', why: '' }
  const consider = (score, evidence, why) => {
    if (score > best.score) best = { score, evidence, why }
  }

  if (profile.idNorm !== '' && textNorm.includes(profile.idNorm)) {
    consider(1, 'id', `提到了项目编号 ${profile.id}`)
  }
  if (profile.nameNorm.length >= 2 && textNorm.includes(profile.nameNorm)) {
    consider(0.97, 'name', `提到了项目名「${profile.name}」`)
  }
  for (const segment of profile.aliasSegments) {
    if (textNorm.includes(segment)) consider(0.9, 'alias', `提到了别名「${segment}」`)
  }
  // 名称片段比整名宽松（"存货核对-2026半年报" 常被说成 "存货核对"），
  // 但两个项目可能共用一个片段 —— 交由 decideMatch 的领先幅度判断。
  for (const segment of profile.nameSegments) {
    if (textNorm.includes(segment)) consider(0.88, 'name', `提到了「${segment}」`)
  }
  if (profile.dirNorm.length >= 3 && textNorm.includes(profile.dirNorm)) {
    consider(0.86, 'dir', `提到了项目目录 ${profile.dir}`)
  }

  // 词汇重合：按**稀有度**加权，而不是按覆盖率；并且区分主线词与旁述词。
  // 覆盖率会被长标题稀释（一条 20 字的节点标题只重合两个词就只剩 10%），
  // 而"减值""答复"这种只有某个项目在用的词，出现一次就足以说明在讲同一件事。
  // 上限压在 0.8 —— 它只够出提示，不够自动挂接。
  //
  // 两道闸：
  // 1. 命中词必须落在**主线词**（标题/名称片段/一句话）上，且只占旁述词权重的 0.4。
  //    否则一个项目只要在摘要里抄过别人的词，就会变成"什么都像"——实测里那个
  //    开发项目在结论文里反复引用被测业务词，连「帮我想个键盘名字」都被它认领。
  //    注意只靠"至少两个词"挡不住这种词：中文里一个领域词（跌价）就足以指认项目，
  //    所以闸设在"主线/旁述"上，不设在命中数量上。
  const idf = typeof context.idf === 'function' ? context.idf : () => 1
  const floor = typeof context.floor === 'number' ? context.floor : 1
  let weight = 0
  let titleWeight = 0
  let matched = 0
  let headline = 0
  const examples = []
  for (const gram of bigrams(text)) {
    if (isStopGram(gram)) continue
    const inTitle = profile.titleGrams.has(gram)
    const inSummary = !inTitle && profile.summaryGrams.has(gram)
    if (!inTitle && !inSummary) continue
    const credit = idf(gram) * (inTitle ? 1 : 0.4)
    if (!(credit > 0)) continue
    matched += 1
    if (inTitle) {
      headline += 1
      titleWeight += credit
    }
    weight += credit
    if (examples.length < 4) examples.push(gram)
  }
  if (headline >= 1 && titleWeight >= floor) {
    consider(
      Math.min(0.8, 0.16 + 0.18 * weight),
      'lexical',
      `本项目的词反复出现：${examples.join('、')}${matched > examples.length ? ' 等' : ''}`,
    )
  }

  return best
}

/**
 * 给所有项目打分并按分数倒序。
 * @param {string} text 消息正文。
 * @param {object[]} profiles 各项目档案。
 * @returns {Array<{id: string, name: string, period: string, score: number, evidence: string, why: string}>} 排名。
 */
export function rankProjects(text, profiles) {
  // df：一个词出现在几个项目的语料里。
  const df = new Map()
  for (const profile of profiles) {
    for (const gram of profile.corpusGrams) df.set(gram, (df.get(gram) ?? 0) + 1)
  }
  const total = Math.max(profiles.length, 1)
  /** 词权重：只在一个项目里出现的词最有用；过半数项目都有的词直接不计分。 */
  const idf = gram => {
    const count = df.get(gram) ?? total
    if (count / total > 0.5) return 0
    return Math.log((total + 1) / count)
  }
  // 词汇档的门槛随语料规模走：词要"比半数项目更稀有"才算证据。
  // 固定常数在小语料里会永远够不着（6 个项目时最稀有的词 idf 也只有 1.95，
  // 而两个项目时上限只有 2 个自然对数单位），大语料里又会过松。
  const floor = Math.log((total + 1) / 2)

  const ranked = []
  for (const profile of profiles) {
    const result = scoreProfile(text, profile, { idf, floor })
    if (result.score <= 0) continue
    ranked.push({
      id: profile.id,
      name: profile.name,
      period: profile.period,
      score: Math.round(result.score * 100) / 100,
      evidence: result.evidence,
      why: result.why,
    })
  }
  return ranked.sort((left, right) => right.score - left.score)
}

/**
 * 判定动作：直接挂、只提示、还是什么都不说。
 *
 * 三档：
 * - `attach`：有具体证据（编号/名/别名/目录）、分数够高、且明显领先第二名；
 * - `hint`：有像的地方，但不够具体或多家并列 —— 让模型在第一轮里问一句；
 * - `none`：连提都不值得提（避免每条新会话都塞一句"这可能是 X"）。
 *
 * @param {Array<object>} ranked {@link rankProjects} 的结果。
 * @param {{length?: number}} [options] `length` 是消息长度，用于挡掉超长注入文本。
 * @returns {{action: 'attach'|'hint'|'none', project?: object, candidates?: object[], why?: string}} 动作。
 */
export function decideMatch(ranked, options = {}) {
  const best = ranked[0]
  if (!best) return { action: 'none' }
  // 挂接的"领先"只跟**同级竞争者**比：另一个项目的编号/名/别名/目录也出现在这条消息里，
  // 才算真的分不清。词汇级的第二名不能把点名的第一句顶掉——那正是第 6 个项目
  // （自己的开发项目，摘要里抄满被测业务词）上线后出现的回归：
  // 点名「存货核对」却被 P2026-06 的词汇分拉到 0.8，领先不足 0.08，降级成提示。
  const rival = ranked.find(item => item.id !== best.id && STRONG_EVIDENCE.has(item.evidence)) ?? null
  // 分数本身是两位小数，相减会带浮点尾差（0.88 - 0.80 = 0.07999999999999996）：
  // 恰好卡在 0.08 边界上会被误判成"不够领先"。先按百分位取整再比。
  const lead = Math.round((best.score - (rival?.score ?? 0)) * 100) / 100
  const length = Number.isFinite(options.length) ? options.length : 0

  // 超长文本多半不是人写的第一句话（而是被注入的摘要/工具输出）：只提示，不写归属。
  const attachable = STRONG_EVIDENCE.has(best.evidence)
    && best.score >= 0.85
    && lead >= 0.08
    && (length === 0 || length <= 2000)

  if (attachable) return { action: 'attach', project: best, why: best.why }
  if (best.score >= 0.35) {
    return {
      action: 'hint',
      project: best,
      candidates: ranked.filter(item => item.score >= 0.35).slice(0, 3),
      why: best.why,
    }
  }
  return { action: 'none' }
}
