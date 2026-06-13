const { query } = require("./db");

// 保守 DDL：兼容 MySQL 5.7 / 8.0，无 CHECK、无函数默认值、无降序索引。
// signal/key/trigger 是保留字，列名分别用 signal_text/setting_key/trigger_type。
const TABLE_SUFFIX = " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS sectors (
    id           VARCHAR(64)  NOT NULL,
    name         VARCHAR(128) NOT NULL,
    description  VARCHAR(512) NOT NULL DEFAULT '',
    keywords     JSON         NOT NULL,
    sort_order   INT          NOT NULL DEFAULT 0,
    is_visible   TINYINT(1)   NOT NULL DEFAULT 1,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_sec_order (sort_order)
  )${TABLE_SUFFIX}`,

  `CREATE TABLE IF NOT EXISTS sources (
    id              VARCHAR(64)   NOT NULL,
    name            VARCHAR(128)  NOT NULL,
    homepage        VARCHAR(512)  NOT NULL DEFAULT '',
    feed_url        VARCHAR(1024) NOT NULL,
    type            ENUM('official','research','media','analysis') NOT NULL DEFAULT 'media',
    region          VARCHAR(32)   NOT NULL DEFAULT 'Global',
    language        VARCHAR(16)   NOT NULL DEFAULT 'en',
    default_sector  VARCHAR(64)   NULL,
    is_enabled      TINYINT(1)    NOT NULL DEFAULT 1,
    sort_order      INT           NOT NULL DEFAULT 0,
    notes           VARCHAR(512)  NOT NULL DEFAULT '',
    last_ok         TINYINT(1)    NULL,
    last_via        VARCHAR(16)   NULL,
    last_count      INT           NOT NULL DEFAULT 0,
    last_error      VARCHAR(512)  NULL,
    last_fetched_at DATETIME      NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_src_enabled (is_enabled, sort_order),
    CONSTRAINT fk_src_sector FOREIGN KEY (default_sector) REFERENCES sectors(id) ON DELETE SET NULL
  )${TABLE_SUFFIX}`,

  `CREATE TABLE IF NOT EXISTS items (
    id            VARCHAR(24)   NOT NULL,
    url_hash      CHAR(40)      NOT NULL,
    title         VARCHAR(512)  NOT NULL,
    url           VARCHAR(2048) NOT NULL,
    source_id     VARCHAR(64)   NOT NULL,
    sector_id     VARCHAR(64)   NOT NULL,
    tags          JSON          NOT NULL,
    summary       TEXT          NULL,
    ai_summary    TEXT          NULL,
    published_at  DATETIME      NOT NULL,
    score         DECIMAL(6,2)  NOT NULL DEFAULT 0,
    classified_by ENUM('keyword','source','llm','fallback','manual') NOT NULL DEFAULT 'keyword',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_items_url (url_hash),
    KEY idx_items_pub (published_at),
    KEY idx_items_sector (sector_id, published_at),
    KEY idx_items_source (source_id),
    CONSTRAINT fk_items_source FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
    CONSTRAINT fk_items_sector FOREIGN KEY (sector_id) REFERENCES sectors(id)
  )${TABLE_SUFFIX}`,

  `CREATE TABLE IF NOT EXISTS insight_topics (
    id             VARCHAR(64)   NOT NULL,
    title          VARCHAR(128)  NOT NULL,
    thesis         VARCHAR(512)  NOT NULL DEFAULT '',
    signal_text    VARCHAR(1024) NOT NULL DEFAULT '',
    keywords       JSON          NOT NULL,
    metric_label   VARCHAR(128)  NOT NULL DEFAULT '',
    best_for       VARCHAR(512)  NOT NULL DEFAULT '',
    opportunity    VARCHAR(1024) NOT NULL DEFAULT '',
    threshold_text VARCHAR(512)  NOT NULL DEFAULT '',
    tools          JSON          NOT NULL,
    first_action   VARCHAR(512)  NOT NULL DEFAULT '',
    actions        JSON          NOT NULL,
    sort_order     INT           NOT NULL DEFAULT 0,
    is_visible     TINYINT(1)    NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_topics_order (sort_order)
  )${TABLE_SUFFIX}`,

  `CREATE TABLE IF NOT EXISTS modules (
    id           VARCHAR(64)  NOT NULL,
    name         VARCHAR(128) NOT NULL,
    anchor       VARCHAR(64)  NOT NULL DEFAULT '',
    nav_items    JSON         NOT NULL,
    is_orderable TINYINT(1)   NOT NULL DEFAULT 1,
    sort_order   INT          NOT NULL DEFAULT 0,
    is_visible   TINYINT(1)   NOT NULL DEFAULT 1,
    settings     JSON         NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_mod_order (sort_order)
  )${TABLE_SUFFIX}`,

  `CREATE TABLE IF NOT EXISTS site_settings (
    setting_key VARCHAR(128) NOT NULL,
    value       TEXT NOT NULL,
    type        VARCHAR(16) NOT NULL DEFAULT 'string',
    category    VARCHAR(64) NOT NULL DEFAULT 'site',
    label       VARCHAR(255) NOT NULL DEFAULT '',
    description VARCHAR(512) NOT NULL DEFAULT '',
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (setting_key),
    KEY idx_set_cat (category)
  )${TABLE_SUFFIX}`,

  `CREATE TABLE IF NOT EXISTS crawl_runs (
    id           INT NOT NULL AUTO_INCREMENT,
    trigger_type ENUM('manual','schedule','startup','admin') NOT NULL DEFAULT 'manual',
    status       ENUM('running','ok','error') NOT NULL DEFAULT 'running',
    started_at   DATETIME NOT NULL,
    finished_at  DATETIME NULL,
    stats        JSON NULL,
    error        TEXT NULL,
    PRIMARY KEY (id),
    KEY idx_runs_started (started_at)
  )${TABLE_SUFFIX}`,

  `CREATE TABLE IF NOT EXISTS ai_reports (
    id           INT NOT NULL AUTO_INCREMENT,
    run_id       INT NULL,
    title        VARCHAR(255) NOT NULL,
    content_md   MEDIUMTEXT NOT NULL,
    model        VARCHAR(64) NOT NULL DEFAULT '',
    tokens_used  INT NOT NULL DEFAULT 0,
    is_published TINYINT(1) NOT NULL DEFAULT 1,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_rep_created (created_at)
  )${TABLE_SUFFIX}`,

  `CREATE TABLE IF NOT EXISTS link_cache (
    google_hash  CHAR(40) NOT NULL,
    google_url   VARCHAR(1024) NOT NULL,
    resolved_url VARCHAR(2048) NULL,
    method       VARCHAR(16) NOT NULL DEFAULT '',
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (google_hash)
  )${TABLE_SUFFIX}`,

  `CREATE TABLE IF NOT EXISTS llm_usage (
    usage_date        DATE NOT NULL,
    calls             INT NOT NULL DEFAULT 0,
    prompt_tokens     INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    errors            INT NOT NULL DEFAULT 0,
    PRIMARY KEY (usage_date)
  )${TABLE_SUFFIX}`,

  `CREATE TABLE IF NOT EXISTS users (
    id            INT NOT NULL AUTO_INCREMENT,
    username      VARCHAR(64)  NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role          ENUM('admin','user') NOT NULL DEFAULT 'user',
    profile       JSON NOT NULL,
    is_enabled    TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_username (username)
  )${TABLE_SUFFIX}`,
];

/** 给已存在的表补列（轻量迁移） */
async function ensureColumn(table, column, columnDdl) {
  const rows = await query(`SHOW COLUMNS FROM ${table} LIKE ?`, [column]);
  if (!rows.length) {
    await query(`ALTER TABLE ${table} ADD COLUMN ${columnDdl}`);
  }
}

async function ensureSchema() {
  for (const ddl of TABLES) {
    await query(ddl);
  }
  // v3: 洞察话题支持置顶（排行榜与卡片均排第一）
  await ensureColumn("insight_topics", "is_pinned", "is_pinned TINYINT(1) NOT NULL DEFAULT 0");
}

module.exports = { ensureSchema };
