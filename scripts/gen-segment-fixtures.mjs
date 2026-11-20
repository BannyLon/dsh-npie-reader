/**
 * 生成 test/fixtures/segment/ 下的三份**合成**夹具。
 *
 * 为什么合成：原来那三份是真实书籍的页面 dump（两本外部手册的整本正文 + 一本小说的
 * 书签目录）。它们把第三方内容放进了公开仓库，属于二次分发。合成数据只保留
 * 「判据需要复现的形态」，不含任何真实出版物的一行字。
 *
 * 需要复现的形态（与 test/segment.test.mjs 的断言一一对应）：
 *   toc-3pages.json   98 页；目录占 p2–p4；40 章；第一章在 p5；目录页 noPunct=1
 *   toc-radical.json  153 页；目录在 p2；首条用康熙部首「⾃」而正文用「自」；
 *                     「附录」与「附录A」指向同一页
 *   outline.json      635 页；58 条书签，含扉页/目录/版权页噪音；首条在 p3
 */
import { writeFileSync } from 'node:fs';

const OUT = 'test/fixtures/segment';

/** 确定性伪随机（同一份脚本永远产出同一份夹具）。 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const FRAG = [
  '这一页用来模拟正常排版的正文行',
  '行与行之间应当把版面撑满',
  '段落末尾一般要收一个句号',
  '分页位置由排版引擎决定',
  '合成文本不含任何真实出版物的内容',
  '示例数据只服务于分段判据',
];

/** 造一页正文：每行 2–3 个分句，末句带句号 ⇒ noPunct 恒为 0。 */
function prose(seed, lines = 5) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < lines; i += 1) {
    const n = 2 + Math.floor(r() * 2);
    let line = '';
    for (let j = 0; j < n; j += 1) {
      line += FRAG[Math.floor(r() * FRAG.length)] + (j === n - 1 ? '。' : '，');
    }
    out.push(line);
  }
  return out;
}

const pad2 = n => String(n).padStart(2, '0');

// ── A：目录占三页 ─────────────────────────────────────────────────────
const WORDS_A = [
  '准备', '起步', '结构', '流程', '协作', '检索', '缓存', '同步',
  '导入', '导出', '校验', '备份', '恢复', '性能', '并发', '日志',
  '权限', '发布', '升级', '回滚', '图表', '表格', '图片', '音频',
  '字幕', '标注', '搜索', '排序', '筛选', '分页', '主题', '快捷',
  '插件', '脚本', '测试', '监控', '告警', '评审', '交接', '收尾',
];
const titleA = i => `第 ${pad2(i + 1)} 章 ${WORDS_A[i]}`;
const pageA = i => 5 + i * 2; // 5,7,…,83
const tocLine = (title, page) => `${title}……${page}`;

const pagesA = [];
pagesA.push(['合成手册', '内部测试用数据', '不含任何真实出版物内容']);
pagesA.push(['目录', 'CONTENTS', ...WORDS_A.slice(0, 20).map((_, i) => tocLine(titleA(i), pageA(i)))]);
pagesA.push(WORDS_A.slice(20, 32).map((_, k) => tocLine(titleA(20 + k), pageA(20 + k))));
pagesA.push(WORDS_A.slice(32).map((_, k) => tocLine(titleA(32 + k), pageA(32 + k))));
for (let p = 5; p <= 98; p += 1) {
  const idx = WORDS_A.findIndex((_, i) => pageA(i) === p);
  pagesA.push(idx >= 0 ? [titleA(idx), ...prose(p * 7)] : prose(p * 13));
}
writeFileSync(`${OUT}/toc-3pages.json`, JSON.stringify({ pages: pagesA }));

// ── B：目录里含康熙部首 + 附录撞页 ────────────────────────────────────
const WORDS_B = [
  '缘起', '概念', '安装', '配置', '账号', '权限', '模型', '提示词',
  '上下文', '工具', '流程', '模板', '调试', '成本', '安全', '备份',
  '迁移', '并发', '日志', '性能', '发布', '回滚', '排错', '总结',
];
const titleB = i => `第 ${pad2(i + 1)} 节 ${WORDS_B[i]}`;
const pageB = i => 6 + i * 5; // 6,11,…,121

const PREFA = '⾃序 关于这本书'; // ★ 首字是 U+2F83 康熙部首，正文里写正常的 U+81EA
const PREFA_BODY = '自序 关于这本书';

const pagesB = [];
pagesB.push(['合成技术手册', '内部测试用数据']);
pagesB.push([
  '目录', 'CONTENTS',
  tocLine(PREFA, 4),
  ...WORDS_B.map((_, i) => tocLine(titleB(i), pageB(i))),
  tocLine('附录', 140),
  tocLine('附录A 术语表', 140),
]);
pagesB.push(prose(101, 12));
pagesB.push([PREFA_BODY, ...prose(103)]);
for (let p = 5; p <= 153; p += 1) {
  if (p === 140) {
    pagesB.push(['附录A 术语表', ...prose(140)]);
    continue;
  }
  const idx = WORDS_B.findIndex((_, i) => pageB(i) === p);
  pagesB.push(idx >= 0 ? [titleB(idx), ...prose(p * 11)] : prose(p * 17));
}
writeFileSync(`${OUT}/toc-radical.json`, JSON.stringify({ pages: pagesB }));

// ── C：书签目录 ───────────────────────────────────────────────────────
const WORDS_C = [
  '序章', '空屋', '来信', '旧照片', '第一个证人', '雨夜', '账本', '阳台',
  '邻居', '校对', '第二封信', '车站', '钥匙', '停电', '口供', '屋顶',
  '日历', '录像带', '第七天', '律师', '生日', '两份名单', '出租车', '地下室',
  '错位', '钟表', '指纹', '匿名电话', '旧报纸', '第十四章', '证人',
  '列车时刻表', '钉子', '硬币', '门外', '两份遗嘱', '雨季', '病历',
  '照片背面', '第二个证人', '空房间', '电话录音', '第三次拜访', '雪',
  '回信', '抽屉', '签字', '结论', '尾声', '附录', '后记', '致读者',
  '再版说明', '译后记',
];
const pagesC = 635;
const firstC = 7;
const lastC = 619;
const step = (lastC - firstC) / (WORDS_C.length - 1);
const outline = [
  { title: '合成小说集', page: 3 },
  { title: '扉页', page: 4 },
  { title: '目录', page: 5 },
  { title: '版权页', page: 6 },
  ...WORDS_C.map((w, i) => ({ title: `${pad2(i + 1)} ${w}`, page: Math.round(firstC + i * step) })),
];
writeFileSync(`${OUT}/outline.json`, JSON.stringify({ pages: pagesC, outline }));
console.log('pagesA=%d pagesB=%d outline=%d 条', pagesA.length, pagesB.length, outline.length);
