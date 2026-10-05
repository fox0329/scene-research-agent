/**
 * library-dedupe — 产品资料库去重（M1 产品行 / M2 规格行）
 *
 * 为什么需要（用户验收 2026-10-04：「重复的内容能不能合并？」）：
 *   ingest 写资料库时，材料里出现的型号一律**新建产品行**，不匹配已有型号——
 *   于是每上传一批提到该型号的材料，资料库里就多一条「待确认」重复行
 *   （实测：拓维产品 25 行里有 7 组同型号重复，如 CT15「在售(111 规格)」+「待确认(2 规格)」）；
 *   M2 规格行同理：同产品内完全相同的一行会被反复写入（实测 843 行有 53 行完全重复、
 *   另有 8 组「一个值包含另一个」的近重复）。
 *
 * 这里的函数**只做判定、不碰 IO**（AGENTS §三.6）：输入行数组，输出「保留谁、删谁、
 * 值取哪个」的计划；落库由应用层按计划执行。同一套计划既服务 ingest 的写入前匹配，
 * 也服务历史数据的清理与「合并重复产品」按钮——三处口径不会漂移。
 */

/**
 * 型号归一键：**去掉所有空白**（含全角空格）后统一大写
 *
 * 为什么是"去掉"而不是"折叠"：实测库里同一个型号被写成了「在鸿7885平板」与
 * 「在鸿 7885平板」两行——中文型号里的空格是排版噪声，不是型号的一部分；
 * 「AI Box」与「AIBOX」同理。去空白后这两类写法才会落到同一把尺子上。
 */
export function normalizeModel(model: string | null | undefined): string {
  return String(model ?? "")
    .replace(/[\u3000\s]+/g, "")
    .toUpperCase();
}

/** 值归一键：去首尾空白、折叠空白（用于判"同一句事实"） */
export function normalizeValue(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u3000\s]+/g, " ")
    .trim();
}

/** 产品行参与判定所需的最小信息 */
export interface ProductLike {
  id: string;
  model: string;
  status?: string;
  created_at?: string;
}

/** 一组重复产品：保留一条，其余删除（其规格按 planSpecDedupe 归并到保留行） */
export interface ProductMergeGroup {
  /** 归一后的型号（用于报告） */
  key: string;
  /** 保留行的 id */
  keepId: string;
  /** 待删除行 id（按稳定顺序） */
  removeIds: string[];
  /** 合并后这个型号的代表名（取保留行的原样 model） */
  model: string;
}

/**
 * 按归一型号分组的合并计划
 *
 * 保留规则（确定性，不靠模型判断）：
 *   ① 「在售」优先于「待确认」——用户确认过的行压过 AI 提取行；
 *   ② 同状态取创建更早的一条（先入为主，避免每次跑都换代表行）；
 *   ③ 仍并列时按 id 字典序（保证同一份数据每次得到同一结果）。
 */
export function planProductMerge(products: ProductLike[]): ProductMergeGroup[] {
  const groups = new Map<string, ProductLike[]>();
  for (const p of products) {
    const key = normalizeModel(p.model);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  const rank = (p: ProductLike): number => (p.status === "在售" ? 0 : 1);
  const out: ProductMergeGroup[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      const ca = a.created_at ?? "";
      const cb = b.created_at ?? "";
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    const keep = sorted[0]!;
    out.push({
      key,
      keepId: keep.id,
      removeIds: sorted.slice(1).map((p) => p.id),
      model: keep.model,
    });
  }
  return out;
}

/** 规格行参与判定所需的最小信息 */
export interface SpecLike {
  id: string;
  product_id: string;
  param_class: string;
  param_name: string;
  value: unknown;
  created_at?: string;
}

/** 规格去重计划 */
export interface SpecDedupePlan {
  /** 直接删除的行 id（完全相同，或同键被更完整的值取代） */
  dropIds: string[];
  /** 用更完整的值覆盖的行（同键近重复，保留更长的那句事实） */
  keep: { id: string; value: string }[];
  /** 完全相同的组数（报告用） */
  exactGroups: number;
  /** 近重复（一个值包含另一个）的组数（报告用） */
  nearGroups: number;
}

/**
 * 同产品内规格去重计划（作用于单个 product_id 的规格集合）
 *
 * 两条规则：
 *   ① **完全相同**（类别+名称+值都相同）→ 留最早一条，其余删；
 *   ② **同键近重复**（类别+名称相同，一个值包含另一个，如「DC24V/1A，支持9-36V宽电压输入」
 *      与「…，支持电源防反接」）→ 留**更完整**的那条值，删短的。
 *      注意：值互相冲突（如工作温度 -10~50℃ 与 -20~60℃）**不算重复**，两条都留，
 *      由来源与核实去分辨——合并的前提是"同一句话被写了两遍"，不是"同名字段有两个值"。
 */
export function planSpecDedupe(specs: SpecLike[]): SpecDedupePlan {
  const byKey = new Map<string, SpecLike[]>();
  for (const s of specs) {
    const key = `${s.product_id}|${s.param_class}|${s.param_name}`;
    const list = byKey.get(key);
    if (list) list.push(s);
    else byKey.set(key, [s]);
  }
  const dropIds: string[] = [];
  const keep: { id: string; value: string }[] = [];
  let exactGroups = 0;
  let nearGroups = 0;
  for (const [, list] of byKey) {
    if (list.length < 2) continue;
    const seen = new Map<string, SpecLike>();
    for (const s of list) {
      const v = normalizeValue(s.value);
      const hit = seen.get(v);
      if (hit) {
        dropIds.push(s.id);
        exactGroups += 1;
        continue;
      }
      seen.set(v, s);
    }
    const unique = [...seen.values()];
    if (unique.length < 2) continue;
    // 长的先处理：包含关系一旦成立，短的那条就没有独立信息
    const sorted = [...unique].sort((a, b) => normalizeValue(b.value).length - normalizeValue(a.value).length);
    const superseded = new Set<string>();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const long = sorted[i]!;
        const short = sorted[j]!;
        if (superseded.has(short.id)) continue;
        const lv = normalizeValue(long.value);
        const sv = normalizeValue(short.value);
        if (lv.includes(sv)) {
          superseded.add(short.id);
          dropIds.push(short.id);
          nearGroups += 1;
          // 保留行可能是先写入的短值（库里 843 行里就有这种），统一校正成完整那句
          keep.push({ id: long.id, value: lv });
        }
      }
    }
  }
  return { dropIds, keep, exactGroups, nearGroups };
}

/**
 * 写入前匹配：材料里这条 M1 行该并入哪条已有产品？
 *
 * 返回 undefined = 资料库里没有这个型号，应当新建。
 * 与 planProductMerge 同一把尺子（normalizeModel），避免"清理时算重复、写入时算新行"。
 */
export function matchExistingProduct<T extends ProductLike>(
  products: T[],
  model: string,
): T | undefined {
  const key = normalizeModel(model);
  if (!key) return undefined;
  const hits = products.filter((p) => normalizeModel(p.model) === key);
  if (hits.length === 0) return undefined;
  return planProductMergeKeep(hits);
}

/** 在"同型号多行"里挑代表行（与 planProductMerge 的保留规则一致） */
function planProductMergeKeep<T extends ProductLike>(list: T[]): T {
  const rank = (p: T): number => (p.status === "在售" ? 0 : 1);
  return [...list].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const ca = a.created_at ?? "";
    const cb = b.created_at ?? "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  })[0]!;
}
