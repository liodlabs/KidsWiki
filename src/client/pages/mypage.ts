// @ts-nocheck — mypage.html 인라인 스크립트 이관(동작 보존). common.ts 와 동일 사유로 타입검사 비활성.
//
// 이관 규칙:
//  - 이 블록 안에서 function/let/const/var/매개변수로 선언되지 않은 bare 식별자 중
//    CDN/표준 전역(Swal 등)이 아닌 것은 common.ts/render.ts/diff.ts 가 window.* 로
//    노출한 공통 전역이다. 모듈 스코프에서는 bare 로 해석되지 않으므로 window.* 로 접근한다.
//    (loadConfig / checkAuth / currentUser / escapeHtml / showDiffModal / isSafeUrl /
//     loadNotificationCount / viewMessage)
//    특히 `typeof loadNotificationCount === 'function'` 은 모듈 스코프에서 'undefined' 가
//    되므로 `typeof window.loadNotificationCount` 로 바꾼다.
//  - 단, innerHTML 로 생성되는 onclick="viewMessage(...)" 같은 핸들러 문자열은 클릭 시
//    전역 스코프에서 실행되므로 viewMessage(common.ts 전역)는 문자열 안에서 bare 로 둔다.
//  - HTML(정적 + innerHTML)의 on* 속성에서 호출되는, 이 블록에서 정의한 함수
//    (updateName / loadMoreMessages / loadMoreSentMessages / loadMoreMyDiscussions /
//     revokeAllSessions / revokeAllMcpClients / refreshProfilePicture /
//     deleteDirectMessage / revokeSession / viewSentMessage)는 파일 끝에서 window.* 로 노출한다.

import { renderUserAvatar } from '../utils/avatar';

        document.addEventListener('DOMContentLoaded', async () => {
            await Promise.all([window.loadConfig(), window.checkAuth()]);
            if (!window.currentUser) {
                window.location.href = '/login';
                return;
            }
            renderProfile();
            loadContributions();
            loadWatches();
            loadNotificationsArchive();
            loadMessages();
            loadSentMessages();
            loadMyDiscussions();
            loadMyTickets();
            loadSessions();
            loadMcpClients();
            loadMcpApiKey();
            loadMcpSubmissions();
            loadAuthIdentities();
            checkNameChangeStatus();
            showPictureUpdateResult();
            showIdentityUpdateResult();

            // URL hash #mcp-submissions 가 있으면 섹션이 렌더된 뒤 스크롤.
            // 제출안이 없으면 섹션은 끝까지 hidden 으로 남으므로 무한 retry 가 되지 않게 횟수를 제한한다.
            // 약 30 회 × 150ms = 4.5초 — loadMcpSubmissions 의 fetch 가 정상 종료될 시간으로 충분.
            const hashScrollTargets = {
                '#mcp-submissions': 'mcpSubmissionsSection',
                '#notifications': 'notificationsArchiveSection',
            };
            const scrollSectionId = hashScrollTargets[window.location.hash];
            if (scrollSectionId) {
                let scrollRetries = 30;
                const tryScroll = () => {
                    const el = document.getElementById(scrollSectionId);
                    if (el && el.style.display !== 'none') {
                        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        return;
                    }
                    if (--scrollRetries > 0) setTimeout(tryScroll, 150);
                };
                setTimeout(tryScroll, 200);
            }
        });

        function showPictureUpdateResult() {
            const params = new URLSearchParams(window.location.search);
            const updated = params.get('picture_updated');
            const error = params.get('picture_error');
            if (!updated && !error) return;

            // 쿼리 제거 (새로고침 시 다시 뜨는 것 방지)
            const cleanUrl = window.location.pathname + window.location.hash;
            window.history.replaceState({}, '', cleanUrl);

            if (updated === '1') {
                Swal.fire({
                    icon: 'success',
                    title: '프로필 사진이 갱신되었습니다.',
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 1500,
                });
                return;
            }

            const errorMessages = {
                provider_not_enabled: '현재 이 OAuth 공급자가 비활성화되어 있어 사진을 갱신할 수 없습니다.',
                provider_not_supported: '이 계정의 OAuth 공급자는 프로필 사진 갱신을 지원하지 않습니다.',
                session_mismatch: '세션 정보가 일치하지 않습니다. 다시 시도해주세요.',
                account_mismatch: '재인증한 계정이 현재 로그인 계정과 일치하지 않습니다. 동일한 계정으로 다시 인증해주세요.',
                invalid_state: '요청이 만료되었거나 올바르지 않습니다. 다시 시도해주세요.',
                user_not_found: '사용자 정보를 찾을 수 없습니다.',
                private: '프로필 사진이 비공개로 설정되어 있어 갱신할 수 없습니다. 먼저 비공개를 해제해주세요.',
            };
            Swal.fire({
                icon: 'error',
                title: '프로필 사진 갱신 실패',
                text: errorMessages[error] || '알 수 없는 오류가 발생했습니다.',
            });
        }

        async function showIdentityUpdateResult() {
            const params = new URLSearchParams(window.location.search);
            const linked = params.get('identity_linked');
            const unlinked = params.get('identity_unlinked');
            const merged = params.get('identity_merged');
            const error = params.get('identity_error');
            const mergeToken = params.get('identity_merge');
            const mergePrimary = params.get('merge_primary');
            const mergeCandidate = params.get('merge_candidate');
            if (!linked && !unlinked && !merged && !error && !mergeToken) return;

            window.history.replaceState({}, '', window.location.pathname + window.location.hash);
            if (mergeToken && mergePrimary && /^[0-9a-f-]{36}$/i.test(mergeToken)) {
                const labels = { google: 'Google', discord: 'Discord', naver: '네이버', kakao: '카카오' };
                const result = await Swal.fire({
                    icon: 'warning',
                    title: '이미 별도 계정으로 사용 중입니다',
                    text: `${labels[mergeCandidate] || mergeCandidate} 계정과 현재 계정을 하나로 합칩니다. 최고관리자 계정이 우선 유지되고, 둘 다 최고관리자면 먼저 가입한 계정이 유지됩니다. 합쳐지는 계정의 세션은 모두 종료되며 되돌릴 수 없습니다.`,
                    showCancelButton: true,
                    confirmButtonText: `${labels[mergePrimary] || mergePrimary}로 다시 인증하고 합치기`,
                    cancelButtonText: '취소',
                    confirmButtonColor: '#dc3545',
                });
                if (result.isConfirmed) {
                    window.location.href = `/auth/${encodeURIComponent(mergePrimary)}?merge_token=${encodeURIComponent(mergeToken)}`;
                }
                return;
            }
            if (linked) {
                Swal.fire({
                    icon: 'success',
                    title: '로그인 계정이 연결되었습니다.',
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 1800,
                });
                return;
            }
            if (unlinked) {
                Swal.fire({
                    icon: 'success',
                    title: '로그인 연결을 해지했습니다.',
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 1800,
                });
                return;
            }
            if (merged) {
                Swal.fire({
                    icon: 'success',
                    title: '계정을 안전하게 합쳤습니다.',
                    text: '이제 연결된 어느 로그인 수단으로 인증해도 현재 계정으로 로그인됩니다.',
                });
                return;
            }

            const messages = {
                session_mismatch: '로그인 세션이 바뀌었습니다. 다시 시도해주세요.',
                provider_not_enabled: '현재 비활성화된 로그인 공급자입니다.',
                provider_already_linked: '해당 공급자의 로그인 계정이 이미 연결되어 있습니다.',
                identity_in_use: '이 로그인 계정은 이미 다른 사용자에게 연결되어 있습니다.',
                user_not_found: '사용자 계정을 찾을 수 없습니다.',
                invalid_merge_request: '계정 병합 요청이 만료되었거나 올바르지 않습니다.',
                merge_reauth_failed: '현재 계정과 동일한 기본 로그인 수단으로 다시 인증해야 합니다.',
                merge_identity_changed: '합칠 계정의 로그인 정보가 바뀌었습니다. 처음부터 다시 시도해주세요.',
                account_inactive: '탈퇴 또는 차단된 계정은 합칠 수 없습니다.',
                privileged_account: '일반 관리자 또는 토론 관리자 계정은 자동으로 합칠 수 없습니다.',
                provider_conflict: '두 계정에 같은 공급자의 로그인이 있어 자동으로 합칠 수 없습니다.',
                draft_conflict: '두 계정에 같은 문서의 초안이 있어 먼저 하나를 정리해야 합니다.',
                pending_edit_conflict: '두 계정에 같은 문서의 편집 요청이 있어 먼저 하나를 정리해야 합니다.',
                not_found: '연결된 로그인 계정을 찾을 수 없습니다.',
                last_identity: '마지막 로그인 계정은 연결 해지 대신 회원 탈퇴를 이용해주세요.',
                primary_super_admin: '최고 관리자의 기준 로그인은 추가 연결을 먼저 해지한 뒤 탈퇴할 수 있습니다.',
                protected_super_admin_email: '최고관리자 이메일은 SUPER_ADMIN_EMAILS에서 먼저 제거해야 연결이나 계정을 삭제할 수 있습니다.',
                links_remaining: '회원 탈퇴 전에 추가 로그인 연결을 먼저 해지해주세요.',
                last_super_admin: '마지막 활성 최고 관리자는 탈퇴할 수 없습니다. 다른 최고 관리자를 먼저 지정해주세요.',
                identity_reauth_failed: '해지하려는 로그인 계정과 동일한 계정으로 다시 인증해주세요.',
                identity_changed: '로그인 연결 정보가 변경되었습니다. 처음부터 다시 시도해주세요.',
                invalid_identity_action: '연동 관리 요청이 만료되었거나 올바르지 않습니다. 다시 시도해주세요.',
                provider_disconnect_unsupported: '이 로그인 공급자는 아직 안전한 연결 해제를 지원하지 않습니다.',
                provider_disconnect_failed: '로그인 공급자에서 연결을 해제하지 못했습니다. 잠시 후 다시 시도해주세요.',
                unlink_failed: '공급자 연결은 해제했지만 위키 계정 반영에 실패했습니다. 다시 인증해 시도해주세요.',
                account_delete_failed: '공급자 연결은 해제했지만 회원 탈퇴 처리에 실패했습니다. 다시 인증해 시도해주세요.',
            };
            Swal.fire('계정 연결 실패', messages[error] || '로그인 계정을 연결하지 못했습니다.', 'error');
        }

        async function loadAuthIdentities() {
            const container = document.getElementById('authIdentitiesList');
            if (!container) return;
            try {
                const res = await fetch('/api/me/identities');
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || '불러오기 실패');

                const identities = data.identities || [];
                const linked = new Set(identities.map(identity => identity.provider));
                const rows = identities.map(identity => {
                    const lockedPrimary = identity.unlink_reason === 'primary_super_admin';
                    const protectedEmail = identity.protected_email
                        || identity.unlink_reason === 'protected_super_admin_email'
                        || data.account_deletion?.reason === 'protected_super_admin_email';
                    const soleLastAdmin = identities.length === 1 && data.account_deletion?.reason === 'last_super_admin';
                    const unsupported = identity.unlink_reason === 'provider_disconnect_unsupported'
                        || data.account_deletion?.reason === 'provider_disconnect_unsupported';
                    const action = identity.can_unlink
                        ? `<button type="button" class="btn btn-sm btn-outline-danger" data-identity-unlink="${window.escapeHtml(identity.provider)}">연동 해지</button>`
                        : identities.length === 1 && data.account_deletion?.allowed
                            ? `<button type="button" class="btn btn-sm btn-outline-danger" data-identity-delete="${window.escapeHtml(identity.provider)}">회원 탈퇴</button>`
                            : protectedEmail
                                ? `<span class="text-muted" tabindex="0" role="img" aria-label="최고관리자 이메일은 SUPER_ADMIN_EMAILS에서 먼저 제거해야 연결을 해지할 수 있습니다." title="최고관리자 이메일은 SUPER_ADMIN_EMAILS에서 먼저 제거해야 연결을 해지할 수 있습니다."><i class="mdi mdi-lock-outline"></i></span>`
                                : lockedPrimary
                                    ? `<span class="text-muted" tabindex="0" role="img" aria-label="다른 로그인 연결을 모두 해지하면 회원 탈퇴가 활성화됩니다." title="다른 로그인 연결을 모두 해지하면 회원 탈퇴가 활성화됩니다."><i class="mdi mdi-lock-outline"></i></span>`
                                    : soleLastAdmin
                                    ? `<span class="text-muted" tabindex="0" role="img" aria-label="다른 활성 최고 관리자를 먼저 지정해야 탈퇴할 수 있습니다." title="다른 활성 최고 관리자를 먼저 지정해야 탈퇴할 수 있습니다."><i class="mdi mdi-lock-outline"></i></span>`
                                    : unsupported
                                        ? `<span class="text-muted" tabindex="0" role="img" aria-label="이 로그인 공급자는 아직 안전한 연결 해제를 지원하지 않습니다." title="이 로그인 공급자는 아직 안전한 연결 해제를 지원하지 않습니다."><i class="mdi mdi-lock-outline"></i></span>`
                                        : '';
                    return `
                    <div class="d-flex align-items-center justify-content-between gap-2 rounded border px-3 py-2">
                        <div class="min-w-0">
                            <strong>${window.escapeHtml(identity.label)}</strong>
                            ${identity.primary ? '<span class="badge bg-primary ms-1">기준 로그인</span>' : '<span class="badge bg-secondary ms-1">연결됨</span>'}
                            ${identity.provider_email ? `<div class="text-muted small text-truncate">${window.escapeHtml(identity.provider_email)}${identity.protected_email ? ' <span class="badge bg-dark ms-1">최고관리자 이메일</span>' : ''}</div>` : ''}
                        </div>
                        ${action}
                    </div>
                `;
                });

                for (const provider of data.available || []) {
                    if (linked.has(provider.name)) continue;
                    rows.push(`
                        <div class="d-flex align-items-center justify-content-between gap-2 rounded border px-3 py-2">
                            <strong>${window.escapeHtml(provider.label)}</strong>
                            <button type="button" class="btn btn-sm btn-wiki-outline" data-identity-link="${window.escapeHtml(provider.name)}">연결</button>
                        </div>
                    `);
                }
                container.innerHTML = rows.join('') || '<div class="text-muted small">사용 가능한 로그인 공급자가 없습니다.</div>';
                container.querySelectorAll('[data-identity-link]').forEach(button => {
                    button.addEventListener('click', () => linkAuthIdentity(button.dataset.identityLink));
                });
                container.querySelectorAll('[data-identity-unlink]').forEach(button => {
                    button.addEventListener('click', () => unlinkAuthIdentity(button.dataset.identityUnlink));
                });
                container.querySelectorAll('[data-identity-delete]').forEach(button => {
                    button.addEventListener('click', () => deleteAccount(button.dataset.identityDelete));
                });
            } catch (error) {
                container.innerHTML = '<div class="text-danger small">로그인 계정 정보를 불러오지 못했습니다.</div>';
            }
        }

        async function linkAuthIdentity(provider) {
            if (!provider) return;
            const result = await Swal.fire({
                icon: 'question',
                title: '로그인 계정 연결',
                text: '새 공급자 계정으로 로그인해 현재 계정에 연결합니다. 이미 별도 계정이라면 두 계정 소유권을 다시 확인한 뒤 병합 여부를 묻습니다.',
                showCancelButton: true,
                confirmButtonText: '계속',
                cancelButtonText: '취소',
            });
            if (result.isConfirmed) window.location.href = `/auth/${encodeURIComponent(provider)}/link`;
        }

        async function unlinkAuthIdentity(provider) {
            if (!provider) return;
            const result = await Swal.fire({
                icon: 'warning',
                title: '연결을 해제할까요?',
                text: '해제한 공급자로는 이 계정에 로그인할 수 없습니다.',
                showCancelButton: true,
                confirmButtonText: '연결 해제',
                cancelButtonText: '취소',
            });
            if (!result.isConfirmed) return;

            try {
                const response = await fetch(`/api/me/identities/${encodeURIComponent(provider)}`, { method: 'DELETE' });
                const data = await response.json();
                if (!response.ok || !data.reauth_url) {
                    Swal.fire('연동 해지 실패', data.error || '다시 시도해주세요.', 'error');
                    return;
                }
                window.location.href = data.reauth_url;
            } catch {
                Swal.fire('연동 해지 실패', '네트워크 상태를 확인하고 다시 시도해주세요.', 'error');
            }
        }

        async function refreshProfilePicture() {
            const result = await Swal.fire({
                title: '프로필 사진 갱신',
                html: '현재 로그인된 OAuth 공급자로 재인증을 진행하여<br>프로필 사진을 해당 계정의 최신 이미지로 갱신합니다.<br><small class="text-muted">직접 업로드는 지원하지 않습니다.</small>',
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: '재인증 진행',
                cancelButtonText: '취소',
            });
            if (!result.isConfirmed) return;
            window.location.href = '/auth/refresh-picture';
        }

        function renderProfile() {
            const header = document.getElementById('profileHeader');

            let roleBadge = '';
            switch (window.currentUser.role) {
                case 'super_admin':
                    roleBadge = '<span class="badge bg-dark role-badge">최고 관리자</span>';
                    break;
                case 'admin':
                    roleBadge = '<span class="badge bg-primary role-badge">관리자</span>';
                    break;
                case 'banned':
                    roleBadge = '<span class="badge bg-danger role-badge">차단됨</span>';
                    break;
                default:
                    roleBadge = '<span class="badge bg-secondary role-badge">일반 유저</span>';
            }

            const joinDate = window.currentUser.created_at
                ? new Date(window.currentUser.created_at * 1000).toLocaleDateString('ko-KR', {
                    year: 'numeric', month: 'long', day: 'numeric'
                })
                : '알 수 없음';

            const avatarInner = renderUserAvatar(
                window.currentUser.picture,
                window.currentUser.name,
                80,
                'profile-avatar-placeholder',
            );

            // 사진 비공개 상태에서는 공급자 사진 갱신 버튼을 숨긴다(갱신이 서버에서 거부됨).
            const refreshBtn = window.currentUser.picture_private
                ? ''
                : `<button type="button" class="profile-avatar-refresh"
                            onclick="refreshProfilePicture()"
                            aria-label="프로필 사진 갱신"
                            title="OAuth 재인증으로 프로필 사진 갱신">
                        <i class="mdi mdi-refresh" aria-hidden="true"></i>
                    </button>`;

            const avatarHtml = `
                <div class="profile-avatar-wrap">
                    ${avatarInner}
                    ${refreshBtn}
                </div>
            `;

            header.innerHTML = `
                ${avatarHtml}
                <div class="profile-info">
                    <h2>${window.escapeHtml(window.currentUser.name)} ${roleBadge}</h2>
                    ${window.currentUser.email ? `<div class="text-muted"><i class="mdi mdi-email"></i> ${window.escapeHtml(window.currentUser.email)}</div>` : ''}
                    <div class="text-muted"><i class="mdi mdi-calendar"></i> ${joinDate} 가입</div>
                </div>
            `;

            // 설정 섹션 표시
            document.getElementById('nameInput').value = window.currentUser.name;
            const privToggle = document.getElementById('picturePrivateToggle');
            if (privToggle) privToggle.checked = !!window.currentUser.picture_private;
            // MCP 승인 없는 즉시 반영 설정은 직접 게시 가능한 신뢰 기여자·관리자에게만 노출한다.
            const canEditWiki = !!(window.currentUser.permissions && window.currentUser.permissions['wiki:edit']);
            const canPublishDirectly = !!window.currentUser.trusted_contributor
                || !!(window.currentUser.permissions && window.currentUser.permissions['admin:access']);
            const instantApplyWrap = document.getElementById('mcpInstantApplySetting');
            const instantApplyToggle = document.getElementById('mcpInstantApplyToggle');
            if (instantApplyWrap) instantApplyWrap.style.display = canEditWiki && canPublishDirectly ? '' : 'none';
            if (instantApplyToggle) instantApplyToggle.checked = !!window.currentUser.mcp_instant_apply;
            document.getElementById('settingsSection').style.display = '';
        }

        async function togglePicturePrivacy(el) {
            const makePrivate = !!el.checked;
            el.disabled = true;
            try {
                const res = await fetch('/api/me/picture-privacy', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ private: makePrivate })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || '변경 실패');

                window.currentUser.picture_private = data.private ? 1 : 0;
                window.currentUser.picture = data.picture;
                renderProfile();

                Swal.fire({
                    icon: 'success',
                    title: makePrivate ? '프로필 사진을 비공개로 설정했습니다.' : '프로필 사진 비공개를 해제했습니다.',
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 1800,
                });
            } catch (err) {
                el.checked = !makePrivate; // 롤백
                Swal.fire('오류', err.message, 'error');
            } finally {
                el.disabled = false;
            }
        }

        async function toggleMcpInstantApply(el) {
            const enabled = !!el.checked;
            el.disabled = true;
            try {
                const res = await fetch('/api/me/mcp-instant-apply', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || '변경 실패');

                window.currentUser.mcp_instant_apply = data.enabled ? 1 : 0;

                Swal.fire({
                    icon: 'success',
                    title: enabled ? 'MCP 즉시 반영 도구를 허용했습니다.' : 'MCP 즉시 반영 도구를 비활성화했습니다.',
                    text: enabled ? '연결된 MCP 클라이언트를 새로고침하면 apply_edit과 revert_page가 노출됩니다.' : '',
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 2200,
                });
            } catch (err) {
                el.checked = !enabled; // 롤백
                Swal.fire('오류', err.message, 'error');
            } finally {
                el.disabled = false;
            }
        }

        async function loadContributions() {
            try {
                const res = await fetch('/api/me/contributions');
                if (!res.ok) throw new Error();
                const data = await res.json();
                const contributions = data.contributions || [];

                // 통계 표시
                const statsSection = document.getElementById('statsSection');
                statsSection.style.display = '';
                document.getElementById('statCards').innerHTML = `
                    <div class="stat-card">
                        <div class="stat-value">${contributions.length}</div>
                        <div class="stat-label">편집한 문서</div>
                    </div>
                `;

                // 기여 목록
                const section = document.getElementById('contributionsSection');
                section.style.display = '';
                const listEl = document.getElementById('contributionsList');

                if (contributions.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-pencil-square', title: '아직 편집한 문서가 없습니다' });
                    return;
                }

                listEl.innerHTML = contributions.map(c => {
                    const date = new Date(c.updated_at * 1000).toLocaleDateString('ko-KR');
                    const categoryBadge = c.category
                        ? `<span class="badge bg-secondary ms-1">${window.escapeHtml(c.category)}</span>`
                        : '';
                    return `
                        <div class="contribution-item">
                            <div>
                                <a href="/w/${encodeURIComponent(c.slug)}">${window.escapeHtml(c.slug)}</a>
                                ${categoryBadge}
                            </div>
                            <span class="meta">${date}</span>
                        </div>
                    `;
                }).join('');

            } catch (e) {
                document.getElementById('contributionsList').innerHTML =
                    window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오기 실패' });
            }
        }

        // ─── 주시 목록 ───────────────────────────────────────────────────
        async function loadWatches() {
            const pagesSection = document.getElementById('watchedPagesSection');
            const catsSection = document.getElementById('watchedCategoriesSection');
            const pagesList = document.getElementById('watchedPagesList');
            const catsList = document.getElementById('watchedCategoriesList');
            try {
                const res = await fetch('/api/me/watches');
                if (!res.ok) throw new Error();
                const data = await res.json();
                pagesSection.style.display = '';
                catsSection.style.display = '';
                renderWatchedPages(data.pages || []);
                renderWatchedCategories(data.categories || []);
            } catch (e) {
                pagesSection.style.display = '';
                catsSection.style.display = '';
                pagesList.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오기 실패' });
                catsList.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오기 실패' });
                document.getElementById('watchedPagesCount').textContent = '0';
                document.getElementById('watchedCategoriesCount').textContent = '0';
            }
        }

        function renderWatchedPages(items) {
            const listEl = document.getElementById('watchedPagesList');
            document.getElementById('watchedPagesCount').textContent = String(items.length);

            if (items.length === 0) {
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-eye', title: '주시 중인 문서가 없습니다' });
                return;
            }

            // 슬러그는 사용자 입력이므로 따옴표 등이 포함될 수 있다. 인라인 onclick 핸들러에
            // 문자열로 직접 보간하면 XSS 가 가능하므로 data-* 속성 + addEventListener 패턴을 사용한다.
            listEl.innerHTML = items.map(p => {
                const slug = p.slug;
                const scope = p.scope === 'subtree' ? 'subtree' : 'this';
                const scopeLabel = scope === 'subtree' ? '하위 포함' : '이 문서만';
                const scopeBadgeColor = scope === 'subtree' ? 'bg-info text-dark' : 'bg-light text-dark border';
                const otherScope = scope === 'subtree' ? 'this' : 'subtree';
                const switchLabel = scope === 'subtree' ? '이 문서만' : '하위 포함';
                const categoryBadge = p.category
                    ? `<span class="badge bg-secondary ms-1">${window.escapeHtml(p.category)}</span>`
                    : '';
                return `
                    <div class="contribution-item">
                        <div class="flex-grow-1 me-2 text-truncate">
                            <a href="/w/${encodeURIComponent(slug)}">${window.escapeHtml(slug)}</a>
                            <span class="badge ${scopeBadgeColor} ms-1">${scopeLabel}</span>
                            ${categoryBadge}
                        </div>
                        <div class="d-flex gap-1 flex-shrink-0">
                            <button class="btn btn-sm btn-outline-secondary"
                                data-watch-action="change-scope"
                                data-slug="${window.escapeHtml(slug)}"
                                data-target-scope="${otherScope}"
                                title="주시 범위 변경">
                                <i class="mdi mdi-swap-horizontal"></i> ${switchLabel}
                            </button>
                            <button class="btn btn-sm btn-outline-danger"
                                data-watch-action="unwatch-page"
                                data-slug="${window.escapeHtml(slug)}"
                                data-current-scope="${scope}"
                                title="주시 해제">
                                <i class="mdi mdi-eye-off-outline"></i> 해제
                            </button>
                        </div>
                    </div>
                `;
            }).join('');

            listEl.querySelectorAll('button[data-watch-action]').forEach(btn => {
                btn.addEventListener('click', onWatchedPageAction);
            });
        }

        function renderWatchedCategories(items) {
            const listEl = document.getElementById('watchedCategoriesList');
            document.getElementById('watchedCategoriesCount').textContent = String(items.length);

            if (items.length === 0) {
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-folder', title: '주시 중인 카테고리가 없습니다' });
                return;
            }

            // 카테고리명도 사용자 입력이므로 동일하게 data-* 속성 패턴을 사용.
            listEl.innerHTML = items.map(c => {
                const cat = c.category;
                const count = Number(c.page_count) || 0;
                return `
                    <div class="contribution-item">
                        <div class="flex-grow-1 me-2 text-truncate">
                            <a href="/w/category/${encodeURIComponent(cat)}">${window.escapeHtml(cat)}</a>
                            <span class="badge bg-light text-dark border ms-1">${count} 문서</span>
                        </div>
                        <div class="d-flex gap-1 flex-shrink-0">
                            <button class="btn btn-sm btn-outline-danger"
                                data-watch-action="unwatch-category"
                                data-category="${window.escapeHtml(cat)}"
                                title="주시 해제">
                                <i class="mdi mdi-eye-off-outline"></i> 해제
                            </button>
                        </div>
                    </div>
                `;
            }).join('');

            listEl.querySelectorAll('button[data-watch-action]').forEach(btn => {
                btn.addEventListener('click', onWatchedCategoryAction);
            });
        }

        async function onWatchedPageAction(ev) {
            const btn = ev.currentTarget;
            const action = btn.dataset.watchAction;
            const slug = btn.dataset.slug;
            if (!slug) return;
            if (action === 'change-scope') {
                await changeWatchScope(btn, slug, btn.dataset.targetScope || 'this');
            } else if (action === 'unwatch-page') {
                await unwatchPage(btn, slug, btn.dataset.currentScope || 'this');
            }
        }

        async function onWatchedCategoryAction(ev) {
            const btn = ev.currentTarget;
            if (btn.dataset.watchAction !== 'unwatch-category') return;
            const category = btn.dataset.category;
            if (!category) return;
            await unwatchCategory(btn, category);
        }

        async function changeWatchScope(btn, slug, newScope) {
            btn.disabled = true;
            try {
                const res = await fetch(`/api/w/${encodeURIComponent(slug)}/watch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scope: newScope, action: 'set' }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || '범위 변경에 실패했습니다.');
                }
                await loadWatches();
            } catch (err) {
                btn.disabled = false;
                Swal.fire('오류', err.message, 'error');
            }
        }

        async function unwatchPage(btn, slug, currentScope) {
            btn.disabled = true;
            try {
                const res = await fetch(`/api/w/${encodeURIComponent(slug)}/watch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scope: currentScope, action: 'toggle' }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || '주시 해제에 실패했습니다.');
                }
                await loadWatches();
            } catch (err) {
                btn.disabled = false;
                Swal.fire('오류', err.message, 'error');
            }
        }

        async function unwatchCategory(btn, category) {
            btn.disabled = true;
            try {
                const res = await fetch(`/api/w/category/${encodeURIComponent(category)}/watch`, {
                    method: 'POST',
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || '카테고리 주시 해제에 실패했습니다.');
                }
                await loadWatches();
            } catch (err) {
                btn.disabled = false;
                Swal.fire('오류', err.message, 'error');
            }
        }

        // ─── MCP 편집 승인 대기 ──────────────────────────────────────────
        async function loadMcpSubmissions() {
            const listEl = document.getElementById('mcpSubmissionsList');
            const section = document.getElementById('mcpSubmissionsSection');
            const countBadge = document.getElementById('mcpSubmissionsCount');
            try {
                const res = await fetch('/api/mcp-submissions');
                if (!res.ok) throw new Error();
                const data = await res.json();
                const submissions = data.submissions || [];

                // 대기 중인 제출안이 없으면 섹션 자체를 노출하지 않는다 — mypage 가 불필요하게 길어지지 않도록.
                if (submissions.length === 0) {
                    section.style.display = 'none';
                    return;
                }
                section.style.display = '';
                countBadge.textContent = String(submissions.length);

                listEl.innerHTML = '';
                for (const s of submissions) {
                    listEl.appendChild(buildMcpSubmissionItem(s));
                }
            } catch (e) {
                section.style.display = '';
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오기 실패' });
            }
        }

        function buildMcpSubmissionItem(s) {
            const wrap = document.createElement('div');
            wrap.className = 'mcp-submission-item' + (s.has_conflict ? ' has-conflict' : '');

            const head = document.createElement('div');
            head.className = 'mcp-sub-head';
            const slugLink = document.createElement('a');
            slugLink.className = 'mcp-sub-slug';
            slugLink.href = '/w/' + encodeURIComponent(s.slug);
            slugLink.textContent = s.slug;
            const actionBadge = document.createElement('span');
            actionBadge.className = 'badge ' + (s.action === 'create' ? 'bg-success' : 'bg-info text-dark');
            actionBadge.textContent = s.action === 'create' ? '신규' : '수정';
            head.appendChild(slugLink);
            head.appendChild(actionBadge);
            if (s.has_conflict) {
                const conflictBadge = document.createElement('span');
                conflictBadge.className = 'badge bg-danger';
                conflictBadge.textContent = s.conflict_reason === 'slug_taken' ? '제목 점거 충돌'
                    : s.conflict_reason === 'slug_soft_deleted' ? '소프트 삭제된 동일 제목'
                    : s.conflict_reason === 'page_missing' ? '문서 없음/삭제됨'
                    : '동시 편집 충돌';
                head.appendChild(conflictBadge);
            }
            wrap.appendChild(head);

            if (s.submitted_summary) {
                const summary = document.createElement('div');
                summary.className = 'mcp-sub-summary';
                summary.textContent = s.submitted_summary;
                wrap.appendChild(summary);
            }

            const meta = document.createElement('div');
            meta.className = 'mcp-sub-meta';
            const ts = s.submitted_at ? new Date(s.submitted_at).toLocaleString('ko-KR') : '';
            meta.textContent = `제출 ${ts} · 본문 ${s.content_length}자`;
            wrap.appendChild(meta);

            const actions = document.createElement('div');
            actions.className = 'mcp-sub-actions';
            const reviewBtn = document.createElement('button');
            reviewBtn.className = 'btn btn-sm btn-wiki';
            reviewBtn.innerHTML = '<i class="mdi mdi-eye-outline"></i> 검토';
            reviewBtn.addEventListener('click', () => openMcpSubmissionReview(s.id));
            actions.appendChild(reviewBtn);

            // 에디터에서 직접 편집/저장. 충돌이 없으면 제출안 본문이 적재된 채로 일반 편집,
            // concurrent_modification 충돌은 3-way merge UI 로 진입한다.
            // page_missing / slug_taken / slug_soft_deleted 는 에디터에서 처리할 수 없으므로 노출하지 않는다.
            // (slug_taken 은 create 액션 한정 — update 액션에서는 발생하지 않으므로 같이 가려도 무방하다.)
            const canEditInEditor = !s.has_conflict || s.conflict_reason === 'concurrent_modification';
            if (canEditInEditor) {
                const editBtn = document.createElement('button');
                editBtn.className = s.conflict_reason === 'concurrent_modification'
                    ? 'btn btn-sm btn-wiki'
                    : 'btn btn-sm btn-wiki-outline';
                editBtn.innerHTML = s.conflict_reason === 'concurrent_modification'
                    ? '<i class="mdi mdi-source-merge"></i> 에디터에서 편집/병합'
                    : '<i class="mdi mdi-pencil"></i> 편집';
                editBtn.title = '에디터에서 제출안 본문을 수정한 뒤 직접 저장합니다.';
                editBtn.addEventListener('click', () => openMcpSubmissionInEditor(s.id, s.slug));
                actions.appendChild(editBtn);
            }

            const rejectBtn = document.createElement('button');
            rejectBtn.className = 'btn btn-sm btn-wiki btn-wiki-danger';
            rejectBtn.innerHTML = '<i class="mdi mdi-close"></i> 거부';
            rejectBtn.addEventListener('click', () => rejectMcpSubmission(s.id, s.slug));
            actions.appendChild(rejectBtn);

            wrap.appendChild(actions);
            return wrap;
        }

        async function openMcpSubmissionReview(id) {
            let detail;
            try {
                const res = await fetch('/api/mcp-submissions/' + encodeURIComponent(id));
                if (!res.ok) {
                    const errBody = await res.json().catch(() => ({}));
                    Swal.fire('오류', errBody.error || '제출안을 불러오지 못했습니다.', 'error');
                    return;
                }
                detail = await res.json();
            } catch {
                Swal.fire('오류', '네트워크 오류', 'error');
                return;
            }

            // 동시 편집 충돌(concurrent_modification, action=update) 은 에디터에서 3-way merge UI 로
            // 직접 해결할 수 있다 — 그 외 충돌(슬러그 점거/소프트삭제/페이지 사라짐) 은 에디터에서 다룰 수 없다.
            const canMergeInEditor = detail.has_conflict
                && detail.action === 'update'
                && detail.conflict_reason === 'concurrent_modification';
            const conflictBanner = detail.has_conflict
                ? `<div class="alert alert-danger py-2 mb-2 text-start"><i class="mdi mdi-alert"></i> ${
                    detail.conflict_reason === 'slug_taken' ? '동일 제목의 다른 문서가 그 사이 생성되었습니다.'
                    : detail.conflict_reason === 'slug_soft_deleted' ? '동일 제목의 소프트 삭제된 문서가 존재합니다. 먼저 복원하거나 영구 삭제하지 않으면 승인할 수 없습니다.'
                    : detail.conflict_reason === 'page_missing' ? '문서가 삭제되었거나 존재하지 않습니다.'
                    : '제출 이후 다른 사용자가 페이지를 수정했습니다. 그대로 승인하면 그 변경이 덮어쓰여집니다. <b>「에디터에서 편집/병합」</b> 으로 3-way merge UI 를 사용하세요.'
                  }</div>`
                : '';
            const ts = detail.submitted_at ? new Date(detail.submitted_at).toLocaleString('ko-KR') : '';
            const summaryDefault = detail.submitted_summary || '';

            // 슬러그가 익스텐션 데이터 네임스페이스(예: freq:foo) 면 렌더링 비교가 무의미.
            // revisions.html 의 showDiff 와 동일한 정책을 적용한다.
            const enabledExts = (window.appConfig && window.appConfig.enabledExtensions) || [];
            const isExtensionDataDiff = enabledExts.some((ext) => detail.slug.startsWith(ext + ':'));

            const extraTopHtml = `
                ${conflictBanner}
                <div class="text-start small text-muted mb-2">
                    <div><b>${window.escapeHtml(detail.slug)}</b> · ${detail.action === 'create' ? '신규' : '수정'} · 제출 ${window.escapeHtml(ts)}</div>
                    <div>+${detail.lines_added}줄 / -${detail.lines_removed}줄</div>
                </div>
                <div class="mt-1 mb-2 text-start">
                    <label class="form-label small mb-1">편집 요약</label>
                    <input type="text" id="mcpApproveSummary" class="form-control form-control-sm" maxlength="255" value="${window.escapeHtml(summaryDefault)}">
                </div>
            `;

            const result = await window.showDiffModal({
                title: 'MCP 편집안 검토',
                oldText: detail.current_content || '',
                newText: detail.proposed_content || '',
                slug: detail.slug,
                forceRaw: isExtensionDataDiff,
                width: '1100px',
                extraTopHtml,
                swalOptions: {
                    showCancelButton: true,
                    showDenyButton: true,
                    // 동시 편집 충돌인 경우 그대로 승인하면 다른 사용자 변경을 덮어쓰므로,
                    // 승인 버튼을 「에디터에서 해결」로 바꿔 3-way merge 화면으로 유도한다.
                    confirmButtonText: canMergeInEditor
                        ? '<i class="mdi mdi-source-merge"></i> 에디터에서 편집/병합'
                        : '<i class="mdi mdi-check"></i> 승인',
                    denyButtonText: '<i class="mdi mdi-close"></i> 거부',
                    cancelButtonText: '닫기',
                    confirmButtonColor: canMergeInEditor ? '#F59E0B' : '#10B981',
                    denyButtonColor: '#EF4444',
                    preConfirm: () => {
                        const input = document.getElementById('mcpApproveSummary');
                        return { summary: input ? input.value : '' };
                    },
                },
            });

            if (result.isConfirmed) {
                if (canMergeInEditor) {
                    openMcpSubmissionInEditor(id, detail.slug);
                } else {
                    await approveMcpSubmission(id, result.value && result.value.summary);
                }
            } else if (result.isDenied) {
                await rejectMcpSubmission(id, detail.slug);
            }
        }

        function openMcpSubmissionInEditor(id, slug) {
            // edit.html 에서 ?mcp_submission= 을 보면 제출안 본문을 에디터에 적재한다.
            // concurrent_modification 충돌이면 base/ours/theirs 3-way merge 모달까지 자동으로 띄우고,
            // 충돌이 없으면 그대로 일반 편집/저장 흐름이다 (src/client/edit/main.ts).
            const url = '/edit?slug=' + encodeURIComponent(slug) + '&mcp_submission=' + encodeURIComponent(id);
            window.location.href = url;
        }

        async function approveMcpSubmission(id, summary) {
            try {
                const res = await fetch('/api/mcp-submissions/' + encodeURIComponent(id) + '/approve', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ summary }),
                });
                const data = await res.json();
                if (!res.ok) {
                    const msg = data.error === 'conflict'
                        ? '충돌이 발생해 승인할 수 없습니다. 페이지 상태를 확인하세요.'
                        : (data.message || data.error || '승인 실패');
                    Swal.fire('승인 실패', msg, 'error');
                    return;
                }
                await Swal.fire({
                    icon: 'success',
                    title: '승인되었습니다.',
                    text: `리비전 #${data.revision_id} 가 생성되었습니다. (+${data.lines_added ?? 0}줄 -${data.lines_removed ?? 0}줄)`,
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 2500,
                });
                loadMcpSubmissions();
            } catch {
                Swal.fire('오류', '네트워크 오류', 'error');
            }
        }

        async function rejectMcpSubmission(id, slug) {
            const confirmRes = await Swal.fire({
                icon: 'warning',
                title: '제출안을 거부하시겠습니까?',
                text: `"${slug}" 의 제출안을 폐기합니다. 되돌릴 수 없습니다.`,
                showCancelButton: true,
                confirmButtonText: '거부',
                cancelButtonText: '취소',
                confirmButtonColor: '#EF4444',
            });
            if (!confirmRes.isConfirmed) return;
            try {
                const res = await fetch('/api/mcp-submissions/' + encodeURIComponent(id) + '/reject', { method: 'POST' });
                if (!res.ok) {
                    const errBody = await res.json().catch(() => ({}));
                    Swal.fire('거부 실패', errBody.error || '거부에 실패했습니다.', 'error');
                    return;
                }
                loadMcpSubmissions();
            } catch {
                Swal.fire('오류', '네트워크 오류', 'error');
            }
        }

        // (편집 요청 검토 UI 는 문서 열람 페이지로 이전됨 — index.ts 의 편집 버튼 배지/드롭다운 참조)

        async function updateName() {
            const name = document.getElementById('nameInput').value.trim();
            if (!name) {
                Swal.fire('오류', '이름을 입력해주세요.', 'warning');
                return;
            }
            if (name.length > 20) {
                Swal.fire('오류', '표시명은 20자 이내로 입력해주세요.', 'warning');
                return;
            }

            try {
                const res = await fetch('/api/me/profile', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || '변경 실패');

                window.currentUser.name = data.name;
                renderProfile();
                checkNameChangeStatus();

                Swal.fire({
                    icon: 'success',
                    title: '이름이 변경되었습니다!',
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 1500
                });
            } catch (err) {
                Swal.fire('오류', err.message, 'error');
            }
        }

        async function checkNameChangeStatus() {
            try {
                const res = await fetch('/api/me/namechange-status');
                if (!res.ok) return;
                const data = await res.json();

                const btn = document.getElementById('nameChangeBtn');
                const input = document.getElementById('nameInput');
                const statusEl = document.getElementById('nameChangeStatus');
                const hintEl = document.getElementById('nameChangeHint');

                if (!data.allowed) {
                    btn.disabled = true;
                    input.disabled = true;

                    if (data.reason === 'disabled') {
                        statusEl.innerHTML = '<div class="alert alert-secondary py-2 mb-0"><i class="mdi mdi-lock"></i> 표시명 변경이 비활성화되어 있습니다.</div>';
                        hintEl.style.display = 'none';
                    } else if (data.reason === 'cooldown') {
                        statusEl.innerHTML = `<div class="alert alert-warning py-2 mb-0"><i class="mdi mdi-clock-outline"></i> ${window.escapeHtml(data.message)}</div>`;
                    }
                    statusEl.style.display = '';
                } else {
                    btn.disabled = false;
                    input.disabled = false;
                    statusEl.style.display = 'none';
                    hintEl.style.display = '';

                    if (data.reason === 'first_change') {
                        hintEl.textContent = '최초 1회 변경은 제한 없이 가능합니다.';
                    } else {
                        hintEl.textContent = '다른 유저에게 보이는 이름입니다.';
                    }
                }
            } catch (e) {
                // 조회 실패 시 기본 상태 유지
            }
        }

        let currentMessageOffset = 0;
        const MESSAGE_LIMIT = 10;

        async function loadMessages(isLoadMore = false) {
            if (!isLoadMore) {
                currentMessageOffset = 0;
            }

            try {
                const res = await fetch(`/api/messages?offset=${currentMessageOffset}&limit=${MESSAGE_LIMIT}`);
                if (!res.ok) throw new Error();
                const data = await res.json();
                const messages = data.messages || [];

                const section = document.getElementById('messagesSection');
                section.style.display = '';
                const listEl = document.getElementById('messagesList');
                const loadMoreBtn = document.getElementById('loadMoreMessagesBtn');

                if (!isLoadMore && messages.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'mdi mdi-inbox-outline', title: '받은 쪽지가 없습니다' });
                    loadMoreBtn.classList.add('d-none');
                    return;
                }

                if (!isLoadMore) {
                    listEl.innerHTML = '';
                }

                listEl.insertAdjacentHTML('beforeend', messages.map(m => {
                    const date = new Date(m.created_at * 1000).toLocaleString('ko-KR');
                    // title 형식으로 조금 잘라서 보여주기
                    const preview = m.content.length > 50 ? window.escapeHtml(m.content.substring(0, 50)) + '...' : window.escapeHtml(m.content);
                    const senderName = m.sender_name || '알 수 없음';

                    return `
                        <div class="contribution-item" style="cursor:pointer;" onclick="viewMessage(${m.id})">
                            <div class="flex-grow-1">
                                <span class="fw-bold"><i class="mdi mdi-account-circle text-muted"></i> ${window.escapeHtml(senderName)}</span>
                                <span class="text-muted ms-2">${preview}</span>
                            </div>
                            <div class="d-flex align-items-center gap-3">
                                <span class="meta">${date}</span>
                                <button class="btn btn-sm btn-outline-danger border-0 p-1" onclick="event.stopPropagation(); deleteDirectMessage(${m.id})" title="보관함에서 삭제">
                                    <i class="mdi mdi-delete"></i>
                                </button>
                            </div>
                        </div>
                    `;
                }).join(''));

                currentMessageOffset += messages.length;

                if (data.has_more) {
                    loadMoreBtn.classList.remove('d-none');
                } else {
                    loadMoreBtn.classList.add('d-none');
                }

            } catch (e) {
                if (!isLoadMore) {
                    document.getElementById('messagesList').innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '쪽지를 불러오지 못했습니다' });
                }
            }
        }

        async function loadMoreMessages() {
            const btn = document.getElementById('loadMoreMessagesBtn');
            btn.disabled = true;
            btn.innerHTML = window.uiInlineLoading();
            await loadMessages(true);
            btn.disabled = false;
            btn.innerHTML = '더보기 <i class="mdi mdi-chevron-down"></i>';
        }

        // ── 알림 보관함 (마이페이지) ──
        const NOTIF_ARCHIVE_LIMIT = 20;
        let currentNotifArchiveOffset = 0;
        let notifArchiveDelegated = false;

        const NOTIF_ICON_MAP = {
            'discussion_comment': 'mdi mdi-comment-text-outline',
            'banned': 'mdi mdi-block-helper',
            'message': 'mdi mdi-email-outline',
            'ticket_created': 'mdi mdi-ticket-outline',
            'ticket_comment': 'mdi mdi-ticket-confirmation-outline',
            'pending_edit': 'mdi mdi-clock-edit-outline',
            'pending_edit_result': 'mdi mdi-pencil-outline',
        };

        async function loadNotificationsArchive(isLoadMore = false) {
            if (!isLoadMore) currentNotifArchiveOffset = 0;
            const section = document.getElementById('notificationsArchiveSection');
            const listEl = document.getElementById('notificationsArchiveList');
            const loadMoreBtn = document.getElementById('loadMoreNotifArchiveBtn');
            const unreadBadge = document.getElementById('notifArchiveUnreadBadge');
            if (!section || !listEl) return;

            try {
                const res = await fetch(`/api/notifications?offset=${currentNotifArchiveOffset}&limit=${NOTIF_ARCHIVE_LIMIT}`);
                if (!res.ok) throw new Error();
                const data = await res.json();
                const notifs = data.notifications || [];
                section.style.display = '';

                if (!isLoadMore && notifs.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'mdi mdi-inbox-outline', title: '보관된 알림이 없습니다' });
                    loadMoreBtn?.classList.add('d-none');
                    if (unreadBadge) unreadBadge.classList.add('d-none');
                    return;
                }

                if (!isLoadMore) listEl.innerHTML = '';

                listEl.insertAdjacentHTML('beforeend', notifs.map(n => {
                    const icon = NOTIF_ICON_MAP[n.type] || 'mdi mdi-bell';
                    const date = new Date(n.created_at * 1000).toLocaleString('ko-KR');
                    const unreadCls = n.read_at ? '' : ' unread';
                    return `
                        <div class="contribution-item notif-archive-item${unreadCls}" style="cursor:pointer;"
                             data-notif-id="${window.escapeHtml(String(n.id))}"
                             data-notif-type="${window.escapeHtml(n.type)}"
                             data-notif-ref="${window.escapeHtml(String(n.ref_id || ''))}"
                             data-notif-link="${window.escapeHtml(n.link || '')}">
                            <i class="${icon} text-muted me-1"></i>
                            <div class="flex-grow-1 text-truncate">
                                <span class="notif-archive-text">${window.escapeHtml(n.content)}</span>
                            </div>
                            <div class="d-flex align-items-center gap-3 flex-shrink-0">
                                <span class="meta">${date}</span>
                                <button class="btn btn-sm btn-outline-danger border-0 p-1" data-notif-delete="${window.escapeHtml(String(n.id))}" title="삭제">
                                    <i class="mdi mdi-delete"></i>
                                </button>
                            </div>
                        </div>
                    `;
                }).join(''));

                currentNotifArchiveOffset += notifs.length;
                if (data.has_more) loadMoreBtn?.classList.remove('d-none');
                else loadMoreBtn?.classList.add('d-none');

                // 안 읽은 알림 배지 동기화
                if (unreadBadge) {
                    try {
                        const cntRes = await fetch('/api/notifications/count');
                        const cntData = cntRes.ok ? await cntRes.json() : { count: 0 };
                        const cnt = Number(cntData.count) || 0;
                        if (cnt > 0) {
                            unreadBadge.textContent = cnt > 99 ? '99+' : String(cnt);
                            unreadBadge.classList.remove('d-none');
                        } else {
                            unreadBadge.classList.add('d-none');
                        }
                    } catch (_) { /* 무시 */ }
                }

                if (!notifArchiveDelegated) {
                    notifArchiveDelegated = true;
                    listEl.addEventListener('click', (e) => {
                        const delBtn = e.target.closest('[data-notif-delete]');
                        if (delBtn) {
                            e.stopPropagation();
                            deleteNotificationArchiveItem(parseInt(delBtn.dataset.notifDelete, 10));
                            return;
                        }
                        const item = e.target.closest('[data-notif-id]');
                        if (item) openNotificationArchiveItem(item);
                    });
                }
            } catch (e) {
                section.style.display = '';
                if (!isLoadMore) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '알림을 불러오지 못했습니다' });
                }
            }
        }

        function openNotificationArchiveItem(item) {
            const id = parseInt(item.dataset.notifId, 10);
            const type = item.dataset.notifType;
            const refId = item.dataset.notifRef ? parseInt(item.dataset.notifRef, 10) : null;
            const link = item.dataset.notifLink || null;

            // 읽음 처리 (백그라운드)
            if (item.classList.contains('unread')) {
                fetch(`/api/notifications/${id}/read`, { method: 'POST' }).then(() => {
                    item.classList.remove('unread');
                    if (typeof window.loadNotificationCount === 'function') window.loadNotificationCount();
                    syncNotifArchiveUnreadBadge();
                }).catch(() => { /* 무시 */ });
            }

            if (type === 'message' && refId) {
                window.viewMessage(refId);
            } else if (link && link !== 'null' && window.isSafeUrl(link)) {
                window.location.href = link;
            }
        }

        async function syncNotifArchiveUnreadBadge() {
            const unreadBadge = document.getElementById('notifArchiveUnreadBadge');
            if (!unreadBadge) return;
            try {
                const res = await fetch('/api/notifications/count');
                const data = res.ok ? await res.json() : { count: 0 };
                const cnt = Number(data.count) || 0;
                if (cnt > 0) {
                    unreadBadge.textContent = cnt > 99 ? '99+' : String(cnt);
                    unreadBadge.classList.remove('d-none');
                } else {
                    unreadBadge.classList.add('d-none');
                }
            } catch (_) { /* 무시 */ }
        }

        async function loadMoreNotificationsArchive() {
            const btn = document.getElementById('loadMoreNotifArchiveBtn');
            if (btn) { btn.disabled = true; btn.innerHTML = window.uiInlineLoading(); }
            await loadNotificationsArchive(true);
            if (btn) { btn.disabled = false; btn.innerHTML = '더보기 <i class="mdi mdi-chevron-down"></i>'; }
        }

        async function deleteNotificationArchiveItem(id) {
            const numId = parseInt(id, 10);
            if (isNaN(numId)) return;
            try {
                const res = await fetch(`/api/notifications/${numId}`, { method: 'DELETE' });
                if (!res.ok) throw new Error();
                await loadNotificationsArchive();
                if (typeof window.loadNotificationCount === 'function') window.loadNotificationCount();
            } catch (e) {
                Swal.fire('오류', '알림 삭제에 실패했습니다.', 'error');
            }
        }

        async function markAllNotificationsReadArchive() {
            try {
                const res = await fetch('/api/notifications/read-all', { method: 'POST' });
                if (!res.ok) throw new Error();
                await loadNotificationsArchive();
                if (typeof window.loadNotificationCount === 'function') window.loadNotificationCount();
            } catch (e) {
                Swal.fire('오류', '알림 읽음 처리에 실패했습니다.', 'error');
            }
        }

        async function deleteAllNotificationsArchive() {
            const result = await Swal.fire({
                title: '알림 전체 삭제',
                text: '보관된 모든 알림을 삭제합니다. 이 작업은 되돌릴 수 없습니다.',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#dc3545',
                confirmButtonText: '전체 삭제',
                cancelButtonText: '취소',
            });
            if (!result.isConfirmed) return;
            try {
                const res = await fetch('/api/notifications', { method: 'DELETE' });
                if (!res.ok) throw new Error();
                await loadNotificationsArchive();
                if (typeof window.loadNotificationCount === 'function') window.loadNotificationCount();
            } catch (e) {
                Swal.fire('오류', '알림 삭제에 실패했습니다.', 'error');
            }
        }

        async function deleteAccount(provider) {
            if (!provider) return;
            const result = await Swal.fire({
                title: '회원탈퇴',
                html: '정말로 탈퇴하시겠습니까?<br><strong>탈퇴 후 동일 계정으로 재가입이 불가능합니다.</strong>',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: '탈퇴',
                cancelButtonText: '취소',
                input: 'text',
                inputPlaceholder: '확인을 위해 "탈퇴"를 입력해주세요',
                inputValidator: (value) => {
                    if (value !== '탈퇴') {
                        return '"탈퇴"를 정확히 입력해주세요.';
                    }
                }
            });

            if (result.isConfirmed) {
                try {
                    const response = await fetch('/api/me/account', { method: 'DELETE' });
                    const data = await response.json();
                    if (!response.ok || !data.reauth_url) {
                        Swal.fire('회원 탈퇴 실패', data.error || '다시 시도해주세요.', 'error');
                        return;
                    }
                    window.location.href = data.reauth_url;
                } catch {
                    Swal.fire('회원 탈퇴 실패', '네트워크 상태를 확인하고 다시 시도해주세요.', 'error');
                }
            }
        }

        function summarizeUserAgent(ua) {
            if (!ua) return { label: '알 수 없는 기기', icon: 'mdi-help-circle-outline' };
            const s = ua;

            let os = '기타 OS';
            if (/Windows NT 10\.0/.test(s)) os = 'Windows 10/11';
            else if (/Windows NT/.test(s)) os = 'Windows';
            else if (/Android/.test(s)) os = 'Android';
            else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
            else if (/Mac OS X/.test(s)) os = 'macOS';
            else if (/Linux/.test(s)) os = 'Linux';

            let browser = '알 수 없는 브라우저';
            if (/Edg\//.test(s)) browser = 'Edge';
            else if (/OPR\//.test(s)) browser = 'Opera';
            else if (/Chrome\//.test(s) && !/Chromium/.test(s)) browser = 'Chrome';
            else if (/Firefox\//.test(s)) browser = 'Firefox';
            else if (/Safari\//.test(s) && !/Chrome\//.test(s)) browser = 'Safari';

            let icon = 'mdi-monitor';
            if (/Mobile|Android|iPhone|iPod/.test(s)) icon = 'mdi-cellphone';
            else if (/iPad|Tablet/.test(s)) icon = 'mdi-tablet';

            return { label: `${browser} · ${os}`, icon };
        }

        async function loadSessions() {
            const section = document.getElementById('sessionsSection');
            const listEl = document.getElementById('sessionsList');
            try {
                const res = await fetch('/api/me/sessions');
                if (!res.ok) throw new Error();
                const data = await res.json();
                const sessions = data.sessions || [];

                section.style.display = '';

                if (sessions.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-shield-lock', title: '활성 세션이 없습니다' });
                    return;
                }

                const hasOthers = sessions.some(s => !s.current);
                document.getElementById('revokeAllSessionsBtn').disabled = !hasOthers;

                listEl.innerHTML = sessions.map(s => {
                    const info = summarizeUserAgent(s.user_agent);
                    const created = s.created_at
                        ? new Date(s.created_at * 1000).toLocaleString('ko-KR')
                        : '알 수 없음';
                    const expires = s.expires_at
                        ? new Date(s.expires_at * 1000).toLocaleString('ko-KR')
                        : '알 수 없음';
                    const currentBadge = s.current
                        ? '<span class="badge bg-primary session-current-badge">현재 세션</span>'
                        : '';
                    const action = s.current
                        ? '<a href="/auth/logout" class="btn btn-sm btn-outline-secondary"><i class="mdi mdi-logout"></i> 로그아웃</a>'
                        : `<button class="btn btn-sm btn-outline-danger" onclick="revokeSession('${encodeURIComponent(s.id)}')"><i class="mdi mdi-close-circle"></i> 종료</button>`;
                    const uaRaw = s.user_agent
                        ? `<div class="session-ua-raw">${window.escapeHtml(s.user_agent)}</div>`
                        : '<div class="session-ua-raw text-muted">User-Agent 정보 없음</div>';

                    return `
                        <div class="session-item ${s.current ? 'current' : ''}">
                            <div class="session-meta">
                                <div class="session-ua">
                                    <i class="mdi ${info.icon}"></i> ${window.escapeHtml(info.label)} ${currentBadge}
                                </div>
                                ${uaRaw}
                                <div class="session-times">
                                    <span><i class="mdi mdi-clock-outline"></i> 로그인: ${created}</span>
                                    <span><i class="mdi mdi-timer-sand"></i> 만료: ${expires}</span>
                                </div>
                            </div>
                            <div class="flex-shrink-0">${action}</div>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                section.style.display = '';
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '세션 목록을 불러오지 못했습니다' });
            }
        }

        async function revokeSession(encodedId) {
            const id = decodeURIComponent(encodedId);
            const result = await Swal.fire({
                title: '세션 종료',
                text: '이 기기의 로그인을 즉시 종료합니다. 계속하시겠습니까?',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: '종료',
                cancelButtonText: '취소',
            });
            if (!result.isConfirmed) return;

            try {
                const res = await fetch(`/api/me/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || '세션 종료에 실패했습니다.');

                Swal.fire({ icon: 'success', title: '세션이 종료되었습니다.', toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
                loadSessions();
            } catch (err) {
                Swal.fire('오류', err.message, 'error');
            }
        }

        async function revokeAllSessions() {
            const result = await Swal.fire({
                title: '다른 세션 모두 종료',
                text: '현재 세션을 제외한 모든 로그인 세션을 종료합니다. 계속하시겠습니까?',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: '모두 종료',
                cancelButtonText: '취소',
            });
            if (!result.isConfirmed) return;

            try {
                const res = await fetch('/api/me/sessions', { method: 'DELETE' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || '세션 종료에 실패했습니다.');

                Swal.fire({
                    icon: 'success',
                    title: `${data.count || 0}개의 세션이 종료되었습니다.`,
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 1500,
                });
                loadSessions();
            } catch (err) {
                Swal.fire('오류', err.message, 'error');
            }
        }

        function formatMcpTime(epochSec) {
            if (!epochSec) return '알 수 없음';
            return new Date(epochSec * 1000).toLocaleString('ko-KR');
        }

        function formatMcpRelative(epochSec) {
            if (!epochSec) return '없음';
            const diff = Math.floor(Date.now() / 1000) - epochSec;
            if (diff < 60) return '방금 전';
            if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
            if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
            if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}일 전`;
            return new Date(epochSec * 1000).toLocaleDateString('ko-KR');
        }

        async function loadMcpClients() {
            const section = document.getElementById('wikiMcpSection');
            const listEl = document.getElementById('mcpClientsList');
            if (!section || !listEl) return;

            // 위키 MCP 엔드포인트 URL 및 API 키 JSON 스니펫 세팅 (origin + /api/mcp)
            const wikiEndpointEl = document.getElementById('wikiMcpEndpointUrl');
            if (wikiEndpointEl) wikiEndpointEl.textContent = window.location.origin + '/api/mcp';

            const jsonSnippetEl = document.getElementById('mcpApiKeyJsonSnippet');
            if (jsonSnippetEl) {
                const endpoint = window.location.origin + '/api/mcp';
                jsonSnippetEl.textContent = JSON.stringify({
                    mcpServers: {
                        kidswiki: {
                            url: endpoint,
                            headers: {
                                Authorization: "Bearer YOUR_API_KEY"
                            }
                        }
                    }
                }, null, 2);
            }

            try {
                const res = await fetch('/api/me/mcp-clients');
                if (!res.ok) throw new Error();
                const data = await res.json();
                const clients = data.clients || [];

                section.style.display = '';

                if (clients.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-plug', title: '연결된 MCP 클라이언트가 없습니다' });
                    document.getElementById('revokeAllMcpClientsBtn').disabled = true;
                    return;
                }

                const hasActive = clients.some(c => c.status === 'active');
                document.getElementById('revokeAllMcpClientsBtn').disabled = !hasActive;

                listEl.innerHTML = clients.map(client => {
                    const isActive = client.status === 'active';
                    const statusBadge = isActive
                        ? '<span class="badge bg-success">연결됨</span>'
                        : '<span class="badge bg-secondary">해제됨</span>';
                    const clientLabel = client.client_name
                        ? window.escapeHtml(client.client_name)
                        : '<span class="text-muted">(이름 미등록 클라이언트)</span>';
                    const clientIdShort = window.escapeHtml((client.client_id || '').slice(0, 12)) + '…';
                    const scopeList = Array.isArray(client.scopes) && client.scopes.length
                        ? client.scopes
                        : ['mcp'];
                    const scopeLabel = scopeList.map(s => window.escapeHtml(s)).join(', ');
                    const lastUsed = client.last_used_at ? formatMcpRelative(client.last_used_at) : '미사용';
                    const revokedAt = client.last_revoked_at ? formatMcpTime(client.last_revoked_at) : null;

                    const action = isActive
                        ? `<button class="btn btn-sm btn-outline-danger" data-revoke-client-id="${window.escapeHtml(client.client_id)}"><i class="mdi mdi-close-circle"></i> 연결 해제</button>`
                        : '';

                    const lastLine = revokedAt
                        ? `<span><i class="mdi mdi-cancel"></i> 해제: ${window.escapeHtml(revokedAt)}</span>`
                        : '';

                    return `
                        <div class="session-item ${isActive ? '' : 'opacity-75'}">
                            <div class="session-meta">
                                <div class="session-ua">
                                    <i class="mdi mdi-application-brackets-outline"></i> ${clientLabel} ${statusBadge}
                                </div>
                                <div class="session-ua-raw text-muted">
                                    client_id: <code>${clientIdShort}</code> · scope: <code>${scopeLabel}</code>
                                </div>
                                <div class="session-times">
                                    <span><i class="mdi mdi-history"></i> 마지막 사용: ${window.escapeHtml(lastUsed)}</span>
                                    ${lastLine}
                                </div>
                            </div>
                            <div class="flex-shrink-0">${action}</div>
                        </div>
                    `;
                }).join('');

                listEl.querySelectorAll('button[data-revoke-client-id]').forEach(btn => {
                    btn.addEventListener('click', () => {
                        revokeMcpClient(btn.getAttribute('data-revoke-client-id') || '');
                    });
                });
            } catch (e) {
                section.style.display = '';
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: 'MCP 클라이언트 목록을 불러오지 못했습니다' });
            }
        }

        function copyWikiMcpEndpoint() {
            const url = (document.getElementById('wikiMcpEndpointUrl') as HTMLElement)?.textContent || '';
            navigator.clipboard.writeText(url).then(() => {
                Swal.fire({ icon: 'success', title: '복사됨', toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
            }).catch(() => {
                Swal.fire({ icon: 'error', title: '복사 실패', toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
            });
        }

        function copyMcpApiKeyJsonSnippet() {
            const text = (document.getElementById('mcpApiKeyJsonSnippet') as HTMLElement)?.textContent || '';
            navigator.clipboard.writeText(text).then(() => {
                Swal.fire({ icon: 'success', title: '복사됨', toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
            }).catch(() => {
                Swal.fire({ icon: 'error', title: '복사 실패', toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
            });
        }

        async function revokeMcpClient(clientId) {
            if (!clientId) return;
            const result = await Swal.fire({
                title: 'MCP 클라이언트 연결 해제',
                text: '이 클라이언트가 보유한 모든 토큰을 즉시 무효화합니다. 해당 클라이언트는 재인증해야 다시 접근할 수 있습니다. 계속하시겠습니까?',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: '연결 해제',
                cancelButtonText: '취소',
            });
            if (!result.isConfirmed) return;

            try {
                const res = await fetch(`/api/me/mcp-clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || 'MCP 클라이언트 연결 해제에 실패했습니다.');

                Swal.fire({ icon: 'success', title: '연결이 해제되었습니다.', toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
                loadMcpClients();
            } catch (err) {
                Swal.fire('오류', err.message, 'error');
            }
        }

        async function revokeAllMcpClients() {
            const result = await Swal.fire({
                title: '모든 MCP 클라이언트 연결 해제',
                text: '본 계정에 연결된 모든 활성 MCP 클라이언트의 토큰을 일괄 무효화합니다. 외부 MCP 클라이언트는 재인증해야 합니다. 계속하시겠습니까?',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: '모두 해제',
                cancelButtonText: '취소',
            });
            if (!result.isConfirmed) return;

            try {
                const res = await fetch('/api/me/mcp-clients', { method: 'DELETE' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || 'MCP 클라이언트 연결 해제에 실패했습니다.');

                Swal.fire({
                    icon: 'success',
                    title: `${data.count || 0}개의 토큰이 무효화되었습니다.`,
                    toast: true,
                    position: 'top-end',
                    showConfirmButton: false,
                    timer: 1500,
                });
                loadMcpClients();
            } catch (err) {
                Swal.fire('오류', err.message, 'error');
            }
        }

        async function loadMcpApiKey() {
            const section = document.getElementById('wikiMcpSection');
            const container = document.getElementById('mcpApiKeyContainer');
            const generateBtn = document.getElementById('generateMcpApiKeyBtn');
            const usage = document.getElementById('mcpApiKeyUsage');
            if (!container || !generateBtn || !usage) return;
            generateBtn.disabled = true;
            try {
                const res = await fetch('/api/me/mcp-api-keys', { cache: 'no-store' });
                if (!res.ok) throw new Error();
                const { apiKeys, limit } = await res.json();
                const now = Date.now() / 1000;
                const activeCount = apiKeys.filter(key => key.expires_at === null || key.expires_at > now).length;
                usage.textContent = `유효한 키 ${activeCount} / ${limit}개 · 만료된 키는 한도에서 제외됩니다.`
                    + (activeCount >= limit ? ' 새 키를 추가하려면 기존 키를 삭제해주세요.' : '');
                generateBtn.disabled = activeCount >= limit;
                if (section) section.style.display = '';
                container.innerHTML = apiKeys.length ? apiKeys.map(apiKey => {
                    const expired = apiKey.expires_at !== null && apiKey.expires_at <= now;
                    const expires = apiKey.expires_at === null ? '무기한' : expired ? '만료됨'
                        : `${new Date(apiKey.expires_at * 1000).toLocaleString('ko-KR')} 만료`;
                    return `<div class="border rounded p-3 mb-2">
                        <div class="d-flex flex-wrap align-items-center justify-content-between gap-2">
                            <strong class="text-break">${window.escapeHtml(apiKey.name)}</strong>
                            <button type="button" class="btn btn-sm btn-outline-danger" data-key-id="${window.escapeHtml(apiKey.id)}"
                                aria-label="${window.escapeHtml(apiKey.name)} 키 삭제">삭제</button>
                        </div>
                        <code class="d-block text-break my-1">${window.escapeHtml(apiKey.masked_key)}</code>
                        <div class="small text-muted">발급: ${new Date(apiKey.created_at * 1000).toLocaleString('ko-KR')}</div>
                        <div class="small ${expired ? 'text-danger' : 'text-muted'}">${expires}</div>
                    </div>`;
                }).join('') : '<div class="text-center text-muted py-2">발급된 API 키가 없습니다.</div>';
                container.querySelectorAll('[data-key-id]').forEach(button => {
                    button.addEventListener('click', () => deleteMcpApiKey(button.dataset.keyId));
                });
            } catch {
                if (section) section.style.display = '';
                usage.textContent = '';
                container.innerHTML = '<div class="text-danger py-2">API 키 정보를 불러오지 못했습니다.</div>';
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.className = 'btn btn-sm btn-wiki-outline';
                retry.textContent = '다시 불러오기';
                retry.addEventListener('click', loadMcpApiKey);
                container.append(retry);
            }
        }

        async function generateMcpApiKey() {
            const result = await Swal.fire({
                title: 'API 키 추가',
                html: `<div class="text-start">
                    <label for="mcpKeyName" class="form-label">키 이름</label>
                    <input id="mcpKeyName" class="form-control mb-3" maxlength="80" placeholder="예: Codex, Claude Desktop" autocomplete="off">
                    <label for="mcpKeyExpiration" class="form-label">유효기간</label>
                    <select id="mcpKeyExpiration" class="form-select">
                        <option value="30d">30일</option><option value="never">무기한</option>
                    </select>
                    <small class="text-muted d-block mt-2">무기한 키는 직접 삭제할 때까지 유효합니다.</small>
                </div>`,
                showCancelButton: true,
                confirmButtonText: '발급',
                cancelButtonText: '취소',
                showLoaderOnConfirm: true,
                allowOutsideClick: () => !Swal.isLoading(),
                allowEscapeKey: () => !Swal.isLoading(),
                didOpen: () => document.getElementById('mcpKeyName')?.focus(),
                preConfirm: async () => {
                    const name = document.getElementById('mcpKeyName').value.trim();
                    const expiration = document.getElementById('mcpKeyExpiration').value;
                    if (!name || name.length > 80) {
                        Swal.showValidationMessage('키 이름을 1~80자로 입력해주세요.');
                        return false;
                    }
                    try {
                        const res = await fetch('/api/me/mcp-api-keys', { method: 'POST',
                            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, expiration }) });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'API 키 발급에 실패했습니다.');
                        return data;
                    } catch (err) {
                        Swal.showValidationMessage(err.message || 'API 키 발급에 실패했습니다.');
                        void loadMcpApiKey();
                        return false;
                    }
                },
            });
            if (!result.isConfirmed) return;
            const data = result.value;
            await Swal.fire({
                title: 'API 키 발급 완료',
                html: `<div class="text-start">
                    <p>키 전체는 지금 한 번만 표시됩니다. 복사해서 보관해주세요.</p>
                    <code id="rawApiKeyText" class="d-block text-break border rounded p-3 mb-3">${window.escapeHtml(data.rawKey)}</code>
                    <button type="button" id="copyRawMcpKey" class="btn btn-sm btn-wiki-outline">키 복사</button>
                </div>`,
                icon: 'success',
                confirmButtonText: '확인 및 닫기',
                allowOutsideClick: false,
                allowEscapeKey: false,
                didOpen: () => {
                    document.getElementById('copyRawMcpKey').addEventListener('click', async () => {
                        try {
                            await navigator.clipboard.writeText(data.rawKey);
                            document.getElementById('copyRawMcpKey').textContent = '복사됨';
                        } catch { Swal.showValidationMessage('복사하지 못했습니다. 키를 직접 선택해서 복사해주세요.'); }
                    });
                },
            });
            await loadMcpApiKey();
        }

        async function deleteMcpApiKey(id: string) {
            if (!id) return;
            const result = await Swal.fire({
                title: 'API 키 삭제',
                text: '이 키를 사용하는 클라이언트의 접근이 즉시 차단됩니다. 다른 키는 유지됩니다.',
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: '삭제',
                cancelButtonText: '취소',
                showLoaderOnConfirm: true,
                allowOutsideClick: () => !Swal.isLoading(),
                allowEscapeKey: () => !Swal.isLoading(),
                preConfirm: async () => {
                    try {
                        const res = await fetch('/api/me/mcp-api-keys/' + encodeURIComponent(id), { method: 'DELETE' });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'API 키 삭제에 실패했습니다.');
                        return true;
                    } catch (err) {
                        Swal.showValidationMessage(err.message || 'API 키 삭제에 실패했습니다.');
                        return false;
                    }
                },
            });
            if (result.isConfirmed) {
                await loadMcpApiKey();
                void Swal.fire({ icon: 'success', title: 'API 키가 삭제되었습니다.', toast: true,
                    position: 'top-end', showConfirmButton: false, timer: 1500 });
            }
        }

        async function deleteDirectMessage(id) {
            Swal.fire({
                title: '쪽지 삭제',
                text: "이 쪽지를 보관함에서 지우시겠습니까?",
                icon: 'warning',
                showCancelButton: true,
                confirmButtonColor: '#cf222e',
                confirmButtonText: '삭제',
                cancelButtonText: '취소'
            }).then(async (result) => {
                if (result.isConfirmed) {
                    try {
                        const res = await fetch(`/api/messages/${id}`, { method: 'DELETE' });
                        if (!res.ok) throw new Error();

                        Swal.fire({ icon: 'success', title: '삭제됨', toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
                        // 목록 리로드
                        loadMessages(false);
                        // 헤더 알림 뱃지도 갱신 가능성 있음
                        if (typeof window.loadNotificationCount === 'function') {
                            window.loadNotificationCount();
                        }
                    } catch (e) {
                        Swal.fire('오류', '쪽지 삭제에 실패했습니다.', 'error');
                    }
                }
            });
        }

        // ─── 보낸 쪽지함 ─────────────────────────────────────────────────
        let currentSentOffset = 0;
        const SENT_LIMIT = 10;

        async function loadSentMessages(isLoadMore = false) {
            if (!isLoadMore) currentSentOffset = 0;

            try {
                const res = await fetch(`/api/messages/sent?offset=${currentSentOffset}&limit=${SENT_LIMIT}`);
                if (!res.ok) throw new Error();
                const data = await res.json();
                const messages = data.messages || [];

                const section = document.getElementById('sentMessagesSection');
                section.style.display = '';
                const listEl = document.getElementById('sentMessagesList');
                const loadMoreBtn = document.getElementById('loadMoreSentMessagesBtn');

                if (!isLoadMore && messages.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-send', title: '보낸 쪽지가 없습니다' });
                    loadMoreBtn.classList.add('d-none');
                    return;
                }

                if (!isLoadMore) listEl.innerHTML = '';

                listEl.insertAdjacentHTML('beforeend', messages.map(m => {
                    const date = new Date(m.created_at * 1000).toLocaleString('ko-KR');
                    const preview = m.content.length > 50 ? window.escapeHtml(m.content.substring(0, 50)) + '...' : window.escapeHtml(m.content);
                    const receiverName = m.receiver_name || '알 수 없음';
                    return `
                        <div class="contribution-item" style="cursor:pointer;" onclick="viewSentMessage(${m.id})">
                            <div class="flex-grow-1">
                                <span class="fw-bold"><i class="mdi mdi-account-circle text-muted"></i> → ${window.escapeHtml(receiverName)}</span>
                                <span class="text-muted ms-2">${preview}</span>
                            </div>
                            <span class="meta">${date}</span>
                        </div>
                    `;
                }).join(''));

                currentSentOffset += messages.length;
                data.has_more ? loadMoreBtn.classList.remove('d-none') : loadMoreBtn.classList.add('d-none');
            } catch (e) {
                if (!isLoadMore) {
                    document.getElementById('sentMessagesSection').style.display = '';
                    document.getElementById('sentMessagesList').innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오기 실패' });
                }
            }
        }

        async function loadMoreSentMessages() {
            const btn = document.getElementById('loadMoreSentMessagesBtn');
            btn.disabled = true;
            btn.innerHTML = window.uiInlineLoading();
            await loadSentMessages(true);
            btn.disabled = false;
            btn.innerHTML = '더보기 <i class="mdi mdi-chevron-down"></i>';
        }

        async function viewSentMessage(messageId) {
            try {
                const res = await fetch(`/api/messages/${messageId}`);
                if (!res.ok) throw new Error();
                const msg = await res.json();

                const date = new Date(msg.created_at * 1000).toLocaleString('ko-KR');
                const receiverName = msg.receiver_name || '알 수 없음';
                const receiverPic = renderUserAvatar(msg.receiver_picture, receiverName, 28, 'me-2');

                Swal.fire({
                    title: '<i class="mdi mdi-email-send-outline text-primary"></i> 보낸 쪽지',
                    html: `
                        <div class="text-start">
                            <div class="d-flex align-items-center mb-3 pb-2 border-bottom">
                                ${receiverPic}
                                <div>
                                    <span class="text-muted small">받는 사람</span><br>
                                    <strong>${window.escapeHtml(receiverName)}</strong>
                                    <div class="text-muted small">${date}</div>
                                </div>
                            </div>
                            <div style="white-space: pre-wrap; word-break: break-word;">${window.escapeHtml(msg.content)}</div>
                        </div>
                    `,
                    showConfirmButton: true,
                    confirmButtonText: '닫기',
                    width: 480,
                });
            } catch (e) {
                Swal.fire('오류', '쪽지를 불러오지 못했습니다.', 'error');
            }
        }

        // ─── 내가 쓴 토론 목록 ───────────────────────────────────────────
        let currentDiscussionsOffset = 0;
        const DISCUSSIONS_LIMIT = 10;

        async function loadMyDiscussions(isLoadMore = false) {
            if (!isLoadMore) currentDiscussionsOffset = 0;

            try {
                const res = await fetch(`/api/me/discussions?offset=${currentDiscussionsOffset}&limit=${DISCUSSIONS_LIMIT}`);
                if (!res.ok) throw new Error();
                const data = await res.json();
                const discussions = data.discussions || [];

                const section = document.getElementById('myDiscussionsSection');
                section.style.display = '';
                const listEl = document.getElementById('myDiscussionsList');
                const loadMoreBtn = document.getElementById('loadMoreDiscussionsBtn');

                if (!isLoadMore && discussions.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-chat-left-text', title: '작성한 토론이 없습니다' });
                    loadMoreBtn.classList.add('d-none');
                    return;
                }

                if (!isLoadMore) listEl.innerHTML = '';

                listEl.insertAdjacentHTML('beforeend', discussions.map(d => {
                    const date = new Date(d.updated_at * 1000).toLocaleDateString('ko-KR');
                    const statusBadge = d.status === 'open'
                        ? '<span class="badge bg-success ms-1">진행중</span>'
                        : '<span class="badge bg-secondary ms-1">종료</span>';
                    const discUrl = d.page_slug
                        ? `/w/${encodeURIComponent(d.page_slug)}?mode=discussions&id=${encodeURIComponent(d.id)}`
                        : null;
                    const titleEl = discUrl
                        ? `<a href="${discUrl}">${window.escapeHtml(d.title)}</a>`
                        : `<span>${window.escapeHtml(d.title)}</span>`;
                    const pageLink = d.page_slug
                        ? `<a href="/w/${encodeURIComponent(d.page_slug)}" class="badge bg-light text-dark border text-decoration-none ms-1">${window.escapeHtml(d.page_slug)}</a>`
                        : '';
                    return `
                        <div class="contribution-item">
                            <div class="flex-grow-1 text-truncate me-2">
                                ${titleEl}
                                ${statusBadge}
                                ${pageLink}
                                <span class="text-muted ms-1" style="font-size:0.8rem;">댓글 ${d.comment_count || 0}</span>
                            </div>
                            <span class="meta flex-shrink-0">${date}</span>
                        </div>
                    `;
                }).join(''));

                currentDiscussionsOffset += discussions.length;
                data.has_more ? loadMoreBtn.classList.remove('d-none') : loadMoreBtn.classList.add('d-none');
            } catch (e) {
                if (!isLoadMore) {
                    document.getElementById('myDiscussionsSection').style.display = '';
                    document.getElementById('myDiscussionsList').innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오기 실패' });
                }
            }
        }

        async function loadMoreMyDiscussions() {
            const btn = document.getElementById('loadMoreDiscussionsBtn');
            btn.disabled = true;
            btn.innerHTML = window.uiInlineLoading();
            await loadMyDiscussions(true);
            btn.disabled = false;
            btn.innerHTML = '더보기 <i class="mdi mdi-chevron-down"></i>';
        }

        // ─── 내 티켓 목록 ────────────────────────────────────────────────
        const TICKET_TYPE_LABELS = { general: '일반', document: '문서', discussion: '토론', account: '계정' };

        async function loadMyTickets() {
            const section = document.getElementById('myTicketsSection');
            const listEl = document.getElementById('myTicketsList');
            try {
                const res = await fetch('/api/tickets?page=1&my=1');
                if (!res.ok) throw new Error();
                const data = await res.json();
                const tickets = (data.tickets || []).slice(0, 5);

                section.style.display = '';

                if (tickets.length === 0) {
                    listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-ticket-perforated', title: '문의한 티켓이 없습니다' });
                    return;
                }

                listEl.innerHTML = tickets.map(t => {
                    const date = new Date(t.updated_at * 1000).toLocaleDateString('ko-KR');
                    const typeBadge = `<span class="badge bg-secondary ms-1">${TICKET_TYPE_LABELS[t.type] || t.type}</span>`;
                    const statusBadge = t.status === 'open'
                        ? '<span class="badge bg-warning text-dark ms-1">처리중</span>'
                        : '<span class="badge bg-success ms-1">완료</span>';
                    return `
                        <div class="contribution-item">
                            <div class="flex-grow-1 text-truncate me-2">
                                <a href="/tickets/${encodeURIComponent(t.id)}">${window.escapeHtml(t.title)}</a>
                                ${typeBadge}${statusBadge}
                            </div>
                            <span class="meta flex-shrink-0">${date}</span>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                section.style.display = '';
                listEl.innerHTML = window.uiEmptyState({ compact: true, icon: 'bi bi-exclamation-triangle', title: '불러오기 실패' });
            }
        }

// HTML(정적 + innerHTML)의 on* 속성에서 호출되므로 window 로 노출한다.
// (viewMessage 는 common.ts 전역이라 노출 대상이 아니다.)
window.updateName = updateName;
window.togglePicturePrivacy = togglePicturePrivacy;
window.toggleMcpInstantApply = toggleMcpInstantApply;
window.loadMoreMessages = loadMoreMessages;
window.loadMoreSentMessages = loadMoreSentMessages;
window.loadMoreMyDiscussions = loadMoreMyDiscussions;
window.revokeAllSessions = revokeAllSessions;
window.revokeAllMcpClients = revokeAllMcpClients;
window.refreshProfilePicture = refreshProfilePicture;
window.deleteDirectMessage = deleteDirectMessage;
window.revokeSession = revokeSession;
window.viewSentMessage = viewSentMessage;
window.loadMoreNotificationsArchive = loadMoreNotificationsArchive;
window.markAllNotificationsReadArchive = markAllNotificationsReadArchive;
window.deleteAllNotificationsArchive = deleteAllNotificationsArchive;
window.generateMcpApiKey = generateMcpApiKey;
window.deleteMcpApiKey = deleteMcpApiKey;
window.copyWikiMcpEndpoint = copyWikiMcpEndpoint;
window.copyMcpApiKeyJsonSnippet = copyMcpApiKeyJsonSnippet;
