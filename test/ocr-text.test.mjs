/**
 * OCR 视觉行 → 可读段落（0.25.9）。
 *
 * 本机 OCR（macOS Vision）按「它在图上看到的每一行」输出，行末硬断、宽度接近原页。
 * 直接塞进 380px 的伴读面板会**二次折行**：一句被切成「…白色」/「封面」两截。
 * 这组用例锁的是「合并行」的三条边界：中文直接连、ASCII 之间补空格、空行保段落。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { tidyOcrText } from '../src/client/ocr-text.js';

describe('tidyOcrText：把视觉行拼回段落', () => {
  it('单行不变', () => {
    assert.equal(tidyOcrText('她的衣着是怎样的呢？'), '她的衣着是怎样的呢？');
  });

  it('★ 中文行直接连，不插空格', () => {
    assert.equal(
      tidyOcrText('他在超现实主义时代的《新法兰西杂志》白色\n封面上发表过东西'),
      '他在超现实主义时代的《新法兰西杂志》白色封面上发表过东西',
    );
  });

  it('★ ASCII 之间补一个空格（否则 NewYork 会粘成一块）', () => {
    assert.equal(tidyOcrText('he lived in New\nYork for years'), 'he lived in New York for years');
  });

  it('中文接英文不加空格（中文本来就不用空格分隔）', () => {
    assert.equal(tidyOcrText('译者\nSmith'), '译者Smith');
  });

  it('空行保留成段落分隔', () => {
    assert.equal(tidyOcrText('第一段一行\n第一段另一行\n\n第二段'), '第一段一行第一段另一行\n\n第二段');
  });

  it('多个空行压成一个（OCR 常在段落之间吐两三行空白）', () => {
    assert.equal(tidyOcrText('甲\n\n\n\n乙'), '甲\n\n乙');
  });

  it('行首尾的空白先 trim —— 缩进是纸面上的，不是文本里的', () => {
    assert.equal(tidyOcrText('  她戴了一个指环，  \n  也许还别了一根胸针。 '), '她戴了一个指环，也许还别了一根胸针。');
  });

  it('Windows 换行与老式回车都按换行处理', () => {
    assert.equal(tidyOcrText('甲\r\n乙\r丙'), '甲乙丙');
  });

  it('空输入 / 纯空白 / null 都返回空串（调用方不用判空）', () => {
    assert.equal(tidyOcrText(''), '');
    assert.equal(tidyOcrText('   \n\n  '), '');
    assert.equal(tidyOcrText(null), '');
    assert.equal(tidyOcrText(undefined), '');
  });

  it('不纠错、不改标点：OCR 的错字要原样留着，用户才知道该不该信', () => {
    assert.equal(tidyOcrText('正的大腕，他再超现实主义时代'), '正的大腕，他再超现实主义时代');
  });

  it('★ 反向对照：不合并行的那一版会让一句话断成两截', () => {
    const raw = '他在超现实主义时代的《新法兰西杂志》白色\n封面上发表过东西';
    // 旧做法是直接 pre-wrap 渲染 —— 文本里留着 \n，窄容器里必然二次折行。
    assert.ok(raw.includes('\n'), '原始文本确实带视觉换行');
    assert.equal(tidyOcrText(raw).includes('\n'), false, '合并之后不该再有换行');
  });
});
