import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types';
import { resolveBearerAuth } from '../utils/mcpAuth';

// 토큰을 명시한 요청은 쿠키 계정으로 대신 처리하지 않는다.
export const authenticateApiToken: MiddlewareHandler<Env> = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.header('Authorization') !== undefined) {
        const auth = await resolveBearerAuth(c);
        if (auth.kind === 'error') return auth.response;
        if (auth.kind !== 'authenticated') return c.json({ error: 'API 토큰이 필요합니다.' }, 401);
        if (auth.effectiveRole === 'banned' || auth.effectiveRole === 'deleted') {
            return c.json({ error: '이용할 수 없는 계정입니다.' }, 403);
        }
        c.set('user', auth.user);
    }
    await next();
};
