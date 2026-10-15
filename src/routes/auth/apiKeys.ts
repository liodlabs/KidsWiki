import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../../types';
import { requireAuth } from '../../middleware/session';
import { isSuperAdmin } from '../../utils/auth';
import { sha256Hex } from '../../utils/oauth';

const routes = new Hono<Env>();

routes.use('*', requireAuth, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
});

async function keyLimit(c: Context<Env>): Promise<number> {
    // 세션 캐시에 남은 예전 역할로 추가 키를 발급하지 않는다.
    const user = await c.env.DB.prepare('SELECT role, email, banned_until FROM users WHERE id = ?')
        .bind(c.get('user')!.id).first<{ role: string; email: string | null; banned_until: number | null }>();
    if (!user || user.role === 'deleted') return 0;
    if (isSuperAdmin(user.email, c.env)) return 3;
    if (user.banned_until && user.banned_until > Math.floor(Date.now() / 1000)) return 0;
    const role = user.role === 'banned' ? 'user' : user.role;
    return role === 'super_admin' ? 3 : role === 'admin' ? 2
        : role === 'user' || role === 'discussion_manager' ? 1 : 0;
}

routes.get('/', async c => {
    const limit = await keyLimit(c);
    if (!limit) return c.json({ error: 'API 키를 발급할 권한이 없습니다.' }, 403);
    const { results } = await c.env.DB.prepare(`SELECT id, name, masked_key, expires_at, created_at
        FROM mcp_api_keys WHERE user_id = ? ORDER BY created_at DESC, id`)
        .bind(c.get('user')!.id).all();
    return c.json({ apiKeys: results, limit });
});

routes.post('/', async c => {
    const limit = await keyLimit(c);
    if (!limit) return c.json({ error: 'API 키를 발급할 권한이 없습니다.' }, 403);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80
        || (body.expiration !== '30d' && body.expiration !== 'never')) {
        return c.json({ error: '키 이름(1~80자)과 유효기간(30일 또는 무기한)을 선택해주세요.' }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = body.expiration === 'never' ? null : now + 30 * 86400;
    const rawBytes = crypto.getRandomValues(new Uint8Array(32));
    const rawKey = 'mcp_' + Array.from(rawBytes, b => b.toString(16).padStart(2, '0')).join('');
    const maskedKey = rawKey.slice(0, 8) + '...' + rawKey.slice(-4);
    const id = crypto.randomUUID();
    // 개수 확인과 추가를 하나의 SQL로 실행해 동시 발급도 한도를 넘지 않게 한다.
    const inserted = await c.env.DB.prepare(`INSERT INTO mcp_api_keys
        (id, user_id, name, key_hash, masked_key, expires_at, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE
        (SELECT COUNT(*) FROM mcp_api_keys WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)) < ?
        RETURNING id`)
        .bind(id, c.get('user')!.id, body.name.trim(), await sha256Hex(rawKey), maskedKey, expiresAt, now,
            c.get('user')!.id, now, limit).first();
    if (!inserted) return c.json({ error: `유효한 API 키는 최대 ${limit}개까지 발급할 수 있습니다. 기존 키를 삭제한 뒤 다시 시도해주세요.` }, 409);
    return c.json({ id, rawKey, maskedKey, expiresAt }, 201);
});

routes.delete('/:id', async c => {
    const deleted = await c.env.DB.prepare('DELETE FROM mcp_api_keys WHERE id = ? AND user_id = ? RETURNING id')
        .bind(c.req.param('id'), c.get('user')!.id).first();
    if (!deleted) return c.json({ error: 'API 키를 찾을 수 없습니다.' }, 404);
    return c.json({ success: true });
});

export default routes;
