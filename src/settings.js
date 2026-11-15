/**
 * 插件的运行期设置（只在内存里，不落盘）。
 *
 * 为什么不再写 `_台账\项目锚定-设置.json`：那条写盘走的是浏览器请求的 `ctx.fs`，
 * 没有会话语境、拿不到沙箱授权，`workspace-write` 下连工作区内的文件都写不进去
 * （实测报 `FS_SANDBOX_DENIED`）。为了一个"看摘要还是看整张卡"的偏好去绕沙箱
 * 不值得——改成内存里存一份，插件重载或宿主重启回到默认值。
 *
 * 目前只有一个键：
 * - `contextMode`：`digest`（摘要：期间/已定口径/禁入区/续开点）或 `card`（整张项目卡）。
 */

/** 允许的注入粒度。 */
export const CONTEXT_MODES = Object.freeze(['digest', 'card'])

/** 默认设置：与插件配置的默认值一致。 */
export const DEFAULT_SETTINGS = Object.freeze({ contextMode: 'digest' })

/** 进程内当前值（不放 cache，是因为 renderCached 同步取用、且与工作区无关）。 */
let currentMode = DEFAULT_SETTINGS.contextMode

/**
 * 归一化一个注入粒度。
 * @param {unknown} value 待检查的值。
 * @param {string} [fallback] 不认识时退回的值。
 * @returns {string} `digest` 或 `card`。
 */
export function normalizeContextMode(value, fallback = DEFAULT_SETTINGS.contextMode) {
  const mode = String(value ?? '').trim()
  if (CONTEXT_MODES.includes(mode)) return mode
  return CONTEXT_MODES.includes(String(fallback ?? '')) ? String(fallback) : DEFAULT_SETTINGS.contextMode
}

/**
 * 读当前注入粒度。
 * @returns {string} `digest` 或 `card`。
 */
export function getContextMode() {
  return currentMode
}

/**
 * 改注入粒度（内存里立即生效，下一轮注入即用新粒度）。
 * @param {unknown} value 新值。
 * @returns {string} 归一化之后真正生效的值。
 */
export function setContextMode(value) {
  currentMode = normalizeContextMode(value, currentMode)
  return currentMode
}
