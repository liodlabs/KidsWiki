import { Hono } from 'hono';
import type { Env } from '../types';
import type { DraftPayload } from '../shared/editorDraft';
import { requireAuth, requirePermission } from '../middleware/session';
import { ensureEditorDraftSchema } from '../utils/editorDrafts';

const routes = new Hono<Env>();
const MAX_BYTES = 1_500_000; // 본문 + 병합 기준본. D1의 행 크기 제한보다 작게 유지한다.
const conflict = '초안이 다른 기기에서 변경되었습니다. 페이지를 다시 열어 확인한 뒤 저장해주세요.';

routes.use('/editor-drafts', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
routes.use('/editor-drafts/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });

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

routes.get('/editor-drafts/:key', requireAuth, async c => {
    const key = c.req.param('key');
    if (!validKey(key)) return c.json({ error: '잘못된 초안 키입니다.' }, 400);
    await ensureEditorDraftSchema(c.env.DB);
    const row = await c.env.DB.prepare('SELECT payload, revision FROM editor_drafts WHERE user_id = ? AND draft_key = ?')
        .bind(c.get('user')!.id, key).first<{ payload: string; revision: string }>();
    if (!row) return c.json({ error: '저장된 초안이 없습니다.' }, 404);
    return c.json({ draft: { key, revision: row.revision, payload: JSON.parse(row.payload) as DraftPayload } });
});

routes.put('/editor-drafts/:key', requireAuth, requirePermission('wiki:edit'), async c => {
    const key = c.req.param('key');
    if (!validKey(key)) return c.json({ error: '잘못된 초안 키입니다.' }, 400);
    const raw = await c.req.text();
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
    await ensureEditorDraftSchema(c.env.DB);
    const statement = body.expectedRevision === null
        ? c.env.DB.prepare(`INSERT INTO editor_drafts (user_id, draft_key, payload, revision, updated_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, draft_key) DO NOTHING RETURNING revision`)
            .bind(userId, key, JSON.stringify(payload), revision, savedAt)
        : c.env.DB.prepare(`UPDATE editor_drafts SET payload = ?, revision = ?, updated_at = ?
            WHERE user_id = ? AND draft_key = ? AND revision = ? RETURNING revision`)
            .bind(JSON.stringify(payload), revision, savedAt, userId, key, body.expectedRevision);
    if (!await statement.first()) return c.json({ error: conflict }, 409);
    return c.json({ draft: { key, revision, payload } });
});

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
