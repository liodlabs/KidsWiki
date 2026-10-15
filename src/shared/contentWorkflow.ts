export interface McpDraftItem {
    draft_id: number;
    slug: string;
    action: 'create' | 'update';
    status: 'draft' | 'pending_approval';
    content_length: number;
    updated_at: string;
    submitted_at: string | null;
    submitted_summary: string | null;
}

export interface PublishedPageItem {
    slug: string;
    title: string | null;
    version: number;
    my_revision_id: number;
    current_revision_id: number;
    published_at: string;
    updated_at: string;
}

export interface PublishedPagesResponse {
    pages: PublishedPageItem[];
    nextOffset: number | null;
    canDelete: boolean;
}

export interface McpDraftsResponse {
    drafts: McpDraftItem[];
    nextOffset: number | null;
}
