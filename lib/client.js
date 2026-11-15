/**
 * 客户端 bundle：注册「项目锚定」页签 + 插件详情页的台账面板。
 *
 * 手写 loader 格式（无构建步骤）：`window.__ModuleLoader__.load({ id, factory })`，
 * 外部模块只有 baseline 的 `react`。
 *
 * 两个界面：
 * 1. `conversation.view` 的「项目锚定」页签（VIEW_ID = 'project'）——左栏项目清单，右侧就是同一块台账面板；
 * 2. `plugins.detail.section` 的「工作台账」section（BUNDLE_KEY = 'dsh-project-anchor'）——
 *    插件详情页里把 `工作台账-*.md` 与 `_台账\索引.jsonl` 渲染成可读的卡片流。
 *    早先注册在 `plugins.bundle.config`（"bundle 自己的配置卡"）上，但本插件没有
 *    bundle 级配置，那条 slot 在详情页里不渲染，页面看起来是空的——故改挂 section。
 *
 * 两处的数据都走宿主侧 webServer 路由 `/project-anchor/ledger`（纯读、不碰会话日志）。
 * 不用会话投影的原因：宿主从不往会话日志写 `project/catalog`（写了会让会话打不开），
 * 投影的 init 恒为 `{ catalog: null }`，页签以前因此永远显示"还没有目录数据"。
 *
 * @module dsh-project-anchor/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-project-anchor',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** locale 命名空间：与本插件包名一致，避免和别的插件抢词条。 */
    const LOCALE_NS = 'dsh-project-anchor'
    /** 当前翻译函数：locale 服务可用时由 apply 换成 bind(ns)，否则原样显示。 */
    let translate = text => text
    /** 可见文案统一走这里；key 就是中文原文，缺词时回落显示原文。 */
    const t = text => translate(text)
    /** 中文词典：key 即原文，恒等映射（两种语言都给全，locale 服务才不会报缺词）。 */
    const TEXT_ZH = Object.freeze({
      "摘要": "摘要",
      "项目卡全文": "项目卡全文",
      "进行中": "进行中",
      "已完成": "已完成",
      "受阻": "受阻",
      "未开始": "未开始",
      "未标注": "未标注",
      "点一下看 ": "点一下看 ",
      " 的台账": " 的台账",
      "本项目": "本项目",
      "· 正在看": "· 正在看",
      " 个节点 · ": " 个节点 · ",
      " 行台账": " 行台账",
      "暂无台账": "暂无台账",
      "最近 ": "最近 ",
      "无记录": "无记录",
      "挂接中…": "挂接中…",
      "挂上": "挂上",
      "宿主路由返回 ": "宿主路由返回 ",
      "注入改为「摘要 + 项目卡全文」": "注入改为「摘要 + 项目卡全文」",
      "注入改为「四行摘要」": "注入改为「四行摘要」",
      "切换失败：": "切换失败：",
      "取不到会话 id，无法挂接": "取不到会话 id，无法挂接",
      "已锚定到 ": "已锚定到 ",
      "挂接失败：": "挂接失败：",
      "取不到会话 id，无法建卡": "取不到会话 id，无法建卡",
      "本会话 ": "本会话 ",
      " 条台账结论的归集：": " 条台账结论的归集：",
      "本会话台账结论的归集": "本会话台账结论的归集",
      "已建卡 ": "已建卡 ",
      "建卡失败：": "建卡失败：",
      "「项目锚定」页签渲染出错：": "「项目锚定」页签渲染出错：",
      "（未知项目）": "（未知项目）",
      "收起项目列表": "收起项目列表",
      "全部项目（": "全部项目（",
      "本会话尚未锚定": "本会话尚未锚定",
      "下面带「参考」标记的，是按\"这个会话已经产生的台账行落在哪\"算出来的推荐；其余是登记过的全部项目。": "下面带「参考」标记的，是按\"这个会话已经产生的台账行落在哪\"算出来的推荐；其余是登记过的全部项目。",
      "下面的候选是按\"这个会话已经产生的台账行落在哪\"算出来的，不是你选的默认值。": "下面的候选是按\"这个会话已经产生的台账行落在哪\"算出来的，不是你选的默认值。",
      "这个会话还没有产生任何台账行，所以给不出候选。": "这个会话还没有产生任何台账行，所以给不出候选。",
      "候选：本会话的台账行落在这几个项目": "候选：本会话的台账行落在这几个项目",
      "候选：本会话可能属于这几个项目": "候选：本会话可能属于这几个项目",
      "点「挂上」把本会话记到 ": "点「挂上」把本会话记到 ",
      " 行": " 行",
      "参考": "参考",
      "落在该项目 ": "落在该项目 ",
      "本会话无台账行": "本会话无台账行",
      "另有 ": "另有 ",
      " 个项目只是被提到过、本会话没有台账行：": " 个项目只是被提到过、本会话没有台账行：",
      "建卡建议：另有 ": "建卡建议：另有 ",
      " 条结论还没归属": " 条结论还没归属",
      "，都在「": "，都在「",
      "」下": "」下",
      "下面这几组看起来是同一件事，但目前还没有对应项目：": "下面这几组看起来是同一件事，但目前还没有对应项目：",
      "点「建卡」才会登记；判据：": "点「建卡」才会登记；判据：",
      " 条": " 条",
      "覆盖节点：": "覆盖节点：",
      " 等 ": " 等 ",
      " 个": " 个",
      "涉及文件：": "涉及文件：",
      "未归属 ": "未归属 ",
      "建卡中…": "建卡中…",
      "建卡": "建卡",
      "仅提到": "仅提到",
      "这个项目还没有台账节点。": "这个项目还没有台账节点。",
      "先挂到上面的候选项目，这里就显示它的台账节点流；也可以点「全部项目」翻别的项目。": "先挂到上面的候选项目，这里就显示它的台账节点流；也可以点「全部项目」翻别的项目。",
      "新会话自动判定后注入的上下文：": "新会话自动判定后注入的上下文：",
      "整张项目卡原文一并注入：更详尽，但占更多上下文": "整张项目卡原文一并注入：更详尽，但占更多上下文",
      "只注入四行摘要：期间 / 已定口径 / 禁入区 / 续开点": "只注入四行摘要：期间 / 已定口径 / 禁入区 / 续开点",
      "（更详尽，占更多上下文）": "（更详尽，占更多上下文）",
      "（省上下文）": "（省上下文）",
      "· 本次运行有效": "· 本次运行有效",
      "指标": "指标",
      "数值": "数值",
      "口径 / 依据": "口径 / 依据",
      "来自索引·结论待 md 落盘": "来自索引·结论待 md 落盘",
      "未决": "未决",
      "下一步：": "下一步：",
      "收起这个节点": "收起这个节点",
      "展开这个节点": "展开这个节点",
      "(未命名节点)": "(未命名节点)",
      "证据 ": "证据 ",
      " 条结论": " 条结论",
      "这个节点还没有结论。": "这个节点还没有结论。",
      "（未取到台账）": "（未取到台账）",
      "工作台账：": "工作台账：",
      " 个节点": " 个节点",
      "工作台账": "工作台账",
      "期间未登记": "期间未登记",
      "取数失败": "取数失败",
      "数据 ": "数据 ",
      "收起全部": "收起全部",
      "展开全部": "展开全部",
      "刷新": "刷新",
      "全部项目：点一张卡看它的台账": "全部项目：点一张卡看它的台账",
      " 条证据": " 条证据",
      " 个会话": " 个会话",
      " 行索引": " 行索引",
      " 行未归属": " 行未归属",
      "正在读台账…": "正在读台账…",
      "还没有可展示的台账：先在会话里用 work_note 记一条节点，再刷新。": "还没有可展示的台账：先在会话里用 work_note 记一条节点，再刷新。",
      "没有节点匹配「": "没有节点匹配「",
      "按节点名 / 结论 / 未决过滤": "按节点名 / 结论 / 未决过滤",
      "项目锚定": "项目锚定",
      "）": "）",
      "」。": "」。"
    })
    /** 英文词典。 */
    const TEXT_EN = Object.freeze({
      "摘要": "Summary",
      "项目卡全文": "Full card",
      "进行中": "In progress",
      "已完成": "Done",
      "受阻": "Blocked",
      "未开始": "Not started",
      "未标注": "Unmarked",
      "点一下看 ": "Click to open ",
      " 的台账": "'s ledger",
      "本项目": "This project",
      "· 正在看": "· viewing",
      " 个节点 · ": " nodes · ",
      " 行台账": " ledger rows",
      "暂无台账": "No ledger yet",
      "最近 ": "Latest ",
      "无记录": "No records",
      "挂接中…": "Attaching…",
      "挂上": "Attach",
      "宿主路由返回 ": "Host route returned ",
      "注入改为「摘要 + 项目卡全文」": "Injection switched to \"summary + full card\"",
      "注入改为「四行摘要」": "Injection switched to \"four-line summary\"",
      "切换失败：": "Switch failed: ",
      "取不到会话 id，无法挂接": "No session id; cannot attach",
      "已锚定到 ": "Anchored to ",
      "挂接失败：": "Attach failed: ",
      "取不到会话 id，无法建卡": "No session id; cannot create a card",
      "本会话 ": "This session ",
      " 条台账结论的归集：": " ledger conclusions grouped: ",
      "本会话台账结论的归集": "Grouping of this session's ledger conclusions",
      "已建卡 ": "Card created: ",
      "建卡失败：": "Card creation failed: ",
      "「项目锚定」页签渲染出错：": "Project anchor tab failed to render: ",
      "（未知项目）": "(unknown project)",
      "收起项目列表": "Collapse project list",
      "全部项目（": "All projects (",
      "本会话尚未锚定": "This session is not anchored",
      "下面带「参考」标记的，是按\"这个会话已经产生的台账行落在哪\"算出来的推荐；其余是登记过的全部项目。": "Rows tagged \"reference\" are suggestions computed from where this session's ledger rows landed; the rest are all registered projects.",
      "下面的候选是按\"这个会话已经产生的台账行落在哪\"算出来的，不是你选的默认值。": "The candidates below are computed from where this session's ledger rows landed, not a default you picked.",
      "这个会话还没有产生任何台账行，所以给不出候选。": "This session has no ledger rows yet, so there are no candidates.",
      "候选：本会话的台账行落在这几个项目": "Candidates: this session's ledger rows landed in these projects",
      "候选：本会话可能属于这几个项目": "Candidates: this session may belong to these projects",
      "点「挂上」把本会话记到 ": "Click \"Attach\" to record this session in ",
      " 行": " rows",
      "参考": "reference",
      "落在该项目 ": "in this project ",
      "本会话无台账行": "No ledger rows in this session",
      "另有 ": "Also ",
      " 个项目只是被提到过、本会话没有台账行：": " projects were only mentioned, with no ledger rows in this session: ",
      "建卡建议：另有 ": "Card suggestions: also ",
      " 条结论还没归属": " conclusions are unattributed",
      "，都在「": ", all under \"",
      "」下": "\"",
      "下面这几组看起来是同一件事，但目前还没有对应项目：": "These groups look like the same thing, but no project matches them yet:",
      "点「建卡」才会登记；判据：": "Nothing is registered until you click \"Create card\"; basis: ",
      " 条": " items",
      "覆盖节点：": "Covered nodes: ",
      " 等 ": " and ",
      " 个": " more",
      "涉及文件：": "Files: ",
      "未归属 ": "Unattributed ",
      "建卡中…": "Creating…",
      "建卡": "Create card",
      "仅提到": "mentioned only",
      "这个项目还没有台账节点。": "This project has no ledger nodes yet.",
      "先挂到上面的候选项目，这里就显示它的台账节点流；也可以点「全部项目」翻别的项目。": "Attach to one of the candidates above to see its ledger node stream; or click \"All projects\" to browse.",
      "新会话自动判定后注入的上下文：": "Context injected after auto-detection in new sessions: ",
      "整张项目卡原文一并注入：更详尽，但占更多上下文": "Injects the whole project card: more detail, more context",
      "只注入四行摘要：期间 / 已定口径 / 禁入区 / 续开点": "Injects a four-line summary only: period / settled conventions / no-go zones / resume point",
      "（更详尽，占更多上下文）": "(more detail, more context)",
      "（省上下文）": "(saves context)",
      "· 本次运行有效": "· for this run only",
      "指标": "Metric",
      "数值": "Value",
      "口径 / 依据": "Basis / source",
      "来自索引·结论待 md 落盘": "From index · conclusions pending markdown",
      "未决": "Open",
      "下一步：": "Next: ",
      "收起这个节点": "Collapse this node",
      "展开这个节点": "Expand this node",
      "(未命名节点)": "(untitled node)",
      "证据 ": "Evidence ",
      " 条结论": " conclusions",
      "这个节点还没有结论。": "This node has no conclusions yet.",
      "（未取到台账）": "(ledger unavailable)",
      "工作台账：": "Work ledger: ",
      " 个节点": " nodes",
      "工作台账": "Work ledger",
      "期间未登记": "Period not recorded",
      "取数失败": "Load failed",
      "数据 ": "Data ",
      "收起全部": "Collapse all",
      "展开全部": "Expand all",
      "刷新": "Refresh",
      "全部项目：点一张卡看它的台账": "All projects: click a card to see its ledger",
      " 条证据": " evidence items",
      " 个会话": " sessions",
      " 行索引": " index rows",
      " 行未归属": " unattributed rows",
      "正在读台账…": "Reading ledger…",
      "还没有可展示的台账：先在会话里用 work_note 记一条节点，再刷新。": "Nothing to show yet: record a node with work_note in a session, then refresh.",
      "没有节点匹配「": "No node matches \"",
      "按节点名 / 结论 / 未决过滤": "Filter by node name / conclusion / open items",
      "项目锚定": "Project anchor",
      "）": ")",
      "」。": "\"."
    })

    /** 视图 id：必须与宿主侧声明的 target 同名，也是切换器里的 tab id。 */
    const VIEW_ID = 'project'
    /** 详情页插槽的 key：bundle 的包名。 */
    const BUNDLE_KEY = 'dsh-project-anchor'
    /** 台账数据路由（宿主注册）。 */
    const LEDGER_ROUTE = '/project-anchor/ledger'
    /** 一键挂接路由（宿主注册，POST；只追加一条归属事实）。 */
    const ATTACH_ROUTE = '/project-anchor/attach'
    /** 建卡路由（宿主注册，POST；与 `project_register` 工具同一条实现）。 */
    const REGISTER_ROUTE = '/project-anchor/register'
    /** 分组提案路由（宿主注册，GET；只提案，不写库）。 */
    const SUGGEST_ROUTE = '/project-anchor/suggest'
    const SETTINGS_ROUTE = '/project-anchor/settings'
    /** 注入粒度的中文名（键与宿主 `CONTEXT_MODES` 一致）。 */
    const CONTEXT_MODE_LABELS = { digest: '摘要', card: '项目卡全文' }
    /** 面板自动刷新间隔（毫秒）：台账文件随时在变，但不必抢在用户前面。 */
    const REFRESH_MS = 20000
    /** 「项目锚定」页签的目录刷新间隔（毫秒）：比面板慢，够看见新项目即可。 */
    const TAB_REFRESH_MS = 60000

    /** 视图快照：本视图不用快照（数据全来自投影）。 */
    const EMPTY_VIEW_SNAPSHOT = Object.freeze({})

    /** apply 时捕获的客户端上下文，供组件内的跳转使用。 */
    let clientCtx = null

    /** 状态口径 → 中文标签 / 颜色（与宿主 normalizeStatus 对齐）。 */
    const STATUS_LABEL = {
      active: '进行中',
      done: '已完成',
      blocked: '受阻',
      pending: '未开始',
      unknown: '未标注',
    }
    const STATUS_COLOR = {
      active: 'var(--dsw-alias-brand-primary, #2563eb)',
      done: 'var(--dsw-alias-state-success-primary, #16a34a)',
      blocked: 'var(--dsw-alias-state-warn-primary, #d97706)',
      pending: 'var(--dsw-alias-label-secondary, #6b7280)',
      unknown: 'var(--dsw-alias-label-secondary, #6b7280)',
    }

    /**
     * 项目卡片：页签「全部项目」与详情页的项目切换共用这一套，字段顺序固定
     * （名称 / 编号·期间·状态 / 台账量 / 一句话 / 最近活动），等宽等高。
     * 两处只有"能不能挂接""能不能切换"不同，所以样式与排版都在这里定死。
     */
    const cardStyles = {
      // 一行四张：minmax(0,1fr) 让四列平分宽度，卡片内部靠省略号收，不靠撑开格子。
      grid: {
        display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        gap: '8px', padding: '8px 16px 0',
      },
      card: {
        display: 'flex', flexDirection: 'column', gap: '3px', cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.26)', borderLeft: '3px solid rgba(127,127,127,0.35)',
        borderRadius: '8px',
        padding: '9px 11px', minHeight: '118px', color: 'inherit', font: 'inherit',
        textAlign: 'left', background: 'rgba(127,127,127,0.04)', boxSizing: 'border-box',
        // 窄列里长英文/长路径不换行会把卡撑破，统一允许在词内断。
        overflowWrap: 'anywhere',
      },
      cardOn: { borderColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 70%, transparent)', background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 10%, transparent)' },
      // 类别色只染左侧竖条：三类卡片形状一致，靠颜色区分"挂到已有/新建/全部项目"。
      cardCandidate: { borderLeftColor: 'var(--dsw-alias-brand-primary, #2563eb)' },
      cardSuggest: { borderLeftColor: 'var(--dsw-alias-brand-primary, #7c3aed)' },
      cardProject: { borderLeftColor: 'rgba(127,127,127,0.45)' },
      top: { display: 'flex', alignItems: 'flex-start', gap: '6px', minWidth: 0 },
      name: {
        flex: '0 1 auto', minWidth: 0, fontWeight: 600, fontSize: '13px', lineHeight: '1.35',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      // 建议卡的名字是节点标题，比项目名长得多：允许折两行，并固定两行高度，
      // 这样同一排卡片的判据、覆盖节点从同一条水平线开始，不会各说各话。
      nameWide: {
        flex: '1 1 auto', minWidth: 0, fontWeight: 600, fontSize: '13px', lineHeight: '1.35',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        overflow: 'hidden', overflowWrap: 'anywhere', minHeight: '2.7em',
      },
      meta: {
        fontSize: '12px', opacity: 0.66, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      metric: { fontSize: '12px', fontWeight: 600, opacity: 0.8 },
      wrap: { fontSize: '12px', opacity: 0.66, lineHeight: '1.45' },
      summary: {
        fontSize: '12px', opacity: 0.72, display: '-webkit-box', WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: '2.6em',
      },
      foot: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: 'auto', paddingTop: '4px' },
      dim: { fontSize: '12px', opacity: 0.62, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      spacer: { flex: '1 1 auto' },
      tag: {
        flex: '0 0 auto', fontSize: '11px', padding: '1px 8px', borderRadius: '999px',
        border: '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 50%, transparent)', color: 'var(--dsw-alias-brand-primary, #2563eb)', whiteSpace: 'nowrap',
      },
      tagSuggest: {
        flex: '0 0 auto', fontSize: '11px', padding: '1px 8px', borderRadius: '999px',
        border: '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #7c3aed) 50%, transparent)', color: 'var(--dsw-alias-brand-primary, #7c3aed)', whiteSpace: 'nowrap',
      },
      badge: {
        flex: '0 0 auto', fontSize: '11px', padding: '0 6px', borderRadius: '999px',
        border: '1px solid rgba(127,127,127,0.4)', opacity: 0.75, whiteSpace: 'nowrap',
      },
      attach: {
        flex: '0 0 auto', cursor: 'pointer', border: '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 60%, transparent)', borderRadius: '6px',
        color: 'var(--dsw-alias-brand-primary, #2563eb)', background: 'transparent', font: 'inherit', fontSize: '12px',
        padding: '1px 10px', whiteSpace: 'nowrap',
      },
      // 每段卡片阵列上方的小标题：颜色与卡片的左侧竖条同源。
      sectionLabel: { fontSize: '12px', fontWeight: 600, opacity: 0.9 },
    }

    /**
     * 一张项目卡。`options.focusId` 高亮正在看的项目，`options.anchoredId` 标「本项目」，
     * `options.badge` 是名称后的中性小标签（如「参考」），`onPick` 点卡片切过去看，
     * `onAttach` 存在时才画「挂上」按钮。
     * @param {object} item 路由返回的 projects[] 行。
     * @param {object} options 见上。
     * @returns {object} React 元素。
     */
    function projectCard(item, options = {}) {
      const { focusId = null, anchoredId = null, badge = '', busy = '', onPick, onAttach } = options
      const isAnchored = anchoredId !== null && anchoredId === item.id
      const isFocus = focusId !== null && focusId === item.id
      const hasLedger = (item?.nodes ?? 0) > 0 || (item?.notes ?? 0) > 0
      const key = STATUS_LABEL[item?.status] ? item.status : 'unknown'
      return h('div', {
        key: item.id,
        style: isFocus ? { ...cardStyles.card, ...cardStyles.cardOn } : cardStyles.card,
        title: `${t("点一下看 ")}${item.name ?? item.id}${t(" 的台账")}`,
        onClick: () => { if (typeof onPick === 'function') onPick(item.id) },
      },
        h('div', { style: cardStyles.top },
          h('span', { style: cardStyles.name }, item.name ?? item.id),
          isAnchored ? h('span', { style: cardStyles.tag }, t("本项目")) : null,
          badge !== '' ? h('span', { style: cardStyles.badge }, badge) : null,
          isFocus ? h('span', { style: cardStyles.dim }, t("· 正在看")) : null),
        // 编号·期间一行、状态跟在后面：编号长时只省略编号，不让状态被挤到第二行。
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
          h('span', { style: { ...cardStyles.meta, flex: '1 1 auto', minWidth: 0 } },
            [item.id, item.period].filter(Boolean).join(' · ')),
          h('span', { style: { ...ledgerStyles.chipStatus, flex: '0 0 auto', color: STATUS_COLOR[key], whiteSpace: 'nowrap' } }, t(STATUS_LABEL[key]))),
        h('div', { style: hasLedger ? cardStyles.metric : { ...cardStyles.metric, opacity: 0.5 } },
          hasLedger ? `${item.nodes ?? 0}${t(" 个节点 · ")}${item.notes ?? 0}${t(" 行台账")}` : t("暂无台账")),
        h('div', { style: cardStyles.summary }, item.summary ?? ''),
        h('div', { style: cardStyles.foot },
          h('span', { style: cardStyles.dim }, item.lastAt ? `${t("最近 ")}${stamp(item.lastAt)}` : t("无记录")),
          h('span', { style: cardStyles.spacer }),
          typeof onAttach === 'function' && !isAnchored
            ? h('button', {
                type: 'button',
                style: cardStyles.attach,
                disabled: busy !== '',
                onClick: event => {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  onAttach(item.id)
                },
              }, busy === item.id ? t("挂接中…") : t("挂上"))
            : null))
    }

    const styles = {
      root: {
        display: 'flex', height: '100%', width: '100%', minHeight: 0,
        fontFamily: 'inherit', fontSize: '13px', lineHeight: 1.6,
      },
      hint: { opacity: 0.6, padding: '24px 4px' },
      /** 页签整页：上头项目卡/候选 + 中间「全部项目」卡片阵列 + 下半台账，各自滚动。 */
      page: {
        display: 'flex', flexDirection: 'column', height: '100%', width: '100%',
        minHeight: 0, fontFamily: 'inherit', fontSize: '13px', lineHeight: 1.6,
      },
      ledgerPane: {
        flex: '1 1 auto', minWidth: 0, minHeight: 0, overflowY: 'auto',
        padding: '10px 16px 16px',
      },
      /** 页签头部的锚定卡：已锚定是中性描边，未锚定是黄框，一眼分得出"这是默认值还是真归属"。 */
      anchorCard: {
        border: '1px solid rgba(127,127,127,0.28)', borderRadius: '8px',
        padding: '10px 12px', margin: '10px 16px 0', display: 'flex', flexDirection: 'column', gap: '4px',
      },
      warnCard: {
        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 55%, transparent)', background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 8%, transparent)',
        borderRadius: '8px', padding: '10px 12px', margin: '10px 16px 0',
        display: 'flex', flexDirection: 'column', gap: '6px',
      },
      anchorTop: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '8px' },
      anchorTag: {
        fontSize: '11px', padding: '1px 8px', borderRadius: '999px',
        border: '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 50%, transparent)', color: 'var(--dsw-alias-brand-primary, #2563eb)',
      },
      warnTag: {
        fontSize: '11px', padding: '1px 8px', borderRadius: '999px',
        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 60%, transparent)', color: 'var(--dsw-alias-state-warn-primary, #d97706)', fontWeight: 600,
      },
      anchorName: { fontSize: '15px', fontWeight: 600 },
      anchorSummary: { fontSize: '12px', opacity: 0.75 },
      dimText: { fontSize: '12px', opacity: 0.62 },
      grow: { flex: '1 1 auto' },
      listToggle: {
        cursor: 'pointer', border: '1px solid rgba(127,127,127,0.32)', borderRadius: '6px',
        background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px',
        padding: '2px 10px',
      },
      candidateList: { display: 'flex', flexDirection: 'column', gap: '6px' },
      cardSection: { display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '8px' },
      suggestBlock: {
        display: 'flex', flexDirection: 'column', gap: '6px',
        marginTop: '8px', paddingTop: '8px', borderTop: '1px dashed rgba(127,127,127,0.28)',
      },
      candidate: {
        display: 'flex', flexDirection: 'column', gap: '2px',
        border: '1px solid rgba(127,127,127,0.24)', borderRadius: '6px', padding: '6px 10px',
      },
      attachButton: {
        alignSelf: 'flex-start', marginTop: '2px', cursor: 'pointer',
        border: '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 60%, transparent)', borderRadius: '6px', color: 'var(--dsw-alias-brand-primary, #2563eb)',
        background: 'transparent', font: 'inherit', fontSize: '12px', padding: '2px 12px',
      },
      notice: { margin: '8px 16px 0', fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, #16a34a)' },
      /** 注入粒度开关：一行小字 + 两枚胶囊按钮，不抢锚定卡的视线。 */
      modeRow: {
        display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '6px',
        margin: '6px 16px 0', fontSize: '12px',
      },
      modeButton: {
        cursor: 'pointer', border: '1px solid rgba(127,127,127,0.32)', borderRadius: '999px',
        background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px',
        padding: '1px 10px',
      },
      modeButtonOn: {
        borderColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 70%, transparent)', background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 12%, transparent)', color: 'var(--dsw-alias-brand-primary, #2563eb)',
      },
    }

    // ------------------------------------------------------------ 「项目锚定」页签

    /**
     * 「项目锚定」页签：锚定优先。
     *
     * 第一屏回答"这个会话属于哪个项目、那个项目做到哪儿了"，而不是先摊开一张项目清单：
     * - 已锚定 → 项目卡（编号/期间/状态/一句话）+ 该项目节点流（时间倒序，最近在上）；
     * - 未锚定 → 明确说"未锚定"，给出候选与依据（本会话已有几行台账落在哪个项目），
     *   点「挂上」直接写归属（走宿主 POST 路由），不再拿"最近有行"的项目冒充；
     * - 全部项目降级成一个可展开的入口，只在需要翻别的项目时才出现。
     *
     * @param {object} props shell 注入的标准 props（含 `sessionId`）。
     * @returns {object} React 元素。
     */
    function ProjectView(props) {
      // 会话 id 是 shell 的标准 prop：拿它问宿主"本会话锚定在哪个项目"
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const [state, setState] = React.useState({ status: 'loading', data: null, error: '' })
      const [suggestState, setSuggestState] = React.useState({ data: null, error: '' })
      const [selected, setSelected] = React.useState(null)
      const [showAll, setShowAll] = React.useState(false)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      // 注入粒度：digest＝四行摘要；card＝摘要 + 项目卡全文。存工作区，与会话无关。
      const [settings, setSettings] = React.useState({ contextMode: 'digest', modes: ['digest', 'card'] })
      const mounted = React.useRef(true)
      React.useEffect(() => () => { mounted.current = false }, [])

      const load = React.useCallback(async () => {
        const query = sessionId === '' ? '' : `?session=${encodeURIComponent(sessionId)}`
        try {
          const response = await fetch(`${LEDGER_ROUTE}${query}`, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          const text = await response.text()
          if (!response.ok) {
            throw new Error(`${t("宿主路由返回 ")}${response.status}：${text.slice(0, 200)}`)
          }
          const data = JSON.parse(text)
          probePanel('tab', {
            status: 'live',
            detail: `anchored:${data?.current?.anchored === true} projects:${Array.isArray(data?.projects) ? data.projects.length : 0}`,
          })
          if (mounted.current) setState({ status: 'live', data, error: '' })
          // 未锚定时才问"这几组像不像新项目"：已锚定的会话不需要建卡建议。
          if (data?.current?.anchored === true || sessionId === '') {
            if (mounted.current) setSuggestState({ data: null, error: '' })
          } else {
            await loadSuggestions()
          }
        } catch (error) {
          probePanel('tab', { status: 'failed', detail: String(error?.message ?? error).slice(0, 300) })
          if (mounted.current) {
            setState(previous => ({
              status: 'failed',
              data: previous.data,
              error: String(error?.message ?? error),
            }))
          }
        }
      }, [sessionId])

      /**
       * 取分组提案。失败只影响"建卡建议"这一块，不该把整页台账打成错误态，
       * 所以单独 catch：建议是锦上添花，台账是主内容。
       */
      const loadSuggestions = React.useCallback(async () => {
        try {
          const response = await fetch(`${SUGGEST_ROUTE}?session=${encodeURIComponent(sessionId)}`, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          const text = await response.text()
          if (!response.ok) throw new Error(text.slice(0, 200))
          if (mounted.current) setSuggestState({ data: JSON.parse(text), error: '' })
        } catch (error) {
          if (mounted.current) setSuggestState({ data: null, error: String(error?.message ?? error) })
        }
      }, [sessionId])

      /**
       * 读注入粒度。读不到不影响台账：开关是可选装饰，
       * 所以这里吞掉错误、保持"摘要"的默认显示。
       */
      const loadSettingsState = React.useCallback(async () => {
        try {
          const response = await fetch(SETTINGS_ROUTE, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) return
          const data = JSON.parse(await response.text())
          if (mounted.current && typeof data?.contextMode === 'string') {
            setSettings({
              contextMode: data.contextMode,
              modes: Array.isArray(data.modes) && data.modes.length > 0
                ? data.modes.map(String)
                : ['digest', 'card'],
            })
          }
        } catch {
          /* 开关是锦上添花，读不到就按默认摘要显示 */
        }
      }, [])

      /**
       * 切换注入粒度：改插件进程里的值（不落盘——浏览器请求没有沙箱授权），
       * 下一次注入（下一轮对话）即按新粒度渲染。
       */
      const saveMode = React.useCallback(async mode => {
        if (mode === settings.contextMode) return
        setBusy(`mode:${mode}`)
        setNotice('')
        try {
          const response = await fetch(SETTINGS_ROUTE, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ contextMode: mode }),
          })
          const text = await response.text()
          if (!response.ok) throw new Error(text.slice(0, 200))
          const data = JSON.parse(text)
          const next = typeof data?.contextMode === 'string' ? data.contextMode : mode
          if (mounted.current) {
            setSettings(previous => ({ contextMode: next, modes: previous.modes }))
            setNotice(next === 'card' ? t("注入改为「摘要 + 项目卡全文」") : t("注入改为「四行摘要」"))
          }
        } catch (error) {
          setNotice(`${t("切换失败：")}${String(error?.message ?? error)}`)
        } finally {
          if (mounted.current) setBusy('')
        }
      }, [settings.contextMode])

      React.useEffect(() => { void load() }, [load])
      React.useEffect(() => { void loadSettingsState() }, [loadSettingsState])
      React.useEffect(() => {
        const timer = window.setInterval(() => {
          if (document.visibilityState !== 'hidden') void load()
        }, TAB_REFRESH_MS)
        const onVisible = () => {
          if (document.visibilityState === 'visible') void load()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load])

      /** 一键挂接：写的是同一条归属事实（`_台账\归属.jsonl` 追加一行，by:'user'）。 */
      const attach = React.useCallback(async projectId => {
        if (sessionId === '') {
          setNotice(t("取不到会话 id，无法挂接"))
          return
        }
        setBusy(projectId)
        setNotice('')
        try {
          const response = await fetch(ATTACH_ROUTE, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId, project: projectId }),
          })
          const text = await response.text()
          if (!response.ok) throw new Error(text.slice(0, 200))
          setSelected(projectId)
          setNotice(`${t("已锚定到 ")}${projectId}`)
          probePanel('tab', { status: 'attached', detail: projectId })
          await load()
        } catch (error) {
          setNotice(`${t("挂接失败：")}${String(error?.message ?? error)}`)
        } finally {
          if (mounted.current) setBusy('')
        }
      }, [sessionId, load])

      /**
       * 把一组提案登记成项目。
       *
       * 提案里只有名字和依据，没有"一句话"——用覆盖的节点标题拼一句，
       * 让人在项目卡上仍能看出这东西是什么；真正的措辞可以在卡里改。
       */
      const registerProject = React.useCallback(async (suggestion, key) => {
        if (sessionId === '') {
          setNotice(t("取不到会话 id，无法建卡"))
          return
        }
        setBusy(key)
        setNotice('')
        const nodes = Array.isArray(suggestion?.nodes) ? suggestion.nodes.filter(Boolean) : []
        try {
          const response = await fetch(REGISTER_ROUTE, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              session: sessionId,
              name: suggestion?.name ?? '',
              summary: nodes.length > 0 ? `${t("本会话 ")}${suggestion.rows}${t(" 条台账结论的归集：")}${nodes.slice(0, 2).join('、')}` : t("本会话台账结论的归集"),
              basis: suggestion?.basis ?? '',
            }),
          })
          const text = await response.text()
          let payload = null
          try { payload = JSON.parse(text) } catch { payload = null }
          if (!response.ok || payload?.registered === false) {
            throw new Error(payload?.reason ?? payload?.error ?? text.slice(0, 200))
          }
          setSelected(payload?.project?.id ?? null)
          setNotice(`${t("已建卡 ")}${payload?.project?.id ?? ''} ${payload?.project?.name ?? ''}`.trim())
          probePanel('tab', { status: 'registered', detail: String(payload?.project?.id ?? '') })
          await load()
        } catch (error) {
          setNotice(`${t("建卡失败：")}${String(error?.message ?? error)}`)
        } finally {
          if (mounted.current) setBusy('')
        }
      }, [sessionId, load])

      try {
        return buildProjectView()
      } catch (error) {
        // 宁可显示一行错误，也不要整页空白
        probePanel('tab', { status: 'error', detail: String(error?.message ?? error).slice(0, 300) })
        return h('div', { style: styles.root },
          h('div', { style: styles.hint }, `${t("「项目锚定」页签渲染出错：")}${String(error?.message ?? error)}`))
      }

      function buildProjectView() {
        const data = state.data
        const projects = Array.isArray(data?.projects) ? data.projects : []
        const current = data?.current ?? null
        const anchored = current?.anchored === true
        const candidates = Array.isArray(data?.candidates) ? data.candidates : []
        // 强证据＝本会话的台账行就落在这个项目上；弱证据＝只是结论里提到过项目名。
        // 有强证据时弱证据全部退到末尾一行文字里（不画卡、不给「挂上」），
        // 否则一个会话会把"顺口提到的项目"当成推荐，噪音盖过真正的归属。
        const strongCandidates = candidates.filter(item => item.strong === true)
        const weakCandidates = candidates.filter(item => item.strong !== true)
        const visibleCandidates = strongCandidates.length > 0 ? strongCandidates : weakCandidates
        const hiddenWeakCandidates = strongCandidates.length > 0 ? weakCandidates : []
        const suggestions = Array.isArray(suggestState.data?.suggestions) ? suggestState.data.suggestions : []

        // 建议卡的名字来自节点标题，常常整排都带同一段前缀（如「项目锚定插件-」）。
        // 把公共前缀提到小标题里，卡片里只留差异部分，四列一排才不至于每个名字都折两行。
        const stripCommonPrefix = names => {
          if (names.length < 2) return { prefix: '', short: name => name }
          let prefix = names[0]
          for (const name of names) {
            let index = 0
            while (index < prefix.length && index < name.length && prefix[index] === name[index]) index += 1
            prefix = prefix.slice(0, index)
          }
          // 退到最后一个分隔符之后，避免把词从中间切开（「项目锚定插件-台账…」→ 保留「项目锚定插件-」）
          const cut = Math.max(prefix.lastIndexOf('-'), prefix.lastIndexOf('·'), prefix.lastIndexOf(' '), prefix.lastIndexOf('：'))
          if (cut >= 3) prefix = prefix.slice(0, cut + 1)
          if (prefix.trim().length < 4) return { prefix: '', short: name => name }
          return {
            prefix,
            short: name => (String(name ?? '').startsWith(prefix) ? String(name).slice(prefix.length).trim() || name : name),
          }
        }
        const suggestionNames = stripCommonPrefix(suggestions.map(item => String(item?.name ?? '')))

        // 显示哪个项目的台账：手动选过的优先，其次本会话锚定的那个；未锚定时不猜
        const focusId = selected ?? (anchored ? current?.projectId ?? null : null)
        const focus = projects.find(item => item.id === focusId) ?? null

        const head = anchored
          ? h('div', { style: styles.anchorCard },
              h('div', { style: styles.anchorTop },
                h('span', { style: styles.anchorTag }, t("本项目")),
                h('span', { style: styles.anchorName }, focus?.name ?? current?.projectId ?? t("（未知项目）")),
                h('span', { style: styles.dimText },
                  [current?.projectId, focus?.period, focus?.status].filter(Boolean).join(' · ')),
                h('span', { style: styles.grow }),
                h('button', {
                  type: 'button',
                  style: styles.listToggle,
                  onClick: () => setShowAll(value => !value),
                }, showAll ? t("收起项目列表") : `${t("全部项目（")}${projects.length}${t("）")}`)),
              focus?.summary ? h('div', { style: styles.anchorSummary }, focus.summary) : null)
          : h('div', { style: styles.warnCard },
              h('div', { style: styles.anchorTop },
                h('span', { style: styles.warnTag }, t("本会话尚未锚定")),
                h('span', { style: styles.dimText },
                  showAll
                    ? t("下面带「参考」标记的，是按\"这个会话已经产生的台账行落在哪\"算出来的推荐；其余是登记过的全部项目。")
                    : t("下面的候选是按\"这个会话已经产生的台账行落在哪\"算出来的，不是你选的默认值。")),
                h('span', { style: styles.grow }),
                h('button', {
                  type: 'button',
                  style: styles.listToggle,
                  onClick: () => setShowAll(value => !value),
                }, showAll ? t("收起项目列表") : `${t("全部项目（")}${projects.length}）`)),
              // 候选块只在"收起项目列表"时出现；展开「全部项目」后候选就是下面卡片的
              // 前几张（带「参考」标签），不再重复画一遍同样的三个挂接按钮。
              // 候选也用卡片：「为什么推荐它」和「它有几行台账」一句话塞不下，
              // 而且和下面的建卡建议、全部项目的卡片保持同一套观感。
              showAll
                ? null
                : candidates.length === 0
                  ? h('div', { style: styles.dimText }, t("这个会话还没有产生任何台账行，所以给不出候选。"))
                  : h('div', { style: styles.cardSection },
                      h('div', { style: { ...cardStyles.sectionLabel, color: 'var(--dsw-alias-brand-primary, #2563eb)' } },
                        strongCandidates.length > 0
                          ? t("候选：本会话的台账行落在这几个项目")
                          : t("候选：本会话可能属于这几个项目")),
                      h('div', { style: cardStyles.grid }, visibleCandidates.map(item => h('div', {
                        key: item.id,
                        style: { ...cardStyles.card, ...cardStyles.cardCandidate, cursor: 'default' },
                        title: `${t("点「挂上」把本会话记到 ")}${item.name}`,
                      },
                        h('div', { style: cardStyles.top },
                          h('div', { style: cardStyles.name }, item.name),
                          item.rows > 0 ? h('span', { style: cardStyles.badge }, `${item.rows}${t(" 行")}`) : null,
                          item.strong ? null : h('span', { style: cardStyles.tag }, t("参考"))),
                        h('div', { style: cardStyles.wrap },
                          `${item.id}${item.period ? ` · ${item.period}` : ''}${item.status ? ` · ${item.status}` : ''}`),
                        h('div', { style: cardStyles.wrap }, item.why),
                        h('div', { style: cardStyles.foot },
                          // 弱证据的 why 里已经写了"该项目最近有台账行（日期）"，脚注再写一遍就是重复。
                          h('span', { style: cardStyles.dim },
                            item.strong
                              ? (item.lastAt ? `${t("最近 ")}${stamp(item.lastAt)}` : `${t("落在该项目 ")}${item.rows}${t(" 行")}`)
                              : t("本会话无台账行")),
                          h('span', { style: cardStyles.spacer }),
                          h('button', {
                            type: 'button',
                            style: cardStyles.attach,
                            disabled: busy !== '',
                            onClick: () => void attach(item.id),
                          }, busy === item.id ? t("挂接中…") : t("挂上")))))),
                      hiddenWeakCandidates.length > 0
                        ? h('div', { style: cardStyles.wrap },
                            `${t("另有 ")}${hiddenWeakCandidates.length}${t(" 个项目只是被提到过、本会话没有台账行：")}`
                            + hiddenWeakCandidates.map(item => item.name).join('、'))
                        : null),
              // 建卡建议：候选是"挂到已有项目"，这一段是"这批结论还没有项目，要不要立项"。
              // 两者都只在收起态出现——展开「全部项目」时页面已经被卡片占满。
              // 建议也用卡片：行里塞不下"覆盖哪些节点/哪些文件"，而判据本身就是多行文字。
              !showAll && suggestions.length > 0
                ? h('div', { style: styles.suggestBlock },
                    h('div', { style: { ...cardStyles.sectionLabel, color: 'var(--dsw-alias-brand-primary, #7c3aed)' } },
                      `${t("建卡建议：另有 ")}${suggestState.data.sessionRows}${t(" 条结论还没归属")}`
                      + (suggestionNames.prefix ? `${t("，都在「")}${suggestionNames.prefix.replace(/[-·：\s]+$/, '')}${t("」下")}` : '')),
                    h('div', { style: cardStyles.wrap },
                      t("下面这几组看起来是同一件事，但目前还没有对应项目：")),
                    h('div', { style: cardStyles.grid }, suggestions.map(item => {
                      const nodes = [...new Set((item.nodes ?? []).filter(Boolean))]
                      const files = [...new Set((item.files ?? []).filter(Boolean))]
                      return h('div', {
                        key: `s-${item.index}`,
                        style: { ...cardStyles.card, ...cardStyles.cardSuggest, cursor: 'default' },
                        title: `${t("点「建卡」才会登记；判据：")}${item.basis}`,
                      },
                        h('div', { style: cardStyles.top },
                          h('div', { style: cardStyles.nameWide }, suggestionNames.short(item.name)),
                          h('span', { style: cardStyles.tagSuggest }, `${item.rows}${t(" 条")}`)),
                        h('div', { style: cardStyles.wrap }, item.basis),
                        nodes.length > 0
                          ? h('div', { style: cardStyles.wrap }, `${t("覆盖节点：")}${nodes.slice(0, 3).join('、')}${nodes.length > 3 ? `${t(" 等 ")}${nodes.length}${t(" 个")}` : ''}`)
                          : null,
                        files.length > 0
                          ? h('div', { style: cardStyles.wrap }, `${t("涉及文件：")}${files.slice(0, 2).join('、')}${files.length > 2 ? `${t(" 等 ")}${files.length}${t(" 个")}` : ''}`)
                          : null,
                        h('div', { style: cardStyles.foot },
                          h('span', { style: cardStyles.dim }, `${t("未归属 ")}${item.rows}${t(" 条")}`),
                          h('span', { style: cardStyles.spacer }),
                          h('button', {
                            type: 'button',
                            style: cardStyles.attach,
                            disabled: busy !== '',
                            onClick: () => void registerProject(item, `register:${item.index}`),
                          }, busy === `register:${item.index}` ? t("建卡中…") : t("建卡"))))
                    })))
                : null)

        // 「全部项目」：卡片阵列（与详情页项目切换共用 projectCard），等宽等高，
        // 名称过长由卡片自己省略，不把整行撑变形。候选排在最前并标「参考」，
        // 这样"推荐"和"全集"是同一套卡，不再各画一遍。
        const candidateIds = candidates.map(item => item.id)
        const badgeOf = id => {
          const item = candidates.find(entry => entry.id === id)
          if (!item) return ''
          return item.strong === true ? t("参考") : t("仅提到")
        }
        const rankOf = id => {
          const index = candidateIds.indexOf(id)
          return index === -1 ? Number.MAX_SAFE_INTEGER : index
        }
        const rankedProjects = showAll
          ? projects.slice().sort((left, right) => rankOf(left.id) - rankOf(right.id))
          : projects
        const projectGrid = showAll
          ? h('div', { style: cardStyles.grid }, rankedProjects.map(item => projectCard(item, {
              focusId: focus?.id ?? null,
              anchoredId: current?.anchored === true ? current.attachedId ?? null : null,
              badge: badgeOf(item.id),
              busy,
              onPick: setSelected,
              onAttach: id => void attach(id),
            })))
          : null

        const pane = focus
          ? h(LedgerPanel, { view: 'page', project: focus.id, desc: true })
          : h('div', { style: styles.hint },
              anchored
                ? t("这个项目还没有台账节点。")
                : t("先挂到上面的候选项目，这里就显示它的台账节点流；也可以点「全部项目」翻别的项目。"))

        // 注入粒度开关：只对"已锚定"的会话有意义（新会话自动判定后注入什么），
        // 未锚定时注入本来就是空的，摆个开关只会让人以为它能改变什么。
        const contextSwitch = anchored
          ? h('div', { style: styles.modeRow },
              h('span', { style: styles.dimText }, t("新会话自动判定后注入的上下文：")),
              ...settings.modes.map(mode => h('button', {
                key: mode,
                type: 'button',
                style: settings.contextMode === mode
                  ? { ...styles.modeButton, ...styles.modeButtonOn }
                  : styles.modeButton,
                disabled: busy !== '',
                title: mode === 'card'
                  ? t("整张项目卡原文一并注入：更详尽，但占更多上下文")
                  : t("只注入四行摘要：期间 / 已定口径 / 禁入区 / 续开点"),
                onClick: () => void saveMode(mode),
              }, t(CONTEXT_MODE_LABELS[mode] ?? mode))),
              h('span', { style: styles.dimText },
                settings.contextMode === 'card' ? t("（更详尽，占更多上下文）") : t("（省上下文）")),
              // 值不落盘：说清楚，免得用户下次开机发现又回摘要以为是 bug。
              h('span', { style: styles.dimText }, t("· 本次运行有效")))
          : null

        return h('div', { style: styles.page },
          head,
          contextSwitch,
          notice !== '' ? h('div', { style: styles.notice }, notice) : null,
          projectGrid,
          h('div', { style: styles.ledgerPane },
            state.error !== ''
              ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontSize: '12px' } }, state.error)
              : null,
            pane))
      }
    }

    // ------------------------------------------------------------ 台账面板

    const ledgerStyles = {
      root: { display: 'flex', flexDirection: 'column', gap: '10px', fontFamily: 'inherit', fontSize: '13px', lineHeight: 1.65, color: 'inherit' },
      bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '10px' },
      heading: { fontSize: '14px', fontWeight: 600 },
      dim: { opacity: 0.6, fontSize: '12px' },
      spacer: { flex: '1 1 auto' },
      button: {
        cursor: 'pointer', border: '1px solid rgba(127,127,127,0.35)', borderRadius: '6px',
        background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px',
        padding: '3px 10px',
      },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      chip: {
        cursor: 'pointer', border: '1px solid rgba(127,127,127,0.32)', borderRadius: '999px',
        background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px',
        padding: '1px 10px',
      },
      chipOn: { borderColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 70%, transparent)', background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 12%, transparent)' },
      totals: { display: 'flex', flexWrap: 'wrap', gap: '14px', fontSize: '12px', opacity: 0.75 },
      warning: {
        borderLeft: '3px solid var(--dsw-alias-state-warn-primary, #d97706)', background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d97706) 10%, transparent)',
        padding: '6px 10px', borderRadius: '4px', fontSize: '12px',
      },
      card: {
        border: '1px solid rgba(127,127,127,0.3)', borderRadius: '8px',
        marginBottom: '10px', overflow: 'hidden',
      },
      cardHead: {
        display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '8px',
        padding: '9px 12px', borderBottom: '1px solid rgba(127,127,127,0.18)',
        background: 'rgba(127,127,127,0.06)',
      },
      cardBody: { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '10px' },
      nodeTitle: { fontWeight: 600 },
      chipStatus: { border: '1px solid currentColor', borderRadius: '999px', padding: '0 8px', fontSize: '11px' },
      note: { display: 'flex', flexDirection: 'column', gap: '4px' },
      noteHead: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'baseline', fontSize: '12px', opacity: 0.7 },
      noteText: { whiteSpace: 'pre-wrap', margin: 0 },
      table: { borderCollapse: 'collapse', fontSize: '12px' },
      th: { textAlign: 'left', fontWeight: 600, padding: '3px 10px 3px 0', opacity: 0.75, borderBottom: '1px solid rgba(127,127,127,0.25)' },
      td: { padding: '3px 10px 3px 0', borderBottom: '1px solid rgba(127,127,127,0.12)', verticalAlign: 'top' },
      open: { borderLeft: '3px solid var(--dsw-alias-state-warn-primary, #d97706)', padding: '2px 0 2px 8px', fontSize: '12.5px' },
      next: { borderLeft: '3px solid var(--dsw-alias-state-success-primary, #16a34a)', padding: '2px 0 2px 8px', fontSize: '12.5px' },
      label: { opacity: 0.62, fontSize: '12px' },
      filter: {
        border: '1px solid rgba(127,127,127,0.32)', borderRadius: '6px', background: 'transparent',
        color: 'inherit', font: 'inherit', fontSize: '12px', padding: '3px 8px', minWidth: '180px',
      },
      empty: { opacity: 0.6, padding: '18px 4px' },
      err: { borderLeft: '3px solid var(--dsw-alias-state-error-primary, #dc2626)', background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 10%, transparent)', padding: '8px 10px', borderRadius: '4px', fontSize: '12px' },
    }

    /** ISO → `MM-DD HH:MM`；取不到时原样返回。 */
    function stamp(iso) {
      const text = String(iso ?? '')
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text)
      return match ? `${match[2]}-${match[3]} ${match[4]}:${match[5]}` : text
    }

    /** 只取 HH:MM:SS。 */
    function clock(iso) {
      const match = /T(\d{2}:\d{2}:\d{2})/.exec(String(iso ?? ''))
      return match ? match[1] : String(iso ?? '')
    }

    function statusChip(status) {
      const key = STATUS_LABEL[status] ? status : 'unknown'
      return h('span', { style: { ...ledgerStyles.chipStatus, color: STATUS_COLOR[key] } }, t(STATUS_LABEL[key]))
    }

    /** 关键数字表。 */
    function numbersTable(numbers) {
      if (!Array.isArray(numbers) || numbers.length === 0) return null
      const rows = numbers.map((item, index) => h('tr', { key: `${index}-${item?.name ?? ''}` },
        h('td', { style: ledgerStyles.td }, String(item?.name ?? '')),
        h('td', { style: { ...ledgerStyles.td, fontWeight: 600 } }, String(item?.value ?? '')),
        h('td', { style: { ...ledgerStyles.td, opacity: 0.6 } }, String(item?.basis ?? ''))))
      return h('table', { style: ledgerStyles.table },
        h('thead', null, h('tr', null,
          h('th', { style: ledgerStyles.th }, t("指标")),
          h('th', { style: ledgerStyles.th }, t("数值")),
          h('th', { style: ledgerStyles.th }, t("口径 / 依据")))),
        h('tbody', null, rows))
    }

    /** 单条结论。 */
    function noteBlock(note, index) {
      const children = [
        h('div', { key: 'head', style: ledgerStyles.noteHead },
          h('span', { style: { fontWeight: 600, opacity: 0.9 } }, clock(note?.at)),
          note?.source === 'index' ? h('span', null, t("来自索引·结论待 md 落盘")) : null),
        note?.text ? h('p', { key: 'text', style: ledgerStyles.noteText }, String(note.text)) : null,
      ]
      const table = numbersTable(note?.numbers)
      if (table) children.push(h('div', { key: 'numbers' }, table))
      if (Array.isArray(note?.open) && note.open.length > 0) {
        children.push(h('div', { key: 'open', style: ledgerStyles.open },
          h('div', { style: ledgerStyles.label }, t("未决")),
          h('ul', { style: { margin: '2px 0 0', paddingLeft: '18px' } },
            note.open.map((item, i) => h('li', { key: i }, String(item))))))
      }
      if (typeof note?.next === 'string' && note.next !== '') {
        children.push(h('div', { key: 'next', style: ledgerStyles.next },
          h('span', { style: ledgerStyles.label }, t("下一步：")),
          h('span', null, note.next)))
      }
      return h('div', { key: note?.at ?? index, style: ledgerStyles.note }, children)
    }

    /**
     * 单个节点卡片。
     *
     * 卡片头永远显示（序号、标题、状态、时间、证据/结论条数），正文按需展开：
     * 一个项目几十个节点，全展开会变成一条读不完的长河，先给目录再给内容。
     *
     * @param {object} node 台账节点。
     * @param {boolean} open 正文是否展开。
     * @param {Function} onToggle 切换展开。
     */
    function nodeCard(node, open, onToggle) {
      const notes = Array.isArray(node?.notes) ? node.notes : []
      const head = h('div', {
        style: { ...ledgerStyles.cardHead, cursor: 'pointer' },
        onClick: onToggle,
        title: open ? t("收起这个节点") : t("展开这个节点"),
      },
        h('span', { style: { ...ledgerStyles.dim, width: '10px' } }, open ? '▾' : '▸'),
        h('span', { style: ledgerStyles.dim }, String(node?.index ?? '')),
        h('span', { style: ledgerStyles.nodeTitle }, String(node?.title ?? t("(未命名节点)"))),
        statusChip(node?.status),
        h('span', { style: ledgerStyles.dim },
          [stamp(node?.firstAt), stamp(node?.lastAt) !== stamp(node?.firstAt) ? stamp(node?.lastAt) : '']
            .filter(Boolean).join(' → ')),
        node?.evidence > 0 ? h('span', { style: ledgerStyles.dim }, `${t("证据 ")}${node.evidence}${t(" 条")}`) : null,
        notes.length > 0 ? h('span', { style: ledgerStyles.dim }, `${notes.length}${t(" 条结论")}`) : null,
        Array.isArray(node?.sessions) && node.sessions.length > 0
          ? h('span', { style: ledgerStyles.dim },
              node.sessions.map(item => item.shortId || item.id).filter(Boolean).join(' / '))
          : null)
      return h('div', { key: `${node?.index}-${node?.title}`, style: ledgerStyles.card },
        head,
        open
          ? h('div', { style: ledgerStyles.cardBody },
              notes.length > 0
                ? notes.map((note, index) => noteBlock(note, index))
                : h('div', { style: ledgerStyles.empty }, t("这个节点还没有结论。")))
          : null)
    }

    /**
     * 面板自报：把"挂载了没有、取到数没有"回打给宿主（宿主记在内存里，`project_ping` 可见）。
     *
     * 详情页空白时没有 devtools 可看，这一条回执是唯一能区分"slot 没渲染"和
     * "渲染了但取数失败"的证据。回执失败一律吞掉，不能影响面板本身。
     *
     * @param {string} event `mount` | `loaded`
     * @param {object} [params] 附加字段（status / nodes / detail）。
     * @returns {void}
     */
    function probePanel(event, params) {
      try {
        const query = new URLSearchParams({ probe: event, ...(params ?? {}) })
        fetch(`${LEDGER_ROUTE}?${query.toString()}`, { cache: 'no-store', keepalive: true }).catch(() => {})
      } catch {
        /* 回执失败不影响面板 */
      }
    }

    /**
     * 插件详情页的台账面板。
     *
     * 数据源是宿主路由 `/project-anchor/ledger`：每次打开/切项目/定时都会重新读文件，
     * 所以 work_note 写了新结论、项目卡改了续开点，这里会跟着变，不依赖任何事件推送。
     *
     * @param {object} props `plugins.bundle.config` 的 ownerProps：{ view, form }。
     * @returns {object|null} React 元素。
     */
    function LedgerPanel(props) {
      const view = props?.view === 'summary' ? 'summary' : 'page'
      // 页签里复用时由外部指定项目（左侧列表选中的那个）；详情页没有这个 prop，走自己的 chips
      const bound = typeof props?.project === 'string' && props.project !== '' ? props.project : null
      const [state, setState] = React.useState({ status: 'loading', data: null, error: '' })
      const [picked, setPicked] = React.useState(null)
      const [filter, setFilter] = React.useState('')
      // 节点展开状态：undefined 表示按默认（最近活动的那个节点默认展开）
      const [openMap, setOpenMap] = React.useState({})

      const mounted = React.useRef(true)
      React.useEffect(() => () => { mounted.current = false }, [])
      // 挂载即回执：这条到了，说明 slot 真的渲染到本插件，剩下的就只是取数问题
      // detail 区分挂载点：页签里带 tab:<项目>，详情页写 detail
      React.useEffect(() => { probePanel('mount', { status: view, detail: bound ? `tab:${bound}` : 'detail' }) }, [])

      const load = React.useCallback(async projectId => {
        const query = projectId ? `?project=${encodeURIComponent(projectId)}` : ''
        try {
          const response = await fetch(`${LEDGER_ROUTE}${query}`, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          const text = await response.text()
          if (!response.ok) {
            throw new Error(`${t("宿主路由返回 ")}${response.status}：${text.slice(0, 200)}`)
          }
          const data = JSON.parse(text)
          probePanel('loaded', { status: 'live', nodes: String(data?.project?.totals?.nodes ?? 0) })
          if (mounted.current) setState({ status: 'live', data, error: '' })
        } catch (error) {
          probePanel('loaded', { status: 'failed', detail: String(error?.message ?? error) })
          if (mounted.current) {
            setState(previous => ({
              status: 'failed',
              data: previous.data,
              error: String(error?.message ?? error),
            }))
          }
        }
      }, [])

      // 页签里选中别的项目时，把面板切过去（详情页没有 bound，不受影响）
      React.useEffect(() => { if (bound) setPicked(bound) }, [bound])

      React.useEffect(() => { void load(picked) }, [load, picked])

      React.useEffect(() => {
        const timer = window.setInterval(() => {
          if (document.visibilityState !== 'hidden') void load(picked)
        }, REFRESH_MS)
        const onVisible = () => {
          if (document.visibilityState === 'visible') void load(picked)
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          window.clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load, picked])

      // 概览态只给一行字：页面把 summary 渲染成配置行，不能塞整块面板
      if (view === 'summary') {
        const data = state.data
        const projectName = data?.project?.name ?? t("（未取到台账）")
        return h('div', { style: { fontSize: '12px', opacity: 0.75 } },
          `${t("工作台账：")}${projectName} · ${data?.project?.totals?.nodes ?? 0}${t(" 个节点")}`)
      }

      const data = state.data
      const projects = Array.isArray(data?.projects) ? data.projects : []
      const project = data?.project ?? null
      const totals = project?.totals ?? null
      const warnings = Array.isArray(project?.warnings) ? project.warnings : []

      const keyword = filter.trim().toLowerCase()
      const filtered = (Array.isArray(project?.nodes) ? project.nodes : []).filter(node => {
        if (keyword === '') return true
        const haystack = [
          node?.title,
          ...(Array.isArray(node?.notes) ? node.notes.map(note => `${note?.text ?? ''} ${note?.next ?? ''} ${(note?.open ?? []).join(' ')}`) : []),
        ].join(' ').toLowerCase()
        return haystack.includes(keyword)
      })
      // 节点流按“最近在上”排（页签传 desc:true）；详情页仍按台账文件的记录顺序
      const nodes = props?.desc === true
        ? filtered.slice().sort((a, b) => String(b?.lastAt ?? '').localeCompare(String(a?.lastAt ?? '')))
        : filtered

      // 最近活动的节点默认展开：打开面板先看到"最近在干什么"，其余折叠成目录
      const latestKey = nodes.reduce((best, node) => {
        const key = String(node?.index ?? '')
        if (best === null) return key
        const bestNode = nodes.find(item => String(item?.index ?? '') === best)
        return String(node?.lastAt ?? '') > String(bestNode?.lastAt ?? '') ? key : best
      }, null)

      /** 这个节点正文是否展开；搜索时全部展开，方便看命中上下文。 */
      function isOpenOf(node) {
        const key = String(node?.index ?? '')
        if (keyword !== '') return true
        const explicit = openMap[key]
        return typeof explicit === 'boolean' ? explicit : key === latestKey
      }

      const allOpenNodes = nodes.length > 0 && nodes.every(isOpenOf)

      const header = h('div', { style: ledgerStyles.bar },
        h('span', { style: ledgerStyles.heading }, t("工作台账")),
        project ? h('span', { style: { fontWeight: 600 } }, project.name) : null,
        project ? h('span', { style: ledgerStyles.dim },
          [project.id, project.period || t("期间未登记"), project.status || ''].filter(Boolean).join(' · ')) : null,
        h('span', { style: ledgerStyles.spacer }),
        state.status === 'failed' ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary, #dc2626)', fontSize: '12px' } }, t("取数失败")) : null,
        state.status === 'live' && data?.generatedAt
          ? h('span', { style: ledgerStyles.dim }, `${t("数据 ")}${stamp(data.generatedAt)}`)
          : null,
        nodes.length > 1 && keyword === ''
          ? h('button', {
              type: 'button',
              style: ledgerStyles.button,
              onClick: () => setOpenMap(Object.fromEntries(nodes.map(node => [String(node?.index ?? ''), !allOpenNodes]))),
            }, allOpenNodes ? t("收起全部") : t("展开全部"))
          : null,
        h('button', { type: 'button', style: ledgerStyles.button, onClick: () => void load(picked) }, t("刷新")))

      // 详情页没有会话归属，项目切换只能"看"，不能"挂"：同一套卡片，去掉挂接按钮。
      const projectCards = bound === null && projects.length > 0
        ? h('div', { style: styles.cardSection },
            h('div', { style: { ...cardStyles.sectionLabel, color: 'rgba(127,127,127,0.9)' } },
              t("全部项目：点一张卡看它的台账")),
            h('div', { style: cardStyles.grid },
              projects.map(item => projectCard(item, {
                focusId: project?.id ?? null,
                onPick: setPicked,
              }))))
        : null

      const totalsRow = totals
        ? h('div', { style: ledgerStyles.totals },
            h('span', null, `${totals.nodes}${t(" 个节点")}`),
            h('span', null, `${totals.notes}${t(" 条结论")}`),
            h('span', null, `${totals.evidence}${t(" 条证据")}`),
            h('span', null, `${totals.sessions}${t(" 个会话")}`),
            h('span', null, `${totals.indexRows}${t(" 行索引")}`),
            data?.unassigned > 0 ? h('span', { style: { color: 'var(--dsw-alias-state-warn-primary, #d97706)' } }, `${t("另有 ")}${data.unassigned}${t(" 行未归属")}`) : null)
        : null

      const body = []
      if (state.error !== '') body.push(h('div', { key: 'err', style: ledgerStyles.err }, state.error))
      if (warnings.length > 0) {
        body.push(h('div', { key: 'warn', style: ledgerStyles.warning },
          warnings.map((text, index) => h('div', { key: index }, String(text)))))
      }
      if (state.status === 'loading' && data === null) {
        body.push(h('div', { key: 'loading', style: ledgerStyles.empty }, t("正在读台账…")))
      } else if (project === null) {
        body.push(h('div', { key: 'none', style: ledgerStyles.empty },
          t("还没有可展示的台账：先在会话里用 work_note 记一条节点，再刷新。")))
      } else if (nodes.length === 0) {
        body.push(h('div', { key: 'nofilter', style: ledgerStyles.empty },
          keyword === '' ? t("这个项目还没有台账节点。") : `${t("没有节点匹配「")}${filter}${t("」。")}`))
      } else {
        body.push(h('div', { key: 'filter' },
          h('input', {
            type: 'text',
            value: filter,
            placeholder: t("按节点名 / 结论 / 未决过滤"),
            style: ledgerStyles.filter,
            onChange: event => setFilter(event.target.value),
          })))
        for (const node of nodes) {
          body.push(nodeCard(node, isOpenOf(node), () => {
            const key = String(node?.index ?? '')
            setOpenMap(previous => ({ ...previous, [key]: !isOpenOf(node) }))
          }))
        }
      }

      return h('div', { style: ledgerStyles.root },
        header, projectCards, totalsRow, ...body)
    }

    /**
     * 插件详情页的 section 包装：只在本插件的页面上渲染台账，别人的页面返回 null。
     *
     * 为什么用 `plugins.detail.section` 而不是 `plugins.bundle.config`：后者是"bundle 自己的
     * 配置卡"，purpose 写明只在 `view:'page'` 渲染；本插件的配置在行（row）上、没有 bundle 级
     * 配置，该 slot 在详情页里可能根本不渲染——这正好解释"页面是空的"。section 的 purpose 是
     * "Sections under a detail page's own content: after the source on a bundle's page, after the
     * configuration on a row's or an official plugin's page"，对无内容 subject 返回 null 正是约定。
     *
     * ownerProps 只有 `{ subject: PluginsSubject }`（bundle{pkg} | row{pkg,row} | item{id}），
     * 所以必须自己按包名过滤。
     *
     * @param {object} props `plugins.detail.section` 的 ownerProps：{ subject }。
     * @returns {object|null} React 元素。
     */
    function LedgerSection(props) {
      const subject = props?.subject
      const kind = subject?.kind
      if (kind !== 'bundle' && kind !== 'row') return null
      if (subject?.pkg?.name !== BUNDLE_KEY) return null
      return h(LedgerPanel, { view: 'page' })
    }

    // ------------------------------------------------------------ 注册

    /**
     * @param {object} ctx 受限的客户端插件上下文。
     */
    function apply(ctx) {
      clientCtx = ctx
      // 可见文案走 Client locale service：注册中英词典，再把 t 绑到当前语言。
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        try {
          locale.register(LOCALE_NS, 'zh', TEXT_ZH)
          locale.register(LOCALE_NS, 'en', TEXT_EN)
        } catch (error) {
          // 已经注册过（HMR 重新 apply）：沿用已有词典，不当作失败。
        }
        try {
          translate = locale.bind(LOCALE_NS)
        } catch (error) {
          translate = text => text
        }
      }
      // 两件都要做：注册 view target 才出现在切换器里，注册 slot 才真正渲染。
      ctx.uiConversation.views.register({
        target: VIEW_ID,
        create: () => ({ apply: () => EMPTY_VIEW_SNAPSHOT, replace: () => EMPTY_VIEW_SNAPSHOT }),
      })
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: VIEW_ID,
        order: 6,
        // label 允许是 thunk：切换语言时 owner 每次投影都重读，页签名跟着变。
        label: () => t("项目锚定"),
      }, ProjectView))

      // 插件详情页的台账面板：section 挂在详情页正文之后，对本插件的 bundle / row 页渲染
      ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
        name: 'plugins.detail.section',
        id: 'project-anchor-ledger',
        order: 30,
        label: () => t("工作台账"),
      }, LedgerSection))
    }

    const module = { exports: {} }
    module.exports.name = 'project-anchor-client'
    module.exports.apply = apply
    /** 声明必需服务：缺 `uiConversation` 会在服务就绪前执行、视图静默消失。 */
    module.exports.inject = ['slots', 'uiConversation', 'uiWorkspace', 'locale']
    return module.exports
  },
})
