import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { before, after } from 'node:test';
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
    async batch(statements) {
        this.db.exec('BEGIN');
        try {
            const results = statements.map(s => ({ results: this.db.prepare(s.sql).all(...s.values) }));
            this.db.exec('COMMIT');
            return results;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
}
let server, worker;
before(async () => {
    server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    worker = (await server.ssrLoadModule('/src/index.ts')).default;
});
after(async () => { await server?.close(); });

const userA = '123456789ABCDEFGHJKLMN';
const userB = '23456789ABCDEFGHJKLMNP';
const tokenA = 'mcp_personal_drafts_test_a';
const tokenB = 'mcp_personal_drafts_test_b';
const hash = value => createHash('sha256').update(value).digest('hex');
const overview = '/api/editor-drafts/overview';
const path = key => '/api/editor-drafts/' + encodeURIComponent(key);
const key = 'wiki_draft_API로 작성한 초안';
const payload = { content: '토큰으로 작성한 비공개 본문', version: null, base: null };
const put = (p = payload, revision = null) => ({ method: 'PUT', body: JSON.stringify({ payload: p, expectedRevision: revision }) });
const saveArgs = (title, revision = null) => ({ title, content: payload.content, base_version: null, base_content: null, expected_revision: revision });

function fixture(role = 'user') {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys=ON');
    sqlite.exec(readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8'));
    const expires = Math.floor(Date.now() / 1000) + 3600;
    for (const [id, r, token, cookie] of [[userA, role, tokenA, 'cookie-a'], [userB, 'user', tokenB, 'cookie-b']]) {
        sqlite.prepare("INSERT INTO users (id, provider, uid, name, role) VALUES (?, 'test', ?, ?, ?)").run(id, id, id, r);
        sqlite.prepare("INSERT INTO mcp_api_keys (id, user_id, name, key_hash, masked_key) VALUES (?, ?, '테스트', ?, 'mcp_…')").run(id, id, hash(token));
        sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(cookie, id, expires);
    }
    const cache = new Map();
    const env = { DB: new TestD1(sqlite), KV: { get: async k => cache.get(k) ?? null,
        put: async (k, v) => { cache.set(k, v); }, delete: async k => { cache.delete(k); } },
        MCP_MODE: 'open', WIKI_VISIBILITY: 'open', EDIT_REQUEST_ENABLED: 'true', SUPER_ADMIN_EMAILS: 'owner@example.com' };
    const pending = [];
    const ctx = { waitUntil: p => { pending.push(p); }, passThroughOnException() {} };
    const request = (url, init = {}, token = tokenA) => worker.fetch(new Request('https://wiki.test' + url, {
        ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...init.headers },
    }), env, ctx);
    const rpc = async (method, params, token = tokenA) => {
        const res = await request('/api/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, token);
        assert.equal(res.status, 200);
        return res.json();
    };
    const call = async (name, args, token = tokenA) => (await rpc('tools/call', { name, arguments: args }, token)).result;
    return { sqlite, request, rpc, call, env, close: async () => { await Promise.allSettled(pending); sqlite.close(); } };
}

test('토큰으로 저장한 초안은 같은 계정의 브라우저 목록·편집기와 공유하고 타인에게 숨긴다', async () => {
    const f = fixture();
    try {
        const created = await f.request(path(key), put());
        assert.equal(created.status, 200);
        assert.equal(created.headers.get('cache-control'), 'no-store');
        const draft = (await created.json()).draft;
        const browser = init => ({ ...init, headers: { Cookie: 'wiki_session=cookie-a', ...init?.headers } });
        const list = await (await f.request(overview, browser(), null)).json();
        assert.equal(list.limit, 4);
        assert.equal(list.drafts[0].key, key);
        assert.equal(JSON.stringify(list).includes(payload.content), false);
        assert.equal((await (await f.request(path(key), browser(), null)).json()).draft.payload.content, payload.content);
        const updated = await f.request(path(key), browser(put({ ...payload, content: '브라우저에서 이어 쓴 본문' }, draft.revision)), null);
        assert.equal(updated.status, 200);
        assert.equal((await (await f.request(path(key))).json()).draft.payload.content, '브라우저에서 이어 쓴 본문');
        assert.equal((await f.request(path(key), put(payload, draft.revision))).status, 409);
        assert.equal((await f.request(path(key), {}, tokenB)).status, 404);
        assert.equal((await f.request(path(key), { method: 'DELETE', body: JSON.stringify({ expectedRevision: draft.revision }) }, tokenB)).status, 204);
        assert.deepEqual((await (await f.request(overview, {}, tokenB)).json()).drafts, []);
        assert.equal((await f.request(path(key))).status, 200);
        const latest = (await updated.json()).draft;
        assert.equal((await f.request(path(key), { method: 'DELETE', body: JSON.stringify({ expectedRevision: latest.revision }) })).status, 204);
        assert.equal((await f.request(path(key), browser(), null)).status, 404);
    } finally { await f.close(); }
});

test('토큰을 명시하면 쿠키 대신 토큰 소유자를 사용하며 잘못된 토큰은 쿠키로 우회하지 않는다', async () => {
    const f = fixture();
    try {
        assert.equal((await f.request(path(key), { ...put(), headers: { Cookie: 'wiki_session=cookie-b' } })).status, 200);
        assert.equal((await f.request(path(key), {}, tokenB)).status, 404);
        for (const auth of ['', 'Basic example', 'Bearer invalid']) {
            const r = await f.request(overview, { headers: { Authorization: auth, Cookie: 'wiki_session=cookie-a' } }, null);
            assert.equal(r.status, 401);
        }
        assert.equal((await f.request(overview, {}, null)).status, 401);
        assert.equal((await f.request('/api/me/mcp-api-keys')).status, 401, '토큰 인증은 다른 계정 관리 API로 확장하지 않는다');
        const crossOrigin = await f.request(path(key), { ...put(), headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.test', Cookie: 'wiki_session=cookie-a' } }, null);
        assert.equal(crossOrigin.ok, false); // 기존 전역 오류 처리기가 CSRF 예외의 상태 코드를 변환하더라도 요청은 거부한다.
    } finally { await f.close(); }
});

test('만료·삭제된 API 키와 차단·탈퇴 계정은 개인 초안을 읽거나 변경할 수 없다', async () => {
    const f = fixture();
    try {
        await f.request(path(key), put());
        f.sqlite.prepare('UPDATE mcp_api_keys SET expires_at = 1 WHERE user_id = ?').run(userA);
        assert.equal((await f.request(overview)).status, 401);
        f.sqlite.prepare('UPDATE mcp_api_keys SET expires_at = NULL WHERE user_id = ?').run(userA);
        for (const role of ['banned', 'deleted']) {
            f.sqlite.prepare('UPDATE users SET role = ?, banned_until = ? WHERE id = ?').run(role, Math.floor(Date.now() / 1000) + 3600, userA);
            for (const init of [{}, put()]) assert.equal((await f.request(path(key), init)).status, 403);
            const tools = await f.rpc('tools/list');
            assert.equal(tools.result.tools.some(t => t.name.includes('personal_draft')), false);
            assert.ok((await f.rpc('tools/call', { name: 'read_personal_draft', arguments: { key } })).error);
        }
        f.sqlite.prepare("UPDATE users SET role = 'user', banned_until = NULL WHERE id = ?").run(userA);
        f.sqlite.prepare('DELETE FROM mcp_api_keys WHERE user_id = ?').run(userA);
        assert.equal((await f.request(overview)).status, 401);
        assert.equal((await f.request(path(key), put())).status, 401);
    } finally { await f.close(); }
});

test('MCP 개인 초안 도구는 미인증에 숨기고 일반 기여자에게 허용하되 직접 게시 권한은 넓히지 않는다', async () => {
    const f = fixture();
    try {
        const guest = await f.rpc('tools/list', undefined, null);
        assert.equal(guest.result.tools.some(t => t.name.includes('personal_draft')), false);
        assert.ok((await f.rpc('tools/call', { name: 'save_personal_draft', arguments: saveArgs('숨김') }, null)).error);
        const names = (await f.rpc('tools/list')).result.tools.map(t => t.name);
        for (const name of ['save_personal_draft', 'list_personal_drafts', 'read_personal_draft']) assert.ok(names.includes(name));
        for (const name of ['create_or_update_page', 'commit_edit', 'apply_edit']) assert.equal(names.includes(name), false);
        const result = await f.call('save_personal_draft', saveArgs('MCP 개인 초안'));
        assert.equal(result.isError, false);
        const draft = JSON.parse(result.content[0].text).draft;
        const browserList = await (await f.request(overview, { headers: { Cookie: 'wiki_session=cookie-a' } }, null)).json();
        assert.equal(browserList.drafts[0].key, draft.key);
        const read = await f.call('read_personal_draft', { key: draft.key });
        assert.equal(JSON.parse(read.content[0].text).draft.payload.content, payload.content);
        const listed = await f.call('list_personal_drafts', {});
        assert.equal(JSON.parse(listed.content[0].text).drafts.length, 1);
        assert.equal((await f.call('save_personal_draft', saveArgs('MCP 개인 초안'))).isError, true);
        assert.equal((await f.call('save_personal_draft', { ...saveArgs('MCP 개인 초안', draft.revision), content: 'API로 이어 쓴 본문' })).isError, false);
        assert.equal((await f.call('read_personal_draft', { key: draft.key }, tokenB)).isError, true);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM pages').get().n, 0);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_drafts').get().n, 0);
    } finally { await f.close(); }
});

for (const [role, count] of [['user', 4], ['discussion_manager', 4], ['admin', 5], ['super_admin', 5]]) {
    test(`${role}: REST·브라우저·MCP를 섞어 저장해도 동일한 개인 초안 한도를 적용한다`, async () => {
        const f = fixture(role);
        try {
            for (let i = 0; i < 4; i++) {
                const init = i % 2 ? { ...put(), headers: { Cookie: 'wiki_session=cookie-a' } } : put();
                assert.equal((await f.request(path('wiki_draft_문서' + i), init, i % 2 ? null : tokenA)).status, 200);
                f.sqlite.prepare('UPDATE editor_drafts SET updated_at = ? WHERE draft_key = ?').run(i + 1, 'wiki_draft_문서' + i);
            }
            const result = await f.call('save_personal_draft', { ...saveArgs('문서'), section_index: 0, section_heading: '개요' });
            assert.equal(result.isError, false);
            const saved = JSON.parse(result.content[0].text);
            assert.equal(saved.removedKeys.length, count === 4 ? 1 : 0);
            if (count === 4) assert.deepEqual(saved.removedKeys, ['wiki_draft_문서0']);
            const list = await (await f.request(overview)).json();
            assert.equal(list.drafts.length, count);
            assert.equal(list.drafts[0].sectionIndex, 0);
            assert.equal(list.drafts[0].slug, '문서');
            assert.equal(list.limit, count === 4 ? 4 : null);
        } finally { await f.close(); }
    });
}

test('OAuth 토큰도 공통 검증을 거쳐 초안을 공유하고 허용되지 않은 scope는 거부한다', async () => {
    const f = fixture();
    try {
        const raw = 'oauth-personal-test';
        f.sqlite.prepare("INSERT INTO oauth_tokens (client_id, user_id, access_token_hash, scope, access_expires_at) VALUES ('test-client', ?, ?, 'mcp', ?)")
            .run(userA, hash(raw), Math.floor(Date.now() / 1000) + 3600);
        assert.equal((await f.request(path(key), put(), raw)).status, 200);
        assert.equal((await f.request(path(key))).status, 200);
        f.sqlite.prepare("UPDATE oauth_tokens SET scope = 'unrelated'").run();
        assert.equal((await f.request(overview, {}, raw)).status, 401);
        f.sqlite.prepare("UPDATE oauth_tokens SET scope = 'mcp', revoked_at = 1").run();
        assert.equal((await f.request(overview, {}, raw)).status, 401);
    } finally { await f.close(); }
});

test('MCP 입력 검증 실패는 초안을 남기지 않는다', async () => {
    const f = fixture();
    try {
        for (const args of [saveArgs(''), saveArgs('잘못된#제목'), { ...saveArgs('문서'), section_index: -1 },
            { ...saveArgs('문서'), content: '' }, { title: '문서', content: '기준 버전 누락' },
            { ...saveArgs('문서'), content: '가'.repeat(510_000) }]) {
            assert.equal((await f.call('save_personal_draft', args)).isError, true);
        }
        assert.equal((await f.call('read_personal_draft', {})).isError, true);
        assert.deepEqual((await (await f.request(overview)).json()).drafts, []);
    } finally { await f.close(); }
});
