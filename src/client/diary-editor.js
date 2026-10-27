/**
 * 日记编辑器的装载。
 *
 * ★ 编辑器是**按需下载**的单个 ESM 文件（373 KB），由宿主按
 *   `EDITOR_VENDOR_PREFIX` 发出来。日记页没打开就不下，这是它不和主 bundle
 *   一起走的唯一理由（见 `src/library.js` 里那段注释）。
 * ★ 失败**不缓存**：网络抖一下、宿主重启一次，用户点「重试」应该真的重试一次，
 *   而不是永远拿到同一个被缓存的 rejection（与 `pdfjs.js` 同一条纪律）。
 * ★ 调用方必须准备**退路**：这一层只负责「能不能拿到」，拿不到时日记照样要能写。
 */
import { EDITOR_VENDOR_PREFIX } from '../library.js';

/** 编辑器产物的 URL（相对当前页面，由宿主转发到本机服务）。 */
export function diaryEditorAsset() {
  return `${EDITOR_VENDOR_PREFIX}/editor.mjs`;
}

let editorPromise = null;

/**
 * 装载编辑器模块。返回 `{ createDiaryEditor }`。
 * @returns {Promise<{ createDiaryEditor: (options: object) => Promise<object> }>}
 */
export function loadDiaryEditor() {
  if (editorPromise !== null) return editorPromise;
  editorPromise = import(diaryEditorAsset()).catch((cause) => {
    editorPromise = null;
    throw cause;
  });
  return editorPromise;
}
