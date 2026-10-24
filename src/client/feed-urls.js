/**
 * 把一段粘贴进来的文本切成订阅地址列表。
 *
 * 单独放在 `.js` 里（而不是留在 `dialogs.jsx` 内）是为了能被 `node --test` 真跑：
 * 一次粘 20 个地址时，切错一个会**静默少订几个**，而界面上只会显示「订阅了 19 个」。
 *
 * 语义是**先按行、再按行内分隔符**，不是一上来就全文本切分。原因是注释：
 * `# 我常看的博客` 若按空白切，`#` 被当注释丢掉、`我常看的博客` 却会活下来变成一个假地址，
 * 用户会看到「已忽略 0 行」，而多出来的那个地址在订阅时才报错。注释是**行级**概念。
 */

/** 行内分隔符：空白、逗号、分号。`#` 之后到行尾整体丢弃（行内注释）。 */
const SEPARATORS = /[\s,;]+/;

/**
 * 切分并去重（保持首次出现的顺序）。
 * - 空行、以及 `#` 开头的整行 → 整行忽略；
 * - 行内出现 `#` → 该 token 起到行尾全部忽略；
 * - 首尾空白去掉；重复地址只留第一次。
 */
export function parseFeedUrls(text) {
  const seen = new Set();
  const urls = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    for (const raw of line.split(SEPARATORS)) {
      const token = raw.trim();
      if (token === '') continue;
      // 行内注释：从这里到行尾都不再是地址。`#` 本身不可能是 http(s) 地址的开头，
      // 所以「见到 # 就断」不会误伤任何合法地址。
      if (token.startsWith('#')) break;
      if (seen.has(token)) continue;
      seen.add(token);
      urls.push(token);
    }
  }
  return urls;
}

/** 只留下 http(s) 地址。返回 `{ urls, ignored }`，`ignored` 是**条数**供界面说明。 */
export function httpFeedUrls(text) {
  const all = parseFeedUrls(text);
  const urls = all.filter((url) => /^https?:\/\//i.test(url));
  return { urls, ignored: all.length - urls.length };
}
