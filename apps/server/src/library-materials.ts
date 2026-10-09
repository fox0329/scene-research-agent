/**
 * 资料来源文件聚合与匹配（变更表 #156）
 *
 * 用户原话：「产品资料库现在是怎么管理的，**只能选择，不能删除**」——补的是删除入口。
 * 删除的粒度有两种：① 整条产品线（资料库）；② 某个**导入过的资料文件**（一次 ingest
 * 落进来的那批行）。第 ② 种必须先从行反推出"它来自哪个文件"，判定全在这里。
 *
 * 口径与 ingest 完全同源（`apps/server/src/ingest.ts` 的 `isValidSource`）：来源标注是
 * G-R0 的 `文件名:页码`，文件名 = **最后一个冒号之前**的部分（文件名里可能有冒号，
 * 页码部分不会）。取不到文件名（空值 / 没有冒号 / 冒号开头）的行不是"导入过的资料"，
 * 它们是用户手工补录的行，单独归一组、**不可按文件删除**。
 *
 * 为什么按**全等**而不是前缀匹配：`a.pdf` 用前缀会连 `a.pdf.bak:1` 一起删掉——
 * 用户的文件命名恰好长这样时，一次点击删掉的是两份材料。这里只认文件名全等。
 *
 * 纯函数：不碰数据库，服务端路由只负责取行、落删除。
 */

/** 取不到来源文件的行归到这一组（手工补录行），它不可按文件删除 */
export const NO_SOURCE_FILE_LABEL = "（无来源标注）";

/** 一行资料的最小信息：它来自哪张表、来源标注是什么 */
export interface MaterialRowRef {
  /** 表号（M1/M2/…/O6） */
  code: string;
  /** 来源标注（G-R0：`文件名:页码`） */
  source: unknown;
  /** 行 id（删除路由用；聚合本身不需要） */
  id?: string;
}

/** 一个来源文件的聚合结果 */
export interface MaterialFileGroup {
  /** 文件名（取不到来源时是 `NO_SOURCE_FILE_LABEL`） */
  file: string;
  /** 该文件在该产品线下落的总行数 */
  rows: number;
  /** 表号 → 行数（如 `{ M1: 3, M2: 11 }`） */
  tables: Record<string, number>;
  /** 能否按文件删除（无来源标注的组不能） */
  deletable: boolean;
}

/**
 * 来源标注 → 文件名；取不到返回空串。
 *
 * 与 `isValidSource` 同一口径：`lastIndexOf(":")` 且必须在 0 之后，冒号前非空。
 */
export function sourceFileName(source: unknown): string {
  const s = String(source ?? "").trim();
  if (!s) return "";
  const colon = s.lastIndexOf(":");
  if (colon <= 0) return "";
  return s.slice(0, colon).trim();
}

/**
 * 这一行的来源是不是 `file` —— **文件名全等**比较（不用前缀，见模块头注释）
 *
 * 无来源标注的行对任何文件名都不成立（它们只能逐行删除）。
 */
export function rowBelongsToFile(source: unknown, file: string): boolean {
  const name = sourceFileName(source);
  return name !== "" && name === file.trim();
}

/**
 * 早期上传落进库的是**临时文件名**（`ingest-<时间戳>-<序号>.<ext>`）
 *
 * 变更表 #156 之前，上传路由只把临时落盘路径交给 ingest，`basename()` 于是成了模型看到的
 * "文件名"，行上的 source 全变成 `ingest-1790179606669-44.docx:10`——谁都认不出是哪份材料。
 * 现在改成传真实文件名（新上传不再产生这种来源），**老数据没有别处可查原名**，只能原样展示，
 * 界面据此给一句说明（不是错误，是历史数据的客观样子）。
 */
export function isLegacyTempSource(file: string): boolean {
  return /^ingest-\d+-\d+\.[A-Za-z0-9]+$/.test(file.trim());
}

/**
 * 行清单 → 按来源文件聚合（行数降序；行数相同时按文件名升序，保证顺序稳定）
 *
 * 空线（没有行）返回 `[]`；无来源标注的行归到 `NO_SOURCE_FILE_LABEL` 且 `deletable: false`，
 * 这样"清单里的行数之和 = 本库总行数"这条对账关系永远成立，用户不会觉得"有行不见了"。
 */
export function aggregateMaterials(refs: MaterialRowRef[]): MaterialFileGroup[] {
  const groups = new Map<string, { rows: number; tables: Record<string, number> }>();
  for (const ref of refs) {
    const file = sourceFileName(ref.source) || NO_SOURCE_FILE_LABEL;
    const group = groups.get(file) ?? { rows: 0, tables: {} };
    group.rows += 1;
    group.tables[ref.code] = (group.tables[ref.code] ?? 0) + 1;
    groups.set(file, group);
  }
  return [...groups.entries()]
    .map(([file, g]) => ({
      file,
      rows: g.rows,
      tables: g.tables,
      deletable: file !== NO_SOURCE_FILE_LABEL,
    }))
    .sort((a, b) => b.rows - a.rows || a.file.localeCompare(b.file, "zh"));
}
