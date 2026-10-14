/** 개인 계정에 보관하는 수동 편집 초안. 공개 문서/MCP 제출안과 별개다. */
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
