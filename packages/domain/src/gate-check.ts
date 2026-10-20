/**
 * gate-check — 门槛成立性判定（表1-3，确定性层）
 *
 * 用户定调（2026-10-20 原话）：「所谓的门槛一定是要真实，而且重要的，比如防爆等级、
 * 装备承制资格这种，只是普通的要求不能叫门槛」。
 *
 * 为什么必须落确定性层：LLM 天生爱把「技术难度」写成「技术门槛」——接口封闭、协议不开放、
 * 多源异构，读起来像门槛，其实是**工作量和风险**；一旦进了门槛表，就会被当成出局条件去
 * 做进入/不进入的判断，直接把结论带偏。实测两批数据 19 行里 11 行属此类。
 * 分类（五类）仍由模型给，但「**这算不算门槛**」由本模块判定，模型只按问题清单改写。
 *
 * 判定 = 三问，全过才算门槛：
 *   ① 谁在卡？——否决者必须具体；非"一票否决者"类不许是车间内部角色
 *   ② 拿不出什么就不能进场？——判据里必须有可核验凭据（标准号／证书资质／量化阈值／锁定事实）
 *   ③ 不满足是不是出局？——必须有出局后果或明确的否决触发条件，不能只是"更难/更贵/更慢"
 */

export interface GateVerdict {
  /** 三问是否全过 */
  isGate: boolean;
  /** 不成立的原因（人话，逐条对应某一问） */
  failures: string[];
  /** 不成立时建议归到哪张表（成立时为 null） */
  suggestTable: string | null;
}

/** 表1-3 的合法类型（与契约 barrier_type 枚举一致） */
const GATE_TYPES = ["技术", "行业准入", "经济", "生态锁定", "一票否决者"] as const;

/** 车间内部角色：他们能提要求、能拖进度，但不构成"进场资格" */
const INTERNAL_ROLES =
  /车间主任|生产经理|设备主管|班组长|班长|工艺员|操作工|运维班组|车间管理/;

/** 外部/监管主体：出现这些词即认为否决者是外部或监管方 */
const EXTERNAL_ACTORS =
  /监管|主管部门|生态环境|应急|公安|网安|认证机构|主机厂|整车厂|OEM|军代表|军方|客户|第三方|行业协会|发改委|住建|市场监管|消防/;

/** 可核验凭据：标准号、证书资质、量化阈值 */
const STANDARD_CODE =
  /\b(?:GB|GB\/T|HJ|JB|JB\/T|ISO|IEC|IATF|VDA|EN|API|UL|CCC|Ex|SJ|YD|DL|CJ)\s*[\d.\-]*\d/i;
const LICENSE_WORDS =
  /许可证|资质|名录|认证|注册证|备案|准入|等保|等级保护|定级|检定|合格证|资格|白名单|入围/;
const NUMERIC_THRESHOLD = /\d+(?:\.\d+)?\s*(?:万元|万|元|亿元|%|年|个月|天|小时|级|类|mol|ppm|mg)/;
/** 经济类门槛的立项口径：不是"花了多少钱"，而是"按什么口径判能不能立" */
const ECON_CRITERIA = /回收期|投资回收|预算|立项|审批|投入产出|IRR|内部收益率/;
/** 生态锁定的锁定事实 */
const LOCK_FACT = /私有协议|专有协议|专用网关|独家|绑定|不开放|仅支持|须使用|只能由|原厂/;
const LOCK_CONSISTENCY = /不可替代|无法替换|必须沿用|否则|不能替换|唯一/;
/** 出局后果 */
const OUTCOME_MARKERS =
  /不能|不得|禁止|不予|退出|出局|废标|停产|限产|处罚|取消|无法投标|无法进场|无法验收|不能供货|一票否决|拒收|整改|清退|否则/;
/** 纯难度/成本/环境约束特征（这些不是门槛） */
const DIFFICULTY_MARKERS =
  /接口.{0,6}(封闭|不开放|不统一)|协议.{0,6}(不开放|私有|不统一|碎片)|碎片化|异构|难度|工作量大|成本高|投入大/;
const ENV_CONSTRAINT = /高温|油污|油雾|粉尘|电磁干扰|潮湿|振动|布线受限|空间受限/;

function text(value: unknown): string {
  return String(value ?? "").trim();
}

/**
 * 判定一行是否为真门槛
 *
 * @param row - 表1-3 的一行（键名用契约列 key）
 */
export function judgeGate(row: Record<string, unknown>): GateVerdict {
  const type = text(row["barrier_type"]);
  const name = text(row["barrier_name"]);
  const holder = text(row["veto_holder"]);
  const criteria = text(row["criteria"]);
  const failures: string[] = [];

  if (!GATE_TYPES.includes(type as (typeof GATE_TYPES)[number])) {
    return { isGate: false, failures: [`门槛类型非法：${type || "空"}`], suggestTable: null };
  }
  if (!name || !criteria) {
    return {
      isGate: false,
      failures: ["缺门槛名或判据，无法判定是否成立"],
      suggestTable: null,
    };
  }

  /* ① 谁在卡 */
  if (!holder) {
    failures.push("没写否决者：说不清「谁在卡」，就不是进场门槛");
  } else if (INTERNAL_ROLES.test(holder) && !EXTERNAL_ACTORS.test(holder)) {
    /* 内部角色只有在"写明硬约束"时才够格（如"不得影响出水达标"）：那是真否决权；
       写成"接受度/需达成一致"的，是态度，不是门槛。 */
    const internalHardRule = OUTCOME_MARKERS.test(criteria);
    if (type !== "一票否决者" || !internalHardRule) {
      failures.push(
        `否决者是车间内部角色（${holder.slice(0, 16)}）：内部要求能拖进度，但不构成进场资格`,
      );
    }
  }

  /* ② 拿不出什么就不能进场 */
  const hasAnchor = STANDARD_CODE.test(criteria) || LICENSE_WORDS.test(criteria);
  const hasNumber = NUMERIC_THRESHOLD.test(criteria);
  if (type === "技术" && !hasAnchor) {
    failures.push("技术类门槛必须落到强制标准或认证要求（标准号／证书），没凭据的是技术难度");
  }
  if (type === "行业准入" && !hasAnchor) {
    failures.push("行业准入门槛必须给出许可证／资质／认证／名录类凭据");
  }
  if (type === "经济" && !(hasNumber && ECON_CRITERIA.test(criteria))) {
    failures.push("经济类门槛要给可核验阈值与立项口径（预算科目／回收期上限／收益率），光说「投入几十万」不是门槛");
  }
  if (type === "生态锁定" && !(LOCK_FACT.test(criteria) && LOCK_CONSISTENCY.test(criteria))) {
    failures.push("生态锁定要写清锁定事实与不可替代性（私有协议／独家／必须沿用／否则），否则只是锁定风险");
  }

  /* ③ 不满足是不是出局 */
  const hasOutcome = OUTCOME_MARKERS.test(criteria) || OUTCOME_MARKERS.test(name);
  if (type === "一票否决者") {
    /* 外部主体（主机厂/监管）提出的硬性要求，本身就是准入条件——不以文本里写出"否则"为前提；
       只有内部角色才必须写清"什么情况下会被否掉"，否则那是态度不是否决权。 */
    const externalDemand = EXTERNAL_ACTORS.test(holder) && /须|必须|要求|准入|不予/.test(criteria);
    if (!hasOutcome && !externalDemand) {
      failures.push("一票否决者要写明否决触发条件（什么情况下会被否掉），没写清的是「态度」不是否决权");
    }
  } else if (!hasOutcome && DIFFICULTY_MARKERS.test(criteria + name)) {
    failures.push("只写了「更难做」，没写出局后果：难度与门槛是两件事");
  }

  const isGate = failures.length === 0;
  return { isGate, failures, suggestTable: isGate ? null : suggestTableFor(type, criteria + name) };
}

/** 不成立时该归哪张表（按性质就近归位，别丢信息） */
function suggestTableFor(type: string, content: string): string {
  if (type === "经济") return "表6-1（价值与指标）";
  if (type === "生态锁定") return "表3-5（上游供给格局）";
  if (ENV_CONSTRAINT.test(content)) return "表2-5（物理与合规约束）";
  if (type === "技术") return "表1-2（场景环节现状）/ 表2-5";
  if (type === "一票否决者") return "表4-2（参与角色地图）";
  return "表2-5（物理与合规约束）";
}

/** 批量判定（生成后自检用），只回不成立的行 */
export function findFakeGates(
  rows: ReadonlyArray<{ id?: string; fields: Record<string, unknown> }>,
): ReadonlyArray<{ id: string; label: string; verdict: GateVerdict }> {
  const out: { id: string; label: string; verdict: GateVerdict }[] = [];
  for (const r of rows) {
    const verdict = judgeGate(r.fields);
    if (verdict.isGate) continue;
    out.push({
      id: r.id ?? text(r.fields["barrier_name"]),
      label: text(r.fields["barrier_name"]) || "（无名门槛）",
      verdict,
    });
  }
  return out;
}
