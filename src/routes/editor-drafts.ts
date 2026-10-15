import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../types';
import type { DraftPayload, EditorDraftSummary } from '../shared/editorDraft';
import { STANDARD_EDITOR_DRAFT_LIMIT } from '../shared/editorDraft';
import { requireAuth, requirePermission } from '../middleware/session';
import { ensureEditorDraftSchema } from '../utils/editorDrafts';
import { isSuperAdmin } from '../utils/auth';
import { resolveBearerAuth } from '../utils/mcpAuth';

const routes = new Hono<Env>();
const MAX_BYTES = 1_500_000; // 본문 + 병합 기준본. D1의 행 크기 제한보다 작게 유지한다.
const conflict = '초안이 다른 기기에서 변경되었습니다. 페이지를 다시 열어 확인한 뒤 저장해주세요.';

async function draftLimit(c: Context<Env>): Promise<number | null> {
    // 오래된 세션 역할 때문에 승격된 관리자의 초안을 지우지 않는다.
    const user = await c.env.DB.prepare('SELECT role, email, banned_until FROM users WHERE id = ?')
        .bind(c.get('user')!.id).first<{ role: string; email: string | null; banned_until: number | null }>();
    if (!user || user.role === 'deleted') return 0;
    if (isSuperAdmin(user.email, c.env)) return null;
    if (user.banned_until && user.banned_until > Math.floor(Date.now() / 1000)) return 0;
    const role = user.role === 'banned' ? 'user' : user.role;
    if (role === 'admin' || role === 'super_admin') return null;
    return role === 'user' || role === 'discussion_manager' ? STANDARD_EDITOR_DRAFT_LIMIT : 0;
}

const authenticateDrafts: MiddlewareHandler<Env> = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    // 토큰을 명시한 요청은 쿠키 계정으로 대신 처리하지 않는다.
    if (c.req.header('Authorization') !== undefined) {
        const auth = await resolveBearerAuth(c);
        if (auth.kind === 'error') return auth.response;
        if (auth.kind !== 'authenticated') return c.json({ error: 'API 토큰이 필요합니다.' }, 401);
        if (auth.effectiveRole === 'banned' || auth.effectiveRole === 'deleted') {
            return c.json({ error: '초안을 이용할 수 없는 계정입니다.' }, 403);
        }
        c.set('user', auth.user);
    }
    await next();
};
routes.use('/editor-drafts', authenticateDrafts);
routes.use('/editor-drafts/*', authenticateDrafts);

function validKey(key: string): boolean {
    return key.startsWith('wiki_draft_') && key.length > 11 && key.length <= 2048 && !/[\u0000-\u001f]/.test(key);
}

function validPayload(value: unknown): value is DraftPayload {
    if (!value || typeof value !== 'object') return false;
    const p = value as DraftPayload;
    return typeof p.content === 'string' && !!p.content.trim()
        && (p.base === null || typeof p.base === 'string')
        && (p.version === null || (typeof p.version === 'number' && Number.isFinite(p.version))
            || (typeof p.version === 'string' && p.version.length <= 64))
        && (p.sectionIndex === undefined || (Number.isInteger(p.sectionIndex) && p.sectionIndex >= 0))
        && (p.sectionHeading === undefined || (typeof p.sectionHeading === 'string' && p.sectionHeading.length <= 500));
}

routes.get('/editor-drafts', requireAuth, async c => {
    const prefix = c.req.query('prefix') ?? 'wiki_draft_';
    if (!prefix.startsWith('wiki_draft_') || prefix.length > 2048) return c.json({ error: '잘못된 초안 키입니다.' }, 400);
    await ensureEditorDraftSchema(c.env.DB);
    const rows = await c.env.DB.prepare(`SELECT draft_key AS key, revision FROM editor_drafts
        WHERE user_id = ? AND substr(draft_key, 1, length(?)) = ? ORDER BY draft_key`)
        .bind(c.get('user')!.id, prefix, prefix).all<{ key: string; revision: string }>();
    return c.json({ drafts: rows.results });
});

export async function listEditorDrafts(c: Context<Env>) {
    const limit = await draftLimit(c);
    if (limit === 0) return c.json({ error: '초안을 조회할 권한이 없습니다.' }, 403);
    await ensureEditorDraftSchema(c.env.DB);
    const { results } = await c.env.DB.prepare(`SELECT draft_key AS key, revision, updated_at AS updatedAt,
        json_extract(payload, '$.sectionIndex') AS sectionIndex,
        json_extract(payload, '$.sectionHeading') AS sectionHeading
        FROM editor_drafts WHERE user_id = ? ORDER BY updated_at DESC, draft_key`)
        .bind(c.get('user')!.id).all<{
            key: string; revision: string; updatedAt: number; sectionIndex: number | null; sectionHeading: string | null;
        }>();
    const drafts: EditorDraftSummary[] = results.map(row => {
        const draft: EditorDraftSummary = { key: row.key, revision: row.revision,
            slug: row.key.slice('wiki_draft_'.length), updatedAt: row.updatedAt };
        if (row.sectionIndex !== null && draft.slug.endsWith('#section=' + row.sectionIndex)) {
            draft.slug = draft.slug.slice(0, -('#section=' + row.sectionIndex).length);
            draft.sectionIndex = row.sectionIndex;
            draft.sectionHeading = row.sectionHeading ?? '';
        }
        return draft;
    });
    return c.json({ drafts, limit });
}

export async function readEditorDraft(c: Context<Env>, key: string) {
    if (!validKey(key)) return c.json({ error: '잘못된 초안 키입니다.' }, 400);
    await ensureEditorDraftSchema(c.env.DB);
    const row = await c.env.DB.prepare('SELECT payload, revision FROM editor_drafts WHERE user_id = ? AND draft_key = ?')
        .bind(c.get('user')!.id, key).first<{ payload: string; revision: string }>();
    if (!row) return c.json({ error: '저장된 초안이 없습니다.' }, 404);
    return c.json({ draft: { key, revision: row.revision, payload: JSON.parse(row.payload) as DraftPayload } });
}

export async function saveEditorDraft(c: Context<Env>, key: string, raw: string) {
    if (!validKey(key)) return c.json({ error: '잘못된 초안 키입니다.' }, 400);
    if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return c.json({ error: '초안이 너무 큽니다. 본문과 기준본의 합계는 1.5MB 이하여야 합니다.' }, 413);
    let body: { payload?: unknown; expectedRevision?: unknown };
    try { body = JSON.parse(raw); } catch { return c.json({ error: '잘못된 초안 데이터입니다.' }, 400); }
    if (!body || !validPayload(body.payload) || !(body.expectedRevision === null
        || (typeof body.expectedRevision === 'string' && /^[0-9a-f-]{36}$/.test(body.expectedRevision)))) {
        return c.json({ error: '잘못된 초안 데이터입니다.' }, 400);
    }
    const p = body.payload;
    const savedAt = Date.now();
    const payload: DraftPayload = { content: p.content, version: p.version, base: p.base, savedAt };
    if (p.sectionIndex !== undefined) payload.sectionIndex = p.sectionIndex;
    if (p.sectionHeading !== undefined) payload.sectionHeading = p.sectionHeading;
    const revision = crypto.randomUUID();
    const userId = c.get('user')!.id;
    const limit = await draftLimit(c);
    if (limit === 0) return c.json({ error: '초안을 저장할 권한이 없습니다.' }, 403);
    await ensureEditorDraftSchema(c.env.DB);
    const statement = body.expectedRevision === null
        ? c.env.DB.prepare(`INSERT INTO editor_drafts (user_id, draft_key, payload, revision, updated_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, draft_key) DO NOTHING RETURNING revision`)
            .bind(userId, key, JSON.stringify(payload), revision, savedAt)
        : c.env.DB.prepare(`UPDATE editor_drafts SET payload = ?, revision = ?, updated_at = ?
            WHERE user_id = ? AND draft_key = ? AND revision = ? RETURNING revision`)
            .bind(JSON.stringify(payload), revision, savedAt, userId, key, body.expectedRevision);
    let removedKeys: string[] = [];
    if (body.expectedRevision === null && limit !== null) {
        // 새 초안 생성에 성공한 경우에만 정리한다. 저장·정리는 함께 성공하거나 함께 롤백된다.
        const [saved, removed] = await c.env.DB.batch<{ draft_key: string }>([
            statement,
            c.env.DB.prepare(`DELETE FROM editor_drafts WHERE user_id = ? AND draft_key IN (
                SELECT draft_key FROM editor_drafts WHERE user_id = ? AND draft_key != ?
                ORDER BY updated_at DESC, draft_key DESC LIMIT -1 OFFSET ?
            ) AND EXISTS (
                SELECT 1 FROM editor_drafts WHERE user_id = ? AND draft_key = ? AND revision = ?
            ) RETURNING draft_key`)
                .bind(userId, userId, key, limit - 1, userId, key, revision),
        ]);
        if (!saved.results.length) return c.json({ error: conflict }, 409);
        removedKeys = removed.results.map(row => row.draft_key as string);
    } else if (!await statement.first()) return c.json({ error: conflict }, 409);
    return c.json({ draft: { key, revision, payload }, removedKeys });
}

routes.get('/editor-drafts/overview', requireAuth, requirePermission('wiki:read'), listEditorDrafts);
routes.get('/editor-drafts/:key', requireAuth, c => readEditorDraft(c, c.req.param('key')));
routes.put('/editor-drafts/:key', requireAuth, requirePermission('wiki:edit'),
    async c => saveEditorDraft(c, c.req.param('key'), await c.req.text()));

routes.delete('/editor-drafts/:key', requireAuth, async c => {
    const key = c.req.param('key');
    let body: { expectedRevision?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: '잘못된 초안 데이터입니다.' }, 400); }
    if (!validKey(key) || !body || typeof body.expectedRevision !== 'string'
        || !/^[0-9a-f-]{36}$/.test(body.expectedRevision)) return c.json({ error: '잘못된 초안 데이터입니다.' }, 400);
    await ensureEditorDraftSchema(c.env.DB);
    const userId = c.get('user')!.id;
    const deleted = await c.env.DB.prepare(`DELETE FROM editor_drafts WHERE user_id = ? AND draft_key = ? AND revision = ? RETURNING draft_key`)
        .bind(userId, key, body.expectedRevision).first();
    if (!deleted && await c.env.DB.prepare('SELECT 1 FROM editor_drafts WHERE user_id = ? AND draft_key = ?').bind(userId, key).first()) {
        return c.json({ error: conflict }, 409);
    }
    return c.body(null, 204);
});

export default routes;
