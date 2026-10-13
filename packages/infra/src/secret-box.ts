/**
 * @scene/infra — 密钥落盘保护（AES-256-GCM，变更表 #183）
 *
 * 背景：供应商登记表里的 API Key 原先明文落盘（0600）。桌面版把用户数据放在系统应用目录，
 * 这份文件一旦被时间机器备份、网盘同步或误拷出去，密钥就是明文的。
 *
 * 分工：主密钥由**桌面壳**从系统钥匙串取（macOS Keychain / Windows DPAPI，经 Electron
 * safeStorage），解开后通过环境变量 `SCENE_SECRET_KEY` 交给服务端；服务端只负责用它对
 * `api_key` 做 AES-256-GCM 加密落盘。钥匙串里那份不在应用数据文件旁边——只拷走文件解不开。
 *
 * 四条口径：
 *  1. 没给主密钥（浏览器/开发态、CI、纯 node 起服务）→ 完全不加密，行为与从前一致；
 *  2. 给了主密钥 → 写入的 api_key 一律加密，密文带 `enc:v1:` 前缀；
 *  3. 读到明文（历史数据、从明文环境迁过来的）→ 照常认，下次写入自动变密文（平滑迁移）；
 *  4. 有密文但拿不到主密钥、或密文被改过/换了机器 → **读不到就报读不到**，返回空串并警告一次，
 *     绝不把密文当明文用（否则会拿一串 base64 去当 API Key 调模型，报错更难查）。
 *
 * 安全边界要说清：这只防"文件被拷走"，不防"同账号下的恶意进程"——后者本来就能读钥匙串。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** 密文前缀：带它的一定是密文；不带的一律按历史明文认 */
export const SECRET_PREFIX = "enc:v1:";

/** 主密钥环境变量（base64 的 32 字节） */
export const SECRET_KEY_ENV = "SCENE_SECRET_KEY";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(message);
}

/**
 * 读取主密钥。非法值（不是 base64、长度不对）一律当"没配"：
 * 宁可不加密，也不能按错误密钥写出一份谁都解不开的密文。
 */
export function masterKey(): Buffer | null {
  const raw = process.env[SECRET_KEY_ENV]?.trim();
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  return buf.length === KEY_BYTES ? buf : null;
}

export function isSecretBoxEnabled(): boolean {
  return masterKey() !== null;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(SECRET_PREFIX);
}

/** 加密；未启用或已是密文时原样返回（幂等：避免二次加密把自己锁死） */
export function encryptSecret(plain: string): string {
  const key = masterKey();
  if (!key || !plain || isEncrypted(plain)) return plain;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  const parts = [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString("base64"));
  return SECRET_PREFIX + parts.join(":");
}

/** 解密；历史明文原样返回；解不开则返回空串（调用方按"未填密钥"处理） */
export function decryptSecret(value: string): string {
  if (!value || !isEncrypted(value)) return value;
  const key = masterKey();
  if (!key) {
    warnOnce(
      "供应商登记表里的密钥是加密的，但当前进程拿不到主密钥（桌面版由系统钥匙串提供）：" +
        "本次读不到 API Key。请用桌面版打开，或在设置页重新录入。",
    );
    return "";
  }
  try {
    const [ivB64, tagB64, dataB64] = value.slice(SECRET_PREFIX.length).split(":");
    if (!ivB64 || !tagB64 || !dataB64) throw new Error("密文格式不完整");
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return plain.toString("utf-8");
  } catch {
    warnOnce(
      "供应商登记表里的密钥解不开（换了机器、钥匙串条目被删、或文件被改过）：" +
        "本次读不到 API Key。请在设置页重新录入密钥。",
    );
    return "";
  }
}
