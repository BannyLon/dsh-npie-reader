/**
 * 写作区里的图不许撑满稿纸（0.74.0）。
 *
 * 用户 2026-11-11：「写日记框里被撑满，没有自适应」—— 附了三张图：私密日记的写入口、
 * 灵感便签的写入口各贴了一张截图，整块稿纸被那张图占满；同一张图在便签墙上是正常的。
 *
 * 根因：`.npr-diary-body img`（展示态）从 0.73.1 起就有 `max-width: 100%`，
 * 而写作区（`.npr-write-rich .ProseMirror`）与预览态（`.npr-write-preview`）
 * **一条 img 规则都没有** —— 图按固有像素排版，1031px 宽的截图就是 1031px 宽。
 *
 * 判据的形状：不是「写了 max-width 就算过」，而是**两条一起限**：
 *   ① `max-width` 管横向（宽图不许溢出）；
 *   ② `max-height` 管纵向（3:2 的截图压到 100% 宽后仍有 500px 高，照样占满）；
 *   ③ `height: auto` 必须明确写着 —— 只给 `max-height` 时某些 UA 会按盒子高度拉伸。
 * 再加一条**关系**断言：图的 `max-height` 必须小于稿纸自己的 `max-height`，
 * 否则「图缩了一点」仍然把下面那行字挤出可视区 —— 那是同一句抱怨换个数字复发。
 *
 * ★ 不做成「Chrome 里量高度」的判据：那要真浏览器，不进 CI；这里的结构判据
 *   每次 `npm test` 都会跑，且下面的反向对照保证它真的会红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../src/client/refinements.css', import.meta.url), 'utf8');

/** 取某条规则的声明体（第一个参数是能匹配到 `{` 之前那段的完整正则）。 */
function bodyOf(pattern) {
  const hit = pattern.exec(css);
  return hit ? hit[1] : null;
}

/** 从声明体里读一个 px 数值。 */
function pxOf(body, prop) {
  const hit = new RegExp(`(?:^|;|\\s)${prop}:\\s*(\\d+)px`).exec(body ?? '');
  return hit ? Number(hit[1]) : null;
}

describe('写作区里的图（0.74.0）', () => {
  it('★ 编辑器与预览都有 img 规则（不是只修了其中一边）', () => {
    assert.ok(
      bodyOf(/\.npr-write-rich \.ProseMirror img,\s*\n\.npr-write-preview img \{([^}]*)\}/),
      '写作区/预览的 img 规则不见了 —— 贴一张 1031px 宽的截图就会撑满稿纸',
    );
  });

  it('★ 三条一起写：max-width 管横向、max-height 管纵向、height:auto 防拉伸', () => {
    const body = bodyOf(/\.npr-write-rich \.ProseMirror img,\s*\n\.npr-write-preview img \{([^}]*)\}/);
    assert.match(body ?? '', /max-width:\s*100%/, '没有 max-width —— 宽图会横向溢出');
    assert.ok(pxOf(body, 'max-height') !== null, '没有 max-height —— 宽图压到 100% 后仍有几百像素高');
    assert.match(body ?? '', /(?:^|[\s;])height:\s*auto/, '没有 height:auto —— 只给 max-height 会被按盒子高度拉伸');
  });

  it('★ 图的 max-height 必须小于稿纸自己的 max-height', () => {
    const img = bodyOf(/\.npr-write-rich \.ProseMirror img,\s*\n\.npr-write-preview img \{([^}]*)\}/);
    const box = bodyOf(/\.npr-write-rich \.ProseMirror \{([^}]*max-height:[^}]*)\}/);
    const imgMax = pxOf(img, 'max-height');
    const boxMax = pxOf(box, 'max-height');
    assert.ok(imgMax !== null && boxMax !== null, '量不到高度上限，判据是假绿');
    assert.ok(imgMax < boxMax,
      `图的 max-height(${imgMax}) 不小于稿纸的(${boxMax}) —— 图下面那行字会被挤出可视区`);
  });

  it('★ 反向对照：把 height:auto 删掉，第一条必须咬住', () => {
    const body = bodyOf(/\.npr-write-rich \.ProseMirror img,\s*\n\.npr-write-preview img \{([^}]*)\}/) ?? '';
    const broken = body.replace(/(?:^|[\s;])height:\s*auto;?/, '');
    assert.notEqual(broken, body, '反向对照的替换没生效 —— 这条判据没有牙');
    assert.doesNotMatch(broken, /(?:^|[\s;])height:\s*auto/, '删掉之后仍然能匹配，判据写错了');
  });

  it('★ 展示态没有被改坏：`.npr-diary-body img` 仍在，且不带裁切', () => {
    const body = bodyOf(/\.npr-diary-body img \{([^}]*)\}/);
    assert.ok(body !== null, '展示态的 img 规则不见了');
    assert.match(body, /max-width:\s*100%/, '展示态丢了 max-width');
    assert.doesNotMatch(body, /object-fit:\s*cover/, '展示态改成裁切了 —— 简笔画会被切掉一半');
  });
});
