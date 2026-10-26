-- P5：为并行 Researcher 保存稳定业务标识。
-- task_events 已在 002_tasks.sql 中提供事件序号和断线补读所需的归档。
ALTER TABLE researcher_results
    ADD COLUMN researcher_id text NOT NULL DEFAULT '';

UPDATE researcher_results
SET researcher_id = attempt_id::text || ':legacy:r' || ordinal::text
WHERE researcher_id = '';

ALTER TABLE researcher_results
    ALTER COLUMN researcher_id DROP DEFAULT;

CREATE INDEX task_events_task_seq_idx ON task_events (task_id, seq);
