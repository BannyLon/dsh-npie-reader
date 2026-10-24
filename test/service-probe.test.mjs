/**
 * 「转 RSS 服务」探活结果的文案映射。
 *
 * 这一组用例的重点不是「文案好不好看」，而是**判据有没有写反**：
 * 返回 HTML 是服务正常的信号（它的后台就是个网页），不是配置错误。
 * 写反了界面就会把好配置说成故障，用户接着去改一个本来正确的地址 ——
 * 而这种事在真机上很难归因（用户只会说「检测说不行，但服务明明是好的」）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROBE_KINDS, probeText } from '../src/client/service-probe.js';

const here = dirname(fileURLToPath(import.meta.url));
// 探活界面 0.5.0 从「探索订阅」弹窗搬到了设置页「订阅源」标签 —— 接线断言必须跟着搬，
// 否则它守的是一份已经不存在于线上的代码（旧版这里读的是 Discover.jsx）。
const settings = readFileSync(join(here, '..', 'src', 'client', 'SettingsPage.jsx'), 'utf8');
const discover = readFileSync(join(here, '..', 'src', 'client', 'Discover.jsx'), 'utf8');

const ok = (kind, extra = {}) => ({ ok: true, status: 200, kind, ms: 12, ...extra });

describe('probeText', () => {
  test('没探过就什么都不说（空串，不是「未知」这类占位）', () => {
    assert.equal(probeText(undefined), '');
    assert.equal(probeText(null), '');
  });

  test('★ HTML 是**正常**，不许出现任何否定词', () => {
    const text = probeText(ok('html', { title: 'WeWe RSS' }));
    assert.match(text, /^通了/);
    assert.match(text, /WeWe RSS/);
    // 反向对照：这句里不能出现「不是 / 错误 / 失败 / 无效」这类判定。
    assert.doesNotMatch(text, /不是|错误|失败|无效|有问题/);
  });

  test('feed：认出来并说可以直接订阅', () => {
    const text = probeText(ok('feed', { title: '嗯哌' }));
    assert.match(text, /本身就是 feed/);
    assert.match(text, /嗯哌/);
  });

  test('JSON 与 other 分开说，且都不说「失败」', () => {
    assert.match(probeText(ok('json')), /接口而不是网页/);
    assert.match(probeText(ok('other')), /既不是网页也不是 feed/);
    assert.doesNotMatch(probeText(ok('json')), /失败/);
  });

  test('连不上：带上原始错误，并给出两个可检查的点', () => {
    const text = probeText({ ok: false, status: 0, kind: 'unreachable', ms: 8000, error: 'fetch failed' });
    assert.match(text, /连不上/);
    assert.match(text, /fetch failed/);
    assert.match(text, /服务起来了吗/);
    assert.match(text, /端口对吗/);
  });

  test('网络层失败与 HTTP 错误码是**两件事**，文案不能混', () => {
    const unreachable = probeText({ ok: false, status: 0, kind: 'unreachable', ms: 3, error: 'ECONNREFUSED' });
    const http404 = probeText({ ok: false, status: 404, kind: 'other', ms: 3 });
    assert.notEqual(unreachable, http404);
    assert.match(http404, /返回 HTTP 404/);
    assert.doesNotMatch(http404, /连不上/);
  });

  test('缺 title 时不留下空括号（那是明显的拼装痕迹）', () => {
    for (const kind of ['feed', 'html']) {
      const text = probeText(ok(kind, { title: '' }));
      assert.doesNotMatch(text, /（）|「」/);
    }
  });

  test('每个 kind 都有对应文案，没有漏网的取值', () => {
    for (const kind of PROBE_KINDS) {
      const text = probeText(kind === 'unreachable'
        ? { ok: false, status: 0, kind, ms: 1, error: 'x' }
        : ok(kind));
      assert.ok(text.length > 0, `${kind} 没有文案`);
    }
  });

  test('接线：界面用的是这个模块，不是自己又抄一份', () => {
    assert.match(settings, /import \{ probeText \} from '\.\/service-probe\.js'/);
    assert.match(settings, /probeText\(probe\)/);
    // 反向对照：把映射逻辑抄回组件里的样子 —— 出现就等于这份单测不再覆盖线上代码。
    assert.doesNotMatch(settings, /function probeText/);
    // 反向对照 ②：搬走之后旧落点必须真的清干净，否则「两份探活界面」会各说各话。
    assert.doesNotMatch(discover, /probeText|service-probe/);
  });
});
