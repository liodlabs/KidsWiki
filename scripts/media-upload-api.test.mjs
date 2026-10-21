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
    async run() {
        const result = this.db.prepare(this.sql).run(...this.values);
        return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
}
class TestD1 {
    constructor(db) { this.db = db; }
    prepare(sql) { return new Statement(this.db, sql); }
    async batch(statements) {
        this.db.exec('BEGIN');
        try {
            const results = [];
            for (const statement of statements) results.push(await statement.run());
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
const apiKey = 'mcp_image_upload_test';
const oauthToken = 'oauth_image_upload_test';
const hash = value => createHash('sha256').update(value).digest('hex');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
const uploadArgs = { filename: '테스트그림', mime_type: 'image/png', data: png, tags: ['동물', '동물', '고양이'] };

function fixture(role = 'user') {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys=ON');
    sqlite.exec(readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8'));
    const expires = Math.floor(Date.now() / 1000) + 3600;
    for (const [id, r, cookie] of [[userA, role, 'cookie-a'], [userB, 'admin', 'cookie-b']]) {
        sqlite.prepare("INSERT INTO users (id, provider, uid, name, role) VALUES (?, 'test', ?, ?, ?)").run(id, id, id, r);
        sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(cookie, id, expires);
    }
    sqlite.prepare("INSERT INTO mcp_api_keys (id, user_id, name, key_hash, masked_key) VALUES ('key', ?, '테스트', ?, 'mcp_…')").run(userA, hash(apiKey));
    sqlite.prepare("INSERT INTO oauth_tokens (access_token_hash, client_id, user_id, scope, access_expires_at) VALUES (?, 'test', ?, 'mcp', ?)").run(hash(oauthToken), userA, expires);
    const cache = new Map(), objects = new Map(), pending = [];
    const env = {
        DB: new TestD1(sqlite), KV: { get: async k => cache.get(k) ?? null,
            put: async (k, v) => { cache.set(k, v); }, delete: async k => { cache.delete(k); } },
        MEDIA: { put: async (key, body, options) => {
            objects.set(key, { bytes: new Uint8Array(await new Response(body).arrayBuffer()), ...options });
        } },
        MEDIA_PUBLIC_URL: 'https://wiki.test/media', MCP_MODE: 'open', WIKI_VISIBILITY: 'open',
        EDIT_REQUEST_ENABLED: 'true', SUPER_ADMIN_EMAILS: 'owner@example.com',
    };
    const ctx = { waitUntil: p => { pending.push(p); }, passThroughOnException() {} };
    const request = (url, init = {}, token = apiKey) => worker.fetch(new Request('https://wiki.test' + url, {
        ...init, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...init.headers },
    }), env, ctx);
    const rpc = async (method, params, token = apiKey) => {
        const res = await request('/api/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, token);
        assert.equal(res.status, 200);
        return res.json();
    };
    const call = (args = uploadArgs, token = apiKey) => rpc('tools/call', { name: 'upload_image', arguments: args }, token);
    const upload = (args = uploadArgs, headers = {}, token = apiKey) => {
        const body = new FormData();
        body.set('file', new File([Buffer.from(args.data, 'base64')], 'original.png', { type: args.mime_type }));
        body.set('filename', args.filename);
        body.set('tags', JSON.stringify(args.tags ?? []));
        return request('/api/media', { method: 'POST', body, headers }, token);
    };
    return { sqlite, env, objects, request, rpc, call, upload,
        close: async () => { await Promise.allSettled(pending); sqlite.close(); } };
}

test('REST·MCP 업로드는 원본 바이트·태그·작성자를 공유하고 중복 파일을 덮어쓰지 않는다', async () => {
    const f = fixture();
    try {
        const rest = await f.upload(uploadArgs, { Cookie: 'wiki_session=cookie-b' });
        assert.equal(rest.status, 200);
        assert.equal(rest.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await rest.json(), { url: 'https://wiki.test/media/images/테스트그림.png',
            r2_key: 'images/테스트그림.png', filename: '테스트그림.png', tags: ['동물', '고양이'] });
        const mcp = (await f.call()).result;
        assert.equal(mcp.isError, false);
        assert.equal(JSON.parse(mcp.content[0].text).filename, '테스트그림-2.png');
        assert.equal(f.objects.size, 2);
        for (const object of f.objects.values()) {
            assert.deepEqual(Buffer.from(object.bytes), Buffer.from(png, 'base64'));
            assert.equal(object.httpMetadata.contentType, 'image/png');
        }
        const rows = f.sqlite.prepare('SELECT uploader_id, size FROM media').all();
        assert.ok(rows.every(row => row.uploader_id === userA && row.size === Buffer.from(png, 'base64').length));
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM media_tags').get().n, 4);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM pages').get().n, 0);
    } finally { await f.close(); }
});

test('일반 기여자는 즉시 게시 설정 없이 업로드하고 비로그인·권한 없는 계정에는 도구를 숨긴다', async () => {
    for (const role of ['user', 'discussion_manager', 'admin', 'super_admin', 'guest', 'banned', 'deleted']) {
        const f = fixture(role);
        try {
            if (role === 'banned') f.sqlite.prepare('UPDATE users SET banned_until = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) + 3600, userA);
            const allowed = ['user', 'discussion_manager', 'admin', 'super_admin'].includes(role);
            const names = (await f.rpc('tools/list')).result.tools.map(tool => tool.name);
            assert.equal(names.includes('upload_image'), allowed, role);
            assert.equal((await f.upload()).status, allowed ? 200 : 403, role);
            const called = await f.call();
            if (allowed) assert.equal(called.result.isError, false);
            else assert.equal(called.error.code, -32601);
            if (role === 'user') assert.equal(names.includes('apply_edit'), false);
            assert.equal((await f.rpc('tools/list', undefined, null)).result.tools.some(tool => tool.name === 'upload_image'), false);
            assert.equal((await f.call(uploadArgs, null)).error.code, -32601);
        } finally { await f.close(); }
    }
});

test('쿠키 업로드에는 CSRF 검증을 유지하고 잘못된 토큰을 쿠키로 대신 인증하지 않는다', async () => {
    const f = fixture();
    try {
        assert.equal((await f.upload(uploadArgs, { Cookie: 'wiki_session=cookie-a', Origin: 'https://wiki.test' }, null)).status, 200);
        assert.equal((await f.upload(uploadArgs, { Cookie: 'wiki_session=cookie-a', Origin: 'https://evil.test' }, null)).ok, false);
        assert.equal((await f.upload(uploadArgs, { Origin: 'https://wiki.test' }, null)).status, 401);
        for (const Authorization of ['', 'Basic test', 'Bearer invalid']) {
            assert.equal((await f.upload(uploadArgs, { Authorization, Cookie: 'wiki_session=cookie-a' }, null)).status, 401);
        }
        assert.equal(f.objects.size, 1);
        assert.equal((await f.request('/api/me/mcp-api-keys')).status, 401);
    } finally { await f.close(); }
});

test('OAuth 토큰도 업로드하며 만료·폐기된 OAuth 토큰과 API 키는 거부한다', async () => {
    const f = fixture();
    try {
        assert.equal((await f.upload(uploadArgs, {}, oauthToken)).status, 200);
        assert.equal((await f.call(uploadArgs, oauthToken)).result.isError, false);
        f.sqlite.prepare('UPDATE oauth_tokens SET revoked_at = unixepoch()').run();
        assert.equal((await f.upload(uploadArgs, {}, oauthToken)).status, 401);
        f.sqlite.prepare('UPDATE oauth_tokens SET revoked_at = NULL, access_expires_at = 1').run();
        assert.equal((await f.upload(uploadArgs, {}, oauthToken)).status, 401);
        f.sqlite.prepare('UPDATE mcp_api_keys SET expires_at = 1').run();
        assert.equal((await f.upload()).status, 401);
        f.sqlite.prepare('DELETE FROM mcp_api_keys').run();
        assert.equal((await f.upload()).status, 401);
        assert.equal(f.objects.size, 2);
    } finally { await f.close(); }
});

test('REST·MCP는 동일한 파일명·MIME·SVG·실제 바이트 크기를 검증한다', async () => {
    const f = fixture();
    try {
        const invalid = [
            { filename: '../경로' }, { filename: '공백 포함' }, { filename: '' }, { filename: 'a'.repeat(101) },
            { mime_type: 'text/html' },
            { mime_type: 'image/svg+xml', data: Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64') },
        ];
        for (const changes of invalid) {
            const args = { ...uploadArgs, ...changes };
            assert.equal((await f.upload(args)).status, 400);
            assert.equal((await f.call(args)).result.isError, true);
        }
        const safeSvg = { ...uploadArgs, mime_type: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') };
        assert.equal(JSON.parse((await f.call(safeSvg)).result.content[0].text).filename, '테스트그림.svg');
        f.env.MAX_UPLOAD_SIZE = '4';
        for (const length of [4, 5, 7]) {
            const args = { ...uploadArgs, data: Buffer.alloc(length, 1).toString('base64') };
            assert.equal((await f.upload(args)).status, length === 4 ? 200 : 400);
            assert.equal((await f.call(args)).result.isError, length !== 4);
        }
        assert.equal(f.objects.size, 3);
    } finally { await f.close(); }
});

test('MCP는 누락·잘못된 Base64·잘못된 태그 입력을 저장 전에 거부한다', async () => {
    const f = fixture();
    try {
        for (const changes of [{ data: '' }, { data: '!!!' }, { data: 'data:image/png;base64,' + png },
            { data: '    ' }, { data: 42 }, { filename: null }, { mime_type: null }, { tags: '동물' }, { tags: [42] }]) {
            assert.equal((await f.call({ ...uploadArgs, ...changes })).result.isError, true);
        }
        assert.equal(f.objects.size, 0);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM media').get().n, 0);
    } finally { await f.close(); }
});
