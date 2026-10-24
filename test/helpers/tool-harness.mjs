/**
 * 工具层测试脚手架：把 RssService 跑起来，并把**注册到宿主上的工具**取出来。
 *
 * 为什么单独一个：`service.test.mjs` 的 boot 与它自己的收尾（sandbox 常量、用例里
 * 直接改 `process.env.DSH_HOME`）是缠在一起的，抽出来会牵动那边一堆用例。
 * 这里只服务「真的调一次 `tool.execute()`」这一类测试。
 *
 * 两条纪律照抄 service.test.mjs：
 *  1. 每个 boot 一个独立 `DSH_HOME` —— 共用会让上一个用例 flush 的 data.json
 *     被下一个 `load()` 读回，症状是莫名其妙的「该订阅已存在」。
 *  2. 收尾先清 500ms 去抖计时器**再**删沙箱 —— 否则计时器会在 rm 遍历目录时醒来，
 *     mkdir 往正在被删的目录里塞文件 ⇒ ENOTEMPTY 让收尾钩子失败。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeContext } from './fake-ctx.mjs';
import { loadHostBundle } from './host-bundle.mjs';

let homeCounter = 0;
const sandboxes = new Set();
const liveServices = new Set();
const realFetch = globalThis.fetch;

/** 起一个 service，返回注册在宿主上的工具表（按名字索引）。 */
export async function bootService(options = {}) {
  const { RssService } = await loadHostBundle();
  const sandbox = await mkdtemp(join(tmpdir(), 'npie-tools-'));
  sandboxes.add(sandbox);
  process.env.DSH_HOME = join(sandbox, `home-${homeCounter}`);
  homeCounter += 1;
  const fake = createFakeContext(options);
  globalThis.fetch = fake.state.fetch;
  const service = new RssService(fake.ctx, {});
  liveServices.add(service);
  return { ...fake, service, sandbox, tools: new Map(fake.state.tools.map((tool) => [tool.name, tool])) };
}

/**
 * 调一个工具，把它渲染出来的文本取回来。
 * ★ 必须走 `output.render` 而不是直接读 `execute` 的返回值：工具给模型看的
 *   是渲染结果，`execute` 返回的对象形状与最终文本之间的那段拼装逻辑，
 *   只有渲染这一步才跑得到。
 */
export async function runTool(tools, name, args = {}) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`工具没注册：${name}`);
  const value = await tool.execute(args);
  return tool.output.render(args, value).map((part) => part.text).join('');
}

export async function disposeHarness() {
  globalThis.fetch = realFetch;
  for (const service of liveServices) {
    const store = service?.store;
    if (store?.saveTimer !== undefined) {
      clearTimeout(store.saveTimer);
      store.saveTimer = undefined;
    }
  }
  liveServices.clear();
  for (const sandbox of sandboxes) {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  sandboxes.clear();
}
