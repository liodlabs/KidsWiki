export const STANDARD_EDITOR_DRAFT_LIMIT = 4;

/** 브라우저·API·MCP가 공유하는 개인 편집 초안. 공개 문서/MCP 제출안과 별개다. */
export interface DraftPayload {
    content: string;
    version: number | string | null;
    base: string | null;
    savedAt: number | null;
    sectionIndex?: number;
    sectionHeading?: string;
}

export interface EditorDraft {
    key: string;
    revision: string;
    payload: DraftPayload;
}

/** 초안 목록에는 비공개 본문과 병합 기준본을 포함하지 않는다. */
export interface EditorDraftSummary {
    key: string;
    revision: string;
    slug: string;
    updatedAt: number;
    sectionIndex?: number;
    sectionHeading?: string;
}
