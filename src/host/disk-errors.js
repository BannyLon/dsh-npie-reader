/**
 * 磁盘类错误 → 用户能读懂的一句话（2026-10-25）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 *
 * 写盘失败时，Node 抛出来的 `error.message` 是给**开发者**看的：
 *
 *     ENOSPC: no space left on device, write
 *     EACCES: permission denied, open '/Users/x/.dsh/storages/…/meta.json'
 *
 * 这两句会**原样**流到界面上（`library-routes.js` 把 `error.message` 直接塞进
 * `{ ok: false, error }`，客户端 `jsonRequest` 优先显示它）。用户看到的是英文 +
 * 一长串路径，既不知道发生了什么，也不知道下一步该干什么 —— 而这恰恰是
 * 「他自己能修」的那一类故障（清磁盘、给权限），只要说清楚就行。
 *
 * ★ 与「确定的假话」是同一类缺陷的两面：那边是**没发生的事说成发生了**，
 *   这边是**发生了的事说不清楚**。两者都让用户没法自救。
 *
 * ── 两条纪律 ────────────────────────────────────────────────────────────
 *
 * 1. **只翻「磁盘/权限」这一族**。其它错误（`TypeError`、业务错误）必须原样穿过去：
 *    把它们也包成「磁盘出问题了」会掩盖真正的 bug，比不翻更糟。
 * 2. **必须带上稳定的 `code`**。路由层靠 `code` 决定状态码（`DISK_FULL` ⇒ 507），
 *    靠 `message` 决定文案 —— 拿文案去匹配状态码是脆的（改一个字就失配）。
 */

/**
 * errno → `{ code, message }`。
 *
 * `code` 是本项目自己的稳定标识（不是 errno），路由层与客户端只认它。
 * `message` 里的 `{what}` 会被替换成「在存什么」（划线 / 解读数据 / 阅读进度 …）。
 */
const TABLE = Object.freeze({
  ENOSPC: { code: 'DISK_FULL', message: '磁盘空间不够了：保存{what}的时候被系统拒绝了。清理一下磁盘（或删掉一些解读缓存）再试一次。' },
  EDQUOT: { code: 'DISK_FULL', message: '这块磁盘的配额用完了：保存{what}的时候被系统拒绝了。清理一下磁盘，或者找管理员调大配额。' },
  EACCES: { code: 'DISK_DENIED', message: '没有权限写{what}：它所在的目录可能被设成了只读，或者被安全软件挡住了。' },
  EPERM: { code: 'DISK_DENIED', message: '系统不允许写{what}：它所在的目录可能被设成了只读，或者被安全软件挡住了。' },
  EROFS: { code: 'DISK_READONLY', message: '存{what}的那块磁盘是只读的，写不进去。' },
  EMFILE: { code: 'DISK_TOO_MANY_FILES', message: '同时打开的文件太多了，暂时存不下{what}，过一会儿再试。' },
  ENFILE: { code: 'DISK_TOO_MANY_FILES', message: '同时打开的文件太多了，暂时存不下{what}，过一会儿再试。' },
  ENAMETOOLONG: { code: 'DISK_BAD_PATH', message: '{what}的文件名太长，存不下来。' },
  EIO: { code: 'DISK_IO', message: '磁盘读写出错了：存{what}的时候硬件报了错，可能是硬盘或外接盘有问题。' },
});

/** 这些 code 都属于「磁盘/权限」这一族（路由层用它决定状态码）。 */
export const DISK_ERROR_CODES = Object.freeze([
  'DISK_FULL', 'DISK_DENIED', 'DISK_READONLY', 'DISK_TOO_MANY_FILES', 'DISK_BAD_PATH', 'DISK_IO',
]);

/**
 * 把一个错误翻成人话。
 *
 * @param {unknown} error - 原始错误。
 * @param {object} [options]
 * @param {string} [options.what] - 「在存什么」，会填进句子里。默认「数据」。
 * @returns {unknown} 翻得了 ⇒ 一个新的 `Error`（带 `code` / `cause`）；
 *   翻不了 ⇒ **原样返回**（调用方直接 `throw` 它，行为与没这层一样）。
 */
export function describeFsError(error, { what = '数据' } = {}) {
  const errno = String(error?.code ?? '');
  const entry = TABLE[errno];
  if (entry === undefined) return error;
  const wrapped = new Error(entry.message.replaceAll('{what}', what));
  wrapped.code = entry.code;
  wrapped.errno = errno;
  // 原始错误留在 `cause` 里：日志要能看到真实路径与 errno，界面上只给那句话。
  wrapped.cause = error;
  return wrapped;
}

/**
 * 包住一次写盘动作：失败时抛人话版。
 *
 * ★ 用 `async` 包装而不是在每个 `writeFile` 后面各写一个 `try/catch`：
 *   这个仓库里写盘点有十几处，漏一处就等于那条路径上的人话提示不存在。
 *
 * @param {() => Promise<any>} task
 * @param {string} what - 「在存什么」。
 */
export async function guardFs(task, what = '数据') {
  try {
    return await task();
  } catch (error) {
    throw describeFsError(error, { what });
  }
}
