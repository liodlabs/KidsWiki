-- 기존 키의 해시·만료일을 보존하면서 계정당 여러 키를 허용한다.
CREATE TABLE mcp_api_keys_new (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    masked_key TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    expires_at INTEGER -- NULL이면 직접 삭제할 때까지 유효
);

INSERT INTO mcp_api_keys_new (id, user_id, name, key_hash, masked_key, created_at, expires_at)
SELECT lower(hex(randomblob(16))), user_id, '기존 API 키', key_hash, masked_key, created_at, expires_at
FROM mcp_api_keys;

DROP TABLE mcp_api_keys;
ALTER TABLE mcp_api_keys_new RENAME TO mcp_api_keys;
CREATE INDEX idx_mcp_api_keys_user ON mcp_api_keys(user_id);
CREATE INDEX idx_mcp_api_keys_expires ON mcp_api_keys(expires_at);
