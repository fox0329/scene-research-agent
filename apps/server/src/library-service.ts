/**
 * library-service — 产品资料库的确定性整理（去重、费率骨架）
 *
 * 为什么单独成模块：这三件事都要**判定**（保留哪条、删哪条、骨架长什么样），
 * 判定按项目规则必须落确定性层（AGENTS §三.5），且要能单测。判定在领域层
 * （`@scene/domain` 的 library-dedupe），这里只负责按计划落库。
 *
 * 三件事：
 *   ① `dedupeLibrary`   —— 同型号产品行合并 + 同产品重复规格删除（历史数据清理与按钮共用）
 *   ② `resolveProductForModel` —— ingest 写入前匹配已有型号，从源头不再造重复行
 */

import {
  matchExistingProduct,
  planProductMerge,
  planSpecDedupe,
  gradeSourceByCategory,
} from "@scene/domain";
import type { EvidenceLevel, Product, SpecParam } from "@scene/contract";
import type { DbInstance } from "@scene/infra";

/** 去重报告（接口返回给 UI，也在日志里说清动了什么） */
export interface DedupeReport {
  /** 合并掉的同型号组数 */
  productGroups: number;
  /** 删掉的产品行数 */
  productsRemoved: number;
  /** 归属改到保留行的规格行数 */
  specsMoved: number;
  /** 删掉的重复/被取代规格行数 */
  specsRemoved: number;
  /** 其中"完全相同"的组数 */
  specExactGroups: number;
  /** 其中"一个值包含另一个"的组数 */
  specNearGroups: number;
  /** 逐组说明（型号 + 删了几行） */
  groups: { model: string; removed: number }[];
}

/**
 * 资料库去重：产品行 + 规格行（幂等，跑几次结果一样）
 *
 * 规格去重放在**合并之后**：重复产品行的规格此刻已归到保留行，正好一起判重。
 */
export function dedupeLibrary(db: DbInstance, productLineId: string): DedupeReport {
  const products = db.productRepo.list({
    where: "product_line_id = ?",
    params: [productLineId],
    orderBy: "created_at ASC",
  });
  const report: DedupeReport = {
    productGroups: 0,
    productsRemoved: 0,
    specsMoved: 0,
    specsRemoved: 0,
    specExactGroups: 0,
    specNearGroups: 0,
    groups: [],
  };

  /* ① 同型号产品行合并 */
  for (const group of planProductMerge(products)) {
    const keep = products.find((p) => p.id === group.keepId);
    if (!keep) continue;
    const dupes = products.filter((p) => group.removeIds.includes(p.id));
    // 缺位字段（曾用名/定位描述/发布日期）从重复行补到保留行，别把信息删掉
    const patch: Record<string, string> = {};
    for (const field of ["former_name", "position_desc", "launch_date"] as const) {
      if (!keep[field]) {
        const donor = dupes.find((d) => d[field]);
        if (donor) patch[field] = String(donor[field]);
      }
    }
    if (Object.keys(patch).length) db.productRepo.update(keep.id, patch as never);
    for (const d of dupes) {
      for (const sp of db.specParamRepo.list({ where: "product_id = ?", params: [d.id] })) {
        db.specParamRepo.update(sp.id, { product_id: keep.id } as never);
        report.specsMoved += 1;
      }
      // M6 报价挂 product_id（外键）：同型号合并时把报价迁到保留行，别让去重撞外键
      for (const q of db.quoteRepo.list({ where: "product_id = ?", params: [d.id] })) {
        db.quoteRepo.update(q.id, { product_id: keep.id, model: keep.model } as never);
      }
      db.productRepo.deleteById(d.id);
      report.productsRemoved += 1;
    }
    report.productGroups += 1;
    report.groups.push({ model: group.model, removed: dupes.length });
  }

  /* ② 规格行去重（按产品分组，逐个产品判） */
  const liveProducts = db.productRepo.list({
    where: "product_line_id = ?",
    params: [productLineId],
    orderBy: "created_at ASC",
  });
  for (const p of liveProducts) {
    const specs = db.specParamRepo.list({
      where: "product_id = ?",
      params: [p.id],
      orderBy: "created_at ASC",
    }) as SpecParam[];
    if (specs.length < 2) continue;
    const plan = planSpecDedupe(specs);
    for (const fix of plan.keep) db.specParamRepo.update(fix.id, { value: fix.value } as never);
    for (const id of plan.dropIds) {
      db.specParamRepo.deleteById(id);
      report.specsRemoved += 1;
    }
    report.specExactGroups += plan.exactGroups;
    report.specNearGroups += plan.nearGroups;
  }
  return report;
}

/** ingest 写入前的型号匹配结果 */
export interface ProductResolution {
  /** 用哪个产品行承接这次材料里的规格数据 */
  productId: string;
  /** 是否新建了产品行 */
  created: boolean;
}

/**
 * 材料里的 M1 行落到哪个产品：能匹配上已有型号就并进去，匹配不上才新建
 *
 * 这一条是"重复行"的**根因修复**：旧实现一律新建，于是每上传一批提到该型号的材料，
 * 资料库里就多一条「待确认」重复行（实测 7 组）。匹配用与清理同一把尺子
 * （`matchExistingProduct` → normalizeModel）。
 */
export function resolveProductForModel(
  db: DbInstance,
  productLineId: string,
  fields: Record<string, unknown>,
  source: string,
  /** 原始文件名（类目线索，变更表 #210） */
  fileName?: string,
  /** 证据等级（由来源权威级与夸大措辞确定性判定，缺省 B） */
  evidenceLevel: EvidenceLevel = "B",
): ProductResolution {
  const model = String(fields["model"] ?? "");
  const products = db.productRepo.list({
    where: "product_line_id = ?",
    params: [productLineId],
    orderBy: "created_at ASC",
  });
  const hit = matchExistingProduct(products, model);
  if (hit) {
    // 已有行缺的字段用新材料补上（不覆盖用户确认过的内容）；M1 新口径只保留四列
    const patch: Record<string, string> = {};
    for (const field of ["name"] as const) {
      if (!hit[field] && fields[field]) patch[field] = String(fields[field]);
    }
    if (Object.keys(patch).length) db.productRepo.update(hit.id, patch as never);
    return { productId: hit.id, created: false };
  }
  const created = db.productRepo.insert({
    product_line_id: productLineId,
    model,
    name: String(fields["name"] ?? ""),
    status: (fields["status"] as Product["status"]) ?? "待确认",
    // DB 列保留不迁移；新口径不再从材料解析上市日期/定位/曾用名
    launch_date: "",
    position_desc: "",
    source_type: "AI提取",
    source,
    // 按材料类目判权威性（变更表 #210）：国标→T1、厂商官方→T2、媒体→T3、自媒体→T4
    source_authority: gradeSourceByCategory("AI提取", source, fileName).authority,
    evidence_level: evidenceLevel,
  } as never);
  return { productId: created.id, created: true };
}

/**
 * 写入一条规格：同 key 已存在就不写第二遍，也**不覆盖**
 *
 * 为什么不再"取更完整的那句"：覆盖就是静默改事实，用户看到的值会随材料到达顺序变化，
 * 且没有任何留痕（2026-10-21 定调）。现在同 product/class/name 只要已有值，
 * 无论新旧是否相同都不写；不同值的冲突由 ingest 的 `conflicts` 报出来，
 * 交给人决定保留哪条。
 *
 * 返回 true = 新落库，false = 同 key 已有值（未写、未覆盖）。
 */
export function upsertSpecParam(
  db: DbInstance,
  productId: string,
  fields: Record<string, unknown>,
  source: string,
  /** 原始文件名（类目线索，变更表 #210）；不传则只按来源串判 */
  fileName?: string,
  /** 证据等级（ingest 按来源权威级与夸大措辞确定性判定；缺省 B） */
  evidenceLevel: EvidenceLevel = "B",
): boolean {
  const paramClass = String(fields["param_class"] ?? "");
  const paramName = String(fields["param_name"] ?? "");
  const value = String(fields["value"] ?? "");
  const existing = (
    db.specParamRepo.list({
      where: "product_id = ? AND param_class = ? AND param_name = ?",
      params: [productId, paramClass, paramName],
    }) as SpecParam[]
  ).filter(
    (s) =>
      s.product_id === productId &&
      s.param_class === paramClass &&
      s.param_name === paramName,
  );

  const insert = () =>
    void db.specParamRepo.insert({
      product_id: productId,
      param_class: paramClass,
      param_name: paramName,
      value,
      measured: (fields["measured"] as SpecParam["measured"]) ?? "未提及",
      source_type: "AI提取",
      source,
      source_authority: gradeSourceByCategory("AI提取", source, fileName).authority,
      evidence_level: evidenceLevel,
    } as never);

  if (existing.length === 0) {
    insert();
    return true;
  }
  // 同值 / 不同值都不写：重复不新增，冲突不覆盖（冲突由调用方 ingest 单独记录）
  return false;
}
