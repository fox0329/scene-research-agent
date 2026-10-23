-- 场景通 SQLite 迁移 001: 初始化 15 张表 + FTS5
-- 对应设计文档: 03-数据契约与API.md v0.1
-- 主键 TEXT UUID v4, 时间 TEXT ISO 8601

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ═══════════════════════════════════════════════════════════════
-- 第一层 · 产品资料库（8 表）
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS product_line (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  -- 归属场景：NULL=通用资料库（共享），非空=该场景专属资料库（v1.10）
  scenario_id TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product (
  id               TEXT PRIMARY KEY,
  product_line_id  TEXT NOT NULL REFERENCES product_line(id),
  model            TEXT NOT NULL,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('在售','停售','在研','规划','待确认')),
  launch_date      TEXT NOT NULL,
  former_name      TEXT,
  position_desc    TEXT NOT NULL,
  source_type      TEXT CHECK (source_type IN ('AI提取','AI推断','用户确认','用户补充')),
  source           TEXT,
  source_authority TEXT CHECK (source_authority IN ('T1','T2','T3','T4')),
  evidence_level   TEXT CHECK (evidence_level IN ('A','B','C','D')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spec_param (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES product(id),
  param_class      TEXT NOT NULL,
  param_name       TEXT NOT NULL,
  value            TEXT NOT NULL,
  measured         TEXT NOT NULL CHECK (measured IN ('实测','宣称','未提及')),
  source_type      TEXT CHECK (source_type IN ('AI提取','AI推断','用户确认','用户补充')),
  source           TEXT,
  source_authority TEXT CHECK (source_authority IN ('T1','T2','T3','T4')),
  evidence_level   TEXT CHECK (evidence_level IN ('A','B','C','D')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spec_param_product_class
  ON spec_param (product_id, param_class);

CREATE TABLE IF NOT EXISTS capability (
  id                  TEXT PRIMARY KEY,
  product_line_id     TEXT NOT NULL REFERENCES product_line(id),
  domain              TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL,
  maturity            TEXT NOT NULL CHECK (maturity IN ('已交付','组件具备','在研','规划')),
  dependency          TEXT NOT NULL,
  inapplicable_scene  TEXT,
  source_type         TEXT CHECK (source_type IN ('AI提取','AI推断','用户确认','用户补充')),
  source              TEXT,
  source_authority    TEXT CHECK (source_authority IN ('T1','T2','T3','T4')),
  evidence_level      TEXT CHECK (evidence_level IN ('A','B','C','D')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capability_line_domain
  ON capability (product_line_id, domain);

CREATE TABLE IF NOT EXISTS boundary (
  id               TEXT PRIMARY KEY,
  product_line_id  TEXT NOT NULL REFERENCES product_line(id),
  description      TEXT NOT NULL,
  reason           TEXT NOT NULL,
  has_plan         TEXT NOT NULL CHECK (has_plan IN ('有','无','未定')),
  response         TEXT NOT NULL,
  owner            TEXT NOT NULL,
  plan_date        TEXT,
  source_type      TEXT CHECK (source_type IN ('AI提取','AI推断','用户确认','用户补充')),
  source           TEXT,
  source_authority TEXT CHECK (source_authority IN ('T1','T2','T3','T4')),
  evidence_level   TEXT CHECK (evidence_level IN ('A','B','C','D')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS limitation (
  id                TEXT PRIMARY KEY,
  product_line_id   TEXT NOT NULL REFERENCES product_line(id),
  product_name      TEXT NOT NULL,
  description       TEXT NOT NULL,
  impact            TEXT NOT NULL CHECK (impact IN ('高','中','低')),
  fix_status        TEXT NOT NULL CHECK (fix_status IN ('已修复','修复中','无计划','硬件限制')),
  external_visible  TEXT NOT NULL CHECK (external_visible IN ('可提','内部可提','不可提')),
  owner             TEXT NOT NULL,
  source_type       TEXT CHECK (source_type IN ('AI提取','AI推断','用户确认','用户补充')),
  source            TEXT,
  source_authority  TEXT CHECK (source_authority IN ('T1','T2','T3','T4')),
  evidence_level    TEXT CHECK (evidence_level IN ('A','B','C','D')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_quote (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES product(id),
  model            TEXT NOT NULL,
  config           TEXT NOT NULL,
  unit_price       TEXT NOT NULL,
  price_scope      TEXT NOT NULL CHECK (price_scope IN ('纯设备','含安装','含三年维保','年费')),
  valid_until      TEXT,
  source           TEXT NOT NULL,
  source_type      TEXT CHECK (source_type IN ('AI提取','AI推断','用户确认','用户补充')),
  source_authority TEXT CHECK (source_authority IN ('T1','T2','T3','T4')),
  evidence_level   TEXT CHECK (evidence_level IN ('A','B','C','D')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_price_quote_product
  ON price_quote (product_id, model);

CREATE TABLE IF NOT EXISTS cost_rate (
  id               TEXT PRIMARY KEY,
  product_line_id  TEXT NOT NULL REFERENCES product_line(id),
  category         TEXT NOT NULL CHECK (category IN ('实施','商务')),
  item             TEXT NOT NULL,
  rate             REAL NOT NULL,
  unit             TEXT NOT NULL,
  standard_hours   REAL NOT NULL,
  data_source      TEXT NOT NULL CHECK (data_source IN ('历史项目','内部报价','行业均值','待确认')),
  note             TEXT,
  source_type      TEXT CHECK (source_type IN ('AI提取','AI推断','用户确认','用户补充')),
  source           TEXT,
  source_authority TEXT CHECK (source_authority IN ('T1','T2','T3','T4')),
  evidence_level   TEXT CHECK (evidence_level IN ('A','B','C','D')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_rate_line_category
  ON cost_rate (product_line_id, category);

CREATE TABLE IF NOT EXISTS optional_material (
  id               TEXT PRIMARY KEY,
  product_line_id  TEXT NOT NULL REFERENCES product_line(id),
  category         TEXT NOT NULL CHECK (category IN ('O1认证','O2案例','O3价格','O4SDK','O5路线图','O6生态')),
  payload          TEXT NOT NULL DEFAULT '{}',
  source_type      TEXT CHECK (source_type IN ('AI提取','AI推断','用户确认','用户补充')),
  source           TEXT,
  source_authority TEXT CHECK (source_authority IN ('T1','T2','T3','T4')),
  evidence_level   TEXT CHECK (evidence_level IN ('A','B','C','D')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_optional_material_line_category
  ON optional_material (product_line_id, category);

-- ═══════════════════════════════════════════════════════════════
-- 第二层 · 场景分析项目（6 表）
-- ═══════════════════════════════════════════════════════════════

-- 场景引用的通用资料库（多对多；引用不拷贝，分析时与专属库合并，v1.10）
CREATE TABLE IF NOT EXISTS scenario_linked_line (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenario(id),
  product_line_id TEXT NOT NULL REFERENCES product_line(id),
  -- v2.9：0 = 引用（默认），1 = 用户显式取消引用
  excluded        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (scenario_id, product_line_id)
);

CREATE TABLE IF NOT EXISTS scenario (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  -- 场景描述（分析锚 v1.11）
  description      TEXT,
  -- v3.0（变更表 #160）：原来的 product_line_id NOT NULL REFERENCES product_line(id) 已退休。
  -- 私有库改为按需创建、可删，关系只存在 product_line.scenario_id 上（一处属主）。
  status           TEXT NOT NULL CHECK (status IN ('进行中','已完成','已归档')),
  current_stage    INTEGER NOT NULL CHECK (current_stage BETWEEN 0 AND 8),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- 场景流程步完成记录（v1.5 逐页推进）：一场景一行/已完成步，用户点「完成本步」才写入
CREATE TABLE IF NOT EXISTS scenario_step (
  scenario_id  TEXT NOT NULL REFERENCES scenario(id),
  step         INTEGER NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (scenario_id, step)
);

-- 场景诉求（第一输入，v1.4 §3.0）：一场景一行；raw_text 保留用户原文作对照基准
CREATE TABLE IF NOT EXISTS scenario_brief (
  scenario_id    TEXT PRIMARY KEY REFERENCES scenario(id),
  scene_name     TEXT NOT NULL,
  intent         TEXT NOT NULL,
  customer_hint  TEXT,
  region_hint    TEXT,
  scope_hint     TEXT,
  audience       TEXT,
  deadline       TEXT,
  raw_text       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- 阶段总结文档（每阶段一份；确定性生成，见 04 §五）
CREATE TABLE IF NOT EXISTS stage_summary (
  scenario_id  TEXT NOT NULL REFERENCES scenario(id),
  stage        INTEGER NOT NULL,
  content      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (scenario_id, stage)
);

CREATE TABLE IF NOT EXISTS scenario_material (
  id               TEXT PRIMARY KEY,
  scenario_id      TEXT NOT NULL REFERENCES scenario(id),
  ref_table        TEXT NOT NULL,
  ref_id           TEXT NOT NULL,
  override_value   TEXT NOT NULL DEFAULT '{}',
  reason           TEXT NOT NULL,
  source_type      TEXT CHECK (source_type IN ('AI提取','AI推断','用户确认','用户补充')),
  source           TEXT,
  source_authority TEXT CHECK (source_authority IN ('T1','T2','T3','T4')),
  evidence_level   TEXT CHECK (evidence_level IN ('A','B','C','D')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (scenario_id, ref_table, ref_id)
);

CREATE TABLE IF NOT EXISTS stage_data (
  id               TEXT PRIMARY KEY,
  scenario_id      TEXT NOT NULL REFERENCES scenario(id),
  stage            INTEGER NOT NULL CHECK (stage BETWEEN 0 AND 8),
  table_code       TEXT NOT NULL,
  row              TEXT NOT NULL DEFAULT '{}',
  is_stale         INTEGER NOT NULL DEFAULT 0,
  source_type      TEXT CHECK (source_type IN ('AI提取','AI推断','用户确认','用户补充')),
  source           TEXT,
  source_authority TEXT CHECK (source_authority IN ('T1','T2','T3','T4')),
  evidence_level   TEXT CHECK (evidence_level IN ('A','B','C','D')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stage_data_scenario_stage_code
  ON stage_data (scenario_id, stage, table_code);

CREATE TABLE IF NOT EXISTS conversation (
  id               TEXT PRIMARY KEY,
  scenario_id      TEXT NOT NULL REFERENCES scenario(id),
  title            TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('活跃','已归档')),
  kind             TEXT NOT NULL DEFAULT '用户',
  dsh_session_id   TEXT NOT NULL,
  -- v2 产物会话：一个 (scenario_id, step, scope_type, scope_id) 只有一条活跃会话
  scope_type       TEXT NOT NULL DEFAULT 'legacy',
  scope_id         TEXT NOT NULL DEFAULT '',
  step             INTEGER,
  block            TEXT,
  purpose          TEXT NOT NULL DEFAULT 'assistant',
  summary          TEXT NOT NULL DEFAULT '',
  context_hash     TEXT NOT NULL DEFAULT '',
  last_activity_at TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversation(id),
  role             TEXT NOT NULL CHECK (role IN ('用户','系统')),
  content          TEXT NOT NULL,
  stage            INTEGER CHECK (stage BETWEEN 0 AND 8),
  table_ref        TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_conversation_created
  ON message (conversation_id, created_at);

-- #305 资料库对话消息：按产品线隔离（不挂 scenario 外键；产品线删除时同删）
CREATE TABLE IF NOT EXISTS library_message (
  id               TEXT PRIMARY KEY,
  product_line_id  TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('用户','系统')),
  content          TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_library_message_line_created
  ON library_message (product_line_id, created_at);

CREATE TABLE IF NOT EXISTS quality_gate (
  id               TEXT PRIMARY KEY,
  scenario_id      TEXT NOT NULL REFERENCES scenario(id),
  stage            INTEGER NOT NULL CHECK (stage BETWEEN 0 AND 8),
  item_no          TEXT NOT NULL,
  title            TEXT NOT NULL,
  result           TEXT NOT NULL CHECK (result IN ('通过','不通过','未检')),
  detail           TEXT NOT NULL,
  evidence_refs    TEXT NOT NULL DEFAULT '{}',
  checked_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quality_gate_scenario_stage
  ON quality_gate (scenario_id, stage);

-- ═══════════════════════════════════════════════════════════════
-- FTS5 全文索引（来源抽查，Spike S4 已验证）
-- 使用 content-bearing FTS5，触发器通过业务表 id 保持同步
-- ═══════════════════════════════════════════════════════════════

CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(
  ref_id,
  source,
  content,
  table_code,
  tokenize='trigram'
);

-- ═══════════════════════════════════════════════════════════════
-- 触发器：资料库表 INSERT/UPDATE 时同步 FTS5 索引
-- ref_id 列存储业务行 id，便于删除/更新时定位 FTS 行
-- ═══════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS trg_product_fts_insert AFTER INSERT ON product
BEGIN
  INSERT INTO source_fts (ref_id, source, content, table_code)
  VALUES (NEW.id, NEW.source, NEW.name || ' ' || NEW.position_desc, 'M1');
END;

CREATE TRIGGER IF NOT EXISTS trg_product_fts_update AFTER UPDATE ON product
BEGIN
  DELETE FROM source_fts WHERE ref_id = OLD.id;
  INSERT INTO source_fts (ref_id, source, content, table_code)
  VALUES (NEW.id, NEW.source, NEW.name || ' ' || NEW.position_desc, 'M1');
END;

CREATE TRIGGER IF NOT EXISTS trg_spec_param_fts_insert AFTER INSERT ON spec_param
BEGIN
  INSERT INTO source_fts (ref_id, source, content, table_code)
  VALUES (NEW.id, NEW.source, NEW.param_name || ' ' || NEW.value, 'M2');
END;

CREATE TRIGGER IF NOT EXISTS trg_spec_param_fts_update AFTER UPDATE ON spec_param
BEGIN
  DELETE FROM source_fts WHERE ref_id = OLD.id;
  INSERT INTO source_fts (ref_id, source, content, table_code)
  VALUES (NEW.id, NEW.source, NEW.param_name || ' ' || NEW.value, 'M2');
END;

CREATE TRIGGER IF NOT EXISTS trg_capability_fts_insert AFTER INSERT ON capability
BEGIN
  INSERT INTO source_fts (ref_id, source, content, table_code)
  VALUES (NEW.id, NEW.source, NEW.name || ' ' || NEW.description, 'M3');
END;

CREATE TRIGGER IF NOT EXISTS trg_capability_fts_update AFTER UPDATE ON capability
BEGIN
  DELETE FROM source_fts WHERE ref_id = OLD.id;
  INSERT INTO source_fts (ref_id, source, content, table_code)
  VALUES (NEW.id, NEW.source, NEW.name || ' ' || NEW.description, 'M3');
END;

CREATE TRIGGER IF NOT EXISTS trg_boundary_fts_insert AFTER INSERT ON boundary
BEGIN
  INSERT INTO source_fts (ref_id, source, content, table_code)
  VALUES (NEW.id, NEW.source, NEW.description, 'M4');
END;

CREATE TRIGGER IF NOT EXISTS trg_boundary_fts_update AFTER UPDATE ON boundary
BEGIN
  DELETE FROM source_fts WHERE ref_id = OLD.id;
  INSERT INTO source_fts (ref_id, source, content, table_code)
  VALUES (NEW.id, NEW.source, NEW.description, 'M4');
END;

CREATE TRIGGER IF NOT EXISTS trg_limitation_fts_insert AFTER INSERT ON limitation
BEGIN
  INSERT INTO source_fts (ref_id, source, content, table_code)
  VALUES (NEW.id, NEW.source, NEW.description, 'M5');
END;

CREATE TRIGGER IF NOT EXISTS trg_limitation_fts_update AFTER UPDATE ON limitation
BEGIN
  DELETE FROM source_fts WHERE ref_id = OLD.id;
  INSERT INTO source_fts (ref_id, source, content, table_code)
  VALUES (NEW.id, NEW.source, NEW.description, 'M5');
END;

CREATE TRIGGER IF NOT EXISTS trg_optional_material_fts_insert AFTER INSERT ON optional_material
BEGIN
  INSERT INTO source_fts (ref_id, source, content, table_code)
  VALUES (NEW.id, NEW.source, NEW.payload, NEW.category);
END;

CREATE TRIGGER IF NOT EXISTS trg_optional_material_fts_update AFTER UPDATE ON optional_material
BEGIN
  DELETE FROM source_fts WHERE ref_id = OLD.id;
  INSERT INTO source_fts (ref_id, source, content, table_code)
  VALUES (NEW.id, NEW.source, NEW.payload, NEW.category);
END;

-- ═══════════════════════════════════════════════════════════════
-- 材料原文页（变更表 #212）
--
-- 为什么必须单独存：`source_fts.content` 原来存的是**业务字段拼接**
-- （触发器里 `NEW.name || ' ' || NEW.position_desc`），于是
-- `hasContent(ref, snippet)` 等于拿业务行跟自己比——**自证**，永远为真。
-- G-R8「该页确有这句话」要成立，必须把材料原文按页落库。
--
-- 语义：一行 = 某份材料的某一页（PDF 页号 / PPT 幻灯片号 / Excel sheet 号；
-- docx 无稳定分页，整篇为第 1 页）。
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS source_page (
  id TEXT PRIMARY KEY,
  /** 材料文件名（与引用里的 `文件名:页码` 对齐） */
  file_name TEXT NOT NULL,
  /** 页码/单元号，从 1 起 */
  page INTEGER NOT NULL,
  /** 该页原文 */
  content TEXT NOT NULL DEFAULT '',
  /** 入库时间 */
  created_at TEXT NOT NULL,
  UNIQUE(file_name, page)
);

CREATE INDEX IF NOT EXISTS idx_source_page_file ON source_page(file_name);

-- ═══════════════════════════════════════════════════════════════
-- 网页来源（变更表 #216）
--
-- 设计依据：docs/技术调研-权威来源检索.md §6.3
-- 一次抓取 = `web_source` 一行；一块 = `web_source_block` 一行 = 一「页」。
-- 引用格式 `域名-标题.md:块号`，与材料引用同一套正则，hasSource/hasContent 不用改。
--
-- 与 `source_page`（材料原文）的区别：
--   source_page 存本地材料的分页原文；web_source_block 存网页快照的分块原文。
--   两者都是**真原文**，所以 G-R8「该页确有这句话」在两类来源上都成立。
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS web_source (
  id TEXT PRIMARY KEY,
  /** 原始 URL */
  url TEXT NOT NULL,
  /** 规范化 URL 的散列（去追踪参数等）→ 缓存键 */
  url_key TEXT NOT NULL UNIQUE,
  /** 跟随重定向后的最终 URL */
  final_url TEXT NOT NULL DEFAULT '',
  /** 注册域（eTLD+1 近似） */
  domain TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  /** 发布机构（og:site_name / 页脚） */
  publisher TEXT NOT NULL DEFAULT '',
  /** 页面声明的发布日期（ISO 8601） */
  published_at TEXT NOT NULL DEFAULT '',
  /** 抓取时间（ISO 8601，带时区） */
  fetched_at TEXT NOT NULL,
  http_status INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT '',
  etag TEXT NOT NULL DEFAULT '',
  last_modified TEXT NOT NULL DEFAULT '',
  /** 快照文件名（含 .md），就是引用里的「文件名」 */
  snapshot_name TEXT NOT NULL DEFAULT '',
  snapshot_sha256 TEXT NOT NULL DEFAULT '',
  block_count INTEGER NOT NULL DEFAULT 0,
  /** 文号 / 标准号 / 公告编号 */
  doc_no TEXT NOT NULL DEFAULT '',
  /** 复用 SourceCategory */
  category TEXT NOT NULL DEFAULT '未知',
  authority TEXT NOT NULL DEFAULT 'T4',
  /** 命中的 P 规则 + 降级/升级因子（JSON，可审计） */
  authority_reason TEXT NOT NULL DEFAULT '',
  /** 降级因子（JSON 数组） */
  trust_flags TEXT NOT NULL DEFAULT '',
  /** 注入特征（JSON 数组） */
  injection_flags TEXT NOT NULL DEFAULT '',
  /** 有效 / 已变更 / 已删除 / 抓取失败 */
  status TEXT NOT NULL DEFAULT '有效',
  /** 产出这份快照的检索 query（便于回溯为什么抓它） */
  query TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_source_key ON web_source(url_key);
CREATE INDEX IF NOT EXISTS idx_web_source_domain ON web_source(domain);
CREATE INDEX IF NOT EXISTS idx_web_source_status ON web_source(status);

CREATE TABLE IF NOT EXISTS web_source_block (
  id TEXT PRIMARY KEY,
  web_source_id TEXT NOT NULL,
  /** 块号，从 1 起，就是引用里的「页码」 */
  block_no INTEGER NOT NULL,
  /** 所属最近标题 */
  heading TEXT NOT NULL DEFAULT '',
  /** 该块原文（**真原文**，不是字段拼接） */
  text TEXT NOT NULL DEFAULT '',
  char_start INTEGER NOT NULL DEFAULT 0,
  char_end INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  UNIQUE(web_source_id, block_no),
  FOREIGN KEY (web_source_id) REFERENCES web_source(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_web_block_source ON web_source_block(web_source_id);

-- 网页块 → FTS（table_code = 'W'，不改现有 6 张表的触发器）
--
-- 与材料表触发器的关键区别：这里写进 `content` 的是**块的真实原文**，
-- 所以网页来源上的 hasContent 名副其实。材料表那边是字段拼接（既有实现债，
-- 已用 source_page 补偿，见变更表 #212）。
CREATE TRIGGER IF NOT EXISTS trg_web_block_fts_insert AFTER INSERT ON web_source_block
BEGIN
  INSERT INTO source_fts (ref_id, source, content, table_code)
  SELECT NEW.id,
         ws.snapshot_name || ':' || NEW.block_no,
         NEW.text,
         'W'
    FROM web_source ws
   WHERE ws.id = NEW.web_source_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_web_block_fts_delete AFTER DELETE ON web_source_block
BEGIN
  DELETE FROM source_fts WHERE ref_id = OLD.id;
END;
