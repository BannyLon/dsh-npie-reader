/**
 * BibTeX 生成（`src/paper-bibtex.js`）。
 *
 * ★ 这是唯一会**离开插件**的东西：用户复制出去贴进 `.bib`，交给 LaTeX 编译。
 *   所以这里量的是「能不能编过」，不是「看起来像不像 BibTeX」：
 *     · 标题必须套双层花括号（否则 bst 会把 `BERT` 转成 `bert`）；
 *     · 空字段**不许**写成 `journal = {}`（有些解析器会因此报错）；
 *     · 引用键不能为空（`\cite{}` 直接编译失败）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bibtexFile, bibtexFor, citeKeyFor, entryTypeFor, escapeBibtex } from '../src/paper-bibtex.js';

const PAPER = {
  id: 'pabc123',
  title: 'Sparse Routing for Long Documents',
  authors: ['Ada Example', 'Bo Sample'],
  year: 2017,
  venue: 'NeurIPS',
  doi: '10.0000/example.0003',
  arxivId: '2401.00001',
  categories: ['cs.CL'],
  url: '',
  tags: ['transformer'],
};

describe('escapeBibtex', () => {
  it('只转义 LaTeX 里有特殊含义的字符，不做 HTML 那套', () => {
    assert.equal(escapeBibtex('A & B'), 'A \\& B');
    assert.equal(escapeBibtex('100% done'), '100\\% done');
    assert.equal(escapeBibtex('snake_case'), 'snake\\_case');
    // HTML 实体在 .bib 里毫无意义，转了反而会在 PDF 里原样印出来。
    assert.equal(escapeBibtex('<tag>'), '<tag>');
  });

  it('反斜杠先转，不会把后面加进去的反斜杠再转一次', () => {
    assert.equal(escapeBibtex('a\\b'), 'a\\textbackslash{}b');
  });

  it('折叠换行（arXiv 的标题在 XML 里是折行的）', () => {
    assert.equal(escapeBibtex('Sparse Routing for\nLong Documents'), 'Sparse Routing for Long Documents');
  });
});

describe('citeKeyFor', () => {
  it('姓 + 年 + 标题首个实词', () => {
    assert.equal(citeKeyFor(PAPER), 'example2017sparse');
  });

  it('跳过 the / a / on 这类虚词', () => {
    assert.equal(citeKeyFor({ authors: ['Jane Doe'], year: 2020, title: 'On the Origin of Species' }), 'doe2020origin');
  });

  it('`Last, First` 形态也能取到姓', () => {
    assert.equal(citeKeyFor({ authors: ['Example, Ada'], year: 2017, title: 'Sparse Routing' }), 'example2017sparse');
  });

  it('没作者没标题也不能给空键（空键让 `\\cite{}` 直接编不过）', () => {
    assert.equal(citeKeyFor({ id: 'pabc123' }), 'paperpabc123');
  });
});

describe('entryTypeFor', () => {
  it('有 venue ⇒ article；只有 arXiv ⇒ misc；都没有 ⇒ misc', () => {
    assert.equal(entryTypeFor(PAPER), 'article');
    assert.equal(entryTypeFor({ arxivId: '2401.00001', venue: '' }), 'misc');
    assert.equal(entryTypeFor({}), 'misc');
  });
});

describe('bibtexFor', () => {
  it('标题套双层花括号，作者用 and 连接，年份是裸数字', () => {
    const out = bibtexFor(PAPER);
    assert.match(out, /^@article\{example2017sparse,/);
    assert.match(out, /title = \{\{Sparse Routing for Long Documents\}\}/);
    assert.match(out, /author = \{Ada Example and Bo Sample\}/);
    assert.match(out, /year = \{2017\}/);
    assert.match(out, /journal = \{NeurIPS\}/);
    assert.match(out, /doi = \{10\.0000\/example\.0003\}/);
    assert.match(out, /eprint = \{2401\.00001\}/);
    assert.match(out, /archivePrefix = \{arXiv\}/);
    assert.match(out, /primaryClass = \{cs\.CL\}/);
    assert.match(out, /keywords = \{transformer\}/);
    // 收尾必须是 `}` + 换行，不然拼进 .bib 会粘住下一条。
    assert.match(out, /\n\}\n$/);
  });

  it('arXiv-only 用 @misc', () => {
    const out = bibtexFor({ ...PAPER, venue: '', doi: '' });
    assert.match(out, /^@misc\{/);
    assert.doesNotMatch(out, /journal = /);
  });

  it('缺字段就不写那一行（绝不产出 `journal = {}`，那会让解析器报错）', () => {
    const out = bibtexFor({ id: 'px', title: 'T', authors: [], year: 0 });
    assert.doesNotMatch(out, /journal/);
    assert.doesNotMatch(out, /year/);
    assert.doesNotMatch(out, /author/);
    assert.match(out, /^@misc\{paperpx,/);
  });

  it('空条目返回空串（调用方据此跳过，而不是往 .bib 里塞一段空 @misc）', () => {
    assert.equal(bibtexFor(null), '');
    assert.equal(bibtexFor(undefined), '');
  });

  it('显式指定的键优先（整库导出靠它去重）', () => {
    assert.match(bibtexFor(PAPER, { key: 'custom2020' }), /^@article\{custom2020,/);
  });
});

describe('bibtexFile', () => {
  it('键重复时加字母后缀 —— 同一个 .bib 里重复键会让整个文件编不过', () => {
    const out = bibtexFile([PAPER, { ...PAPER, doi: '', arxivId: '2401.00002' }]);
    assert.match(out, /@article\{example2017sparse,/);
    assert.match(out, /@article\{example2017sparsea,/);
  });

  it('多条之间留一个空行（贴进 .bib 时可读，也仍然合法）', () => {
    const out = bibtexFile([PAPER, { ...PAPER, title: 'BERT', arxivId: '2401.00003' }]);
    assert.match(out, /\n\}\n\n@/);
  });

  it('空列表返回空串', () => {
    assert.equal(bibtexFile([]), '');
    assert.equal(bibtexFile(null), '');
  });
});
