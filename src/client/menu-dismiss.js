/**
 * 下拉菜单「点外面关掉」的**唯一判据**（0.71.0）。
 *
 * ★ 为什么单独成一个文件，而不是继续挂在 ReaderPage.jsx 上
 * --------------------------------------------------------
 * 论文页「+」菜单、论文阅读页「翻译」下拉都要复用它。它们从 ReaderPage.jsx
 * 取函数时，会在依赖图里形成 `ReaderPage → LibraryApp/PapersApp → BookReader →
 * ReaderPage` 的环，并把 `ReaderPage.jsx` 的 `import REFINEMENTS from './refinements.css'`
 * 一起拖进「只渲染 BookReader」的测试 bundle —— 那份 bundle 不该也不需要加载
 * 整张 RSS 页面的 CSS 文本。判据本身是**零依赖的纯 DOM 逻辑**，抽出来之后
 * 三个视图各 import 这一份，环和 CSS 链同时消失。
 *
 * ★ 为什么抽成独立函数，而不是把逻辑写在 useEffect 里
 * ----------------------------------------------------
 * 这里有两个**一写错就静默失效**的细节，必须能被断言钉住：
 *
 *   ① **触发器本身要排除**。⋯ 按钮的 onClick 是 `setMenuOpen(open => !open)`。
 *      如果 pointerdown 先把菜单关掉、紧接着 onClick 又把它翻回来，菜单就**永远关不掉** ——
 *      用户看到的是「点了 ⋯ 没反应」，而且不报错。
 *
 *   ② **菜单本身要排除**。用 pointerdown 关闭时，若把菜单也算作「外面」，
 *      菜单会在 **pointerdown 阶段**就卸载，随后的 click 落在已经消失的按钮上 ⇒
 *      **点任何一条菜单项都什么都不做**（比「关不掉」更严重）。
 *
 * 所以判据独立成这个函数，用真 DOM 桩真跑断言（`test/reader-menu-dismiss.test.mjs`）——
 * 这两个坑都靠「源码里写了 `contains`」这种字符串断言看不出来。
 *
 * ★ 监听器挂在 `document` 上且用**捕获阶段**：宿主 UI 里任何一处 `stopPropagation`
 *   都不该让我们自己的菜单关不掉。
 *
 * ★ 「触发器与菜单包在同一个容器」是合法接法：此时 `menu` / `trigger` 传同一个节点，
 *   两个排除条件都落在同一棵子树上（论文「+」与阅读页「翻译」下拉都这么用）。
 *
 * @param {EventTarget} doc 真实调用时是 `document`
 * @param {{menu?: Node|null, trigger?: Node|null, close: () => void}} options
 * @returns {() => void} 卸载函数。★ 移除时的捕获标志**必须与添加时一致**，
 *   否则监听器会留在 document 上（菜单每开一次多一个，且旧的还指向过期的 ref）。
 */
export function attachMenuDismiss(doc, { menu, trigger, close }) {
  const onPointerDown = (event) => {
    const target = event?.target;
    if (!target) return;
    if (menu?.contains?.(target)) return;
    if (trigger?.contains?.(target)) return;
    close();
  };
  doc.addEventListener('pointerdown', onPointerDown, true);
  return () => doc.removeEventListener('pointerdown', onPointerDown, true);
}
