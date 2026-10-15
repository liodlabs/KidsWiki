import type { Context } from 'hono';
import type { Env } from '../types';
import {
    ensureSubmissionSchema,
    listSubmittedDrafts,
    readSubmittedDraft,
    approveSubmittedDraft,
    rejectSubmittedDraft,
} from './mcp-submissions';

export const SUBMISSION_TOOLS = [
    {
        name: 'list_submissions',
        description: '본인 승인 대기 MCP 편집안 목록과 충돌 여부를 조회합니다. 개인 저장 초안과는 별개이며 commit_edit로 제출한 편집안만 반환합니다.',
        inputSchema: { type: 'object', properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            offset: { type: 'integer', minimum: 0 },
        }, required: [] },
    },
    {
        name: 'read_submission',
        description: '본인 승인 대기 편집안의 제안 본문·현재 본문·기준본과 충돌 여부를 조회합니다. 승인 전에 이 도구로 내용을 검토하세요.',
        inputSchema: { type: 'object', properties: {
            draft_id: { type: 'integer', minimum: 1, description: 'commit_edit 또는 list_submissions에서 받은 제출안 ID' },
        }, required: ['draft_id'] },
    },
    {
        name: 'approve_submission',
        description: '본인 승인 대기 편집안을 승인하여 실제 문서에 반영합니다. read_submission으로 내용을 검토하고 사용자가 해당 편집안의 발행을 명시적으로 요청한 경우에만 호출하세요. commit_edit 직후 자동으로 승인하지 마세요. 즉시 적용 설정과 별개이며, 편집 권한·소유권·문서 충돌을 재검증합니다. 아직 제출하지 않은 draft는 승인할 수 없습니다.',
        inputSchema: { type: 'object', properties: {
            draft_id: { type: 'integer', minimum: 1 },
            summary: { type: 'string', maxLength: 255, description: '선택 편집 요약. 생략하면 제출 시 요약 사용. 빈 문자열이면 요약을 비웁니다.' },
        }, required: ['draft_id'] },
    },
    {
        name: 'reject_submission',
        description: '본인 승인 대기 편집안과 관련 알림을 폐기합니다. 사용자가 해당 편집안의 거절을 요청한 경우에만 호출하세요. 실제 문서는 변경하지 않습니다.',
        inputSchema: { type: 'object', properties: {
            draft_id: { type: 'integer', minimum: 1 },
        }, required: ['draft_id'] },
    },
];

export async function dispatchSubmissionTool(c: Context<Env>, name: string, args: Record<string, unknown>) {
    if (!SUBMISSION_TOOLS.some(tool => tool.name === name)) return null;
    if (name !== 'list_submissions' && (typeof args.draft_id !== 'number' || !Number.isSafeInteger(args.draft_id) || args.draft_id <= 0)) {
        return { content: [{ type: 'text', text: 'draft_id는 양의 정수여야 합니다.' }], isError: true };
    }
    if (name === 'approve_submission' && args.summary !== undefined && typeof args.summary !== 'string') {
        return { content: [{ type: 'text', text: 'summary는 문자열이어야 합니다.' }], isError: true };
    }
    await ensureSubmissionSchema(c);
    const draftId = args.draft_id as number;
    const response = name === 'list_submissions' ? await listSubmittedDrafts(c, args.limit as number | undefined, args.offset as number | undefined)
        : name === 'read_submission' ? await readSubmittedDraft(c, draftId)
        : name === 'approve_submission' ? await approveSubmittedDraft(c, draftId, args.summary)
        : await rejectSubmittedDraft(c, draftId);
    c.header('Cache-Control', 'no-store');
    return { content: [{ type: 'text', text: JSON.stringify(await response.json()) }], isError: !response.ok };
}
