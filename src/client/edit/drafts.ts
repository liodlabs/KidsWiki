import type { DraftPayload, EditorDraft } from '../../shared/editorDraft';

const revisions = new Map<string, string | null>();
const consumed = new Set<string>();
const unconfirmed = new Map<string, { payload: DraftPayload; revision: string | null }>();
const endpoint = (key: string) => '/api/editor-drafts/' + encodeURIComponent(key);

async function request<T>(url: string, init?: RequestInit): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init, signal: controller.signal });
        if (response.status === 404 || response.status === 204) return null;
        if (!response.ok) {
            const data = await response.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error || '초안 서버에 연결하지 못했습니다. 편집 내용은 그대로 유지됩니다.');
        }
        return await response.json() as T;
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error('서버 응답이 늦어 저장 여부를 확인하지 못했습니다. 편집 내용은 그대로 유지됩니다. 연결이 돌아오면 초안 저장을 다시 눌러주세요.');
        }
        throw error;
    } finally { clearTimeout(timeout); }
}

function samePayload(a: DraftPayload, b: DraftPayload): boolean {
    return a.content === b.content && a.base === b.base && a.version === b.version
        && a.sectionIndex === b.sectionIndex && a.sectionHeading === b.sectionHeading;
}

async function recoverDraft(key: string): Promise<EditorDraft | null> {
    const pending = unconfirmed.get(key)!;
    const result = await request<{ draft: EditorDraft }>(endpoint(key));
    const draft = result?.draft;
    // 다른 기기의 사본은 읽었더라도 다음 저장의 기준 버전으로 채택하지 않는다.
    if (draft && draft.revision !== pending.revision && samePayload(draft.payload, pending.payload)) {
        revisions.set(key, draft.revision);
        unconfirmed.delete(key);
        return draft;
    }
    if ((draft?.revision ?? null) !== pending.revision) {
        throw new Error('초안이 다른 기기에서 변경되었습니다. 페이지를 다시 열어 확인한 뒤 저장해주세요.');
    }
    unconfirmed.delete(key);
    return null;
}

export async function readDraft(key: string): Promise<DraftPayload | null> {
    const result = await request<{ draft: EditorDraft }>(endpoint(key));
    revisions.set(key, result?.draft.revision ?? null);
    unconfirmed.delete(key);
    return result?.draft.payload ?? null;
}

export async function listDraftKeys(prefix: string): Promise<string[]> {
    const result = await request<{ drafts: { key: string }[] }>('/api/editor-drafts?prefix=' + encodeURIComponent(prefix));
    if (!result) throw new Error('초안 목록을 불러오지 못했습니다.');
    return result.drafts.map(draft => draft.key);
}

export async function writeDraft(key: string, payload: DraftPayload, onRemoved?: (keys: string[]) => void): Promise<DraftPayload> {
    if (unconfirmed.has(key)) {
        const recovered = await recoverDraft(key);
        if (recovered && samePayload(recovered.payload, payload)) return recovered.payload;
    }
    // 아직 읽지 않은 초안은 생성만 허용한다. 다른 기기의 기존 초안을 덮어쓰지 않는다.
    const expectedRevision = revisions.get(key) ?? null;
    unconfirmed.set(key, { payload: { ...payload }, revision: expectedRevision });
    try {
        const result = await request<{ draft: EditorDraft; removedKeys?: string[] }>(endpoint(key), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload, expectedRevision }),
        });
        if (!result) throw new Error('초안을 저장하지 못했습니다.');
        revisions.set(key, result.draft.revision);
        unconfirmed.delete(key);
        if (result.removedKeys?.length) onRemoved?.(result.removedKeys);
        return result.draft.payload;
    } catch (error) {
        try {
            const recovered = await recoverDraft(key);
            if (recovered) return recovered.payload;
        } catch { /* 연결이 돌아온 뒤 재시도할 때 저장 결과를 다시 확인한다. */ }
        throw error;
    }
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
