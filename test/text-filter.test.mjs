/**
 * A6「TXT 假书剔除」判据。
 *
 * ★ 三条互相独立的性质，每条都带反向对照：
 *   ① 判据真能认出 shuting CHANGELOG 里那两次事故里的文件（短文本 / IP 配置）；
 *   ② 扫描**只标 suspect、不排除**：书照常进书单、照常能打开；
 *   ③ 只搬过滤不搬解码：抽样文本仍走本插件更严谨的 decodeTextBuffer。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  TEXT_FILTER_VERSION, hasSentencePunctuation, inspectText, looksLikeBook,
} from '../src/text-filter.js';
import { TEXT_SAMPLE_BYTES, scanLocalRoots } from '../src/host/book-source.js';
import { decodeTextBuffer } from '../src/host/ebook/plain.js';
import { stripComments } from '../scripts/strip-comments.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = joinPath(dirname(fileURLToPath(import.meta.url)), '..');
const filterSource = readFileSync(joinPath(root, 'src/text-filter.js'), 'utf8');
const sourceScan = stripComments(readFileSync(joinPath(root, 'src/host/book-source.js'), 'utf8'));
const librarySource = stripComments(readFileSync(joinPath(root, 'src/client/LibraryApp.jsx'), 'utf8'));

const NOVEL = [
  '第一章 起风了',
  ...Array.from({ length: 12 }, (_, i) =>
    `他从很远的地方走过来，站在那棵老树下面停了一会儿，又把行李放在重庆的旧站台上。` +
    `街灯亮起来的时候，会计还在厦门等着处理那笔账，谁也没有先开口说话。这是第${i + 1}段。`),
].join('\n');

const IP_CONFIG = Array.from({ length: 40 }, (_, i) => ` ip address 10.0.0.${i + 1}`).join('\n');
const REQUIREMENTS = 'requests==2.31.0\nnumpy>=1.26\nflask\n# comment\npytest\n';

describe('A6 · 判据本身：两起真事故的反例必须变红', () => {
  it('版本号锁在 3（改规则要递增，否则缓存里的旧结论永不重算）', () => {
    assert.equal(TEXT_FILTER_VERSION, 3);
    assert.match(filterSource, /TEXT_FILTER_VERSION = 3/);
  });

  it('空文本 / 不足 200 字 → suspect，理由里说清是「多少字」', () => {
    assert.equal(inspectText('').suspect, true);
    assert.match(inspectText('').reason, /没有正文/);
    const short = inspectText('一本很短的笔记。\n只有这两行。');
    assert.equal(short.suspect, true);
    assert.match(short.reason, /字/);
  });

  it('★ 40 行网络设备配置不能算散文（小数点 / IP 不是句号）', () => {
    const verdict = inspectText(IP_CONFIG);
    assert.equal(verdict.suspect, true, 'IP 配置混进书库 = shuting 修过的那次事故');
    assert.equal(verdict.sentenceLines, 0);
    assert.ok(verdict.words >= 200, '夹具必须越过字数下限，才能真正测到标点判据');

    // 反向对照：旧的一刀切正则会把每行都算成句子行 ⇒ 整份配置被判成书。
    const naive = IP_CONFIG.split('\n').filter(l => /[.。！？；.!?;]/.test(l)).length;
    assert.equal(naive, 40, '旧规则在本夹具上确实会误判，这条对照不能假绿');
  });

  it('★ requirements.txt 这类短清单 → suspect', () => {
    assert.equal(inspectText(REQUIREMENTS).suspect, true);
    assert.equal(looksLikeBook(REQUIREMENTS), false);
  });

  it('真小说（有章节、有长句）→ 不 suspect，且带得出统计', () => {
    const verdict = inspectText(NOVEL);
    assert.equal(verdict.suspect, false, verdict.reason);
    assert.equal(verdict.reason, '');
    assert.ok(verdict.longLines >= 5);
    assert.ok(verdict.sentenceLines >= 1);
    assert.equal(looksLikeBook(NOVEL), true);
  });

  it('「几乎全是短行 + 没句子」这一条单独也拦得住（不靠字数下限）', () => {
    // 每行 4 个短词 ⇒ 总词数越过 200 字下限，但每行仍 < 20 字符、没有句子。
    const words = Array.from({ length: 120 }, (_, i) => `a${i} b${i} c${i} d${i}`).join('\n');
    const verdict = inspectText(words);
    assert.ok(verdict.lines >= 100);
    assert.equal(verdict.suspect, true);
    assert.match(verdict.reason, /短行/);
  });

  it('hasSentencePunctuation：中文标点直认，ASCII 要前非数字 + 后空白/行尾', () => {
    assert.equal(hasSentencePunctuation('他说：好了。'), true);
    assert.equal(hasSentencePunctuation('真的吗？当然！'), true);
    assert.equal(hasSentencePunctuation('Done. '), true);
    assert.equal(hasSentencePunctuation('Wait!'), true);
    assert.equal(hasSentencePunctuation('10.0.0.1'), false);
    assert.equal(hasSentencePunctuation('3.14 是圆周率'), false);
    assert.equal(hasSentencePunctuation('版本 v1.2 发布'), false);
  });

  it('looksLikeBook 与 inspectText 同一口径，不会一个说是一个说不是', () => {
    for (const text of [NOVEL, IP_CONFIG, REQUIREMENTS, '', '短']) {
      assert.equal(looksLikeBook(text), !inspectText(text).suspect);
    }
  });
});

// ★ 目录名带 pid：测试套件多进程同毫秒启动时会共用 mkdtemp 前缀而串味。
// ★ 顶层 await 不能放进 describe 回调（回调不是 async），与 book-source.test.mjs 同款姿势。
const SANDBOX = await mkdtemp(join(tmpdir(), `npie-textfilter-${process.pid}-`));
const ROOT = join(SANDBOX, '库');
let result;

try {
  await mkdir(ROOT, { recursive: true });
  await writeFile(join(ROOT, '真书.txt'), NOVEL);
  await writeFile(join(ROOT, '设备配置.txt'), IP_CONFIG);
  await writeFile(join(ROOT, 'requirements.txt'), REQUIREMENTS);
  // BOM 文件：解码链要先剥 BOM，不能把 \uFEFF 当成正文的一个字。
  await writeFile(join(ROOT, '带BOM的书.txt'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(NOVEL, 'utf8')]));
  await writeFile(join(ROOT, '正常.pdf'), 'PDF-A');
  // 二进制垃圾：解码链要宽容兜住，不许让整次扫描抛出去。
  await writeFile(join(ROOT, '坏字节.txt'), Buffer.from(new Array(300).fill(0xff)));
  result = await scanLocalRoots([ROOT]);
} finally {
  // 清理失败不许让判据变红（本机安全策略会拦递归删，与被测行为无关）。
  await rm(SANDBOX, { recursive: true, force: true }).catch(() => {});
}

const byName = Object.fromEntries(result.books.map(book => [book.filename, book]));

describe('A6 · 扫描真跑：只标不排、只对本地 TXT、解码仍走原链路', () => {
  it('★ 六本全在书单里 —— 一个都没被排除', () => {
    assert.equal(result.books.length, 6);
    assert.equal(result.errors.length, 0);
    for (const name of ['真书.txt', '设备配置.txt', 'requirements.txt', '带BOM的书.txt', '正常.pdf', '坏字节.txt']) {
      assert.ok(byName[name], `${name} 被自动排除了 —— 判定放错层了`);
    }
  });

  it('★ 假书带 suspect + 能自救的理由，真书与 PDF 不带标记', () => {
    assert.equal(byName['设备配置.txt'].suspect, true);
    assert.match(byName['设备配置.txt'].suspectReason, /长句|短行/);
    assert.equal(byName['requirements.txt'].suspect, true);
    assert.equal(byName['真书.txt'].suspect, undefined);
    assert.equal(byName['带BOM的书.txt'].suspect, undefined, 'BOM 没剥掉会把书判坏');
    assert.equal(byName['正常.pdf'].suspect, undefined, '非 TXT 不该抽样');
  });

  it('坏字节 TXT 不中断扫描（宽容解码兜住），且如实标出来', () => {
    assert.equal(byName['坏字节.txt'].suspect, true);
    assert.match(byName['坏字节.txt'].suspectReason, /字|短行|长句/);
  });

  it('id 仍然稳定 —— 新增字段没有动进度赖以存活的键', async () => {
    // 目录已清理，这一条只核纯函数的口径：同路径两次 id 必须一致。
    const { bookIdFromPath } = await import('../src/library.js');
    assert.equal(bookIdFromPath('l', '/tmp/a/真书.txt'), bookIdFromPath('l', '/tmp/a/真书.txt'));
  });

  it('抽样上限是 64 KB，解码用的是 decodeTextBuffer（不是另写一份嗅探）', () => {
    assert.equal(TEXT_SAMPLE_BYTES, 64 * 1024);
    assert.equal(decodeTextBuffer(Buffer.from('中文正文')).text, '中文正文');
    assert.match(sourceScan, /decodeTextBuffer\(await sampleTextFile\(full\)\)/);
    assert.match(sourceScan, /import \{ decodeTextBuffer \} from '\.\/ebook\/plain\.js'/);
    assert.doesNotMatch(sourceScan, /toString\('utf8'\)/, '又写了一份 shuting 式解码');
  });

  it('★ 判定只在 scanLocalRoots 里做，网盘不下载正文、不乱标', () => {
    const local = /export async function scanLocalRoots\([\s\S]*?\n\}/.exec(sourceScan)?.[0] ?? '';
    const pan = /export async function scanPanRoots\([\s\S]*?\n\}/.exec(sourceScan)?.[0] ?? '';
    assert.match(local, /inspectText\(/);
    assert.ok(pan.length > 0, '没切出 scanPanRoots，这条断言会静默失效');
    assert.doesNotMatch(pan, /inspectText\(|sampleTextFile\(/);
  });

  it('★ 书单里真的画出了「可能不是书」，且是提示不是按钮', () => {
    assert.match(librarySource, /book\.suspect &&/);
    assert.match(librarySource, /可能不是书/);
    assert.match(librarySource, /title=\{book\.suspectReason/);
    assert.match(librarySource, /className="npr-bookrow-dup"/);
  });

  it('不新增 CSS 类名（复用虚线说明那一档），类名守卫不会被打破', () => {
    const added = /npr-bookrow-suspect|npr-book-suspect/.test(librarySource);
    assert.equal(added, false);
  });

  it('MIT 移植保留原作者署名', () => {
    assert.match(filterSource, /MIT/);
    assert.match(filterSource, /Copyright \(c\) 2026 Zanbin Xu/);
  });
});
