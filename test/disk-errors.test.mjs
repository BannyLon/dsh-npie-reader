/**
 * 磁盘错误 → 人话（2026-10-25）。
 *
 * 判据有两条，缺一条这层就等于没写：
 *   ① **翻得了的必须翻**（ENOSPC 之类），并且带上稳定 `code` —— 路由层靠 code 回 507；
 *   ② **翻不了的必须原样穿过去**。把 `TypeError` 也包成「磁盘出问题了」会掩盖真正的
 *      bug，比不翻更糟（用户去清磁盘，而代码里其实有个 null 没判）。
 *
 * ★ 反向对照钉在「原始错误长什么样」上：如果 `writeFile` 抛出来的那句话里
 *   根本不含 `ENOSPC`，那「翻成中文」这件事就没有必要，整层是自嗨。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DISK_ERROR_CODES, describeFsError, guardFs } from '../src/host/disk-errors.js';

/** 造一个带 errno 的错误，形状与 Node 的 fs 错误一致。 */
function fsError(code, extra = {}) {
  const error = new Error(`${code}: something bad, write`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

describe('describeFsError：errno → 人话', () => {
  it('★ ENOSPC 翻成「磁盘空间不够了」，并带上稳定 code `DISK_FULL`', () => {
    const error = describeFsError(fsError('ENOSPC'), { what: '这条划线和笔记' });
    assert.equal(error.code, 'DISK_FULL');
    assert.match(error.message, /磁盘空间不够了/);
    assert.match(error.message, /这条划线和笔记/, '没说清是「存什么」失败了');
    assert.doesNotMatch(error.message, /ENOSPC/, '把 errno 留在给用户看的句子里，等于没翻');
  });

  it('配额用完（EDQUOT）也算「空间不够」—— 用户的动作是同一个', () => {
    assert.equal(describeFsError(fsError('EDQUOT')).code, 'DISK_FULL');
  });

  it('权限 / 只读 / 文件句柄 / 路径过长 / 硬件 IO 各有各的话', () => {
    assert.equal(describeFsError(fsError('EACCES')).code, 'DISK_DENIED');
    assert.equal(describeFsError(fsError('EPERM')).code, 'DISK_DENIED');
    assert.equal(describeFsError(fsError('EROFS')).code, 'DISK_READONLY');
    assert.equal(describeFsError(fsError('EMFILE')).code, 'DISK_TOO_MANY_FILES');
    assert.equal(describeFsError(fsError('ENFILE')).code, 'DISK_TOO_MANY_FILES');
    assert.equal(describeFsError(fsError('ENAMETOOLONG')).code, 'DISK_BAD_PATH');
    assert.equal(describeFsError(fsError('EIO')).code, 'DISK_IO');
  });

  it('每一种翻出来的 code 都在公开清单里（路由层只认这份清单）', () => {
    for (const errno of ['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EMFILE', 'ENFILE', 'ENAMETOOLONG', 'EIO']) {
      const code = describeFsError(fsError(errno)).code;
      assert.ok(DISK_ERROR_CODES.includes(code), `${errno} 翻出来的 ${code} 不在 DISK_ERROR_CODES 里`);
    }
  });

  it('原始错误留在 `cause` 里（日志要能看到真实路径）', () => {
    const raw = fsError('ENOSPC', { path: '/Users/x/.dsh/storages/data.json' });
    const error = describeFsError(raw, { what: '阅读进度' });
    assert.equal(error.cause, raw);
    assert.equal(error.errno, 'ENOSPC');
    assert.match(String(error.cause.path), /data\.json$/);
  });

  it('★ 翻不了的**原样返回同一个对象** —— 不许把 TypeError 说成磁盘问题', () => {
    const typeError = new TypeError('x is not a function');
    assert.equal(describeFsError(typeError), typeError, '被包了一层，真正的原因就再也看不到了');
    const business = new Error('这本书的划线已经到 2000 条上限');
    business.code = 'BAD_ANNOTATION';
    assert.equal(describeFsError(business), business);
    // 没有 code 的普通 Error 也不能动。
    const plain = new Error('随便什么');
    assert.equal(describeFsError(plain), plain);
    assert.equal(describeFsError(undefined), undefined);
  });

  it('`what` 默认是「数据」，不会漏出 `{what}` 这个占位符', () => {
    const error = describeFsError(fsError('ENOSPC'));
    assert.match(error.message, /保存数据/);
    assert.doesNotMatch(error.message, /\{what\}/);
  });
});

describe('guardFs：包住一次写盘', () => {
  it('成功时把返回值原样交出来', async () => {
    assert.equal(await guardFs(async () => 42, '数据'), 42);
  });

  it('失败时抛人话版（并保留 cause）', async () => {
    const raw = fsError('ENOSPC');
    await assert.rejects(
      () => guardFs(async () => { throw raw; }, '导出的技能包'),
      (error) => {
        assert.equal(error.code, 'DISK_FULL');
        assert.match(error.message, /导出的技能包/);
        assert.equal(error.cause, raw);
        return true;
      },
    );
  });

  it('★ 真实的 fs 错误（ENOENT）不该被翻译 —— 它原样抛出来', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'npie-disk-'));
    try {
      const target = join(dir, 'not-a-dir', 'x.json');
      await assert.rejects(
        () => guardFs(() => writeFile(target, 'x'), '数据'),
        (error) => {
          assert.equal(error.code, 'ENOENT', 'ENOENT 被改写成了别的 code');
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('★ 反向对照：Node 自己抛的 ENOSPC 文案确实是英文 errno（所以这层翻译不是自嗨）', () => {
    // 不真的把磁盘写满：这里只钉「我们翻的那句话，原始形态长什么样」。
    const raw = new Error('ENOSPC: no space left on device, write');
    raw.code = 'ENOSPC';
    assert.match(raw.message, /ENOSPC: no space left on device/);
    assert.doesNotMatch(describeFsError(raw).message, /no space left on device/);
  });
});
