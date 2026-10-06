/**
 * 投资回报：回收期 = 投入 ÷ 年收益（契约 `COMPUTED_CARDS.roi`，输入 表5-5 + 表6-1）
 *
 * 为什么落在确定性层：这是给客户看钱的数字。让模型写「约 1.5 年」，既无法复核，
 * 也必然与表5-5 的投入对不上（契约里 `reason` 已写明"派生值若让模型填，必然不一致"）。
 *
 * 缺年收益时**不给数字**：报「算不出 + 缺哪几条」，绝不拿 0 或估值顶上（G-R0/R2）。
 * 纯函数、无 IO：投入与收益都由调用方读好传进来（服务端一次查表即可）。
 */

export type RoiRow = Record<string, unknown>;

export interface RoiInput {
  /** 总投入（元）：表5-5 的投入合计（含首年运营），由 `investmentFromCostRows` 求出 */
  investment: number;
  /** 表6-1 的收益行（年收益读 `annual_value`） */
  valueRows: readonly RoiRow[];
}

export interface RoiSummary {
  /** 总投入（元） */
  investment: number;
  /** 年收益（元/年）＝各条收益行年收益之和 */
  annualValue: number;
  /** 投资回报率（倍）＝年收益 ÷ 投入 */
  roiMultiple: number;
  /** 回收期（年）＝投入 ÷ 年收益 */
  paybackYears: number;
  /** 有年收益的行数 */
  valuedRows: number;
  /** 收益行总数 */
  totalRows: number;
  /** 没填（或填了 0/非数字）年收益的收益行——报出来，不当 0 算 */
  missingAnnualValue: string[];
  /** 算不出的原因；null = 算得出 */
  blocked: string | null;
}

/** 汇总块里表「总投入」的行（不是子块合计，避免重复相加） */
const GRAND_TOTAL_RE = /总投入|总成本|总投资/u;

function amountOf(row: RoiRow): number | undefined {
  const raw = row["amount"];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 从表5-5 的行里取「总投入」
 *
 * 优先取汇总块写着「总投入/总成本/总投资」的那行（它已经把首年运营算进去了）；
 * 没有这行才把各子块合计相加。两个都有时**只认总投入**——否则投入直接翻倍。
 */
export function investmentFromCostRows(rows: readonly RoiRow[]): number {
  const withAmount = rows
    .map((row) => ({ row, amount: amountOf(row) }))
    .filter((x): x is { row: RoiRow; amount: number } => x.amount !== undefined);
  const grand = withAmount.filter((x) => GRAND_TOTAL_RE.test(String(x.row["item"] ?? "")));
  if (grand.length > 0) return grand.reduce((sum, x) => sum + x.amount, 0);
  return withAmount.reduce((sum, x) => sum + x.amount, 0);
}

function annualValueOf(row: RoiRow): number | undefined {
  const raw = row["annual_value"];
  if (raw === undefined || raw === null || String(raw).trim() === "") return undefined;
  const n = Number(String(raw).replace(/[,\s元]/gu, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 收益行的名字（报缺项时给用户看得懂的标签，不报行 id） */
function labelOf(row: RoiRow): string {
  for (const key of ["benefit", "metric", "item"]) {
    const text = String(row[key] ?? "").trim();
    if (text !== "") return text;
  }
  return "(未命名收益)";
}

/**
 * 算投资回报
 *
 * 口径：投入 = 表5-5 总投入；年收益 = Σ 表6-1 各条年收益(元)；
 * 回收期 = 投入 ÷ 年收益；投资回报率 = 年收益 ÷ 投入。
 * 任一输入缺失或 ≤0 → `blocked` 说明原因，数字给 0 且调用方**不得展示为结论**。
 */
export function computeRoi(input: RoiInput): RoiSummary {
  const investment = Number.isFinite(input.investment) ? input.investment : 0;

  const missingAnnualValue: string[] = [];
  let annualValue = 0;
  let valuedRows = 0;
  for (const row of input.valueRows) {
    const value = annualValueOf(row);
    if (value === undefined) missingAnnualValue.push(labelOf(row));
    else {
      annualValue += value;
      valuedRows += 1;
    }
  }

  // 两样都缺时一起说清（用户看一次就知道要补什么，不用来回试）
  const gaps: string[] = [];
  if (investment <= 0) gaps.push("表5-5 还没有可用的投入合计（成本估算没生成或汇总行为空）");
  if (annualValue <= 0) gaps.push("表6-1 没有一条填了年收益(元)");
  const blocked = gaps.length > 0 ? gaps.join("；") : null;

  return {
    investment,
    annualValue,
    roiMultiple: blocked === null ? annualValue / investment : 0,
    paybackYears: blocked === null ? investment / annualValue : 0,
    valuedRows,
    totalRows: input.valueRows.length,
    missingAnnualValue,
    blocked,
  };
}
