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
    async run() { const r = this.db.prepare(this.sql).run(...this.values); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
}
class TestD1 {
    constructor(db) { this.db = db; }
    prepare(sql) { return new Statement(this.db, sql); }
    async batch(statements) {
        this.db.exec('BEGIN');
        try {
            const results = statements.map(s => {
                const results = this.db.prepare(s.sql).all(...s.values);
                const { changes, last_row_id } = this.db.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get();
                return { results, meta: { changes: Number(changes), last_row_id: Number(last_row_id) } };
            });
            this.db.exec('COMMIT');
            return results;
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
}
let server, worker;
before(async () => {
    server = await createServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true }, appType: 'custom', logLevel: 'silent' });
    worker = (await server.ssrLoadModule('/src/index.ts')).default;
});
after(async () => { await server?.close(); });

const userA = '123456789ABCDEFGHJKLMN';
const userB = '23456789ABCDEFGHJKLMNP';
const tokenA = 'mcp_submissions_test_a';
const tokenB = 'mcp_submissions_test_b';
const hash = value => createHash('sha256').update(value).digest('hex');
const path = id => '/api/mcp-submissions/' + id;
const post = (body = {}) => ({ method: 'POST', body: JSON.stringify(body) });
const data = result => JSON.parse(result.content[0].text);
const toolNames = ['list_submissions', 'read_submission', 'approve_submission', 'reject_submission'];

function fixture(role = 'admin') {
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
    const objects = new Map();
    env.MEDIA = { put: async (k, v) => objects.set(k, v), delete: async k => objects.delete(k),
        get: async k => objects.has(k) ? { text: async () => objects.get(k) } : null };
    globalThis.caches = { default: { match: async () => undefined, put: async () => {}, delete: async () => true } };
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
    return { sqlite, request, rpc, call, env, objects, close: async () => { await Promise.allSettled(pending); sqlite.close(); } };
}

function submit(f, { user = userA, slug = '승인할 문서', action = 'create', submitted = true,
    content = '승인 후 공개될 본문', baseRevision = null, baseVersion = 0 } = {}) {
    const row = f.sqlite.prepare(`INSERT INTO mcp_drafts
        (user_id, slug, action, content, base_revision_id, base_version, submitted_at, submitted_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, '제출 시 요약')`)
        .run(user, slug, action, content, baseRevision, baseVersion, submitted ? Math.floor(Date.now() / 1000) : null);
    const id = Number(row.lastInsertRowid);
    f.sqlite.prepare("INSERT INTO notifications (user_id, type, ref_id, content, link) VALUES (?, 'mcp_submission', ?, '편집안', '/mypage')").run(user, id);
    return id;
}

test('즉시 적용 설정이 꺼져 있어도 승인 도구가 보이고, 미인증·게시 권한 없는 호출은 차단한다', async () => {
    const f = fixture();
    try {
        const names = (await f.rpc('tools/list')).result.tools.map(t => t.name);
        for (const name of toolNames) assert.ok(names.includes(name));
        assert.equal(names.includes('apply_edit'), false);
        for (const token of [null, tokenB]) {
            const hidden = (await f.rpc('tools/list', undefined, token)).result.tools.map(t => t.name);
            for (const name of toolNames) {
                assert.equal(hidden.includes(name), false);
                assert.ok((await f.rpc('tools/call', { name, arguments: { draft_id: 1 } }, token)).error);
            }
        }
        f.sqlite.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(userA);
        assert.equal((await f.request(path(submit(f)) + '/approve', post())).status, 403);
    } finally { await f.close(); }
});

test('API 키로 작성·제출해도 승인 전까지 비공개로 남고 명시적 승인 시에만 발행한다', async () => {
    const f = fixture();
    try {
        const created = await f.call('create_or_update_page', { title: 'API 작성부터 발행까지', content: '아직 승인 전인 본문' });
        assert.equal(created.isError, false, JSON.stringify(created));
        const id = data(created).draft_id;
        assert.equal((await f.call('approve_submission', { draft_id: id })).isError, true);
        const submitted = await f.call('commit_edit', { draft_id: id, summary: '제출 요약' });
        assert.equal(submitted.isError, false, JSON.stringify(submitted));
        assert.equal(data(submitted).submitted, true);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM pages').get().n, 0);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM revisions').get().n, 0);
        assert.equal(data(await f.call('read_submission', { draft_id: id })).proposed_content, '아직 승인 전인 본문');
        const approved = await f.call('approve_submission', { draft_id: id });
        assert.equal(approved.isError, false, JSON.stringify(approved));
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM pages').get().n, 1);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM revisions').get().n, 1);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_drafts').get().n, 0);
    } finally { await f.close(); }
});

test('MCP로 홈의 월령·주제 카테고리를 발행하고 변경할 수 있다', async () => {
    const f = fixture();
    try {
        const title = '홈에 연결할 문서';
        const categories = ['0~6개월', '7~12개월', '1~3세', '4~6세', '수유·이유식'];
        const created = await f.call('create_or_update_page', { title, content: '본문', category: categories.join(',') });
        assert.equal(created.isError, false, JSON.stringify(created));
        const id = data(created).draft_id;
        assert.equal((await f.call('commit_edit', { draft_id: id })).isError, false);
        assert.equal((await f.call('approve_submission', { draft_id: id })).isError, false);
        const page = f.sqlite.prepare('SELECT id, category FROM pages WHERE slug = ?').get(title);
        assert.equal(page.category, categories.join(','));
        const indexed = () => f.sqlite.prepare('SELECT category FROM page_categories WHERE page_id = ? ORDER BY category').all(page.id).map(row => row.category);
        assert.deepEqual(indexed(), [...categories].sort());

        assert.equal((await f.call('set_page_status', { title, category: '수유·이유식,0~6개월' })).isError, false);
        assert.deepEqual(indexed(), ['0~6개월', '수유·이유식']);
        for (const category of ['<script>', '수유|이유식', '수유/이유식']) {
            assert.equal((await f.call('create_or_update_page', { title, content: '본문', category })).isError, true);
            assert.equal((await f.call('set_page_status', { title, category })).isError, true);
        }
        assert.deepEqual(indexed(), ['0~6개월', '수유·이유식']);
    } finally { await f.close(); }
});

test('웹 카테고리 사전 검증과 카테고리 문서 자동 분류가 ~와 ·를 허용한다', async () => {
    const f = fixture();
    const web = (url, init) => f.request(url, { ...init, headers: { Cookie: 'wiki_session=cookie-a' } }, null);
    try {
        for (const category of ['0~6개월', '수유·이유식']) {
            const check = await web('/api/w/check-category', post({ category }));
            assert.equal((await check.json()).ok, true);
            const slug = '카테고리:' + category;
            const saved = await web('/api/w/' + encodeURIComponent(slug), { method: 'PUT', body: JSON.stringify({ content: '카테고리 안내' }) });
            assert.equal(saved.status, 201, await saved.text());
            const page = f.sqlite.prepare('SELECT id, category FROM pages WHERE slug = ?').get(slug);
            assert.equal(page.category, category);
            assert.equal(f.sqlite.prepare('SELECT category FROM page_categories WHERE page_id = ?').get(page.id).category, category);
        }
        for (const category of ['<script>', '수유|이유식', '수유/이유식', '수유,이유식']) {
            assert.equal((await (await web('/api/w/check-category', post({ category }))).json()).ok, false);
        }
        const invalid = await web('/api/w/' + encodeURIComponent('잘못된 카테고리'), { method: 'PUT', body: JSON.stringify({ content: '본문', category: '<script>' }) });
        assert.equal(invalid.status, 400);
    } finally { await f.close(); }
});

test('관리자의 카테고리 ACL과 자동 분류 규칙이 ~와 ·를 허용한다', async () => {
    const f = fixture();
    const web = (url, init) => f.request('/api/admin' + url, { ...init, headers: { Cookie: 'wiki_session=cookie-a' } }, null);
    try {
        for (const category of ['0~6개월', '수유·이유식']) {
            const saved = await web('/category-acl/' + encodeURIComponent(category), { method: 'PUT', body: JSON.stringify({ edit_acl: { flags: ['admin_only'] } }) });
            assert.equal(saved.status, 200, await saved.text());
            assert.ok(f.sqlite.prepare('SELECT name FROM category_acl WHERE name = ?').get(category));
        }
        const saved = await web('/category-prefix-rules', post({ prefix: '육아', categories: '0~6개월,수유·이유식' }));
        assert.equal(saved.status, 200, await saved.text());
        assert.equal(f.sqlite.prepare('SELECT categories FROM category_prefix_rules WHERE prefix = ?').get('육아').categories, '0~6개월,수유·이유식');
        const invalid = await web('/category-prefix-rules', post({ prefix: '육아', categories: '<script>' }));
        assert.equal(invalid.status, 400);
    } finally { await f.close(); }
});

test('API 키로 목록·상세를 읽고 본인 제출안만 실제 문서로 발행한다', async () => {
    const f = fixture();
    try {
        const id = submit(f);
        const other = submit(f, { user: userB, slug: '타인 제출안' });
        const writing = submit(f, { slug: '작성 중', submitted: false });
        const list = await f.request('/api/mcp-submissions');
        assert.equal(list.status, 200);
        assert.equal(list.headers.get('cache-control'), 'no-store');
        assert.deepEqual((await list.json()).submissions.map(s => s.id), [id]);
        assert.deepEqual(data(await f.call('list_submissions', {})).submissions.map(s => s.id), [id]);
        const read = data(await f.call('read_submission', { draft_id: id }));
        assert.equal(read.proposed_content, '승인 후 공개될 본문');
        assert.equal(read.status, 'pending_approval');
        assert.equal((await f.request('/api/mcp-submissions/count')).status, 200);
        for (const hidden of [other, writing]) {
            for (const suffix of ['', '/approve', '/reject']) {
                assert.equal((await f.request(path(hidden) + suffix, suffix ? post() : {})).status, 404);
            }
            assert.equal((await f.call('read_submission', { draft_id: hidden })).isError, true);
            assert.equal((await f.call('approve_submission', { draft_id: hidden })).isError, true);
        }
        const res = await f.request(path(id) + '/approve', post());
        const approved = await res.json();
        assert.equal(res.status, 200, JSON.stringify(approved));
        assert.equal(approved.approved, true);
        const page = f.sqlite.prepare('SELECT * FROM pages WHERE slug = ?').get('승인할 문서');
        assert.equal(page.content, read.proposed_content);
        const revision = f.sqlite.prepare('SELECT * FROM revisions WHERE id = ?').get(approved.revision_id);
        assert.equal(revision.author_id, userA);
        assert.equal(revision.human_authored, 0);
        assert.match(revision.summary, /제출 시 요약/);
        assert.equal(f.objects.get(revision.r2_key), read.proposed_content);
        assert.equal(f.sqlite.prepare('SELECT id FROM mcp_drafts WHERE id = ?').get(id), undefined);
        assert.equal(f.sqlite.prepare('SELECT id FROM notifications WHERE ref_id = ?').get(id), undefined);
        assert.equal((await f.request(path(id) + '/approve', post())).status, 404);
        assert.ok(f.sqlite.prepare('SELECT id FROM mcp_drafts WHERE id = ?').get(other));
    } finally { await f.close(); }
});

test('MCP 승인으로 신규 문서와 기존 문서를 저장하며 요약 생략·빈 문자열을 구분한다', async () => {
    const f = fixture();
    try {
        const id = submit(f);
        const created = await f.call('approve_submission', { draft_id: id, summary: '직접 지정한 요약' });
        assert.equal(created.isError, false, JSON.stringify(created));
        const first = data(created);
        const page = f.sqlite.prepare('SELECT * FROM pages WHERE slug = ?').get(first.slug);
        const updateId = submit(f, { action: 'update', slug: first.slug, content: '두 번째 본문',
            baseRevision: first.revision_id, baseVersion: page.version });
        const updated = await f.call('approve_submission', { draft_id: updateId, summary: '' });
        assert.equal(updated.isError, false, JSON.stringify(updated));
        assert.equal(data(updated).version, 2);
        const revisions = f.sqlite.prepare('SELECT summary FROM revisions ORDER BY id').all();
        assert.match(revisions[0].summary, /직접 지정한 요약/);
        assert.equal(revisions[1].summary.includes('제출 시 요약'), false);
        assert.equal(f.sqlite.prepare('SELECT content FROM pages WHERE id = ?').get(page.id).content, '두 번째 본문');
    } finally { await f.close(); }
});

test('문서 충돌과 ACL 거부는 REST·MCP에서 유지되며 제출안이 보존된다', async () => {
    const f = fixture('user');
    f.env.EDIT_REQUEST_ENABLED = 'false';
    try {
        f.sqlite.prepare("INSERT INTO pages (slug, content, version, last_revision_id) VALUES ('기존 문서', '현재 본문', 2, 100)").run();
        const id = submit(f, { action: 'update', slug: '기존 문서', baseRevision: 99, baseVersion: 1 });
        const conflict = await f.request(path(id) + '/approve', post());
        assert.equal(conflict.status, 409);
        assert.equal((await conflict.json()).reason, 'concurrent_modification');
        assert.equal(data(await f.call('read_submission', { draft_id: id })).has_conflict, true);
        assert.equal((await f.call('approve_submission', { draft_id: id })).isError, true);
        f.sqlite.prepare('UPDATE mcp_drafts SET base_revision_id = 100, base_version = 2 WHERE id = ?').run(id);
        f.sqlite.prepare('UPDATE pages SET edit_acl = ?').run(JSON.stringify({ flags: ['admin_only'] }));
        const denied = await f.request(path(id) + '/approve', post());
        assert.equal(denied.status, 403);
        assert.equal((await f.call('approve_submission', { draft_id: id })).isError, true);
        assert.ok(f.sqlite.prepare('SELECT id FROM mcp_drafts WHERE id = ?').get(id));
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM revisions').get().n, 0);
    } finally { await f.close(); }
});

test('토큰 소유자가 쿠키보다 우선하며 잘못된·만료된·폐기된 키는 쿠키로 우회하지 않는다', async () => {
    const f = fixture();
    try {
        const id = submit(f);
        const cookie = { Cookie: 'wiki_session=cookie-b' };
        assert.equal((await f.request(path(id), { headers: cookie })).status, 200);
        assert.equal((await f.request(path(id), { headers: cookie }, null)).status, 404);
        assert.equal((await f.request(path(id), {}, null)).status, 401);
        for (const Authorization of ['', 'Basic example', 'Bearer invalid']) {
            assert.equal((await f.request(path(id) + '/approve', { ...post(), headers: {
                Authorization, Cookie: 'wiki_session=cookie-a',
            } }, null)).status, 401);
        }
        f.sqlite.prepare('UPDATE mcp_api_keys SET expires_at = 1 WHERE user_id = ?').run(userA);
        assert.equal((await f.request(path(id))).status, 401);
        f.sqlite.prepare('DELETE FROM mcp_api_keys WHERE user_id = ?').run(userA);
        assert.equal((await f.request(path(id) + '/reject', post())).status, 401);
        assert.ok(f.sqlite.prepare('SELECT id FROM mcp_drafts WHERE id = ?').get(id));
        assert.equal((await f.request('/api/me/mcp-api-keys', {}, tokenB)).status, 401);
    } finally { await f.close(); }
});

test('OAuth도 승인·거절을 지원하고 잘못된 scope·폐기·차단·탈퇴 계정은 거부한다', async () => {
    const f = fixture();
    try {
        const raw = 'oauth-submissions-test';
        f.sqlite.prepare("INSERT INTO oauth_tokens (client_id, user_id, access_token_hash, scope, access_expires_at) VALUES ('test-client', ?, ?, 'mcp', ?)")
            .run(userA, hash(raw), Math.floor(Date.now() / 1000) + 3600);
        const id = submit(f);
        assert.equal((await f.request(path(id), {}, raw)).status, 200);
        assert.equal((await f.call('approve_submission', { draft_id: id }, raw)).isError, false);
        const rejectId = submit(f, { slug: '거절할 OAuth 제출안' });
        for (const role of ['banned', 'deleted']) {
            f.sqlite.prepare('UPDATE users SET role = ?, banned_until = ? WHERE id = ?')
                .run(role, Math.floor(Date.now() / 1000) + 3600, userA);
            for (const suffix of ['', '/approve', '/reject']) {
                assert.equal((await f.request(path(rejectId) + suffix, suffix ? post() : {}, raw)).status, 403);
            }
            assert.ok((await f.rpc('tools/call', { name: 'approve_submission', arguments: { draft_id: rejectId } }, raw)).error);
        }
        f.sqlite.prepare("UPDATE users SET role = 'admin', banned_until = NULL WHERE id = ?").run(userA);
        f.sqlite.prepare("UPDATE oauth_tokens SET scope = 'unrelated'").run();
        assert.equal((await f.request(path(rejectId), {}, raw)).status, 401);
        f.sqlite.prepare("UPDATE oauth_tokens SET scope = 'mcp', revoked_at = 1").run();
        assert.equal((await f.request(path(rejectId) + '/reject', post(), raw)).status, 401);
        f.sqlite.prepare('UPDATE oauth_tokens SET revoked_at = NULL').run();
        assert.equal((await f.request(path(rejectId) + '/reject', post(), raw)).status, 200);
    } finally { await f.close(); }
});

test('MCP·REST 거절은 본인 제출안과 알림만 삭제하고 작성 중 초안은 discard_edit로 삭제한다', async () => {
    const f = fixture();
    try {
        for (const useMcp of [true, false]) {
            const id = submit(f);
            const result = useMcp ? await f.call('reject_submission', { draft_id: id })
                : await f.request(path(id) + '/reject', post());
            if (useMcp) assert.equal(result.isError, false);
            else assert.equal(result.status, 200);
            assert.equal(f.sqlite.prepare('SELECT id FROM mcp_drafts WHERE id = ?').get(id), undefined);
            assert.equal(f.sqlite.prepare('SELECT id FROM notifications WHERE ref_id = ?').get(id), undefined);
        }
        const writing = submit(f, { submitted: false });
        assert.equal((await f.call('reject_submission', { draft_id: writing })).isError, true);
        assert.equal((await f.call('discard_edit', { draft_id: writing })).isError, false);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM pages').get().n, 0);
    } finally { await f.close(); }
});

test('쿠키 승인·거절은 유지하며 다른 출처의 쿠키 요청과 잘못된 MCP 입력은 거부한다', async () => {
    const f = fixture();
    try {
        const id = submit(f);
        const cookie = { Cookie: 'wiki_session=cookie-a' };
        assert.equal((await f.request(path(id), { headers: cookie }, null)).status, 200);
        const crossOrigin = await f.request(path(id) + '/approve', { ...post(), headers: {
            ...cookie, 'Content-Type': 'text/plain', Origin: 'https://evil.test',
        } }, null);
        assert.equal(crossOrigin.ok, false);
        for (const draft_id of [undefined, null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
            for (const name of toolNames.slice(1)) {
                assert.equal((await f.call(name, { draft_id })).isError, true);
            }
        }
        for (const summary of [null, 123, 'a'.repeat(256)]) {
            assert.equal((await f.call('approve_submission', { draft_id: id, summary })).isError, true);
        }
        assert.equal((await f.request(path(id) + '/approve', { ...post(), headers: cookie }, null)).status, 200);
        const rejectId = submit(f);
        assert.equal((await f.request(path(rejectId) + '/reject', { ...post(), headers: cookie }, null)).status, 200);
    } finally { await f.close(); }
});

test('API 키로 작성 중·제출안 목록을 구분해 페이지로 조회하고 웹에서도 제출·삭제한다', async () => {
    const f = fixture();
    try {
        const writing = submit(f, { slug: '작성 중 초안', submitted: false });
        const second = submit(f, { slug: '다음 작성 중 초안', submitted: false });
        const submitted = submit(f, { slug: '이미 제출한 초안' });
        const other = submit(f, { slug: '타인 초안', user: userB, submitted: false });
        const firstPage = await (await f.request('/api/mcp-drafts?status=draft&limit=1')).json();
        assert.deepEqual(firstPage.drafts.map(d => d.draft_id), [second]);
        assert.equal(firstPage.nextOffset, 1);
        const nextPage = await (await f.request('/api/mcp-drafts?status=draft&limit=1&offset=1')).json();
        assert.deepEqual(nextPage.drafts.map(d => d.draft_id), [writing]);
        const pending = await (await f.request('/api/mcp-drafts?status=pending_approval')).json();
        assert.deepEqual(pending.drafts.map(d => d.draft_id), [submitted]);
        const list = data(await f.call('list_drafts', { status: 'draft', limit: 1, offset: 1 }));
        assert.equal(list[0].draft_id, writing);
        const detail = await f.request('/api/mcp-drafts/' + writing);
        assert.equal((await detail.json()).content, '승인 후 공개될 본문');
        for (const [suffix, init] of [['', {}], ['/submit', post()], ['', { method: 'DELETE' }]]) {
            assert.equal((await f.request('/api/mcp-drafts/' + other + suffix, init)).status, 404);
        }
        assert.equal((await f.request('/api/mcp-drafts/' + writing + '/submit', post({ summary: '웹 제출 요약' }))).status, 200);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM pages').get().n, 0);
        assert.ok(f.sqlite.prepare('SELECT submitted_at FROM mcp_drafts WHERE id = ?').get(writing).submitted_at);
        assert.equal((await f.request('/api/mcp-drafts/' + writing + '/submit', post())).status, 409);
        assert.equal((await f.request('/api/mcp-drafts/' + second, { method: 'DELETE' })).status, 200);
        assert.equal(f.sqlite.prepare('SELECT id FROM mcp_drafts WHERE id = ?').get(second), undefined);
        assert.ok(f.sqlite.prepare('SELECT id FROM mcp_drafts WHERE id = ?').get(other));
        for (const query of ['status=bad', 'limit=0', 'limit=101', 'offset=-1', 'offset=1.5']) {
            assert.equal((await f.request('/api/mcp-drafts?' + query)).status, 400);
        }
    } finally { await f.close(); }
});

test('제출안 목록 페이지를 순회해도 누락·중복 없이 본인 제출안만 반환한다', async () => {
    const f = fixture();
    try {
        const ids = [0, 1, 2].map(n => submit(f, { slug: '제출안 ' + n }));
        submit(f, { user: userB });
        const first = await (await f.request('/api/mcp-submissions?limit=2')).json();
        const second = await (await f.request('/api/mcp-submissions?limit=2&offset=' + first.nextOffset)).json();
        assert.deepEqual([...first.submissions, ...second.submissions].map(s => s.id), ids.reverse());
        assert.equal(second.nextOffset, null);
        assert.equal(data(await f.call('list_submissions', { limit: 1, offset: 1 })).submissions.length, 1);
        assert.equal((await f.call('list_submissions', { limit: 101 })).isError, true);
        assert.equal((await f.request('/api/mcp-submissions?offset=-1')).status, 400);
    } finally { await f.close(); }
});

test('발행 목록은 내 발행 이력이 있는 현재 문서만 중복 없이 보여주고 삭제 권한을 유지한다', async () => {
    const f = fixture();
    try {
        for (const slug of ['내 문서 A', '내 문서 B']) {
            const id = submit(f, { slug });
            assert.equal((await f.call('approve_submission', { draft_id: id })).isError, false);
        }
        const page = f.sqlite.prepare("SELECT * FROM pages WHERE slug = '내 문서 A'").get();
        const newer = f.sqlite.prepare("INSERT INTO revisions (page_id, page_version, content, author_id) VALUES (?, 2, '타인의 후속 편집', ?)").run(page.id, userB);
        f.sqlite.prepare('UPDATE pages SET last_revision_id = ?, version = 2 WHERE id = ?').run(Number(newer.lastInsertRowid), page.id);
        f.sqlite.prepare("INSERT INTO pages (slug, content) VALUES ('타인 문서', '타인 본문')").run();
        const otherPage = f.sqlite.prepare("SELECT id FROM pages WHERE slug = '타인 문서'").get().id;
        const otherRevision = f.sqlite.prepare("INSERT INTO revisions (page_id, page_version, author_id) VALUES (?, 1, ?)").run(otherPage, userB);
        f.sqlite.prepare('UPDATE pages SET last_revision_id = ? WHERE id = ?').run(Number(otherRevision.lastInsertRowid), otherPage);
        const list = await f.request('/api/published-pages?limit=1');
        assert.equal(list.headers.get('cache-control'), 'no-store');
        const first = await list.json();
        assert.equal(first.pages.length, 1);
        assert.equal(first.canDelete, true);
        const second = await (await f.request('/api/published-pages?limit=1&offset=' + first.nextOffset)).json();
        const pages = [...first.pages, ...second.pages];
        assert.deepEqual(pages.map(p => p.slug).sort(), ['내 문서 A', '내 문서 B']);
        assert.notEqual(pages.find(p => p.slug === '내 문서 A').my_revision_id, Number(newer.lastInsertRowid));
        assert.equal(second.nextOffset, null);
        const listed = data(await f.call('list_published_pages', {}));
        assert.equal(listed.pages.length, 2);
        for (const args of [{ limit: true }, { offset: null }, { limit: 101 }, { offset: -1 }]) {
            assert.equal((await f.call('list_published_pages', args)).isError, true);
        }
        assert.equal((await f.request('/api/published-pages/' + encodeURIComponent('타인 문서'), { method: 'DELETE' })).status, 404);
        for (const role of ['user', 'discussion_manager']) {
            f.sqlite.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userA);
            assert.equal((await (await f.request('/api/published-pages')).json()).canDelete, false);
            assert.equal((await f.request('/api/published-pages/' + encodeURIComponent('내 문서 A'), { method: 'DELETE' })).status, 403);
            assert.ok((await f.rpc('tools/call', { name: 'delete_page', arguments: { title: '내 문서 A' } })).error);
        }
        f.sqlite.prepare('UPDATE pages SET is_private = 1 WHERE id = ?').run(page.id);
        assert.deepEqual(data(await f.call('list_published_pages', {})).pages.map(p => p.slug), ['내 문서 B']);
        f.sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(userA);
        assert.equal((await f.request('/api/published-pages/' + encodeURIComponent('내 문서 A'), { method: 'DELETE' })).status, 200);
        assert.ok(f.sqlite.prepare('SELECT deleted_at FROM pages WHERE id = ?').get(page.id).deleted_at);
        assert.deepEqual(data(await f.call('list_published_pages', {})).pages.map(p => p.slug), ['내 문서 B']);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM revisions WHERE page_id = ?').get(page.id).n, 2);
        f.sqlite.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").run(userA);
        assert.equal((await f.request('/api/published-pages/' + encodeURIComponent('내 문서 B'), { method: 'DELETE' })).status, 200);
    } finally { await f.close(); }
});

test('워크플로 API도 무인증·무효 키·차단을 거부하고 일반 기여자의 직접 게시를 넓히지 않는다', async () => {
    const f = fixture('user');
    try {
        const id = submit(f, { submitted: false });
        for (const token of [null, 'invalid-token']) {
            for (const url of ['/api/mcp-drafts', '/api/published-pages']) assert.equal((await f.request(url, {}, token)).status, 401);
        }
        assert.equal((await f.request('/api/mcp-drafts/' + id + '/submit', post())).status, 403);
        for (const role of ['banned', 'deleted']) {
            f.sqlite.prepare('UPDATE users SET role = ?, banned_until = ? WHERE id = ?').run(role, Math.floor(Date.now() / 1000) + 3600, userA);
            for (const url of ['/api/mcp-drafts', '/api/published-pages']) assert.equal((await f.request(url)).status, 403);
        }
    } finally { await f.close(); }
});
