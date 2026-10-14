export const EDITOR_DRAFT_SCHEMA = `CREATE TABLE IF NOT EXISTS editor_drafts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    draft_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    revision TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, draft_key)
)`;

const migrations = new WeakMap<D1Database, Promise<void>>();

/** 기존 설치도 초안을 처음 사용할 때 테이블을 준비한다. 실패는 호출자에게 전달한다. */
export function ensureEditorDraftSchema(db: D1Database): Promise<void> {
    let pending = migrations.get(db);
    if (!pending) {
        pending = db.prepare(EDITOR_DRAFT_SCHEMA).run().then(() => undefined).catch(error => {
            migrations.delete(db);
            throw error;
        });
        migrations.set(db, pending);
    }
    return pending;
}
