import type { DraftPayload, EditorDraft } from '../../shared/editorDraft';

const revisions = new Map<string, string | null>();
const consumed = new Set<string>();
const endpoint = (key: string) => '/api/editor-drafts/' + encodeURIComponent(key);

async function request(url: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init });
    if (!response.ok && response.status !== 404) {
        const data = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || '초안 서버에 연결하지 못했습니다. 편집 내용은 그대로 유지됩니다.');
    }
    return response;
}

export async function readDraft(key: string): Promise<DraftPayload | null> {
    const response = await request(endpoint(key));
    if (response.status === 404) { revisions.set(key, null); return null; }
    const { draft } = await response.json() as { draft: EditorDraft };
    revisions.set(key, draft.revision);
    return draft.payload;
}

export async function listDraftKeys(prefix: string): Promise<string[]> {
    const response = await request('/api/editor-drafts?prefix=' + encodeURIComponent(prefix));
    const { drafts } = await response.json() as { drafts: { key: string }[] };
    return drafts.map(draft => draft.key);
}

export async function writeDraft(key: string, payload: DraftPayload): Promise<DraftPayload> {
    // 아직 읽지 않은 초안은 생성만 허용한다. 다른 기기의 기존 초안을 덮어쓰지 않는다.
    const response = await request(endpoint(key), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload, expectedRevision: revisions.get(key) ?? null }),
    });
    if (!response.ok) throw new Error('초안을 저장하지 못했습니다.');
    const { draft } = await response.json() as { draft: EditorDraft };
    revisions.set(key, draft.revision);
    return draft.payload;
}

export function consumeDraft(key: string): void { consumed.add(key); }

async function deleteRevision(key: string, revision: string): Promise<void> {
    await request(endpoint(key), {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: revision }),
    });
    if (revisions.get(key) === revision) { revisions.set(key, null); consumed.delete(key); }
}

export async function deleteDraft(key: string): Promise<void> {
    const revision = revisions.get(key);
    if (revision) await deleteRevision(key, revision);
}

/** 제출을 시작할 때 버전을 캡처한다. 제출 중 저장된 새 초안은 삭제하지 않는다. */
export function captureDraftCleanup(): () => Promise<void> {
    const snapshot = [...consumed].flatMap(key => {
        const revision = revisions.get(key);
        return revision ? [{ key, revision }] : [];
    });
    return async () => {
        const results = await Promise.allSettled(snapshot.map(({ key, revision }) => deleteRevision(key, revision)));
        if (results.some(result => result.status === 'rejected')) {
            await window.Swal?.fire({ icon: 'warning', title: '문서는 제출되었습니다',
                text: '일부 초안은 정리하지 못해 보관 중입니다. 다른 기기에서 변경되었거나 연결이 끊겼을 수 있습니다.' });
        }
    };
}
