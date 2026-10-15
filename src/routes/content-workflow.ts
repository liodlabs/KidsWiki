import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import type { PublishedPageItem, PublishedPagesResponse } from '../shared/contentWorkflow';
import { authenticateApiToken } from '../middleware/apiToken';
import { requireAuth, requirePermission } from '../middleware/session';
import { RBAC } from '../utils/role';
import { isTrustedContributor } from '../utils/contributorTrust';
import { ensureRevisionsVirtualMigration } from '../utils/revisionsVirtualMigration';
import { ensureSubmissionSchema } from './mcp-submissions';
import { dispatchAdminEditTool, dispatchAdminReadTool } from './admin-mcp';
import type { ToolResult } from '../utils/mcpDispatch';

const routes = new Hono<Env>();
for (const path of ['/mcp-drafts', '/mcp-drafts/*', '/published-pages', '/published-pages/*']) {
    routes.use(path, authenticateApiToken, requireAuth);
}

function pagination(limit: unknown = 20, offset: unknown = 0) {
    if ((typeof limit !== 'number' && typeof limit !== 'string')
        || (typeof offset !== 'number' && typeof offset !== 'string')) return null;
    const size = Number(limit), start = Number(offset);
    return Number.isSafeInteger(size) && size >= 1 && size <= 100
        && Number.isSafeInteger(start) && start >= 0 ? { limit: size, offset: start } : null;
}

function toolResponse(c: Context<Env>, result: ToolResult | null) {
    if (!result) return c.json({ error: '처리할 수 없는 요청입니다.' }, 400);
    const text = result.content.find(item => item.type === 'text')?.text ?? '';
    let data: Record<string, unknown>;
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    return c.json(data, result.isError ? (data.error === 'conflict' ? 409 : 400) : 200);
}

async function ownDraft(c: Context<Env>) {
    await ensureSubmissionSchema(c);
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return c.env.DB.prepare('SELECT id, slug, submitted_at FROM mcp_drafts WHERE id = ? AND user_id = ?')
        .bind(id, c.get('user')!.id).first<{ id: number; slug: string; submitted_at: number | null }>();
}

routes.get('/mcp-drafts', requirePermission('wiki:edit'), async c => {
    const page = pagination(c.req.query('limit'), c.req.query('offset'));
    const status = c.req.query('status') ?? 'draft';
    if (!page || !['draft', 'pending_approval', 'all'].includes(status)) return c.json({ error: '잘못된 목록 조건입니다.' }, 400);
    const result = await dispatchAdminReadTool(c, c.get('user')!, 'list_drafts', { ...page, status });
    const response = toolResponse(c, result);
    if (!response.ok) return response;
    const drafts = await response.json() as unknown[];
    return c.json({ drafts, nextOffset: drafts.length === page.limit ? page.offset + page.limit : null });
});

routes.get('/mcp-drafts/:id', requirePermission('wiki:edit'), async c => {
    const draft = await ownDraft(c);
    if (!draft) return c.json({ error: '초안을 찾을 수 없습니다.' }, 404);
    return toolResponse(c, await dispatchAdminReadTool(c, c.get('user')!, 'read_draft', { title: draft.slug }));
});

routes.post('/mcp-drafts/:id/submit', requirePermission('wiki:edit'), async c => {
    const user = c.get('user')!;
    const rbac = c.get('rbac') as RBAC;
    if (c.env.EDIT_REQUEST_ENABLED === 'true' && !rbac.can(user.role, 'admin:access')
        && !(await isTrustedContributor(c.env.DB, user.id))) {
        return c.json({ error: '제출하려면 신뢰 기여자 또는 관리자여야 합니다.' }, 403);
    }
    const draft = await ownDraft(c);
    if (!draft) return c.json({ error: '초안을 찾을 수 없습니다.' }, 404);
    if (draft.submitted_at !== null) return c.json({ error: '이미 제출된 편집안입니다.' }, 409);
    const body = await c.req.json<{ summary?: unknown }>().catch(() => null);
    if (!body || (body.summary !== undefined && typeof body.summary !== 'string')) return c.json({ error: '잘못된 편집 요약입니다.' }, 400);
    return toolResponse(c, await dispatchAdminEditTool(c, user, 'commit_edit', { draft_id: draft.id, summary: body.summary }));
});

routes.delete('/mcp-drafts/:id', requirePermission('wiki:edit'), async c => {
    const draft = await ownDraft(c);
    if (!draft) return c.json({ error: '초안을 찾을 수 없습니다.' }, 404);
    return toolResponse(c, await dispatchAdminEditTool(c, c.get('user')!, 'discard_edit', { draft_id: draft.id }));
});

export async function listPublishedPages(c: Context<Env>, limit: number, offset: number) {
    await ensureRevisionsVirtualMigration(c.env.DB);
    const rbac = c.get('rbac') as RBAC;
    const user = c.get('user')!;
    const privateFilter = rbac.can(user.role, 'wiki:private') ? '' : 'AND p.is_private = 0';
    const { results } = await c.env.DB.prepare(`SELECT p.slug, p.title, p.version,
        mine.my_revision_id, p.last_revision_id AS current_revision_id,
        r.created_at AS published_at, p.updated_at
        FROM pages p JOIN (
            SELECT page_id, MAX(id) AS my_revision_id FROM revisions
            WHERE author_id = ? AND is_virtual = 0 AND deleted_at IS NULL AND purged_at IS NULL
            GROUP BY page_id
        ) mine ON mine.page_id = p.id
        JOIN revisions r ON r.id = mine.my_revision_id
        WHERE p.deleted_at IS NULL ${privateFilter}
        ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`)
        .bind(user.id, limit + 1, offset).all<Omit<PublishedPageItem, 'published_at' | 'updated_at'> & { published_at: number; updated_at: number }>();
    const pages = results.slice(0, limit).map(row => ({ ...row,
        published_at: new Date(row.published_at * 1000).toISOString(),
        updated_at: new Date(row.updated_at * 1000).toISOString(),
    }));
    return c.json<PublishedPagesResponse>({ pages, nextOffset: results.length > limit ? offset + limit : null,
        canDelete: rbac.can(user.role, 'wiki:delete') });
}

routes.get('/published-pages', requirePermission('wiki:read'), async c => {
    const page = pagination(c.req.query('limit'), c.req.query('offset'));
    return page ? listPublishedPages(c, page.limit, page.offset) : c.json({ error: '잘못된 목록 조건입니다.' }, 400);
});

routes.delete('/published-pages/:slug', requirePermission('wiki:delete'), async c => {
    await ensureRevisionsVirtualMigration(c.env.DB);
    const slug = c.req.param('slug');
    const own = await c.env.DB.prepare(`SELECT p.id FROM pages p JOIN revisions r ON r.page_id = p.id
        WHERE p.slug = ? AND p.deleted_at IS NULL AND r.author_id = ? AND r.is_virtual = 0
        AND r.deleted_at IS NULL AND r.purged_at IS NULL LIMIT 1`).bind(slug, c.get('user')!.id).first();
    if (!own) return c.json({ error: '발행한 문서를 찾을 수 없습니다.' }, 404);
    return toolResponse(c, await dispatchAdminEditTool(c, c.get('user')!, 'delete_page', { title: slug, hard: false }));
});

export const PUBLISHED_PAGE_TOOL = {
    name: 'list_published_pages',
    description: '본인이 발행한 이력이 있는 현재 문서 목록을 조회합니다. 문서당 한 항목이며 이후 다른 사람이 편집한 문서도 포함됩니다. 비공개·삭제 문서는 현재 열람 권한에 따라 숨깁니다. limit(기본 20, 최대 100), offset으로 다음 목록을 조회하세요. 삭제는 기존 관리자 전용 delete_page 도구를 사용합니다.',
    inputSchema: { type: 'object', properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
    }, required: [] },
};

export async function dispatchPublishedPagesTool(c: Context<Env>, args: Record<string, unknown>) {
    const page = pagination(args.limit, args.offset);
    if (!page) return { content: [{ type: 'text', text: 'limit 또는 offset이 올바르지 않습니다.' }], isError: true };
    const response = await listPublishedPages(c, page.limit, page.offset);
    c.header('Cache-Control', 'no-store');
    return { content: [{ type: 'text', text: JSON.stringify(await response.json()) }], isError: false };
}

export default routes;
