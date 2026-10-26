-- 尚未完成研究时，没有充分性判断。false 只表示图最终接受了“不充分”。
ALTER TABLE research_tasks ALTER COLUMN research_done DROP NOT NULL;
ALTER TABLE research_tasks ALTER COLUMN research_done DROP DEFAULT;
UPDATE research_tasks SET research_done = NULL WHERE status <> 'succeeded';

-- 用户行锁串行化 COUNT 与创建；这个索引缩小活跃任务计数的扫描范围。
CREATE INDEX research_tasks_active_owner_idx ON research_tasks (user_id)
    WHERE status IN ('queued', 'running');
