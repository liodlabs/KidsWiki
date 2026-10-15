import type { Context } from 'hono';
import type { Env } from '../types';
import { normalizeSlug } from '../utils/slug';
import { SLUG_FORBIDDEN_CHARS } from '../utils/validation';
import { listEditorDrafts, readEditorDraft, saveEditorDraft } from './editor-drafts';

export const PERSONAL_DRAFT_READ_TOOLS = [
    {
        name: 'list_personal_drafts',
        description: '마이페이지 ‘내 초안’과 같은 개인 초안 목록을 최신순으로 조회합니다. 본인의 초안만 반환하며 본문은 포함하지 않습니다. MCP 승인용 편집안(list_drafts)과는 별개입니다.',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'read_personal_draft',
        description: '내 초안의 본문·병합 기준본·revision을 조회합니다. key는 list_personal_drafts 결과에서 가져옵니다. 다른 기기에서 수정한 내용을 보호하려면 저장 전에 반드시 읽고 revision을 확인하세요.',
        inputSchema: { type: 'object', properties: {
            key: { type: 'string', description: '목록에서 받은 초안 key' },
        }, required: ['key'] },
    },
];

export const PERSONAL_DRAFT_WRITE_TOOLS = [
    {
        name: 'save_personal_draft',
        description: '본문을 비공개 개인 초안으로 저장합니다. 마이페이지 ‘내 초안’에서 불러와 이어 쓸 수 있으며 문서를 게시하거나 승인 대기로 제출하지 않습니다. 일반 사용자·토론관리자는 문서·섹션을 합해 4개까지 보관하며, 새 초안 저장 시 마지막 저장이 가장 오래된 초안을 자동 삭제합니다. 관리자는 제한이 없습니다. 기존 초안은 read_personal_draft의 revision을 expected_revision으로 보내야 수정할 수 있습니다. 응답의 removedKeys는 자동 삭제된 초안입니다.',
        inputSchema: { type: 'object', properties: {
            title: { type: 'string', description: '편집할 문서 슬러그' },
            content: { type: 'string', description: '초안 본문. 섹션 초안은 해당 섹션 헤딩을 포함한 본문' },
            expected_revision: { type: ['string', 'null'], description: '새 초안은 null. 수정은 읽기·저장 응답의 revision. 충돌 시 다시 읽고 내용을 확인한 뒤 재시도' },
            base_version: { type: ['number', 'string', 'null'], description: '편집 기준 문서의 버전. 새 문서는 null. 모르면 null로 보내며 브라우저 복원 시 충돌 확인이 필요할 수 있습니다.' },
            base_content: { type: ['string', 'null'], description: '편집을 시작할 때 읽은 원본 본문(섹션이면 원본 섹션 본문). 새 문서나 알 수 없는 경우 null' },
            section_index: { type: 'integer', minimum: 0, description: '섹션 초안일 때만 브라우저 편집기의 0부터 시작하는 섹션 인덱스. 목차의 1.1 같은 번호와 다릅니다.' },
            section_heading: { type: 'string', description: '섹션 초안일 때 해당 헤딩 텍스트' },
        }, required: ['title', 'content', 'expected_revision', 'base_version', 'base_content'] },
    },
];

export async function dispatchPersonalDraftTool(c: Context<Env>, name: string, args: Record<string, unknown>) {
    let response: Response;
    if (name === 'list_personal_drafts') {
        response = await listEditorDrafts(c);
    } else if (name === 'read_personal_draft') {
        if (typeof args.key !== 'string') return toolError('초안 key가 필요합니다.');
        response = await readEditorDraft(c, args.key);
    } else if (name === 'save_personal_draft') {
        if (typeof args.title !== 'string') return toolError('문서 슬러그가 필요합니다.');
        const slug = normalizeSlug(args.title);
        if (!slug || SLUG_FORBIDDEN_CHARS.test(slug)) return toolError('잘못된 문서 슬러그입니다.');
        const key = 'wiki_draft_' + slug + (args.section_index === undefined ? '' : '#section=' + args.section_index);
        response = await saveEditorDraft(c, key, JSON.stringify({ expectedRevision: args.expected_revision,
            payload: { content: args.content, version: args.base_version, base: args.base_content,
                sectionIndex: args.section_index, sectionHeading: args.section_heading } }));
    } else {
        return null;
    }
    c.header('Cache-Control', 'no-store');
    const data = await response.json();
    return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: !response.ok };
}

function toolError(message: string) {
    return { content: [{ type: 'text', text: message }], isError: true };
}
