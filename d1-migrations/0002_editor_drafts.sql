-- 계정별 수동 편집 초안. 공개 문서 검색/리비전에 포함되지 않는다.
CREATE TABLE IF NOT EXISTS editor_drafts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    draft_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    revision TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, draft_key)
);
