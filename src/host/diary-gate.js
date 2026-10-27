/**
 * 私密日记的**口令闸门**（第二层，与磁盘加密正交）。
 *
 * 为什么需要这一层 —— 用户 2026-10-27 的原话：
 *
 *   「私密日记点击就能查看还有什么私密，一定是只能本人查看啊。」
 *
 * 当时的状态是：文件确实加密了（AES-256-GCM，密钥在登录钥匙串），但只要打开 App，
 * 宿主的 `readFull()` 就会把私密那一天解密成明文递给界面，界面再用一层「点击显示」
 * 的遮罩挡住。**遮罩不是权限**：任何人坐到这台已解锁的 Mac 前，点一下就看到了。
 *
 * 这一层要解决的就是「点一下」这件事：
 *
 *   - 没设置口令时，`/day` **根本不返回私密正文**（不是返回了再藏起来）；
 *   - 设置之后，必须 `POST /gate/unlock` 带上口令，宿主才在**进程内存**里记一个
 *     「已解锁」布尔量，此后 `/day` 才给正文；
 *   - 关掉 App / 手动锁定 / 离开私密模块 / 空闲 10 分钟，都会把这个布尔量清掉。
 *
 * ★ 它的强度上限写在最前面，免得高估：这是一道**本机防误看**的闸，不是抗取证。
 *   能在这台机器上以你的身份跑代码的人，仍然能读钥匙串、能读插件内存。要更强的
 *   隔离，正确做法是给日记单独一个 macOS 账户。这一点与 `diary-secret.js` 的威胁
 *   模型一致。
 *
 * ★ 口令**不用于加密文件**（那是密钥的活，而且换口令会重新加密整个目录）。
 *   口令只用来「开闸」：存的是 `scrypt(口令, salt)`，从它反推不出口令；把 gate.json
 *   拷走也解不开任何一天，因为解开文件靠的是钥匙串里的那把密钥。
 *   这样设计的好处是：忘记口令不会丢数据（删掉 gate.json 重设即可，日记还在）。
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 口令最短长度。4 位是「防误看」这个定位的下限，再长就变成折磨。 */
export const MIN_PASSPHRASE = 4;
export const MAX_PASSPHRASE = 200;

/** 空闲多久自动上锁。用户离开座位一会儿就重新锁上，但不会边写边被打断。 */
export const IDLE_LOCK_MS = 10 * 60 * 1000;

/** scrypt 参数。存进文件里，将来调参不会让老口令失效。 */
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function scrypt(passphrase, salt, params) {
  return new Promise((resolve, reject) => {
    scryptCallback(passphrase, salt, params.keylen, { N: params.N, r: params.r, p: params.p }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * @param options.root     日记根目录（`~/.dsh/storages/dsh-npie-reader/diary`）
 * @param options.log      记一行日志
 * @param options.now      取当前时间（测试注入）
 */
export function createDiaryGate(options = {}) {
  const root = options.root ?? '';
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const file = join(root, 'gate.json');

  let unlocked = false;
  let lastSeen = 0;

  async function readStamp() {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (!parsed || parsed.v !== 1 || typeof parsed.salt !== 'string' || typeof parsed.hash !== 'string') return null;
      return parsed;
    } catch (error) {
      // ★ 文件损坏**不等于没设口令**：当成「设了口令但读不出来」报错，
      //   否则一次 JSON 解析失败就会把私密日记敞开（fail-open 是这里最不能犯的错）。
      if (error?.code === 'ENOENT') return null;
      throw coded('GATE_BROKEN', `口令文件读不出来：${error?.message ?? error}`);
    }
  }

  /** 只报状态，**永不抛错、永不刷新空闲计时**（界面会轮询它）。 */
  async function peek() {
    try {
      const stamp = await readStamp();
      return { set: stamp !== null, unlocked: unlocked && now() - lastSeen <= IDLE_LOCK_MS };
    } catch {
      return { set: true, unlocked: false };
    }
  }

  /**
   * 现在能不能把私密正文交出去。
   * ★ 这里**会**刷新空闲计时：它是「真的读了一次」的那个动作，而 `peek()` 不是。
   */
  function allow() {
    if (!unlocked) return false;
    if (now() - lastSeen > IDLE_LOCK_MS) {
      unlocked = false;
      log('[日记] 私密日记空闲超时，已自动上锁');
      return false;
    }
    lastSeen = now();
    return true;
  }

  /** 第一次设置口令。已经有了就拒绝 —— 改口令是「先解锁、再重设」，不能静默覆盖。 */
  async function setup(passphrase) {
    const text = String(passphrase ?? '');
    if (text.length < MIN_PASSPHRASE) throw coded('GATE_WEAK', `口令至少 ${MIN_PASSPHRASE} 位`);
    if (text.length > MAX_PASSPHRASE) throw coded('GATE_WEAK', `口令最长 ${MAX_PASSPHRASE} 位`);
    if (await readStamp()) throw coded('GATE_EXISTS', '已经设过口令了');
    const salt = randomBytes(16);
    const hash = await scrypt(text, salt, SCRYPT);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({
      v: 1,
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
      createdAt: new Date(now()).toISOString(),
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
    unlocked = true;
    lastSeen = now();
    log('[日记] 私密日记已设置口令');
    return { set: true, unlocked: true };
  }

  /**
   * 校验口令。错了就是错了，不回「接近」也不回「用户名不存在」这类可区分的信息 ——
   * 这里根本没有用户名字段，只有一道口令，所以只回 true / false 就够。
   */
  async function unlock(passphrase) {
    const stamp = await readStamp();
    if (!stamp) throw coded('GATE_UNSET', '还没有设置口令');
    const text = String(passphrase ?? '');
    if (text === '' || text.length > MAX_PASSPHRASE) return false;
    const expected = Buffer.from(stamp.hash, 'base64');
    const params = { N: stamp.N ?? SCRYPT.N, r: stamp.r ?? SCRYPT.r, p: stamp.p ?? SCRYPT.p, keylen: expected.length };
    const actual = await scrypt(text, Buffer.from(stamp.salt, 'base64'), params);
    // 长度不等时 `timingSafeEqual` 会抛，先比长度（长度是公开信息，不构成旁路）。
    if (actual.length !== expected.length) return false;
    if (!timingSafeEqual(actual, expected)) return false;
    unlocked = true;
    lastSeen = now();
    return true;
  }

  function lock() {
    unlocked = false;
    lastSeen = 0;
  }

  return {
    file,
    peek,
    allow,
    setup,
    unlock,
    lock,
    /** 测试与「改口令」用：删掉口令文件。**不删日记**。 */
    async reset() { lock(); },
  };
}
