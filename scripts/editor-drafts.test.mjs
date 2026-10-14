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
let server, routes;
before(async () => {
    server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    routes = (await server.ssrLoadModule('/src/routes/editor-drafts.ts')).default;
});
after(async () => { await server?.close(); });

function fixture() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys=ON');
    sqlite.exec(readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8'));
    for (const id of ['123456789ABCDEFGHJKLMN', '23456789ABCDEFGHJKLMNP']) sqlite.prepare("INSERT INTO users (id, provider, uid, name, role) VALUES (?, 'test', ?, ?, 'user')").run(id, id, id);
    const app = new Hono();
    app.use('*', async (c, next) => {
        const id = c.req.header('x-user');
        if (id) c.set('user', { id: id === 'a' ? '123456789ABCDEFGHJKLMN' : '23456789ABCDEFGHJKLMNP', role: c.req.header('x-role') ?? 'user' });
        c.set('rbac', { can: () => c.req.header('x-edit') !== 'no' });
        await next();
    });
    app.route('/api', routes);
    app.get('/api/public-probe', c => c.json({ ok: true }));
    const DB = new TestD1(sqlite);
    return { sqlite, app, request: (path, init = {}, user = 'a') => app.request(path, {
        ...init, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}), ...init.headers },
    }, { DB }) };
}
const key = 'wiki_draft_문서/하위#section=0';
const url = '/api/editor-drafts/' + encodeURIComponent(key);
const payload = { content: '초안 본문', version: 3, base: '기준본', savedAt: 1, sectionIndex: 0, sectionHeading: '제목' };
const put = (payload, expectedRevision = null) => ({ method: 'PUT', body: JSON.stringify({ payload, expectedRevision }) });
const del = expectedRevision => ({ method: 'DELETE', body: JSON.stringify({ expectedRevision }) });

test('인증과 편집 권한을 적용하고 이후 공개 라우트는 보호하지 않는다', async () => {
    const { request, sqlite } = fixture();
    for (const [path, init] of [['/api/editor-drafts', {}], [url, {}], [url, put(payload)], [url, del(crypto.randomUUID())]]) {
        const response = await request(path, init, null);
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await request(url, { ...put(payload), headers: { 'x-role': 'banned' } })).status, 403);
    assert.equal((await request(url, { ...put(payload), headers: { 'x-edit': 'no' } })).status, 403);
    assert.equal((await request('/api/public-probe', {}, null)).status, 200);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM editor_drafts').get().n, 0);
    sqlite.close();
});

test('본인만 읽고 수정하며 동일 문서의 다른 사용자 초안을 분리한다', async () => {
    const { request, sqlite } = fixture();
    const first = await request(url, put({ ...payload, user_id: 'b' }));
    assert.equal(first.status, 200);
    const a = (await first.json()).draft;
    assert.ok(a.payload.savedAt > payload.savedAt);
    assert.equal((await request(url, {}, 'b')).status, 404);
    assert.deepEqual((await (await request('/api/editor-drafts', {}, 'b')).json()).drafts, []);
    assert.equal((await request(url, put({ ...payload, content: 'B의 초안' }), 'b')).status, 200);
    assert.equal((await (await request(url)).json()).draft.payload.content, '초안 본문');
    assert.equal((await request(url, del(a.revision), 'b')).status, 409);
    const listed = await request('/api/editor-drafts?prefix=' + encodeURIComponent('wiki_draft_문서/하위#section='));
    assert.deepEqual((await listed.json()).drafts, [{ key, revision: a.revision }]);
    sqlite.close();
});

test('동시 저장과 오래된 삭제를 거부하고 삭제 후 재생성도 보호한다', async () => {
    const { request, sqlite } = fixture();
    const a = (await (await request(url, put(payload))).json()).draft;
    assert.equal((await request(url, put(payload))).status, 409);
    const updates = await Promise.all([request(url, put({ ...payload, content: '기기1' }, a.revision)), request(url, put({ ...payload, content: '기기2' }, a.revision))]);
    assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
    const newer = (await (await request(url)).json()).draft;
    assert.notEqual(newer.revision, a.revision);
    assert.equal((await request(url, del(a.revision))).status, 409);
    assert.equal((await request(url, del(newer.revision))).status, 204);
    assert.equal((await request(url, del(newer.revision))).status, 204);
    const recreated = (await (await request(url, put(payload))).json()).draft;
    assert.notEqual(recreated.revision, newer.revision);
    assert.equal((await request(url, put(payload, newer.revision))).status, 409);
    assert.equal((await request(url, del(newer.revision))).status, 409);
    sqlite.close();
});

test('손상되거나 너무 큰 초안을 거부하고 기존 설치에도 테이블을 생성한다', async () => {
    const { request, sqlite } = fixture();
    sqlite.exec('DROP TABLE editor_drafts');
    assert.equal((await request(url)).status, 404); // 런타임 마이그레이션
    for (const value of [null, {}, { ...payload, content: '' }, { ...payload, version: {} }, { ...payload, sectionIndex: -1 }]) {
        assert.equal((await request(url, put(value))).status, 400);
    }
    assert.equal((await request(url, { method: 'PUT', body: '{' })).status, 400);
    assert.equal((await request(url, put({ ...payload, content: '가'.repeat(510_000) }))).status, 413);
    assert.equal((await request('/api/editor-drafts/not-a-draft', put(payload))).status, 400);
    assert.equal((await request(url, { method: 'DELETE', body: '{}' })).status, 400);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM editor_drafts').get().n, 0);
    sqlite.close();
});

test('D1 정식 마이그레이션은 기존 데이터베이스와 초기 스키마에 반복 적용할 수 있다', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    const migration = readFileSync(new URL('../d1-migrations/0002_editor_drafts.sql', import.meta.url), 'utf8');
    db.exec(migration); db.exec(migration);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='editor_drafts'").get().name, 'editor_drafts');
    db.close();
});

test('클라이언트는 저장 실패와 제출 중 변경된 초안을 보존하고 복원한 초안만 정리한다', async () => {
    const { request, sqlite } = fixture();
    const originalFetch = globalThis.fetch;
    const messages = [];
    globalThis.window = { Swal: { fire: async options => { messages.push(options); return {}; } } };
    globalThis.fetch = (path, init) => request(path, init);
    try {
        const repo = await server.ssrLoadModule('/src/client/edit/drafts.ts');
        const k = 'wiki_draft_제출';
        assert.equal(await repo.readDraft(k), null);
        await repo.writeDraft(k, payload); repo.consumeDraft(k);
        const cleanup = repo.captureDraftCleanup();
        await repo.writeDraft(k, { ...payload, content: '제출 중 추가 변경' });
        await cleanup();
        assert.equal((await repo.readDraft(k)).content, '제출 중 추가 변경');
        assert.equal(messages.at(-1).icon, 'warning');
        const untouched = 'wiki_draft_나중에';
        await repo.writeDraft(untouched, payload); await repo.readDraft(untouched);
        await repo.captureDraftCleanup()();
        assert.equal(await repo.readDraft(k), null);
        assert.equal((await repo.readDraft(untouched)).content, payload.content);
        const revision = sqlite.prepare('SELECT revision FROM editor_drafts WHERE draft_key=?').get(untouched).revision;
        globalThis.fetch = async () => { throw new Error('네트워크 중단'); };
        await assert.rejects(repo.writeDraft(untouched, { ...payload, content: '실패한 저장' }), /네트워크/);
        assert.equal(sqlite.prepare('SELECT revision FROM editor_drafts WHERE draft_key=?').get(untouched).revision, revision);
    } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('브라우저 초안은 동의 후 저장 성공 시에만 옮기고 복원 취소는 DB 초안을 지우지 않는다', async () => {
    const { request, sqlite } = fixture();
    const originalFetch = globalThis.fetch;
    const local = new Map();
    const k = 'wiki_draft_이전';
    const legacy = { ...payload, sectionIndex: undefined, sectionHeading: undefined };
    local.set(k, JSON.stringify(legacy));
    const choices = [];
    let content = '기준본';
    const messages = [];
    globalThis.document = { getElementById: () => null };
    globalThis.localStorage = { getItem: k => local.get(k) ?? null, removeItem: k => local.delete(k), key: i => [...local.keys()][i], get length() { return local.size; } };
    globalThis.window = { DRAFT_KEY: k, slug: '이전', pageVersion: 3, originalContent: '기준본',
        editor: { on() {}, getMarkdown: () => content, setMarkdown: v => { content = v; } },
        Swal: { fire: async options => { messages.push(options); return choices.shift() ?? {}; } } };
    globalThis.fetch = (path, init) => request(path, init);
    try {
        await server.ssrLoadModule('/src/client/edit/utils.ts');
        await window.checkDraft(); // 가져오기 닫기
        assert.equal(local.has(k), true);
        assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM editor_drafts').get().n, 0);
        choices.push({ isConfirmed: true });
        globalThis.fetch = (path, init) => init?.method === 'PUT' ? Promise.resolve(Response.json({ error: '저장 실패' }, { status: 500 })) : request(path, init);
        await window.checkDraft();
        assert.equal(local.has(k), true);
        assert.equal(content, '기준본');
        globalThis.fetch = (path, init) => request(path, init);
        choices.push({ isConfirmed: true }, { isConfirmed: true });
        await window.checkDraft();
        assert.equal(local.has(k), false);
        assert.equal(content, legacy.content);
        await window.checkDraft(); // 불러오기 닫기
        assert.equal((await (await request('/api/editor-drafts/' + encodeURIComponent(k))).json()).draft.payload.content, legacy.content);
        choices.push({ isDenied: true });
        await window.checkDraft();
        assert.equal((await request('/api/editor-drafts/' + encodeURIComponent(k))).status, 404);
        assert.equal(messages.some(m => m.title === '초안 처리 실패'), true);
    } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('섹션 초안 복원은 나머지 본문과 DB 사본을 보존하고 변경된 기준본은 충돌 해결로 넘긴다', async () => {
    const { request, sqlite } = fixture();
    const originalFetch = globalThis.fetch;
    const slug = '섹션테스트';
    const k = 'wiki_draft_' + slug + '#section=0';
    const base = '# 첫째\n기준\n# 둘째\n보존';
    let content = base;
    const conflicts = [];
    const ranges = [{ lineIdx: 0, endLine: 2, level: 1, headingText: '첫째', transcluded: false }];
    globalThis.document = { getElementById: () => null };
    globalThis.localStorage = { getItem: () => null, length: 0 };
    Object.assign(window, { DRAFT_KEY: 'wiki_draft_' + slug, slug, pageVersion: 4, originalContent: base,
        sectionMode: false, isExtensionData: false, editor: { on() {}, getMarkdown: () => content, setMarkdown: v => { content = v; } },
        _extractMarkdownSectionRanges: () => ranges, showConflictModal: info => conflicts.push(info),
        Swal: { fire: async () => ({ isConfirmed: true }) } });
    globalThis.fetch = (path, init) => request(path, init);
    try {
        const repo = await server.ssrLoadModule('/src/client/edit/drafts.ts');
        await repo.writeDraft(k, { ...payload, content: '# 첫째\n수정', base: '# 첫째\n기준', sectionHeading: '첫째' });
        await window.checkSectionDrafts();
        assert.equal(content, '# 첫째\n수정\n# 둘째\n보존');
        assert.equal(conflicts.length, 0);
        assert.equal((await repo.readDraft(k)).content, '# 첫째\n수정');
        await window.checkSectionDrafts(); // 아직 제출하지 않은 전체 본문과 같아도 사본은 남긴다.
        assert.equal((await repo.readDraft(k)).content, '# 첫째\n수정');
        content = '# 첫째\n다른 편집자 수정\n# 둘째\n보존';
        await window.checkSectionDrafts();
        assert.equal(conflicts.length, 1);
        assert.equal(conflicts[0].content, '# 첫째\n다른 편집자 수정\n# 둘째\n보존');
        assert.equal(window.originalContent, base);
        await repo.captureDraftCleanup()();
        assert.equal(await repo.readDraft(k), null);
    } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});


test('섹션 페이지의 문서 버전 충돌을 전체 문서로 승격하고 제출 전까지 섹션 사본을 남긴다', async () => {
    const { request, sqlite } = fixture();
    const originalFetch = globalThis.fetch;
    const slug = '섹션승격';
    const k = 'wiki_draft_' + slug + '#section=0';
    const full = '# 첫째\n서버 최신\n# 둘째\n보존';
    let content = '# 첫째\n서버 최신';
    const conflicts = [];
    const range = { lineIdx: 0, endLine: 2, level: 1, headingText: '첫째', transcluded: false };
    Object.assign(window, { DRAFT_KEY: k, slug, pageVersion: 8, originalContent: content, fullOriginalContent: full,
        sectionMode: true, sectionIndex: 0, sectionRange: range, editor: { on() {}, getMarkdown: () => content, setMarkdown: v => { content = v; } },
        showConflictModal: info => conflicts.push(info), Swal: { fire: async () => ({ isConfirmed: true }) } });
    globalThis.fetch = (path, init) => request(path, init);
    try {
        const repo = await server.ssrLoadModule('/src/client/edit/drafts.ts');
        await repo.writeDraft(k, { ...payload, content: '# 첫째\n나의 수정', base: '# 첫째\n이전 본문', version: 7, sectionHeading: '첫째' });
        await window.checkDraft();
        assert.equal(window.sectionMode, false);
        assert.equal(window.DRAFT_KEY, 'wiki_draft_' + slug);
        assert.equal(content, '# 첫째\n나의 수정\n# 둘째\n보존');
        assert.equal(window.originalContent, '# 첫째\n이전 본문\n# 둘째\n보존');
        assert.deepEqual(conflicts, [{ current_version: 8, content: full }]);
        assert.equal((await repo.readDraft(k)).version, 7);
        await repo.captureDraftCleanup()();
        assert.equal(await repo.readDraft(k), null);
    } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('저장 응답만 유실되면 DB 사본으로 성공을 확인하고 후속 저장도 허용한다', async () => {
    const { request, sqlite } = fixture();
    const originalFetch = globalThis.fetch;
    const k = 'wiki_draft_응답유실';
    try {
        const repo = await server.ssrLoadModule('/src/client/edit/drafts.ts');
        globalThis.fetch = async (path, init) => {
            const response = await request(path, init);
            if (init?.method === 'PUT') throw new TypeError('저장 응답 유실');
            return response;
        };
        assert.equal((await repo.writeDraft(k, payload)).content, payload.content);
        globalThis.fetch = (path, init) => request(path, init);
        const next = { ...payload, content: '확인 후 추가 편집' };
        assert.equal((await repo.writeDraft(k, next)).content, next.content);
        assert.equal((await repo.readDraft(k)).content, next.content);
    } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('저장과 확인 응답이 모두 끊겨도 재시도 때 이전 저장을 확인한 뒤 새 본문을 저장한다', async () => {
    const { request, sqlite } = fixture();
    const originalFetch = globalThis.fetch;
    const k = 'wiki_draft_연결복구';
    try {
        const repo = await server.ssrLoadModule('/src/client/edit/drafts.ts');
        globalThis.fetch = async (path, init) => {
            if (init?.method === 'PUT') await request(path, init);
            throw new TypeError('네트워크 중단');
        };
        await assert.rejects(repo.writeDraft(k, payload), /네트워크/);
        globalThis.fetch = (path, init) => request(path, init);
        const next = { ...payload, content: '연결 중단 후 추가 편집' };
        assert.equal((await repo.writeDraft(k, next)).content, next.content);
        assert.equal((await repo.readDraft(k)).content, next.content);
    } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('저장 응답 본문이 손상되어도 복구하며 기준본이나 섹션 정보가 다른 사본은 채택하지 않는다', async () => {
    const { request, sqlite } = fixture();
    const originalFetch = globalThis.fetch;
    try {
        const repo = await server.ssrLoadModule('/src/client/edit/drafts.ts');
        const k = 'wiki_draft_손상응답';
        globalThis.fetch = async (path, init) => {
            const response = await request(path, init);
            return init?.method === 'PUT' ? new Response('{', { status: 200 }) : response;
        };
        assert.equal((await repo.writeDraft(k, payload)).content, payload.content);
        globalThis.fetch = (path, init) => request(path, init);
        for (const [field, value] of [['base', '다른 기준본'], ['version', 4], ['sectionIndex', 1], ['sectionHeading', '다른 제목']]) {
            const k = 'wiki_draft_다른정보_' + field;
            const path = '/api/editor-drafts/' + encodeURIComponent(k);
            const other = { ...payload, [field]: value };
            assert.equal((await request(path, put(other))).status, 200);
            await assert.rejects(repo.writeDraft(k, payload), /다른 기기/);
            await assert.rejects(repo.writeDraft(k, { ...payload, content: '재시도한 변경' }), /다른 기기/);
            assert.equal((await (await request(path)).json()).draft.payload[field], value);
        }
    } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('저장이 도달하지 않았으면 재시도하고 다른 기기의 변경은 계속 보호한다', async () => {
    const { request, sqlite } = fixture();
    const originalFetch = globalThis.fetch;
    const k = 'wiki_draft_재시도보호';
    const path = '/api/editor-drafts/' + encodeURIComponent(k);
    try {
        const repo = await server.ssrLoadModule('/src/client/edit/drafts.ts');
        globalThis.fetch = async () => { throw new TypeError('네트워크 중단'); };
        await assert.rejects(repo.writeDraft(k, payload), /네트워크/);
        globalThis.fetch = (path, init) => request(path, init);
        await repo.writeDraft(k, payload);
        const saved = (await (await request(path)).json()).draft;
        const other = { ...payload, content: '다른 기기의 초안' };
        assert.equal((await request(path, put(other, saved.revision))).status, 200);
        for (const content of ['내 수정', '재시도한 내 수정']) {
            await assert.rejects(repo.writeDraft(k, { ...payload, content }), /다른 기기/);
            assert.equal((await (await request(path)).json()).draft.payload.content, other.content);
        }
    } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});

test('저장 지연을 표시하고 시간 초과 후 본문을 유지한 채 버튼을 다시 활성화한다', async t => {
    const originalFetch = globalThis.fetch;
    const button = { disabled: false, innerHTML: '<i></i> 초안 저장', attributes: new Map(),
        setAttribute(name, value) { this.attributes.set(name, value); },
        removeAttribute(name) { this.attributes.delete(name); } };
    const messages = [];
    const content = '지연 중에도 보존할 본문';
    globalThis.document = { getElementById: () => button };
    Object.assign(window, { DRAFT_KEY: 'wiki_draft_시간초과', slug: '시간초과', sectionMode: false,
        editor: { getMarkdown: () => content },
        Swal: { fire: async options => { messages.push(options); return {}; } } });
    globalThis.fetch = async (_path, init) => new Promise((_, reject) => {
        assert.ok(init.signal, '초안 요청에는 시간 제한이 있어야 한다');
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const saving = window.saveDraftToDatabase();
        assert.equal(button.disabled, true);
        assert.match(button.innerHTML, /저장 중/);
        assert.equal(button.attributes.get('aria-busy'), 'true');
        assert.equal(await window.saveDraftToDatabase(), false);
        t.mock.timers.tick(15_000);
        await new Promise(resolve => setImmediate(resolve));
        t.mock.timers.tick(15_000); // 저장 여부를 확인하는 GET에도 같은 제한 적용
        assert.equal(await saving, false);
        assert.equal(button.disabled, false);
        assert.equal(button.innerHTML, '<i></i> 초안 저장');
        assert.equal(button.attributes.has('aria-busy'), false);
        assert.equal(window.editor.getMarkdown(), content);
        assert.match(messages.at(-1).text, /저장 여부.*확인/);
    } finally { globalThis.fetch = originalFetch; }
});
