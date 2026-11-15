# dsh-project-anchor

<!--
  「项目锚定」：把会话挂到项目上，并在新会话第一句话到达时自动判定归属。
  客户端文案走 Client locale 服务（命名空间 `dsh-project-anchor`），中英两套。
-->

A DSH bundle that anchors a session to a project, and — on the first message of a new
session — decides whether that message belongs to an existing project. High confidence
attaches the session automatically; medium confidence injects a one-line hint; when the
work clearly belongs nowhere it asks once whether to register a new project.

## 安装

要求 DSH `>=0.2.0-rc.2 <0.3.0`（见 `package.json` 的 `engines.dsh`）。`@deepseek-ai/schemastery`
与宿主共享实例，写在 `peerDependencies` + `devDependencies`，不要装成独立依赖。

```bash
# 从 GitHub 装（按 release tag，可复现）
#   plugin_manager install_bundle { target: "git+https://github.com/lvguqingyou/dsh-project-anchor.git#v0.2.0" }

# 本地 tarball（先 npm pack）
dsh plugin install ./dsh-project-anchor-0.2.0.tgz

# 或直接用 plugin_manager 工具装 bundle
#   plugin_manager install_bundle { target: "dsh-project-anchor@0.2.0" }
```

装完用 `project_ping` 确认宿主侧已加载（`live: true`、`indexRows` 非 0、`ledger.route.status === 'registered'`）。
`test/` 只在源码仓库里，不随 npm 包发布。

## 工具

| 工具 | 用途 |
|---|---|
| `project_status` | 读某个项目的卡摘要（期间 / 已定口径 / 禁入区 / 续开点）与最近索引节点；默认读本会话锚定的项目 |
| `project_attach` | 把本会话挂到项目上（`project` 可直接给项目名、目录名、别名或 `P2026-01`；`取消` 表示解挂） |
| `project_register` | 登记新项目：写一行登记表 + 生成项目卡，默认顺手挂本会话。**不需要先有目录** |
| `project_suggest` | 看本会话产出但未归属的台账结论，聚类成"像是独立项目"的候选（只建议，不落盘） |
| `project_rebuild` | 从只追加的事实重建两个索引视图（`索引.md` / `自由会话.md`） |
| `project_ping` | 宿主插件是否在线 + 索引文件状态 |

## 「项目锚定」页签

对话视图里的一个页签（`conversation.view`，order 6）。功能：显示本会话的归属、可挂的项目、
建卡建议、以及该项目的台账面板。界面文字全部走 Client locale 服务，跟随宿主语言切换。

页签头部有一枚粒度开关（只有已锚定时才显示）：`摘要` / `项目卡全文`，后面标着「· 本次运行有效」。
它改的是**插件进程内存里的值**，不落盘 —— 写工作区在浏览器请求那条路径上没有会话语境、
拿不到沙箱授权，`workspace-write` 下会被拒（实测 `FS_SANDBOX_DENIED`）。代价是插件重载后回到
`contextMode` 配置项的初始值。容器与控件的颜色走宿主主题变量
（`--dsw-alias-brand-primary` / `--dsw-alias-state-*` / `--dsw-alias-label-*`，带原色兜底），深色模式跟随宿主。

## 新会话自动判定（P5）

新开会话的第一句话到达时，宿主先看这句话像不像某个已登记项目，再决定要不要**替你把归属写掉**、
要不要把项目上下文递进模型的第一轮。

**四档动作**（前三档由 `src/match.js` 的 `decideMatch` 给出，第四档在 `src/index.js` 里按会话账本判断）：

| 档 | 条件 | 行为 |
|---|---|---|
| `attach` | 有具体证据（编号 / 项目名 / 别名 / 目录），分数 ≥ 0.85、领先另一个**同级**竞争者 ≥ 0.08（按两位小数取整后比较，见下），且是会话第一句（判过的消息 ≤ 1）、消息 ≤ 2000 字 | 直接追加一行归属（`_台账\归属.jsonl`，`by:'auto-match'`、`conf:'high'`），下一轮注入即带上该项目上下文 |
| `hint` | 只靠词汇相似（"减值""答复"这类只有某个项目在用的词），主线词权重够得上稀有度门槛、分数 ≥ 0.35 | 不写归属；把"可能相关的项目 + 判定依据 + 卡上的期间 / 已定口径 / 禁入区 / 上次停在哪（各截到 120–200 字）"递进上下文，让模型在第一轮末尾用一句话确认 |
| `new-project` | 哪个已有项目都没有明确对上，但本会话已判过 ≥2 条真人消息、且写下 ≥2 条未归属结论 | 不写归属；注入一句"本会话还没有项目归属，现有 N 个项目都没有明确对上（已有 M 条结论没归属）"，并给出两条出路：`project_register` 建新卡（不必先有目录）或 `project_attach` 挂到已有项目。**每个会话只出现一次** |
| `none` | 都不像，而且还没干出东西 | 不注入、不吭声 |

`new-project` 这一档是补出来的：只有前三档时，"干了一整天的活、但哪个已有项目都不像"会被判成
`none`，而 `none` 是彻底沉默 —— 模型既不知道"该挂一个"，也不知道"该建一个"，于是整段工作躺在
台账里没有归属（本插件自己的开发过程就是这样）。

这一档的判定依据是**干出来的活**，不是开场白：`noteLanded()` 在每条 `work_note` 落盘后，把本会话
所有未归属结论的 `node + summary` 拼成一段"工作文本"重新打分。原因是开场白里的客套词太容易蹭到
某个项目的常用词（一次词汇命中就有 0.5 分），开场白说"帮我起个名"而活干在别处时，旧提示会把这条
更强的证据整个挡掉。只有**点名级**证据（`attach` 档：编号 / 全名 / 别名 / 目录）才认为"这活属于
已有项目"，此时用工作文本的结论替换旧提示；否则清掉旧提示、改提"像是新项目"。

另外两处边界是实测踩出来的：

- **长名字补 3 字前缀**：「说明书修订」被说成「说明书」时，整名与整片段都命不中，句子会被当成"只提了另一个项目"然后自动挂过去。实测过：「存货核对和说明书这两条线今天都要交」原本直接挂到存货核对，补前缀后两边都是强证据、领先度 0，降级成提示（`match.test.mjs` 用例 13）。
- **领先度只跟同级竞争者比**。另一个项目的编号 / 全名 / 别名 / 目录也出现在这句话里，才算"真的
  分不清"；词汇级的第二名不能把点名的第一句顶掉。第 6 个项目（本插件的开发项目）上线后，它的
  摘要里全是被测试的业务词，词汇分一度冲到 0.8 以上，把点名「存货核对」的那句从挂接降成了提示。
- **领先度先按两位小数取整再比**：分数本身就是两位小数，直接相减会带浮点尾差
  （`0.88 - 0.80 = 0.07999999999999996`），恰好卡在 0.08 边界上的第一句会被误降级。

为什么不一律自动挂：猜错会往 `归属.jsonl` 写错一行，而"第一轮多问一句"几乎零成本 —— 代价不对等。

**词汇证据的算法**：2-gram + **按稀有度加权**（`idf = ln((项目数+1)/出现该词的项目数)`）。原来按
"标题覆盖率"算，实测会被长标题稀释（20 字标题重合 2 个词只剩 10%），而"跌价"这种只在一个项目里
用的词出现一次就足够说明在讲同一件事。四层过滤防误报：

1. **主线词 vs 旁述词**：节点标题、项目名/别名片段、一句话算主线（权重 1.0），节点摘要只算旁述
   （权重 0.4）。不分层时，一个把别家关键词抄进结论的项目会变成"什么都像"——本插件的开发项目就
   踩过：它的结论文里全是被测试的业务词，于是任何一句话都像它。
2. **稀有度门槛随语料规模走**：主线词权重合计要 ≥ `ln((项目数+1)/2)`，也就是"比半数项目更稀有"
   才算证据。「存货」「采购」这类在一半项目语料里都出现的词不够；「跌价」够。
3. **纯虚词、泛词、动作词、非汉字片段一律不计分**：「对不」「的话」「项目」「会话」「台账」
   「补充」「核对」，以及 "summary" 切出来的 `su`/`mp`、路径、代码。少了这层，一句"新会话第一句话"
   或"猫砂补充"就会被凑成提示。
4. **切词边界上带虚词的 gram 一律不计分**：「的」「了」「是」「这」「个」「不」「和」这类字只要
   出现在 gram 的任一侧，这个 gram 就是切词切歪了的产物。实测踩过：「今天的活先记两条」里的
   `的活` 在某个项目的摘要里出现过，idf 判它稀有，于是单靠一个伪词就把闲聊判成了提示。

项目名的**纯英文片段**不参与名称片段匹配（"dsh-project-anchor" 里的 `project` 太像日常词，
任何一句英文提示都会命中）；要指认这类项目，请写全名或编号。

**只认真人发言**：`user/message` 要求 `source.kind === 'user'`；`agent/inbox/spliced` 要求
`inserted` 里至少一条是 user。`runtime-context`（宿主把上一轮注入的快照再发一遍）、
`agent-instructions`、`time-context`、`skill-catalog`、`subagent-settled` 一律不判 —— 否则插件会
把自己的提示当成用户的话，自我强化出错误的归属。

**触发入口**：`turn/start`（记轮次）+ `user/message` 与 `agent/inbox/spliced`（判文本），
都在 `registerIndexWriter` 里那**一个** `session/event` 监听回调里处理（`test/plugin.test.mjs`
断言只允许一次订阅）。inbox 会早于 `turn/start` 到达，所以挂接门是"判过的消息数 ≤ 1 **且** 轮次 ≤ 1"。

**注入**：`systemPrompt.context({ name: 'project:anchor', order: 100 })`。已锚定时给项目摘要
（`renderCached`）；未锚定但判出提示时给提示（`renderAutoHint`）；都没有就不注入。`context()`
返回的是 Cordis effect disposer，注册归属调用方 scope，插件卸载时自动回收。

## 宿主配置

| 键 | 默认 | 说明 |
|---|---|---|
| `autoMatch` | `true` | 新会话首句自动判定的总开关 |
| `autoMatchTurns` | `3` | 前几轮内仍允许判定（含第四档） |
| `contextMode` | `'digest'` | 注入粒度的初始值；页签开关只在本次进程内覆盖 |
| `publishCatalog` | `false` | 是否把项目目录投影给插件市场/目录 |
| `catalogThrottleMinutes` | `10` | 上面那项的最小间隔（分钟） |

## 测试

```bash
npm test
# 等价于：
node test/plugin.test.mjs      # work_note → 索引行：落盘、去重、空节点、忽略其他工具
node test/contract.test.mjs    # work-note 契约 v1（与 dsh-work-ledger 共享向量）
node test/match.test.mjs       # 判定器：点名挂接 / 编号 / 词汇提示 / 并列不挂 / 无关沉默 / 超长降级 / 领先度边界 / 单词巧合 / 旁述词 / 半通用词
node test/apply.test.mjs       # 装配层：11 个场景（含 inbox 入口、运行时快照过滤、中途加载保护、第四档、带目录登记、设置路由）
```

## 数据文件（都在工作区 `_台账\` 下）

| 文件 | 性质 |
|---|---|
| `项目登记表.md` | 人可读的项目清单：编号 / 名称 / 目录 / 期间 / 状态 / 别名 / 一句话 |
| `项目卡-<编号>.md` | 每项目的卡：期间、已定口径、禁入区、续开点 |
| `索引.jsonl` | 只追加的事实：每条结论一行（session、node、summary、归属） |
| `归属.jsonl` | 只追加的归属记录：`{type:'attach', session, project, by, conf, note, ts}`，同会话取最新 |
| `索引.md` / `自由会话.md` | 由上面两份事实重建的视图（`project_rebuild`） |

自动挂接只往 `归属.jsonl` 追加一行，不动任何文件；归属写错可以用 `project_attach` 再写一行覆盖
（同会话以最新为准），或 `project_attach { project: '取消' }` 解挂。

## 两个必须避开的坑

1. **`ctx.fs` 的 `stat` 只返回 `type: 'file' | 'directory' | 'other'`**，没有 `'dir'`。
   早期把 `info.type` 原样返回、上层却拿它和 `'dir'` 比，于是**任何带目录的项目登记都被误拒**，
   还错报成「不是目录」。判定目录请显式映射到 `'dir'`。
2. **浏览器请求那条路径不能写工作区**：设置路由（`/project-anchor/settings`）由页面发起，没有会话语境，
   `ctx.fs` 写盘拿不到沙箱授权。所以粒度开关只存内存；要持久化请改 `contextMode` 配置项。

其它踩过的：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM（要
`[System.Text.UTF8Encoding]::new($false)`）；`.NET` 静态方法按**进程** cwd 解析相对路径（不跟随
PowerShell `cd`）；`rg` 读不了 `app.asar` 内的路径；裸 `http://127.0.0.1:55888` 没有启动 token，
打不开 Web GUI。

## 发布合规

- bundle：`dsh.bundle.patch` 指向 `./cordis.patch.yml`；`exports` 含 `.`、`./client`、`./cordis.patch.yml`、
  `./locale/*.json`、`./icon`；`files` 含入口、patch、locale、icon 与全部运行期文件。
- 显示元数据：`locale/zh.json` 与 `locale/en.json` 各有 `meta.title`（「项目锚定」/ `Project anchor`，
  sentence case）与 `meta.description`（功能 + 用法 + 限制）；`meta.detail` 省略，详情页回落到本 README。
- 图标：`icon.svg`（24×24 描边锚形，`#2f6fed`，323 字节），已实测能在浏览器里渲染出像素。
- 客户端：工厂 id 等于包名，无副作用；样式与定时器在 `apply` 里用 `ctx.effect` / `ctx.on` 注册并返回清理；
  可见文案走 Client locale（`zh`/`en` 各 105 条）；容器与控件颜色走宿主主题变量。
- Host：`systemPrompt.context()`、路由注册都返回/绑定 effect disposer，插件卸载即回收。

## 复盘：第四档是怎么补出来的

2026-11-15 那一整天的开发（自动判定 → 最小样本 → 发布合规 → 第四档）全程都在本插件自己的项目里
记账，但那个项目是**最后**才建的。原因不是功能缺失，而是三处习惯：把"不匹配现有项目"当终点、
拿到 `project_status` 说"本会话未锚定"却没当行动项、把归属当成"用户在页签点按钮"的事。

第四档就是为了把这条缝补上：`none` 不再等于沉默 —— 干出 ≥2 条结论、又哪个项目都不像时，宿主自己
开口问一句"要不要建一个新项目"。判定依据是干出来的活，不是开场白。
