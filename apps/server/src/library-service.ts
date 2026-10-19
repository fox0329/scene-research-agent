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
  normalizeValue,
  planProductMerge,
  planSpecDedupe,
  gradeSourceByCategory,
} from "@scene/domain";
import type { Product, SpecParam } from "@scene/contract";
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
): ProductResolution {
  const model = String(fields["model"] ?? "");
  const products = db.productRepo.list({
    where: "product_line_id = ?",
    params: [productLineId],
    orderBy: "created_at ASC",
  });
  const hit = matchExistingProduct(products, model);
  if (hit) {
    // 已有行缺的字段用新材料补上（不覆盖用户确认过的内容）
    const patch: Record<string, string> = {};
    for (const field of ["name", "launch_date", "position_desc", "former_name"] as const) {
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
    launch_date: String(fields["launch_date"] ?? ""),
    former_name: fields["former_name"] ? String(fields["former_name"]) : undefined,
    position_desc: String(fields["position_desc"] ?? ""),
    source_type: "AI提取",
    source,
    // 按材料类目判权威性（变更表 #210）：国标→T1、厂商官方→T2、媒体→T3、自媒体→T4
    source_authority: gradeSourceByCategory("AI提取", source, fileName).authority,
    evidence_level: "B",
  } as never);
  return { productId: created.id, created: true };
}

/**
 * 写入一条规格：完全相同的不再写第二遍，近重复的留更完整的那句
 *
 * 返回 true = 落库（新增或更新），false = 库里的那条已经更完整、本次不写。
 */
export function upsertSpecParam(
  db: DbInstance,
  productId: string,
  fields: Record<string, unknown>,
  source: string,
  /** 原始文件名（类目线索，变更表 #210）；不传则只按来源串判 */
  fileName?: string,
): boolean {
  const paramClass = String(fields["param_class"] ?? "");
  const paramName = String(fields["param_name"] ?? "");
  const value = String(fields["value"] ?? "");
  const nv = normalizeValue(value);
  const existing = (
    db.specParamRepo.list({
      where: "product_id = ? AND param_class = ? AND param_name = ?",
      params: [productId, paramClass, paramName],
    }) as SpecParam[]
  ).filter((s) => s.param_class === paramClass && s.param_name === paramName);

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
      evidence_level: "B",
    } as never);

  if (existing.length === 0) {
    insert();
    return true;
  }
  // ① 已经有一模一样的一句 → 不写第二遍（历史库里 53 行完全重复就是这么来的）
  if (existing.some((e) => normalizeValue(e.value) === nv)) return false;
  // ② 库里那条更完整（包含新材料这句）→ 保留库里那条
  if (existing.some((e) => normalizeValue(e.value).includes(nv))) return false;
  // ③ 新材料更完整 → 用完整那句覆盖库里被它包含的那条，并清掉同键的冗余
  const covered = existing.filter((e) => nv.includes(normalizeValue(e.value)));
  if (covered.length > 0) {
    db.specParamRepo.update(covered[0]!.id, { value, source, source_type: "AI提取" } as never);
    for (const extra of covered.slice(1)) db.specParamRepo.deleteById(extra.id);
    return true;
  }
  // ④ 互不包含 = 两个不同的事实（如工作温度两个值）→ 并存，由来源与核实去分辨
  insert();
  return true;
}
