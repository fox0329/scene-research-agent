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
  product_line_id  TEXT NOT NULL REFERENCES product_line(id),
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
  dsh_session_id   TEXT NOT NULL,
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
