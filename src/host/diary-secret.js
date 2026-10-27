/**
 * 私密日记的密钥与信封加密（AES-256-GCM）。
 *
 * 威胁模型**写在最前面**，因为「加密」这两个字最容易让人高估它：
 *
 *   防住：把日记目录拷到 U 盘 / 同步进网盘 / 发给人 —— 拿到的是一堆密文。
 *   防不住：有人用你已解锁的 Mac 打开这个 App。密钥在登录钥匙串里，
 *          插件进程随时能取到，这正是「透明可读」的代价。
 *
 * ★ 为什么不用「让用户设一个口令」：那会引入解锁界面、忘记口令就永久丢数据、
 *   以及「口令强度」三件事，而用户要的是「本地加密存储」而不是「每次打开输密码」。
 *   要更强的隔离，正确做法是给日记单独一个 macOS 账户，不是在这层堆密码学。
 *
 * ★ 密钥放哪：登录钥匙串（`security` 命令行，系统自带、零依赖、实测非交互可读写）。
 *   取不到就退回**本地密钥文件**（0600），并在 `status()` 里如实报 `mode: 'file'` ——
 *   界面必须把这件事说出来。悄悄降级等于给用户一个「以为加密了」的假象。
 *
 * ★ 绝不 `execFileSync`：钥匙串偶发会弹系统授权框，同步调用会把**整个宿主进程**
 *   吊住（本项目踩过同类：被吊住时零输出、看着像死循环）。一律 spawn + 超时强杀。
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pluginDataDir } from './store.js';

/** 钥匙串条目的 service / account。改名字等于丢掉所有已加密的日记（旧密钥找不回来）。 */
export const KEYCHAIN_SERVICE = 'dsh-npie-reader.diary';
export const KEYCHAIN_ACCOUNT = 'npie-reader';

/** 信封版本号。将来换算法时靠它分流，别靠「试着解一下」。 */
export const ENVELOPE_VERSION = 1;

const KEY_BYTES = 32;
const IV_BYTES = 12;
/** 钥匙串调用的硬超时。超过就当它不可用，退回文件。 */
const KEYCHAIN_TIMEOUT_MS = 5000;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 默认的钥匙串执行器：spawn + 超时强杀。
 * 返回 `{ code, stdout, stderr }`，**永不 reject**（失败也是一种结果，由调用方决定怎么办）。
 */
export function runSecurity(args, { timeoutMs = KEYCHAIN_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('/usr/bin/security', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      // 强杀：杀掉自己还不够，`security` 可能已经拉起了授权窗口，
      // 但至少插件这一侧不会挂死。
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
      finish({ code: -2, stdout, stderr: '钥匙串调用超时' });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ code: -1, stdout, stderr: String(error?.message ?? error) }));
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * @param options.log - 记一行日志。
 * @param options.run - 执行 `security` 的函数（测试注入用）。
 * @param options.keyPath - 退路密钥文件的路径。
 * @param options.key - 直接给一把密钥（测试用；给了就不碰钥匙串）。
 */
export function createDiarySecret(options = {}) {
  const log = options.log ?? (() => {});
  const run = options.run ?? runSecurity;
  const keyPath = options.keyPath ?? join(pluginDataDir(), 'diary', 'secret.key');
  const fixed = options.key ? Buffer.from(options.key) : null;

  let cached = null;
  let mode = fixed ? 'injected' : 'unknown';

  function decodeKey(text) {
    const raw = String(text ?? '').trim();
    if (raw === '') return null;
    let buffer;
    try {
      buffer = Buffer.from(raw, 'base64');
    } catch {
      return null;
    }
    return buffer.length === KEY_BYTES ? buffer : null;
  }

  async function fromKeychain() {
    const found = await run(['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w']);
    if (found.code === 0) {
      const key = decodeKey(found.stdout);
      if (key) { mode = 'keychain'; return key; }
      // 条目在但内容不是 32 字节：不能覆盖（那会把已加密的日记变成永久乱码），
      // 只能报出来让人处理。
      throw coded('KEY_MALFORMED', '钥匙串里的日记密钥长度不对，无法解密已有日记');
    }
    if (found.code === -2) return null; // 超时 ⇒ 当不可用，走文件
    // 不存在 ⇒ 建一把。`-U` 让重复执行幂等（并发启动时两个进程都建也不会打架）。
    const key = randomBytes(KEY_BYTES);
    const made = await run([
      'add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE,
      '-w', key.toString('base64'), '-U',
    ]);
    if (made.code !== 0) return null;
    mode = 'keychain';
    log('[日记] 已在登录钥匙串里创建日记密钥');
    return key;
  }

  async function fromFile() {
    try {
      const key = decodeKey(await readFile(keyPath, 'utf8'));
      if (key) { mode = 'file'; return key; }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const key = randomBytes(KEY_BYTES);
    await mkdir(dirname(keyPath), { recursive: true });
    await writeFile(keyPath, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
    // `mode` 只在创建时生效，已存在的文件不会被改 —— 显式再来一次。
    await chmod(keyPath, 0o600).catch(() => {});
    mode = 'file';
    log(`[日记] 钥匙串不可用，密钥落在 ${keyPath}（权限 0600）`);
    return key;
  }

  /** 取密钥（首次会创建）。钥匙串优先，失败退回文件。 */
  async function key() {
    if (fixed) return fixed;
    if (cached) return cached;
    let fromChain = null;
    try {
      fromChain = await fromKeychain();
    } catch (error) {
      if (error?.code === 'KEY_MALFORMED') throw error;
      log(`[日记] 钥匙串不可用：${error?.message ?? error}`);
    }
    cached = fromChain ?? await fromFile();
    return cached;
  }

  /**
   * 现在到底在用哪把钥匙、放在哪。**会触发取密钥**（首次会创建）。
   * `mode: 'file'` 时界面**必须**说明「防拷走、不防本机进程」。
   */
  async function status() {
    try {
      await key();
    } catch (error) {
      return { mode: 'error', keyPath, error: error?.message ?? String(error) };
    }
    return { mode, keyPath };
  }

  /**
   * 只报「现在知道的状态」，**不取密钥、不建密钥**。
   *
   * ★ 存在的理由：页脚/设置页会频繁调 `stats()`，而取密钥可能碰到钥匙串。
   *   一个「看一眼统计」的动作不该去碰系统钥匙串 —— 更不该在没人用私密日记时
   *   就凭空创建一把密钥（那会在用户的钥匙串里留下一个他不知道为什么存在的东西）。
   */
  function peek() {
    return { mode: fixed ? 'injected' : mode, keyPath };
  }

  /** 明文 → 信封（一行 JSON，方便直接 `cat` 出来看结构）。 */
  async function encrypt(text) {
    const plain = typeof text === 'string' ? text : '';
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', await key(), iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${JSON.stringify({
      v: ENVELOPE_VERSION,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    })}\n`;
  }

  /** 信封 → 明文。密文被改过 / 换过密钥 ⇒ GCM 校验失败，抛 `DECRYPT_FAILED`。 */
  async function decrypt(blob) {
    let envelope;
    try {
      envelope = JSON.parse(String(blob ?? '').trim());
    } catch {
      throw coded('DECRYPT_FAILED', '这一天的私密日记文件损坏了（不是有效的加密信封）');
    }
    if (envelope?.v !== ENVELOPE_VERSION) {
      throw coded('DECRYPT_FAILED', `不认识的加密信封版本：${String(envelope?.v)}`);
    }
    const iv = Buffer.from(String(envelope.iv ?? ''), 'base64');
    const tag = Buffer.from(String(envelope.tag ?? ''), 'base64');
    const data = Buffer.from(String(envelope.data ?? ''), 'base64');
    if (iv.length !== IV_BYTES || tag.length !== 16) {
      throw coded('DECRYPT_FAILED', '这一天的私密日记文件损坏了（iv / tag 长度不对）');
    }
    let decipher;
    try {
      decipher = createDecipheriv('aes-256-gcm', await key(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (error) {
      if (error?.code === 'DECRYPT_FAILED') throw error;
      throw coded('DECRYPT_FAILED', '解不开这一天的私密日记：密钥换过了，或者文件被改过');
    }
  }

  return { key, status, peek, encrypt, decrypt, keyPath, get mode() { return mode; } };
}
