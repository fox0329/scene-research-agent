/**
 * constraint-check — 「这是约束，还是门槛的复述」判定（表2-5，确定性层）
 *
 * 用户定调（2026-10-20）：「不用合成一张表，要区分边界，同时要确认表格内容是否真有价值，
 * 进入表格的内容要确认价值」。
 *
 * 两张表的分界线（可操作的那条）：**能不能靠改设计/加投入满足？**
 *   - 能（换型号、加隔离装置、提精度、定期校准）→ 约束（表2-5）
 *   - 不能（要资质、许可证、认证、客户放行）→ 门槛（表1-3）
 *
 * 实测用户真实数据：表2-5 共 21 行，10 行与表1-3 主题撞车，其中「排污许可与自行监测」
 * 「车间网络与信息安全等级保护」等整行只是复述准入制度，没有给出任何可执行判据——
 * 这类行让表2-5 从"设计输入清单"退化成第二份门槛表。
 *
 * 价值判据（进入本表的门槛）：**标准号／具体数值／具体等级清单，三者至少有其二**，
 * 且不得是准入门槛的复述。三者只剩一个、或写「量级待确认」的，不构成可执行约束。
 */

export interface ConstraintVerdict {
  isConstraint: boolean;
  failures: string[];
  suggestTable: string | null;
}

/** 准入门槛的复述特征：只讲"必须有资格"，没有可执行判据 */
const ADMISSION_RESTATE = /须(取得|通过|列入|持证|备案)|须持|持证排污|须经|须具备.+资质/;
/** 拿不出判据的措辞 */
const VAGUE = /量级待确认|具体.{0,4}待确认|一般要求|视情况|按.{0,6}要求执行|待属地确认/;
/** 具体数值（含量级词与单位） */
const NUMERIC_VALUE =
  /\d+(?:\.\d+)?\s*(?:%|％|万元|元|亿元|年|个月|天|小时|h|min|分钟|秒|s|ms|s级|级|类|次|℃|dB|ppm|mg|mol|TOPS|GB|TB|台|路)/;
/** 具体等级（枚举式取值，可核验） */
const GRADE = /一级A|一级B|二级|三级|四级|SIL\s*[1-4]|0\.5S|0\.2S|1\.0级|等保[一二三四]级/;
/** 具体清单：协议名、指标名等具名项，凑够两项即算「点名了要求」 */
const LIST_TOKENS =
  /OPC UA|Modbus|Profibus|Profinet|HART|IEC 61850|工业防火墙|单向隔离|批次|件号|温度|粉尘|振动|湿度|COD|氨氮|总磷|总氮|pH|流量|含水率|电能表|流量计|在线分析仪|时间开动率|性能开动率|合格品率|停机分类/g;
/** 写成准入要求的（用于给出去向建议，不参与成立性判定） */
const ADVANCE_GATE_LOOK = /须|不得|禁止|持证|资质|许可证|认证/;

/** 一行里塞了多个约束项（违反"一个约束项一行"） */
function packsMultipleItems(item: string, value: string): boolean {
  const inParentheses = item.match(/[（(]([^）)]*)[）)]/);
  if (inParentheses) {
    const items = (inParentheses[1] ?? "").split(/[、，,]/).filter((x) => x.trim().length > 1);
    if (items.length >= 4) return true;
  }
  /* 要求值里用「；」并列四个以上具体指标，同样属于一行多项 */
  const segments = value.split(/[；;]/).filter((x) => x.trim().length > 4);
  return segments.length >= 4;
}

/**
 * 判定一行是否为「可执行的约束」
 *
 * @param row - 表2-5 的一行（键名用契约列 key）
 */
export function judgeConstraint(row: Record<string, unknown>): ConstraintVerdict {
  const item = String(row["constraint_item"] ?? "").trim();
  const value = String(row["required_value"] ?? "").trim();
  const failures: string[] = [];

  if (!item || !value) {
    return { isConstraint: false, failures: ["缺约束项或要求值，无法判定"], suggestTable: null };
  }

  /* ① 边界：只讲资格、不给可执行判据的，是门槛不是约束 */
  const hasNumeric = NUMERIC_VALUE.test(value);
  if (ADMISSION_RESTATE.test(value) && !hasNumeric) {
    return {
      isConstraint: false,
      failures: ["整行是准入门槛的复述（只讲须持证/须通过认证），没有可执行判据"],
      suggestTable: "表1-3（门槛与合规）",
    };
  }

  /* ② 价值：必须"可执行"——给出数值、等级或具名清单之一；
        只引一个标准号却不说要满足多少，算引经据典，不算约束。 */
  const period = String(row["period"] ?? "");
  const numeric = hasNumeric || NUMERIC_VALUE.test(period);
  const graded = GRADE.test(value) || GRADE.test(item);
  const tokens = new Set((value + item).match(LIST_TOKENS) ?? []);
  const listed = tokens.size >= 2 || value.split(/[、，,]/).filter((x) => x.trim().length > 1).length >= 3;
  const concrete = numeric || graded || listed;
  if (!concrete) {
    const vague = VAGUE.test(value) ? "，而且写的是「待确认/一般要求」这类模糊措辞" : "";
    failures.push(`没有可执行判据：数值、等级、具名清单一样都没有${vague}`);
  } else if (VAGUE.test(value) && !numeric) {
    failures.push("写了「待确认/一般要求」却给不出数值：这条落不了地");
  }

  /* ③ 粒度：一行一项 */
  if (packsMultipleItems(item, value)) {
    failures.push("一行塞了多个约束项：拆成一行一项，否则下游无法逐条对照");
  }

  const isConstraint = failures.length === 0;
  return {
    isConstraint,
    failures,
    suggestTable: isConstraint
      ? null
      : ADVANCE_GATE_LOOK.test(value)
        ? "表1-3（门槛与合规）"
        : "补判据，或按性质归表1-3（强制准入）/ 表4-3（我方能力边界）",
  };
}

/** 批量判定，只回不成立的行 */
export function findWeakConstraints(
  rows: ReadonlyArray<{ id?: string; fields: Record<string, unknown> }>,
): ReadonlyArray<{ id: string; label: string; verdict: ConstraintVerdict }> {
  const out: { id: string; label: string; verdict: ConstraintVerdict }[] = [];
  for (const r of rows) {
    const verdict = judgeConstraint(r.fields);
    if (verdict.isConstraint) continue;
    out.push({
      id: r.id ?? String(r.fields["constraint_item"] ?? ""),
      label: String(r.fields["constraint_item"] ?? "") || "（无名约束）",
      verdict,
    });
  }
  return out;
}
