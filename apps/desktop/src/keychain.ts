/**
 * 钥匙串探测开关（桌面壳）
 *
 * macOS 的 `safeStorage.isEncryptionAvailable()` 会访问系统钥匙串；应用是免签名分发，
 * 覆盖安装/重新签名后 macOS 常把它当成另一个应用，于是弹「想要使用钥匙串中的机密信息」。
 *
 * 主密钥保护默认关闭（见 main.ts 的 resolveMasterKey），这种状态下连探测都不该做：
 * 设置页只是读版本，却会顺手探测钥匙串，导致没开保护也弹窗（用户实测 0.7.8）。
 * 只有显式 `SCENE_KEYCHAIN_PROTECTION=1` 时才访问 Keychain，让默认路径保持零打扰。
 */

/** 当前进程是否显式要求用系统钥匙串保护主密钥 */
export function keychainProtectionRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SCENE_KEYCHAIN_PROTECTION === "1";
}

export interface SafeStorageLike {
  isEncryptionAvailable?: () => boolean;
}

/**
 * 是否可用系统钥匙串加密；未显式开启时**不调用**底层探测。
 * 探测失败或抛错一律按不可用处理，不让排障信息影响启动。
 */
export function keychainStatus(
  storage: SafeStorageLike | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!keychainProtectionRequested(env)) return false;
  try {
    return storage?.isEncryptionAvailable?.() === true;
  } catch {
    return false;
  }
}
