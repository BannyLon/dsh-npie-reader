/**
 * 私密日记的密钥与信封加密（`src/host/diary-secret.js`）。
 *
 * ★ 这一层**不能靠「看起来对」验收**：加密写错一个字，结果是「能加能解、一切正常，
 *   但谁都能解开」—— 而这种错误在界面上完全没有症状。所以这里的断言分成两类：
 *   1. **往返**（加密 → 解密 → 逐字节相同）：证明它至少是自洽的；
 *   2. **拒绝**（篡改 / 换钥匙 / 坏信封）：证明那道校验是真的在校验。
 *   只有第 1 类的测试，把 `setAuthTag` 那一行删掉也照样全绿。
 *
 * ★ 钥匙串一律用注入的假执行器（`run`）：真去调 `security` 会在跑测试时往用户的
 *   登录钥匙串里写条目 —— 测试不该有这种副作用，而且 CI 里根本没有钥匙串。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  ENVELOPE_VERSION, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, createDiarySecret,
} from '../src/host/diary-secret.js';

let dir = '';
const keyPathOf = (name) => join(dir, name);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'npie-secret-'));
});

after(async () => {
  // 清理失败 ≠ 断言失败（沙箱有时会拦删除，甚至把它吊住）。
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** 一把固定的 32 字节钥匙（不碰钥匙串、不碰磁盘）。 */
const keyOf = (fill) => Buffer.alloc(32, fill);

/**
 * 假的 `security`：内存里存一条条目，行为与真命令对齐。
 * `available: false` 模拟「钥匙串不可用」（无 GUI 会话 / 权限被拒 / 超时）。
 */
function fakeKeychain({ available = true, stored = null } = {}) {
  const state = {
    stored, adds: 0, finds: 0, calls: [],
    run: async (args) => {
      state.calls.push(args.join(' '));
      if (args[0] === 'find-generic-password') {
        state.finds += 1;
        if (!available) return { code: 44, stdout: '', stderr: 'The specified item could not be found' };
        if (state.stored === null) return { code: 44, stdout: '', stderr: 'The specified item could not be found' };
        return { code: 0, stdout: `${state.stored}\n`, stderr: '' };
      }
      if (args[0] === 'add-generic-password') {
        state.adds += 1;
        if (!available) return { code: 1, stdout: '', stderr: 'denied' };
        state.stored = args[args.indexOf('-w') + 1];
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: `未知子命令 ${args[0]}` };
    },
  };
  return state;
}

describe('信封往返', () => {
  it('中文 / 多行 / 空串都能原样回来', async () => {
    const secret = createDiarySecret({ key: keyOf(1), keyPath: keyPathOf('a.key') });
    const samples = [
      '今天很累。#生活',
      '## 09:31 灵感\n\n第一段\n\n- 列表\n- 第二项\n\n> 引用',
      '',
      '表情与符号：😄 🎐 《被讨厌的勇气》 100%',
    ];
    for (const plain of samples) {
      const blob = await secret.encrypt(plain);
      assert.equal(await secret.decrypt(blob), plain);
    }
  });

  it('信封是单行 JSON，带 v / iv / tag / data 四个字段', async () => {
    const secret = createDiarySecret({ key: keyOf(2), keyPath: keyPathOf('b.key') });
    const blob = await secret.encrypt('正文');
    assert.equal(blob.endsWith('\n'), true, '末尾留一个换行，`cat` 出来才像文本文件');
    const envelope = JSON.parse(blob.trim());
    assert.deepEqual(Object.keys(envelope).sort(), ['data', 'iv', 'tag', 'v']);
    assert.equal(envelope.v, ENVELOPE_VERSION);
    assert.equal(Buffer.from(envelope.iv, 'base64').length, 12);
    assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);
    // 明文**不在**信封里（这条很笨，但它正是「加密有没有真的发生」的唯一直接证据）
    assert.equal(blob.includes('正文'), false);
    assert.equal(blob.includes(Buffer.from('正文').toString('base64')), false);
  });

  it('★ 同一明文两次加密结果不同（iv 随机）', async () => {
    const secret = createDiarySecret({ key: keyOf(3), keyPath: keyPathOf('c.key') });
    const one = await secret.encrypt('同一段话');
    const two = await secret.encrypt('同一段话');
    assert.notEqual(one, two);
    // 反向对照：两个都能解开，说明差异来自 iv 而不是「其中一个坏了」
    assert.equal(await secret.decrypt(one), '同一段话');
    assert.equal(await secret.decrypt(two), '同一段话');
  });
});

describe('拒绝（这一层真正要证明的东西）', () => {
  const sealed = async () => {
    const secret = createDiarySecret({ key: keyOf(4), keyPath: keyPathOf('d.key') });
    return { secret, envelope: JSON.parse((await secret.encrypt('机密内容')).trim()) };
  };

  it('★ 改一个字节的密文就解不开（GCM 校验真的在校验）', async () => {
    const { secret, envelope } = await sealed();
    const data = Buffer.from(envelope.data, 'base64');
    data[0] ^= 0xff;
    const tampered = JSON.stringify({ ...envelope, data: data.toString('base64') });
    await assert.rejects(() => secret.decrypt(tampered), (error) => error.code === 'DECRYPT_FAILED');
  });

  it('★ 改 tag 也解不开（不能只校验密文长度）', async () => {
    const { secret, envelope } = await sealed();
    const tag = Buffer.from(envelope.tag, 'base64');
    tag[0] ^= 0xff;
    await assert.rejects(
      () => secret.decrypt(JSON.stringify({ ...envelope, tag: tag.toString('base64') })),
      (error) => error.code === 'DECRYPT_FAILED',
    );
  });

  it('★ 换一把钥匙解不开 —— 「密钥丢了」必须是可观察的失败，而不是乱码', async () => {
    const { envelope } = await sealed();
    const other = createDiarySecret({ key: keyOf(5), keyPath: keyPathOf('e.key') });
    await assert.rejects(() => other.decrypt(JSON.stringify(envelope)), (error) => error.code === 'DECRYPT_FAILED');
  });

  it('坏信封（不是 JSON / 版本不对 / iv 或 tag 长度不对）一律 DECRYPT_FAILED 且带人话', async () => {
    const secret = createDiarySecret({ key: keyOf(6), keyPath: keyPathOf('f.key') });
    const cases = [
      '这不是 JSON',
      '',
      JSON.stringify({ v: 99, iv: 'AAAA', tag: 'AAAA', data: 'AAAA' }),
      JSON.stringify({ v: ENVELOPE_VERSION, iv: 'AAAA', tag: 'AAAAAAAAAAAAAAAAAAAAAA==', data: '' }),
      JSON.stringify({ v: ENVELOPE_VERSION, iv: 'AAAAAAAAAAAAAAAA', tag: 'AAAA', data: '' }),
    ];
    for (const blob of cases) {
      await assert.rejects(
        () => secret.decrypt(blob),
        (error) => error.code === 'DECRYPT_FAILED' && /日记|信封|解不开/.test(error.message),
        blob,
      );
    }
  });
});

describe('密钥来源：钥匙串优先，失败退回文件', () => {
  it('钥匙串可用时用它，并把条目建在约定的 service / account 上', async () => {
    const chain = fakeKeychain();
    const secret = createDiarySecret({ run: chain.run, keyPath: keyPathOf('g.key') });
    const status = await secret.status();
    assert.equal(status.mode, 'keychain');
    assert.equal(chain.adds, 1);
    const add = chain.calls.find(line => line.startsWith('add-generic-password'));
    assert.ok(add.includes(KEYCHAIN_SERVICE), add);
    assert.ok(add.includes(KEYCHAIN_ACCOUNT), add);
    assert.ok(add.includes('-U'), '必须幂等：并发启动时两个进程都会建');
    // 密钥**没有**落到磁盘
    await assert.rejects(() => stat(keyPathOf('g.key')), (error) => error.code === 'ENOENT');
  });

  it('★ 第二次取密钥不再碰钥匙串（缓存），且加解密都能用', async () => {
    const chain = fakeKeychain();
    const secret = createDiarySecret({ run: chain.run, keyPath: keyPathOf('h.key') });
    const blob = await secret.encrypt('一');
    const before = chain.calls.length;
    assert.equal(await secret.decrypt(blob), '一');
    await secret.encrypt('二');
    assert.equal(chain.calls.length, before, '取过一次就不该再调 security');
  });

  it('★ 钥匙串不可用 ⇒ 退回本地密钥文件，并如实报 `mode: "file"`', async () => {
    const chain = fakeKeychain({ available: false });
    const secret = createDiarySecret({ run: chain.run, keyPath: keyPathOf('i.key') });
    const status = await secret.status();
    assert.equal(status.mode, 'file', '悄悄降级等于给用户一个「以为加密了」的假象');
    assert.equal(status.keyPath, keyPathOf('i.key'));
    // 权限必须是 0600：这把钥匙能解开全部私密日记
    const info = await stat(keyPathOf('i.key'));
    assert.equal(info.mode & 0o777, 0o600, `权限是 ${(info.mode & 0o777).toString(8)}`);
    // 文件里是 base64 的 32 字节
    assert.equal(Buffer.from((await readFile(keyPathOf('i.key'), 'utf8')).trim(), 'base64').length, 32);
    // 而且真的能用
    assert.equal(await secret.decrypt(await secret.encrypt('退回文件也能用')), '退回文件也能用');
  });

  it('★ 退回文件后重启（新的 secret 实例）读回**同一把**钥匙，旧日记仍能解', async () => {
    const chain = fakeKeychain({ available: false });
    const first = createDiarySecret({ run: chain.run, keyPath: keyPathOf('j.key') });
    const blob = await first.encrypt('昨天的日记');
    const second = createDiarySecret({ run: chain.run, keyPath: keyPathOf('j.key') });
    assert.equal(await second.decrypt(blob), '昨天的日记');
  });

  it('钥匙串超时（code -2）当不可用，退回文件而不是抛错', async () => {
    const secret = createDiarySecret({
      run: async () => ({ code: -2, stdout: '', stderr: '钥匙串调用超时' }),
      keyPath: keyPathOf('k.key'),
    });
    assert.equal((await secret.status()).mode, 'file');
  });

  it('★ 钥匙串里有条目但长度不对 ⇒ 报错且**绝不覆盖**', async () => {
    // 覆盖的后果不是「修好了」，而是把已加密的日记变成永久乱码。
    const chain = fakeKeychain({ stored: randomBytes(16).toString('base64') });
    const secret = createDiarySecret({ run: chain.run, keyPath: keyPathOf('l.key') });
    // `status()` 是**报告**函数：它不 reject（reject 会让「看一眼状态」变成一个错误页），
    // 而是把失败如实写在 `mode: 'error'` 里。
    const status = await secret.status();
    assert.equal(status.mode, 'error');
    assert.match(status.error, /密钥/);
    // 真正要拦的是写路径：加解密必须拒绝，不能拿一把新钥匙把旧日记盖掉。
    await assert.rejects(() => secret.encrypt('新的一条'), (error) => error.code === 'KEY_MALFORMED');
    assert.equal(chain.adds, 0, '不能建新条目去覆盖');
    // 也不能顺手退回文件（那会让「这把钥匙解不开旧日记」被一个新模式掩盖）
    await assert.rejects(() => stat(keyPathOf('l.key')), (error) => error.code === 'ENOENT');
  });
});

describe('peek 不碰钥匙串', () => {
  it('★ peek 只报已知状态：不取密钥、不建密钥、不调 security', async () => {
    // 存在的理由：页脚/设置页频繁调 `stats()`，而取密钥可能碰系统钥匙串 ——
    // 更不该在没人用私密日记时就凭空在用户钥匙串里留下一条。
    const chain = fakeKeychain();
    const secret = createDiarySecret({ run: chain.run, keyPath: keyPathOf('m.key') });
    assert.equal(secret.peek().mode, 'unknown');
    assert.equal(chain.calls.length, 0);
    // 反向对照：status() 必须真的会取（否则上一条会因为「什么都不做」而假绿）
    await secret.status();
    assert.ok(chain.calls.length > 0);
    assert.equal(secret.peek().mode, 'keychain', '取过之后 peek 要能报出来');
  });

  it('注入密钥时 peek 报 `injected`（测试路径不该被误认成钥匙串）', () => {
    const secret = createDiarySecret({ key: keyOf(7), keyPath: keyPathOf('n.key') });
    assert.equal(secret.peek().mode, 'injected');
  });
});
