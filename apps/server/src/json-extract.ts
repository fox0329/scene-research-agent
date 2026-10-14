/**
 * @scene/server — 从模型输出里取出 JSON（比"整段 JSON.parse"稳得多）
 *
 * 实跑（2026-10-13，思考模式关闭后）里模型的行为依然不干净：
 *  - JSON 前后带说明文字或代码围栏；
 *  - **吐两个对象**——第一个完整合法，后面又跟一份，整段 `JSON.parse` 报
 *    `Extra data: line 1 column 4412`，于是"内容早就写好了"被判成"没有产出可解析的行"，
 *    整张表作废（故障清单 #65）；
 *  - 或写到一半被连接重置截断（`terminated`）。
 *
 * 这些都是**内容已经生成过**的情况，绝不该丢。所以统一从文本里按括号配对取出
 * 第一个完整对象；取不到再退回"补齐未闭合括号"抢救截断输出。
 */

/** 从文本中取出第一个**完整**的 JSON 对象（字符串感知的括号配对；失败返回 null） */
export function extractFirstJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const candidate of [fenced?.[1] ?? "", text]) {
    const start = candidate.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1)) as unknown;
          } catch {
            break; // 这个起点不行，换下一个候选（例如围栏里的那份）
          }
        }
      }
    }
  }
  return null;
}

/**
 * 抢救被截断的 JSON（实测：模型已写到 17 KB 时连接被重置 `terminated`，整份被判作废）
 *
 * 从末尾往回退：每退到一个候选截断点，就补上未闭合的 `]` / `}` 试解析一次，
 * 成功即返回**已完整的行**（丢掉最后一个不完整的对象）。有次数上限，绝不会空转。
 */
export function repairTruncatedJson(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let body = text.slice(start);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const cut = body.lastIndexOf("}");
    if (cut < 0) return null;
    body = body.slice(0, cut + 1);
    let braces = 0;
    let brackets = 0;
    for (const ch of body) {
      if (ch === "{") braces += 1;
      else if (ch === "}") braces -= 1;
      else if (ch === "[") brackets += 1;
      else if (ch === "]") brackets -= 1;
    }
    if (braces < 0 || brackets < 0) return null;
    try {
      return JSON.parse(body + "]".repeat(Math.max(0, brackets)) + "}".repeat(Math.max(0, braces)));
    } catch {
      body = body.slice(0, body.length - 1);
    }
  }
  return null;
}

/**
 * 逐行抢救 `rows` 数组：某一行 JSON 语法坏掉（少个逗号、引号没转义）时，整段解析全废
 *
 * 实测：表2-3 / 表2-5 各有一处 `Expecting property name enclosed in double quotes`
 * （第 540 / 403 字符处），整张表被判"没有产出可解析的行"而作废——可其余十几行都是好的
 * （故障清单 #65）。这里按括号配对逐个取数组元素：能解析的留下，解析不了的跳过并计数。
 *
 * 返回 null = 连 `"rows": [` 都找不到（真的没产出，不是格式问题）。
 */
export function extractRowsBestEffort(text: string): { rows: unknown[]; skipped: number } | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const candidate of [fenced?.[1] ?? "", text]) {
    const at = candidate.search(/"rows"\s*:\s*\[/);
    if (at < 0) continue;
    const arrStart = candidate.indexOf("[", at);
    const rows: unknown[] = [];
    let skipped = 0;
    let i = arrStart + 1;
    while (i < candidate.length) {
      while (i < candidate.length && /[\s,]/.test(candidate[i]!)) i += 1;
      if (i >= candidate.length || candidate[i] === "]") break;
      if (candidate[i] !== "{") {
        skipped += 1;
        i += 1;
        continue;
      }
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let j = i; j < candidate.length; j += 1) {
        const ch = candidate[j]!;
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end < 0) {
        skipped += 1; // 尾部残缺
        break;
      }
      try {
        rows.push(JSON.parse(candidate.slice(i, end + 1)) as unknown);
      } catch {
        skipped += 1;
      }
      i = end + 1;
    }
    if (rows.length > 0) return { rows, skipped };
  }
  return null;
}
