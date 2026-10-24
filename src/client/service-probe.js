/**
 * 把「转 RSS 服务」的探活结果翻成一句人话。
 *
 * 为什么单独成模块：这段映射里藏着一条**容易写反的判据** ——
 * wewe-rss 之类的服务后台本身就是个网页，**返回 HTML 是正常的**。
 * 如果按「不是 feed ⇒ 配置错了」去写，就会把好配置说成故障，用户接着去瞎改
 * 一个本来正确的地址。这种「写反了也看不出来」的映射必须有真跑的单测。
 *
 * 所以这里只有纯函数、没有 React，也没有 DOM。
 */

/** 探活结果里 `kind` 的取值。`unreachable` 是**网络层**失败，与「HTTP 错误码」不同。 */
export const PROBE_KINDS = ['feed', 'html', 'json', 'other', 'unreachable'];

/**
 * @param {{ ok?: boolean, status?: number, kind?: string, ms?: number, title?: string, error?: string } | undefined} result
 * @returns {string} 界面上一句话；`undefined`/空输入返回空串（什么都不说）。
 */
export function probeText(result) {
  if (!result) return '';
  if (result.kind === 'unreachable') {
    return `连不上这个地址：${result.error ?? '未知错误'} —— 服务起来了吗？端口对吗？`;
  }
  const where = `HTTP ${result.status} · ${result.ms}ms`;
  if (!result.ok) return `服务在线，但返回 HTTP ${result.status} —— 地址可能少了路径。`;
  if (result.kind === 'feed') {
    return `通了，而且这个地址本身就是 feed${result.title ? `（${result.title}）` : ''} —— 可以直接订阅。`;
  }
  // ★ 这一条是本模块存在的主要理由：HTML **不是**错误。
  if (result.kind === 'html') {
    return `通了（${where}${result.title ? ` · 页面「${result.title}」` : ''}）。服务正常，去它后台加公众号，再把 feed 地址复制回来。`;
  }
  if (result.kind === 'json') {
    return `通了（${where}）—— 它是个接口而不是网页，多半是 API 根地址，不是给你订阅的 feed。`;
  }
  return `通了（${where}），但返回的内容既不是网页也不是 feed —— 确认一下这个地址填对了没有。`;
}
