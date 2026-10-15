import type { McpDraftItem, McpDraftsResponse, PublishedPageItem, PublishedPagesResponse } from '../../shared/contentWorkflow';

declare global {
    interface Window { checkAuth: () => Promise<unknown>; }
}

type Stage = 'draft' | 'submitted' | 'published';
interface Submission {
    id: number; slug: string; action: string; submitted_at: string; submitted_summary: string | null;
    content_length: number; has_conflict: boolean; conflict_reason: string | null;
}
interface Review {
    slug: string; content?: string; current_content?: string; proposed_content?: string;
    has_conflict?: boolean; submitted_summary?: string | null;
}

const labels: Record<Stage, { title: string; description: string; empty: string }> = {
    draft: { title: '작성 중 초안', description: '아직 제출하지 않은 편집 초안입니다. 내용을 검토한 뒤 제출하세요.', empty: '작성 중인 초안이 없습니다.' },
    submitted: { title: '제출안', description: '제출한 내용과 현재 문서를 비교한 뒤 발행할 수 있습니다.', empty: '검토를 기다리는 제출안이 없습니다.' },
    published: { title: '발행됨', description: '내가 발행한 이력이 있는 문서입니다. 이후 다른 사람이 편집한 문서도 포함됩니다.', empty: '아직 발행한 문서가 없습니다.' },
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const dialog = $<HTMLDialogElement>('content-review');
let stage: Stage = 'draft';
let nextOffset: number | null = null;
let request: AbortController | undefined;
let reviewRequest: AbortController | undefined;
let reviewId: number | null = null;
let reviewStage: Stage = 'draft';
let reviewBusy = false;

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, { credentials: 'same-origin', ...init,
        headers: { 'Content-Type': 'application/json', ...init.headers } });
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? '로그인이 만료되었습니다. 다시 로그인해 주세요.'
        : data.message || (data.error === 'conflict' ? '다른 편집이 반영되어 충돌했습니다. 최신 내용을 다시 검토해 주세요.' : data.error) || '요청을 처리하지 못했습니다.');
    return data as T;
}

function link(label: string, url: string, primary = false) {
    const anchor = document.createElement('a');
    anchor.textContent = label;
    anchor.href = url;
    anchor.className = primary ? 'btn btn-wiki' : 'btn btn-wiki-outline';
    return anchor;
}

function button(label: string, action: (button: HTMLButtonElement) => Promise<void>, danger = false) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.className = danger ? 'btn btn-outline-danger' : 'btn btn-wiki';
    element.addEventListener('click', () => { void action(element); });
    return element;
}

function card(slug: string, meta: string) {
    const article = document.createElement('article');
    article.className = 'content-item';
    const info = document.createElement('div');
    info.className = 'content-item-info';
    const heading = document.createElement('h3');
    heading.textContent = slug;
    const details = document.createElement('p');
    details.className = 'content-meta';
    details.textContent = meta;
    info.append(heading, details);
    const actions = document.createElement('div');
    actions.className = 'content-item-actions';
    article.append(info, actions);
    return { article, info, actions };
}

function date(value: string) {
    return new Date(value).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

async function remove(element: HTMLButtonElement, slug: string, url: string, published = false) {
    if (!confirm(published
        ? `‘${slug}’ 문서를 삭제할까요? 다른 사람이 편집한 내용도 함께 숨겨지며, 관리자만 복원할 수 있습니다.`
        : `‘${slug}’ ${stage === 'draft' ? '초안' : '제출안'}을 삭제할까요? 작성한 내용은 복구할 수 없습니다. 발행된 문서는 변경하지 않습니다.`)) return;
    element.disabled = true;
    try {
        await api(url, { method: published || stage === 'draft' ? 'DELETE' : 'POST', body: '{}' });
        await load();
        $('content-status').textContent = published ? '문서를 삭제했습니다.' : '초안을 삭제했습니다.';
    } catch (error) { $('content-status').textContent = (error as Error).message; }
    finally { element.disabled = false; }
}

function renderDraft(item: McpDraftItem) {
    const row = card(item.slug, `${item.action === 'create' ? '새 문서' : '문서 수정'} · 마지막 저장 ${date(item.updated_at)} · ${item.content_length.toLocaleString()}자`);
    row.actions.append(button('검토·제출', async () => openReview(item.draft_id, item.slug)),
        button('삭제', element => remove(element, item.slug, '/api/mcp-drafts/' + item.draft_id), true));
    return row.article;
}

function renderSubmission(item: Submission) {
    const row = card(item.slug, `${item.action === 'create' ? '새 문서' : '문서 수정'} · 제출 ${date(item.submitted_at)} · ${item.content_length.toLocaleString()}자`);
    if (item.submitted_summary) {
        const summary = document.createElement('p');
        summary.textContent = item.submitted_summary;
        row.info.append(summary);
    }
    if (item.has_conflict) {
        const warning = document.createElement('p');
        warning.className = 'content-meta';
        warning.textContent = '충돌 있음 · 현재 문서가 달라져 바로 발행할 수 없습니다.';
        row.info.append(warning);
    }
    row.actions.append(button('검토·발행', async () => openReview(item.id, item.slug)),
        button('삭제', element => remove(element, item.slug, '/api/mcp-submissions/' + item.id + '/reject'), true));
    return row.article;
}

function renderPublished(item: PublishedPageItem, canDelete: boolean) {
    const row = card(item.slug, `내 발행 ${date(item.published_at)} · 현재 버전 ${item.version}`);
    if (item.my_revision_id !== item.current_revision_id) {
        const note = document.createElement('p');
        note.className = 'content-meta';
        note.textContent = '내가 발행한 뒤 다른 편집이 반영되었습니다.';
        row.info.append(note);
    }
    row.actions.append(link('문서 보기', '/w/' + encodeURIComponent(item.slug), true),
        link('편집', '/edit?slug=' + encodeURIComponent(item.slug)));
    if (canDelete) row.actions.append(button('삭제', element => remove(element, item.slug, '/api/published-pages/' + encodeURIComponent(item.slug), true), true));
    return row.article;
}

async function load(append = false) {
    request?.abort();
    const controller = request = new AbortController();
    const offset = append ? nextOffset ?? 0 : 0;
    const list = $('content-list');
    list.setAttribute('aria-busy', 'true');
    $('refresh-content').setAttribute('disabled', '');
    $('load-more-content').setAttribute('disabled', '');
    $('content-status').textContent = '목록을 불러오는 중입니다.';
    if (!append) list.replaceChildren();
    try {
        let elements: HTMLElement[];
        if (stage === 'draft') {
            const data = await api<McpDraftsResponse>('/api/mcp-drafts?status=draft&limit=20&offset=' + offset, { signal: controller.signal });
            nextOffset = data.nextOffset;
            elements = data.drafts.map(renderDraft);
        } else if (stage === 'submitted') {
            const data = await api<{ submissions: Submission[]; nextOffset: number | null }>('/api/mcp-submissions?limit=20&offset=' + offset, { signal: controller.signal });
            nextOffset = data.nextOffset;
            elements = data.submissions.map(renderSubmission);
        } else {
            const data = await api<PublishedPagesResponse>('/api/published-pages?limit=20&offset=' + offset, { signal: controller.signal });
            nextOffset = data.nextOffset;
            elements = data.pages.map(item => renderPublished(item, data.canDelete));
        }
        if (controller.signal.aborted) return;
        list.append(...elements);
        if (!list.children.length) {
            const empty = document.createElement('div');
            empty.className = 'content-empty';
            const title = document.createElement('h3');
            title.textContent = labels[stage].empty;
            const description = document.createElement('p');
            description.textContent = stage === 'draft' ? '편집 도구로 초안을 만들면 여기에 표시됩니다.' : labels[stage].description;
            empty.append(title, description);
            list.append(empty);
        }
        $('content-status').textContent = elements.length || append ? `${list.children.length}개 문서${nextOffset !== null ? ' · 더 불러올 수 있습니다.' : ''}` : '목록이 비어 있습니다.';
        $('load-more-content').hidden = nextOffset === null;
    } catch (error) {
        if (!controller.signal.aborted) {
            $('content-status').textContent = (error as Error).message;
            $('load-more-content').hidden = true;
        }
    } finally {
        if (!controller.signal.aborted) {
            list.setAttribute('aria-busy', 'false');
            $('refresh-content').removeAttribute('disabled');
            $('load-more-content').removeAttribute('disabled');
        }
    }
}

async function openReview(id: number, slug: string) {
    reviewRequest?.abort();
    const controller = reviewRequest = new AbortController();
    reviewId = id;
    reviewStage = stage;
    $('review-heading').textContent = slug;
    $('review-notice').textContent = '본문을 불러오는 중입니다.';
    $('review-bodies').replaceChildren();
    $('review-error').textContent = '';
    $<HTMLInputElement>('review-summary').value = '';
    const confirm = $<HTMLButtonElement>('review-confirm');
    confirm.disabled = true;
    confirm.textContent = reviewStage === 'draft' ? '제출하기' : '발행하기';
    dialog.showModal();
    try {
        const review = await api<Review>(reviewStage === 'draft' ? '/api/mcp-drafts/' + id : '/api/mcp-submissions/' + id, { signal: controller.signal });
        if (controller.signal.aborted) return;
        $('review-notice').textContent = review.has_conflict ? '충돌이 있어 바로 발행할 수 없습니다. 에디터에서 최신 내용과 병합해 주세요.'
            : reviewStage === 'draft' ? '제출 후에는 초안 수정이 잠깁니다. 실제 문서는 발행을 승인한 뒤 바뀝니다.' : '발행하면 아래 제안 내용이 실제 문서에 반영됩니다.';
        const bodies = reviewStage === 'draft' ? [['작성 중인 본문', review.content ?? '']]
            : [['현재 문서', review.current_content ?? ''], ['발행할 내용', review.proposed_content ?? '']];
        for (const [label, content] of bodies) {
            const section = document.createElement('section');
            const heading = document.createElement('h3');
            heading.textContent = label;
            const pre = document.createElement('pre');
            pre.textContent = content || '(빈 문서)';
            section.append(heading, pre);
            $('review-bodies').append(section);
        }
        if (review.has_conflict) $('review-notice').append(link('에디터에서 검토', '/edit?slug=' + encodeURIComponent(slug) + '&mcp_submission=' + id));
        $<HTMLInputElement>('review-summary').value = review.submitted_summary ?? '';
        confirm.disabled = !!review.has_conflict;
    } catch (error) {
        if (!controller.signal.aborted) $('review-error').textContent = (error as Error).message;
    }
}

$('review-confirm').addEventListener('click', async () => {
    if (reviewId === null || reviewBusy) return;
    reviewBusy = true;
    const confirm = $<HTMLButtonElement>('review-confirm');
    confirm.disabled = true;
    try {
        await api(reviewStage === 'draft' ? '/api/mcp-drafts/' + reviewId + '/submit' : '/api/mcp-submissions/' + reviewId + '/approve',
            { method: 'POST', body: JSON.stringify({ summary: $<HTMLInputElement>('review-summary').value }) });
        dialog.close();
        const target = reviewStage === 'draft' ? 'submitted' : 'published';
        if (location.hash === '#' + target) await load();
        else location.hash = target;
    } catch (error) { $('review-error').textContent = (error as Error).message; }
    finally { reviewBusy = false; confirm.disabled = false; }
});
dialog.addEventListener('close', () => { reviewRequest?.abort(); reviewId = null; });
dialog.addEventListener('cancel', event => { if (reviewBusy) event.preventDefault(); });
dialog.querySelector('form')!.addEventListener('submit', event => { if (reviewBusy) event.preventDefault(); });

function selectStage() {
    const hash = location.hash.slice(1);
    stage = hash === 'submitted' || hash === 'published' ? hash : 'draft';
    for (const name of ['draft', 'submitted', 'published'] as Stage[]) {
        const tab = $('stage-' + name);
        if (stage === name) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
    }
    $('content-heading').textContent = labels[stage].title;
    $('stage-description').textContent = labels[stage].description;
    $('load-more-content').hidden = true;
    void load();
}
$('refresh-content').addEventListener('click', () => { void load(); });
$('load-more-content').addEventListener('click', () => { void load(true); });
document.addEventListener('DOMContentLoaded', async () => {
    await Promise.all([window.loadConfig?.(), window.checkAuth()]);
    if (!window.currentUser) { location.href = '/login?redirect=%2Fcontent'; return; }
    window.addEventListener('hashchange', selectStage);
    selectStage();
});
