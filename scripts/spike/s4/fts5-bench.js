/**
 * S4 Spike: SQLite FTS5 全文检索性能验证
 *
 * 目标：验证万级行查询是否 ≤50ms
 * 方案：内存数据库 + FTS5 虚表，模拟来源引用检索场景
 */

const Database = require('better-sqlite3');

const TOTAL_ROWS = 10_000;
const WARMUP_QUERIES = 5;

// --- 数据生成模板 ---

const FILE_TEMPLATES = [
  '产品白皮书.pdf',
  '技术架构设计.docx',
  '竞品分析报告.xlsx',
  '客户需求说明书.pdf',
  '系统接口规范.md',
  '安全评估报告.pdf',
  '成本测算模型.xlsx',
  '项目实施方案.docx',
  '运维手册.pdf',
  '测试用例集.xlsx',
];

const TABLE_CODES = [
  'T01-场景画像',
  'T02-门槛筛查',
  'T03-技术可行性',
  'T04-成本估算',
  'T05-风险评估',
  'T06-竞争态势',
  'T07-客户画像',
  'T08-交付路径',
  'T09-价值论证',
  'T10-里程碑计划',
];

const CONTENT_TEMPLATES = [
  '该项目在 {topic} 方面具备 {level} 成熟度，预计投入 {months} 个月完成交付。关键风险点在于 {risk}。',
  '根据 {source} 的数据，{topic} 领域的市场增长率为 {rate}%，建议优先布局 {area} 方向。',
  '技术方案采用 {arch} 架构，核心组件包括 {component1} 和 {component2}，性能指标需满足 {metric}。',
  '客户 {customer} 在 {industry} 行业的痛点主要集中在 {painpoint}，解决方案需覆盖 {scope} 范围。',
  '竞品 {competitor} 已在 {region} 地区推出类似方案，定价区间为 {price}，我方差异化优势在于 {advantage}。',
  '安全合规要求包括 {standard1}、{standard2}，需在 {phase} 阶段完成相关认证。',
  '运维成本模型基于 {model} 测算，年度 TCO 约 {cost} 万元，其中人力占比 {ratio}%。',
  '交付团队配置：项目经理 {pm} 人、开发 {dev} 人、测试 {qa} 人，预计 {duration} 周。',
];

const TOPICS = ['AI推理', '数据治理', '边缘计算', '智能客服', '工业视觉', '知识图谱', 'RPA自动化', '数字孪生'];
const LEVELS = ['高', '中', '低', '较高', '初步'];
const RISKS = ['技术栈适配', '数据质量', '团队经验不足', '合规审批周期', '第三方依赖'];
const REGIONS = ['华东', '华南', '华北', '西南', '东南亚', '中东'];
const STANDARDS = ['等保三级', 'ISO27001', 'SOC2', 'GDPR', '数据安全法'];
const ARCHS = ['微服务', 'Serverless', '事件驱动', 'CQRS', '分层架构'];
const INDUSTRIES = ['金融', '制造', '零售', '医疗', '教育', '能源'];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 生成一行模拟数据 */
function generateRow(id) {
  const file = pick(FILE_TEMPLATES);
  const page = randInt(1, 200);
  const source = `${file} p${page}`;
  const tableCode = pick(TABLE_CODES);

  const tpl = pick(CONTENT_TEMPLATES);
  const content = tpl
    .replace('{topic}', pick(TOPICS))
    .replace('{level}', pick(LEVELS))
    .replace('{months}', String(randInt(2, 18)))
    .replace('{risk}', pick(RISKS))
    .replace('{source}', pick(FILE_TEMPLATES))
    .replace('{rate}', String(randInt(5, 45)))
    .replace('{area}', pick(TOPICS))
    .replace('{arch}', pick(ARCHS))
    .replace('{component1}', '消息队列')
    .replace('{component2}', '缓存集群')
    .replace('{metric}', `P99 < ${randInt(50, 500)}ms`)
    .replace('{customer}', `客户${String.fromCharCode(65 + (id % 26))}${id}`)
    .replace('{industry}', pick(INDUSTRIES))
    .replace('{painpoint}', '数据孤岛与流程断点')
    .replace('{scope}', '端到端')
    .replace('{competitor}', `竞品${id % 10}`)
    .replace('{region}', pick(REGIONS))
    .replace('{price}', `${randInt(50, 500)}万`)
    .replace('{advantage}', '本地化交付能力')
    .replace('{standard1}', pick(STANDARDS))
    .replace('{standard2}', pick(STANDARDS))
    .replace('{phase}', 'PoC')
    .replace('{model}', '工时+云资源')
    .replace('{cost}', String(randInt(50, 800)))
    .replace('{ratio}', String(randInt(30, 70)))
    .replace('{pm}', String(randInt(1, 3)))
    .replace('{dev}', String(randInt(3, 12)))
    .replace('{qa}', String(randInt(1, 5)))
    .replace('{duration}', String(randInt(4, 24)));

  return { id, source, content, tableCode };
}

// --- 主测试流程 ---

function main() {
  console.log(`=== S4 Spike: SQLite FTS5 全文检索性能验证 ===`);
  console.log(`数据量: ${TOTAL_ROWS} 行\n`);

  // 1. 创建内存数据库
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // 2. 创建 FTS5 虚表
  console.log('[1/4] 创建 FTS5 虚表...');
  db.exec(`
    CREATE VIRTUAL TABLE evidence_fts USING fts5(
      source,
      content,
      table_code,
      tokenize='unicode61'
    );
  `);

  // 3. 批量插入数据
  console.log(`[2/4] 插入 ${TOTAL_ROWS} 条模拟数据...`);
  const insertStmt = db.prepare(
    `INSERT INTO evidence_fts (source, content, table_code) VALUES (?, ?, ?)`
  );

  const t0 = performance.now();
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insertStmt.run(row.source, row.content, row.tableCode);
    }
  });

  const rows = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    rows.push(generateRow(i));
  }
  insertMany(rows);
  const insertTime = (performance.now() - t0).toFixed(1);
  console.log(`   插入耗时: ${insertTime}ms`);

  // 4. 评估索引大小
  const sizeRow = db.prepare(`SELECT SUM(pgsize) AS total FROM dbstat WHERE name = 'evidence_fts'`).get();
  const indexSizeKB = sizeRow ? (sizeRow.total / 1024).toFixed(1) : 'N/A';
  console.log(`   FTS5 索引大小: ${indexSizeKB} KB`);

  // 5. 定义测试查询
  // FTS5 列过滤语法: column_name:term（无空格），短语用双引号
  const queries = [
    // Q1: 按文件名精确匹配（来源检索，最常见场景）
    {
      label: 'Q1 按文件名精确匹配',
      sql: `SELECT * FROM evidence_fts WHERE evidence_fts MATCH 'source:产品白皮书' LIMIT 20`,
    },
    // Q2: 按文件名 + 页码组合（短语搜索）
    {
      label: 'Q2 文件名+页码组合',
      sql: `SELECT * FROM evidence_fts WHERE evidence_fts MATCH 'source:技术架构设计' LIMIT 20`,
    },
    // Q3: 按表编号精确匹配
    {
      label: 'Q3 按表编号匹配',
      sql: `SELECT * FROM evidence_fts WHERE evidence_fts MATCH 'table_code:T03*' LIMIT 20`,
    },
    // Q4: 按关键词搜索 content
    {
      label: 'Q4 content 关键词',
      sql: `SELECT * FROM evidence_fts WHERE evidence_fts MATCH '边缘计算' LIMIT 20`,
    },
    // Q5: 跨字段模糊 - OR 组合
    {
      label: 'Q5 跨字段 OR 组合',
      sql: `SELECT * FROM evidence_fts WHERE evidence_fts MATCH 'source:竞品 OR content:竞品' LIMIT 20`,
    },
    // Q6: 跨字段 AND 组合
    {
      label: 'Q6 跨字段 AND 组合',
      sql: `SELECT * FROM evidence_fts WHERE evidence_fts MATCH 'content:金融 table_code:T04*' LIMIT 20`,
    },
    // Q7: 前缀搜索（用户输入部分关键词）
    {
      label: 'Q7 前缀搜索',
      sql: `SELECT * FROM evidence_fts WHERE evidence_fts MATCH 'content:安全*' LIMIT 20`,
    },
    // Q8: 短语搜索
    {
      label: 'Q8 短语搜索',
      sql: `SELECT * FROM evidence_fts WHERE evidence_fts MATCH 'content:"本地化交付能力"' LIMIT 20`,
    },
    // Q9: BM25 排序查询（带 relevance 排序）
    {
      label: 'Q9 BM25 排序查询',
      sql: `SELECT *, rank FROM evidence_fts WHERE evidence_fts MATCH 'content:架构 OR content:性能' ORDER BY rank LIMIT 20`,
    },
    // Q10: 最坏情况 - 无 LIMIT 全量匹配计数
    {
      label: 'Q10 全量计数（无 LIMIT）',
      sql: `SELECT COUNT(*) AS cnt FROM evidence_fts WHERE evidence_fts MATCH 'content:交付'`,
    },
  ];

  // 6. Warmup
  console.log('\n[3/4] Warmup...');
  for (let i = 0; i < WARMUP_QUERIES; i++) {
    db.prepare(queries[0].sql).all();
  }

  // 7. 执行查询基准测试
  console.log('[4/4] 执行查询基准测试...\n');
  const results = [];
  let allPass = true;

  for (const q of queries) {
    const times = [];
    const RUNS = 10;
    let rowCount = 0;

    for (let r = 0; r < RUNS; r++) {
      const start = performance.now();
      const rows = db.prepare(q.sql).all();
      const elapsed = performance.now() - start;
      times.push(elapsed);
      rowCount = rows.length;
    }

    const avg = (times.reduce((a, b) => a + b, 0) / times.length).toFixed(2);
    const min = Math.min(...times).toFixed(2);
    const max = Math.max(...times).toFixed(2);
    const p95 = times.sort((a, b) => a - b)[Math.floor(RUNS * 0.95)].toFixed(2);
    const pass = parseFloat(avg) <= 50;

    if (!pass) allPass = false;

    const status = pass ? 'PASS' : 'FAIL';
    console.log(`  ${q.label}`);
    console.log(`    结果行: ${rowCount} | 平均: ${avg}ms | 最小: ${min}ms | 最大: ${max}ms | P95: ${p95}ms [${status}]`);

    results.push({
      label: q.label,
      avg: parseFloat(avg),
      min: parseFloat(min),
      max: parseFloat(max),
      p95: parseFloat(p95),
      rowCount,
      pass,
    });
  }

  // 8. 汇总
  console.log('\n=== 汇总 ===');
  console.log(`总行数: ${TOTAL_ROWS}`);
  console.log(`插入耗时: ${insertTime}ms`);
  console.log(`FTS5 索引大小: ${indexSizeKB} KB`);
  console.log(`所有查询 ≤50ms: ${allPass ? 'YES' : 'NO'}`);

  const maxAvg = Math.max(...results.map((r) => r.avg)).toFixed(2);
  console.log(`最慢查询平均延迟: ${maxAvg}ms`);

  // 输出 JSON 供外部解析
  const summary = {
    totalRows: TOTAL_ROWS,
    insertTimeMs: parseFloat(insertTime),
    indexSizeKB: parseFloat(indexSizeKB),
    allPass,
    maxAvgMs: parseFloat(maxAvg),
    results,
  };
  console.log('\n---JSON_SUMMARY---');
  console.log(JSON.stringify(summary, null, 2));
  console.log('---END_SUMMARY---');

  db.close();

  // 9. 磁盘模式测量索引大小
  console.log('\n=== 磁盘模式索引大小测量 ===');
  const fs = require('fs');
  const path = require('path');
  const dbPath = path.join(__dirname, '_bench_tmp.sqlite');
  try {
    const diskDb = new Database(dbPath);
    diskDb.pragma('journal_mode = WAL');
    diskDb.exec(`
      CREATE VIRTUAL TABLE evidence_fts_d USING fts5(
        source, content, table_code, tokenize='unicode61'
      );
    `);
    const insStmt = diskDb.prepare(
      `INSERT INTO evidence_fts_d (source, content, table_code) VALUES (?, ?, ?)`
    );
    const insTx = diskDb.transaction((rs) => {
      for (const r of rs) insStmt.run(r.source, r.content, r.tableCode);
    });
    insTx(rows);

    // 建完后手动触发 merge 使索引落地
    diskDb.exec(`INSERT INTO evidence_fts_d(evidence_fts_d, rank) VALUES('merge', 1000)`);

    const sizeRow2 = diskDb.prepare(
      `SELECT SUM(pgsize) AS total FROM dbstat WHERE name LIKE 'evidence_fts_d%'`
    ).get();
    const diskIndexKB = sizeRow2 && sizeRow2.total ? (sizeRow2.total / 1024).toFixed(1) : 'N/A';
    console.log(`FTS5 磁盘索引大小: ${diskIndexKB} KB`);

    // 表名列表
    const tables = diskDb.prepare(
      `SELECT name, SUM(pgsize) AS sz FROM dbstat WHERE name LIKE '%evidence_fts_d%' GROUP BY name`
    ).all();
    for (const t of tables) {
      console.log(`  ${t.name}: ${(t.sz / 1024).toFixed(1)} KB`);
    }

    diskDb.close();
    fs.unlinkSync(dbPath);
    fs.unlinkSync(dbPath + '-wal');
    fs.unlinkSync(dbPath + '-shm');

    summary.indexSizeKB = parseFloat(diskIndexKB) || 0;
  } catch (e) {
    console.log('磁盘索引测量失败:', e.message);
  }
}

main();