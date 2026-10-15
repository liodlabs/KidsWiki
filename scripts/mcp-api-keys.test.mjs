import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { before, after } from 'node:test';
import { Hono } from 'hono';
import { createServer } from 'vite';

class Statement {
    constructor(db, sql, values = []) { Object.assign(this, { db, sql, values }); }
    bind(...values) { return new Statement(this.db, this.sql, values); }
    async first() { return this.db.prepare(this.sql).get(...this.values) ?? null; }
    async all() { return { results: this.db.prepare(this.sql).all(...this.values) }; }
    async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.values).changes) } }; }
}
class TestD1 {
    constructor(db) { this.db = db; }
    prepare(sql) { return new Statement(this.db, sql); }
}

let server, auth, authenticate, authenticateShared;
before(async () => {
    server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    auth = (await server.ssrLoadModule('/src/routes/auth/index.ts')).default;
    authenticate = (await server.ssrLoadModule('/src/utils/mcpAuth.ts')).resolveBearerAuth;
    authenticateShared = (await server.ssrLoadModule('/packages/wiki-shared/src/server/bearerAuth.ts')).resolveBearerAuth;
});
after(async () => { await server?.close(); });

const userA = '123456789ABCDEFGHJKLMN';
const userB = '23456789ABCDEFGHJKLMNP';
const url = '/api/me/mcp-api-keys';
const post = (name = '테스트 키', expiration = '30d') => ({ method: 'POST', body: JSON.stringify({ name, expiration }) });
const schema = readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../d1-migrations/0003_multiple_mcp_api_keys.sql', import.meta.url), 'utf8');

function fixture(role = 'user') {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys=ON');
    sqlite.exec(schema);
    for (const [id, r] of [[userA, role], [userB, 'user']]) {
        sqlite.prepare("INSERT INTO users (id, provider, uid, name, role) VALUES (?, 'test', ?, ?, ?)").run(id, id, id, r);
    }
    const DB = new TestD1(sqlite);
    const app = new Hono();
    app.use('*', async (c, next) => {
        const id = c.req.header('x-user');
        if (id) c.set('user', { id, role: c.req.header('x-role') ?? role });
        await next();
    });
    app.route('/', auth);
    app.get('/probe', async c => {
        const result = await authenticate(c);
        return result.kind === 'error' ? result.response : c.json(result);
    });
    const env = { DB, SUPER_ADMIN_EMAILS: 'owner@example.com' };
    return { sqlite, DB, env,
        request: (path = url, init = {}, user = userA) => app.request(path, { ...init,
            headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}), ...init.headers },
        }, env),
    };
}

for (const [role, limit] of [['user', 1], ['discussion_manager', 1], ['admin', 2], ['super_admin', 3]]) {
    test(`${role}: 최대 ${limit}개까지 추가 발급하고 기존 키를 유지한다`, async () => {
        const { sqlite, request } = fixture(role);
        try {
            const keys = [];
            for (let i = 0; i < limit; i++) {
                const res = await request(url, post(`기기 ${i + 1}`));
                assert.equal(res.status, 201);
                assert.equal(res.headers.get('cache-control'), 'no-store');
                keys.push(await res.json());
            }
            assert.equal((await request(url, post('한도 초과'))).status, 409);
            const list = await (await request()).json();
            assert.equal(list.limit, limit);
            assert.equal(list.apiKeys.length, limit);
            for (const key of keys) {
                assert.equal((await request('/probe', { headers: { Authorization: `Bearer ${key.rawKey}` } })).status, 200);
                assert.equal(JSON.stringify(list).includes(key.rawKey), false);
            }
            assert.equal(JSON.stringify(list).includes('key_hash'), false);
            const stored = sqlite.prepare('SELECT key_hash FROM mcp_api_keys LIMIT 1').get();
            assert.match(stored.key_hash, /^[a-f0-9]{64}$/);
        } finally { sqlite.close(); }
    });
}

test('동시 발급 요청이 와도 역할별 한도를 넘지 않는다', async () => {
    const { sqlite, request } = fixture('super_admin');
    try {
        const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => request(url, post(`동시 ${i}`))));
        assert.equal(responses.filter(r => r.status === 201).length, 3);
        assert.equal(responses.filter(r => r.status === 409).length, 5);
        assert.equal(sqlite.prepare('SELECT count(*) AS n FROM mcp_api_keys').get().n, 3);
    } finally { sqlite.close(); }
});

test('30일·무기한 인증을 지원하며 만료된 키는 인증과 발급 한도에서 제외한다', async () => {
    const { sqlite, DB, request } = fixture('admin');
    try {
        const now = Math.floor(Date.now() / 1000);
        const finite = await (await request(url, post('30일 키'))).json();
        const forever = await (await request(url, post('무기한 키', 'never'))).json();
        assert.ok(finite.expiresAt >= now + 30 * 86400 && finite.expiresAt <= now + 30 * 86400 + 5);
        assert.equal(forever.expiresAt, null);
        for (const key of [finite, forever]) {
            assert.equal((await request('/probe', { headers: { Authorization: `Bearer ${key.rawKey}` } })).status, 200);
            assert.equal((await authenticateShared(`Bearer ${key.rawKey}`, DB, null)).kind, 'authenticated');
        }
        sqlite.prepare('UPDATE mcp_api_keys SET expires_at = ? WHERE id = ?').run(now, finite.id);
        assert.equal((await request('/probe', { headers: { Authorization: `Bearer ${finite.rawKey}` } })).status, 401);
        assert.equal((await authenticateShared(`Bearer ${finite.rawKey}`, DB, null)).kind, 'error');
        assert.equal((await request(url, post('교체 키', 'never'))).status, 201);
        assert.equal((await request(url, post('초과 키'))).status, 409);
        assert.equal((await (await request()).json()).apiKeys.length, 3);
    } finally { sqlite.close(); }
});

test('다른 사용자의 키는 조회·삭제하지 못하고 삭제한 키만 인증이 차단된다', async () => {
    const { sqlite, request } = fixture('admin');
    try {
        const a = await (await request(url, post('A'))).json();
        const b = await (await request(url, post('B'))).json();
        assert.deepEqual((await (await request(url, {}, userB)).json()).apiKeys, []);
        assert.equal((await request(`${url}/${a.id}`, { method: 'DELETE' }, userB)).status, 404);
        assert.equal((await request(`${url}/${a.id}`, { method: 'DELETE' })).status, 200);
        assert.equal((await request('/probe', { headers: { Authorization: `Bearer ${a.rawKey}` } })).status, 401);
        assert.equal((await request('/probe', { headers: { Authorization: `Bearer ${b.rawKey}` } })).status, 200);
        assert.equal((await request(url, post('C'))).status, 201);
        // 예전 전체 삭제 API로 남아 있는 키를 실수로 지우지 않는다.
        assert.equal((await request('/api/me/mcp-api-key', { method: 'DELETE' })).status, 404);
    } finally { sqlite.close(); }
});

test('최신 DB 역할·차단 상태를 적용하고 최고 관리자 이메일을 인식한다', async () => {
    const { sqlite, request } = fixture('super_admin');
    try {
        for (let i = 0; i < 3; i++) assert.equal((await request(url, post(`키 ${i}`))).status, 201);
        sqlite.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(userA);
        const downgraded = await (await request()).json();
        assert.equal(downgraded.limit, 1);
        assert.equal(downgraded.apiKeys.length, 3);
        assert.equal((await request(url, post('추가 불가'))).status, 409);
        sqlite.prepare('UPDATE users SET banned_until = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) + 3600, userA);
        assert.equal((await request(url, post())).status, 403);
        sqlite.prepare("UPDATE users SET banned_until = NULL, email = 'OWNER@example.com' WHERE id = ?").run(userA);
        assert.equal((await (await request()).json()).limit, 3);
        sqlite.prepare("UPDATE users SET role = 'deleted' WHERE id = ?").run(userA);
        assert.equal((await request(url, post())).status, 403);
    } finally { sqlite.close(); }
});

test('비로그인·차단 계정과 잘못된 입력은 발급할 수 없다', async () => {
    const { sqlite, request } = fixture();
    try {
        for (const [path, init] of [[url, {}], [url, post()], [`${url}/test`, { method: 'DELETE' }]]) {
            assert.equal((await request(path, init, null)).status, 401);
            assert.equal((await request(path, { ...init, headers: { 'x-role': 'banned' } })).status, 403);
        }
        for (const value of [null, {}, { name: '', expiration: '30d' }, { name: ' '.repeat(5), expiration: 'never' },
            { name: 'a'.repeat(81), expiration: '30d' }, { name: '키', expiration: '90d' }, { name: 123, expiration: 'never' }]) {
            assert.equal((await request(url, { method: 'POST', body: JSON.stringify(value) })).status, 400);
        }
        assert.equal((await request(url, { method: 'POST', body: '{' })).status, 400);
        assert.equal(sqlite.prepare('SELECT count(*) AS n FROM mcp_api_keys').get().n, 0);
    } finally { sqlite.close(); }
});

test('기존 단일 키의 인증·마스킹·발급일·만료일을 보존해 마이그레이션한다', async () => {
    const { sqlite, DB, request } = fixture('admin');
    try {
        const existing = await (await request(url, post('기존'))).json();
        const stored = sqlite.prepare('SELECT * FROM mcp_api_keys').get();
        sqlite.exec(`DROP TABLE mcp_api_keys; CREATE TABLE mcp_api_keys (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            key_hash TEXT NOT NULL UNIQUE, masked_key TEXT NOT NULL,
            created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL
        )`);
        sqlite.prepare('INSERT INTO mcp_api_keys (user_id, key_hash, masked_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
            .run(stored.user_id, stored.key_hash, stored.masked_key, stored.created_at, stored.expires_at);
        sqlite.exec(migration);
        const migrated = sqlite.prepare('SELECT * FROM mcp_api_keys').get();
        assert.equal(migrated.name, '기존 API 키');
        for (const field of ['user_id', 'key_hash', 'masked_key', 'created_at', 'expires_at']) assert.equal(migrated[field], stored[field]);
        assert.equal((await request('/probe', { headers: { Authorization: `Bearer ${existing.rawKey}` } })).status, 200);
        assert.equal((await authenticateShared(`Bearer ${existing.rawKey}`, DB, null)).kind, 'authenticated');
        assert.equal((await request(url, post('추가 키', 'never'))).status, 201);
        sqlite.prepare('DELETE FROM users WHERE id = ?').run(userA);
        assert.equal(sqlite.prepare('SELECT count(*) AS n FROM mcp_api_keys').get().n, 0);
    } finally { sqlite.close(); }
});

test('신규 설치 스키마에도 정식 마이그레이션을 적용할 수 있다', () => {
    const { sqlite } = fixture();
    try {
        sqlite.exec(migration);
        assert.equal(sqlite.prepare('PRAGMA table_info(mcp_api_keys)').all().find(c => c.name === 'expires_at').notnull, 0);
        assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { sqlite.close(); }
});
