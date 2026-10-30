/**
 * 写入口的「预览 → 继续写」（0.56.4）。
 *
 * 用户 2026-10-30：「记录灵感这里有一个错误，就是我没写任何内容，然后点击『预览』，
 * 再点击『继续写』就出现错乱了。」截图里：工具栏的 B I H ” 压在占位提示上，
 * 「0 字」和「记下来」挤在一起，正文区整个塌成一条。
 *
 * 根因不在样式，在**生命周期**：预览原来是三元分支，进预览就把编辑区整棵子树卸掉，
 * 回来再挂一棵空的挂载点。而 ProseMirror 实例只在 effect 里创建一次（依赖
 * `[disabled]`），`richRef.current` 指着的还是那个**容器已被 React 摘走**的旧实例 ——
 * 它不认新的 DOM。于是回来之后编辑区高度 0，占位提示（`position: absolute`）就压到
 * 工具栏上了。
 *
 * 判据分两层：
 *   ① **结构**（这里）：编辑区不在三元里、预览是追加、CSS 靠 `data-mode` 收掉它、
 *      「回来之后把光标放回去」那条 effect 在；
 *   ② **真 DOM**（`.build/preview/check-composer-preview.mjs`）：真 Chrome 里点
 *      「预览」再点「继续写」，量编辑区高度与占位/工具栏的重叠。结构判据答不了
 *      「这段 JSX 真的这么渲染」，而这一条恰恰是靠渲染行为坏掉的。
 *
 * ★ 为什么 ① 仍然要有：② 要 Chrome，不进 CI；① 是每次 `npm test` 都会跑的那道闸。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { stripComments } from '../scripts/strip-comments.mjs';

const composer = stripComments(readFileSync(new URL('../src/client/DiaryComposer.jsx', import.meta.url), 'utf8'));
const css = readFileSync(new URL('../src/client/refinements.css', import.meta.url), 'utf8');

describe('预览不能把编辑区卸掉（0.56.4）', () => {
  it('★ 编辑区无条件渲染：预览不是「二选一」', () => {
    assert.match(composer, /<div className="npr-write-body">/,
      '编辑区容器不见了');
    // ★ 只认「三元里套 JSX 元素」这一种形状：按钮文案那处
    //   `{mode === 'preview' ? '继续写' : '预览'}` 是正常的，不该被这条误伤
    //   （第一版写成 `\{mode === 'preview' \?` 就对它报了红 —— 一次假红）。
    assert.doesNotMatch(composer, /\{mode === 'preview' \? \(\s*preview/,
      '预览又变回三元了 —— 进预览会把编辑区整棵卸掉，回来 ProseMirror 接不回新容器');
    assert.match(composer, /\{mode === 'preview' && \(preview/,
      '预览块不是「追加在编辑区之后」');
  });

  it('★ 预览时靠 CSS 收掉编辑区（display: none），不是卸载', () => {
    assert.match(css, /\.npr-write\[data-mode="preview"\] \.npr-write-body \{ display: none; \}/,
      '没有「预览时收掉编辑区」的规则 —— 编辑区和预览会上下叠着各画一份');
    // 反向对照的素材：`visibility: hidden` 还占着 76px，预览下面会多一大片空白。
    assert.doesNotMatch(css, /\.npr-write\[data-mode="preview"\] \.npr-write-body \{[^}]*visibility/,
      '用 visibility 收的 —— 那块高度还在，预览下面会空一片');
  });

  it('★ 反向对照：把 JSX 改回三元，上面第一条必须变红', () => {
    const old = composer.replace(
      "{mode === 'preview' && (preview",
      "{mode === 'preview' ? (preview",
    );
    assert.notEqual(old, composer, '替换没生效，反向对照是假绿');
    assert.match(old, /\{mode === 'preview' \? \(\s*preview/,
      '三元形状居然没被认出来 —— 判据没牙');
  });

  it('★ 从预览回来要把光标放回编辑区（藏起来时焦点已经丢了）', () => {
    // 预览是把编辑区 `display: none` 收掉，浏览器会把焦点丢给 body；不放回去的话，
    // 用户点完「继续写」直接打字，字落在页面上、正文一个字没进。
    assert.match(composer, /if \(mode !== 'edit'\) return;\s*if \(rich && richRef\.current\) richRef\.current\.focus\(\);\s*else el\.current\?\.focus\(\);/,
      '回来之后没有把光标放回编辑区');
    // 但挂载那一刻不能抢焦点：`mode` 初值就是 edit，必须有「跳过第一次」。
    assert.match(composer, /const modeSeen = useRef\(false\);\s*useLayoutEffect\(\(\) => \{\s*if \(!modeSeen\.current\) \{ modeSeen\.current = true; return; \}/,
      '焦点复位没有跳过第一次 —— 挂载那一刻就会从别的输入框抢走焦点');
  });
});
