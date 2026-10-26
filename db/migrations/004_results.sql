-- 003 已用于任务 API；新增迁移，不改写已应用的 SQL 历史。
CREATE TABLE researcher_results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal > 0),
    topic text NOT NULL,
    findings_json jsonb NOT NULL CHECK (jsonb_typeof(findings_json) = 'array'),
    sources_json jsonb NOT NULL CHECK (jsonb_typeof(sources_json) = 'array'),
    brief_text text NOT NULL DEFAULT '',
    brief_finding_ids jsonb NOT NULL CHECK (jsonb_typeof(brief_finding_ids) = 'array'),
    done boolean NOT NULL,
    gaps_json jsonb NOT NULL CHECK (jsonb_typeof(gaps_json) = 'array'),
    stop_reason text NOT NULL,
    search_round integer NOT NULL CHECK (search_round > 0),
    searched_queries_json jsonb NOT NULL CHECK (jsonb_typeof(searched_queries_json) = 'array'),
    compression_used boolean NOT NULL,
    compression_warning text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (task_id, attempt_id) REFERENCES research_attempts(task_id, id),
    UNIQUE (attempt_id, ordinal)
);

CREATE TABLE research_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL,
    attempt_id uuid NOT NULL UNIQUE,
    version integer NOT NULL CHECK (version > 0),
    markdown text NOT NULL CHECK (length(btrim(markdown)) > 0),
    findings_json jsonb NOT NULL CHECK (jsonb_typeof(findings_json) = 'array'),
    sources_json jsonb NOT NULL CHECK (jsonb_typeof(sources_json) = 'array'),
    gaps_json jsonb NOT NULL CHECK (jsonb_typeof(gaps_json) = 'array'),
    citation_warnings_json jsonb NOT NULL CHECK (jsonb_typeof(citation_warnings_json) = 'array'),
    compression_metrics_json jsonb NOT NULL CHECK (jsonb_typeof(compression_metrics_json) = 'array'),
    research_done boolean NOT NULL,
    stop_reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (task_id, attempt_id) REFERENCES research_attempts(task_id, id),
    UNIQUE (task_id, version)
);

CREATE INDEX research_attempts_expired_idx ON research_attempts (lease_expires_at)
    WHERE status = 'running';
