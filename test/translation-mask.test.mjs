/**
 * 页级论文翻译的「受保护片段」真跑测试。
 *
 * ★ 只断言「源码里写了 contains」看不出这里的问题：模型把占位符丢一个、
 *   重复一个、编一个，界面上分别表现为公式消失 / 公式重复 / 冒出 ⟦99⟧。
 *   所以这里用真实字符串走一遍 mask → 假装模型译文 → restore 的全链路。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { maskInlineTokens, restoreInlineTokens } from '../src/host/translation-mask.js';

describe('受保护片段掩码', () => {
  it('普通正文不产生占位符，还原是恒等变换', () => {
    const text = '大型语言模型在视觉指令微调中表现良好，见 (Smith et al., 2020)。';
    const masked = maskInlineTokens(text);
    assert.equal(masked.tokens.length, 0);
    assert.equal(masked.text, text);
    assert.equal(restoreInlineTokens(text, masked.tokens).text, text);
  });

  it('★ TeX / LaTeX 命令 / URL / DOI / motif 保护标记都被换掉，回来逐字还原', () => {
    const text = 'We use $E=mc^2$ and \\cite{vaswani2017} from https://example.com/a.pdf, doi: 10.1234/abcd, plus ⟪F0⟫.';
    const masked = maskInlineTokens(text);
    assert.ok(masked.tokens.length >= 5, `只保护了 ${masked.tokens.length} 处，正则漏了`);
    for (const token of masked.tokens) {
      assert.ok(masked.text.includes(token.placeholder), `占位符 ${token.placeholder} 没写进待译文本`);
      assert.ok(!masked.text.includes(token.original), `原文片段没被遮住：${token.original}`);
    }
    // 假装模型只把英文换了中文，占位符原样带回。
    const translated = masked.text.replace('We use', '我们使用').replace('and', '以及').replace('from', '取自').replace('plus', '以及');
    const restored = restoreInlineTokens(translated, masked.tokens);
    assert.equal(restored.missing, 0);
    assert.equal(restored.invalid, false);
    for (const token of masked.tokens) {
      assert.ok(restored.text.includes(token.original), `没还原：${token.original}`);
    }
    assert.ok(!/⟦\d+⟧/u.test(restored.text), '译文里还留着占位符');
  });

  it('★ 模型丢掉一个占位符 ⇒ missing > 0（该段必须留原文）', () => {
    const masked = maskInlineTokens('See $x^2$ and https://example.com/x.');
    assert.ok(masked.tokens.length >= 2);
    const dropped = masked.text.replace(/⟦0⟧/u, '');
    const restored = restoreInlineTokens(dropped, masked.tokens);
    assert.ok(restored.missing > 0);
    assert.equal(restored.invalid, false);
  });

  it('★ 占位符重复 / 凭空多一个 ⇒ invalid（不能把结构错乱的译文铺回 PDF）', () => {
    const masked = maskInlineTokens('See $x^2$ and https://example.com/x.');
    const duplicated = masked.text.replace(/⟦0⟧/u, '⟦0⟧⟦0⟧');
    assert.equal(restoreInlineTokens(duplicated, masked.tokens).invalid, true);
    assert.equal(restoreInlineTokens(`${masked.text}⟦99⟧`, masked.tokens).invalid, true);
  });

  it('★ 原文里本来就有 ⟦0⟧：placeholder 不能自撞，还原后仍是原文', () => {
    const text = 'see ⟦0⟧ and $x$';
    const masked = maskInlineTokens(text);
    assert.ok(!masked.tokens.some((token) => token.placeholder === '⟦0⟧'), 'placeholder 与原文撞了');
    const restored = restoreInlineTokens(masked.text, masked.tokens);
    assert.equal(restored.missing, 0);
    assert.equal(restored.invalid, false);
    assert.equal(restored.text, text);
  });

  it('重叠片段只掩码一次，不会嵌套出 ⟦⟦n⟧⟧', () => {
    const masked = maskInlineTokens('a $x + \\alpha$ b');
    assert.ok(!/⟦\d+⟧⟦/u.test(masked.text), '出现了嵌套占位符');
    assert.equal(restoreInlineTokens(masked.text, masked.tokens).text, 'a $x + \\alpha$ b');
  });
});
