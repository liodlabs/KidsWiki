import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { mergeAccounts, resolveCanonicalUserId } from '../src/routes/auth/accountMerge.ts';
import { reconcilePrimaryIdentity } from '../src/routes/auth/identities.ts';

class D1Statement {
    constructor(db, sql, values = []) {
        this.db = db;
        this.sql = sql;
        this.values = values;
    }

    bind(...values) {
        return new D1Statement(this.db, this.sql, values);
    }

    async first() {
        return this.db.prepare(this.sql).get(...this.values) ?? null;
    }

    async all() {
        return { results: this.db.prepare(this.sql).all(...this.values) };
    }

    async run() {
        const result = this.db.prepare(this.sql).run(...this.values);
        return { meta: { changes: Number(result.changes) } };
    }
}

class TestD1 {
    constructor(db) {
        this.db = db;
    }

    prepare(sql) {
        return new D1Statement(this.db, sql);
    }

    async batch(statements) {
        this.db.exec('BEGIN');
        try {
            const results = [];
            for (const statement of statements) results.push(await statement.run());
            this.db.exec('COMMIT');
            return results;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
}

test('중복 계정은 대표 계정으로 이동되고 예전 ID는 별칭으로 남는다', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8'));
    const db = new TestD1(sqlite);
    const survivor = '123456789ABCDEFGHJKLMN';
    const absorbed = '23456789ABCDEFGHJKLMNP';

    const insertUser = sqlite.prepare(
        'INSERT INTO users (id, provider, uid, email, name, role) VALUES (?, ?, ?, ?, ?, \'user\')',
    );
    insertUser.run(survivor, 'google', 'google-a', 'a@example.com', 'A');
    insertUser.run(absorbed, 'naver', 'naver-b', 'b@example.com', 'B');
    sqlite.prepare('INSERT INTO user_identities (user_id, provider, provider_uid, provider_email) VALUES (?, ?, ?, ?)')
        .run(survivor, 'google', 'google-a', 'a@example.com');
    sqlite.prepare('INSERT INTO user_identities (user_id, provider, provider_uid, provider_email) VALUES (?, ?, ?, ?)')
        .run(absorbed, 'naver', 'naver-b', 'b@example.com');
    const pageId = Number(sqlite.prepare("INSERT INTO pages (slug, content) VALUES ('병합-테스트', '')").run().lastInsertRowid);
    sqlite.prepare('INSERT INTO revisions (page_id, content, author_id) VALUES (?, ?, ?)').run(pageId, '본문', absorbed);
    sqlite.prepare("INSERT INTO page_watches (user_id, page_id, scope) VALUES (?, ?, 'this')").run(survivor, pageId);
    sqlite.prepare("INSERT INTO page_watches (user_id, page_id, scope) VALUES (?, ?, 'subtree')").run(absorbed, pageId);
    sqlite.prepare("INSERT INTO mcp_drafts (user_id, slug, action) VALUES (?, '다른-초안', 'create')").run(absorbed);
    sqlite.prepare("INSERT INTO contributor_trust (user_id, status, mode) VALUES (?, 'trusted', 'trusted')").run(absorbed);
    sqlite.prepare("INSERT INTO contributor_trust_events (user_id, event_type, source_type, source_id, document_key) VALUES (?, 'approved', 'test', '1', '병합-테스트')").run(absorbed);
    sqlite.prepare("INSERT INTO user_badges (user_id, badge_key, assigned_by) VALUES (?, 'verified_expert', ?)").run(absorbed, survivor);
    sqlite.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES ('session-b', ?, 9999999999)").run(absorbed);
    const insertKey = sqlite.prepare('INSERT INTO mcp_api_keys (id, user_id, name, key_hash, masked_key, expires_at) VALUES (?, ?, ?, ?, ?, NULL)');
    for (const id of [survivor, absorbed]) {
        for (let i = 0; i < 2; i++) insertKey.run(`${id}-${i}`, id, `키 ${i}`, `${id}-hash-${i}`, 'mcp_test...test');
    }

    sqlite.prepare("INSERT INTO editor_drafts (user_id, draft_key, payload, revision, updated_at) VALUES (?, 'wiki_draft_개인초안', '{}', 'rev-a', 1)").run(absorbed);
    const result = await mergeAccounts(db, survivor, absorbed);

    assert.equal(result.status, 'merged');
    assert.deepEqual(result.revokedSessionIds, ['session-b']);
    assert.equal(sqlite.prepare("SELECT user_id FROM user_identities WHERE provider = 'naver'").get().user_id, survivor);
    assert.equal(sqlite.prepare('SELECT author_id FROM revisions WHERE page_id = ?').get(pageId).author_id, survivor);
    assert.equal(sqlite.prepare('SELECT scope FROM page_watches WHERE user_id = ? AND page_id = ?').get(survivor, pageId).scope, 'subtree');
    assert.equal(sqlite.prepare('SELECT user_id FROM mcp_drafts').get().user_id, survivor);
    assert.equal(sqlite.prepare('SELECT user_id FROM editor_drafts').get().user_id, survivor);
    assert.equal(sqlite.prepare('SELECT status FROM contributor_trust WHERE user_id = ?').get(survivor).status, 'trusted');
    assert.equal(sqlite.prepare('SELECT user_id FROM contributor_trust_events').get().user_id, survivor);
    assert.equal(sqlite.prepare('SELECT user_id FROM user_badges').get().user_id, survivor);
    assert.equal(sqlite.prepare('SELECT role FROM users WHERE id = ?').get(absorbed).role, 'deleted');
    assert.equal(await resolveCanonicalUserId(db, absorbed), survivor);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(absorbed).count, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM mcp_api_keys WHERE user_id = ?').get(absorbed).count, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM mcp_api_keys WHERE user_id = ?').get(survivor).count, 2);
});

test('OAuth 이메일이 최고관리자인 계정은 연결 시작 방향과 무관하게 생존한다', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8'));
    const db = new TestD1(sqlite);
    const current = '3456789ABCDEFGHJKLMNPQ';
    const superAdmin = '456789ABCDEFGHJKLMNPQR';

    const insertUser = sqlite.prepare(
        'INSERT INTO users (id, provider, uid, email, name, role, created_at) VALUES (?, ?, ?, ?, ?, \'user\', ?)',
    );
    insertUser.run(current, 'kakao', 'kakao-current', null, '현재 계정', 100);
    insertUser.run(superAdmin, 'naver', 'naver-admin', null, '최고관리자 계정', 200);
    sqlite.prepare('INSERT INTO user_identities (user_id, provider, provider_uid, provider_email) VALUES (?, ?, ?, ?)')
        .run(current, 'kakao', 'kakao-current', null);
    sqlite.prepare('INSERT INTO user_identities (user_id, provider, provider_uid, provider_email) VALUES (?, ?, ?, ?)')
        .run(superAdmin, 'naver', 'naver-admin', 'Admin@Example.com');

    const result = await mergeAccounts(db, current, superAdmin, new Set(['admin@example.com']));

    assert.equal(result.status, 'merged');
    assert.equal(result.survivorUserId, superAdmin);
    assert.equal(result.absorbedUserId, current);
    assert.equal(sqlite.prepare('SELECT email FROM users WHERE id = ?').get(superAdmin).email, 'Admin@Example.com');
    assert.equal(sqlite.prepare('SELECT role FROM users WHERE id = ?').get(current).role, 'deleted');
});

test('두 계정 모두 최고관리자면 먼저 가입한 계정이 생존한다', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8'));
    const db = new TestD1(sqlite);
    const newer = '56789ABCDEFGHJKLMNPQRS';
    const older = '6789ABCDEFGHJKLMNPQRST';

    const insertUser = sqlite.prepare(
        'INSERT INTO users (id, provider, uid, email, name, role, created_at) VALUES (?, ?, ?, ?, ?, \'user\', ?)',
    );
    insertUser.run(newer, 'google', 'google-newer', 'newer@example.com', '나중 계정', 200);
    insertUser.run(older, 'naver', 'naver-older', 'older@example.com', '먼저 계정', 100);
    sqlite.prepare('INSERT INTO user_identities (user_id, provider, provider_uid, provider_email) VALUES (?, ?, ?, ?)')
        .run(newer, 'google', 'google-newer', 'newer@example.com');
    sqlite.prepare('INSERT INTO user_identities (user_id, provider, provider_uid, provider_email) VALUES (?, ?, ?, ?)')
        .run(older, 'naver', 'naver-older', 'older@example.com');

    const result = await mergeAccounts(
        db,
        newer,
        older,
        new Set(['newer@example.com', 'older@example.com']),
    );

    assert.equal(result.status, 'merged');
    assert.equal(result.survivorUserId, older);
    assert.equal(result.absorbedUserId, newer);
});

test('연결된 최고관리자 이메일은 기준 Identity와 대표 이메일이 된다', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8'));
    const db = new TestD1(sqlite);
    const userId = '789ABCDEFGHJKLMNPQRSTU';

    sqlite.prepare(
        'INSERT INTO users (id, provider, uid, email, name, role) VALUES (?, ?, ?, ?, ?, \'user\')',
    ).run(userId, 'kakao', 'kakao-user', 'normal@example.com', '사용자');
    sqlite.prepare('INSERT INTO user_identities (user_id, provider, provider_uid, provider_email) VALUES (?, ?, ?, ?)')
        .run(userId, 'kakao', 'kakao-user', 'normal@example.com');
    sqlite.prepare('INSERT INTO user_identities (user_id, provider, provider_uid, provider_email) VALUES (?, ?, ?, ?)')
        .run(userId, 'naver', 'naver-user', 'admin@example.com');

    const changed = await reconcilePrimaryIdentity(db, userId, new Set(['admin@example.com']));
    const user = sqlite.prepare('SELECT provider, uid, email FROM users WHERE id = ?').get(userId);

    assert.equal(changed, true);
    assert.equal(user.provider, 'naver');
    assert.equal(user.uid, 'naver-user');
    assert.equal(user.email, 'admin@example.com');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM user_identities WHERE user_id = ?').get(userId).count, 2);
});


test('같은 문서의 개인 초안이 양쪽에 있으면 계정 통합을 중단해 두 초안을 보존한다', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(new URL('../migrations/schema.sql', import.meta.url), 'utf8'));
    const db = new TestD1(sqlite);
    const survivor = '123456789ABCDEFGHJKLMN';
    const absorbed = '23456789ABCDEFGHJKLMNP';
    for (const [id, provider] of [[survivor, 'google'], [absorbed, 'naver']]) {
        sqlite.prepare("INSERT INTO users (id, provider, uid, name, role) VALUES (?, ?, ?, ?, 'user')").run(id, provider, id, id);
        sqlite.prepare('INSERT INTO user_identities (user_id, provider, provider_uid) VALUES (?, ?, ?)').run(id, provider, id);
        sqlite.prepare("INSERT INTO editor_drafts (user_id, draft_key, payload, revision, updated_at) VALUES (?, 'wiki_draft_같은문서', ?, ?, 1)").run(id, JSON.stringify({ content: id }), id);
    }
    assert.equal((await mergeAccounts(db, survivor, absorbed)).status, 'draft_conflict');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM editor_drafts').get().n, 2);
    assert.equal(sqlite.prepare('SELECT role FROM users WHERE id = ?').get(absorbed).role, 'user');
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM user_identities WHERE user_id = ?').get(absorbed).n, 1);
    sqlite.close();
});
