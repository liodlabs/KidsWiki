# 키즈위키 (KidsWiki)

Cloudflare 프리티어만으로 돌아가는 서버리스 위키입니다. 마크다운에 확장 문법을 더해 문서를 컴포넌트 조립식 페이지처럼 구성하고, MCP 연동으로 AI의 외장 지식 저장소로도 씁니다.

## 핵심 특징

- **프리티어 셀프호스팅** — Cloudflare Workers · D1 · R2 · KV 위에서 동작합니다. 트래픽이 늘어도 Workers Paid 전환만으로 대응합니다.
- **컴포넌트 조립식 문서** — 마크다운과 호환되는 확장 문법으로 카드 · 그리드 · 탭 · 콜아웃 · 버튼을 조립해 문서 한 장을 페이지처럼 구성합니다.
- **MCP 외장 지식 저장소** — MCP 서버를 내장해 AI 에이전트가 위키를 검색 · 열람 · 편집합니다.
- **공개 · 비공개 운영** — 문서 · 카테고리 단위 ACL, 회원가입 정책, 위키 공개 설정을 지원합니다.

## 기술 스택

| 영역 | 사용 기술 |
| --- | --- |
| 런타임 | Cloudflare Workers (서버리스) |
| 프레임워크 | [Hono](https://hono.dev/) |
| 데이터베이스 | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite 기반) |
| 오브젝트 스토리지 | [Cloudflare R2](https://developers.cloudflare.com/r2/) (미디어 업로드) |
| Key-Value | [Cloudflare KV](https://developers.cloudflare.com/kv/) (사이드바 설정 · 동시편집 충돌 감지) |
| 보안 · API | [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) (캡차), Web Push API |
| 언어 | TypeScript |
| 프런트엔드 | Bootstrap 5 & Bootstrap Icons, Material Design Icons, Astro, Marked.js, DOMPurify, CodeMirror 6, PrismJS, jsdiff, SweetAlert2, Chart.js |

## 시작하기

1. Cloudflare에서 D1 · R2 · KV를 생성합니다.
2. `wrangler example.toml`을 `wrangler.toml`로 복사하고 바인딩 ID와 도메인, `SUPER_ADMIN_EMAILS`를 채웁니다.
3. OAuth(Google / Discord / 네이버 / 카카오) 제공자를 최소 하나 설정합니다.
4. D1에 `migrations/schema.sql`을 실행해 스키마를 적용합니다.
5. `npm ci && npm run deploy` 또는 Cloudflare Workers에 이 저장소를 연결해 배포합니다.

기본 홈은 검색 · 연령별 길잡이 · 주제별 탐색 · 최근 문서를 제공합니다. `WIKI_HOME_PAGE`를 지정하면 기존처럼 해당 문서를 홈페이지로 사용합니다.

위키 이름 · 로고 · 테마 · 레이아웃 등 브랜딩은 모두 `wrangler.toml`의 `[vars]`에서 바꿉니다. 코드에 남은 `KidsWiki` 문자열은 빌드/런타임에 `WIKI_NAME` 값으로 치환되는 플레이스홀더입니다.

처음 보는 OAuth 로그인은 즉시 사용자를 만들지 않고 **새 계정으로 가입** 또는 **기존 계정에 연결**을 먼저 선택합니다. 계정은 공급자의 불변 사용자 ID로 식별하므로 이메일 제공 동의 없이도 가입할 수 있습니다. 이메일만으로 자동 연결하지 않으며, 이미 별도 계정이 만들어진 로그인은 마이페이지에서 양쪽 계정을 다시 인증한 뒤 현재 계정으로 합칠 수 있습니다.

연결된 로그인이 2개 이상이면 마이페이지에서 개별 연결을 해지할 수 있고, 마지막 로그인에는 회원 탈퇴가 표시됩니다. 해지·탈퇴는 해당 공급자로 다시 인증하고 공급자 측 연결까지 끊은 뒤 처리합니다. 최고 관리자의 기준 로그인과 마지막 활성 최고 관리자에는 추가 보호 규칙이 적용됩니다.

사용자 계정은 대/소문자를 구분하는 22자리 Base58 `users.id` 하나로 식별하며 이메일은 선택 프로필 정보입니다. 병합된 예전 ID는 `user_id_aliases`에 보존되어 기존 프로필 URL과 멘션이 대표 계정을 계속 가리킵니다. 숫자 ID 스키마로 만든 기존 개발 DB와는 호환되지 않으므로, 해당 버전에서 올 때는 개발 단계의 D1을 한 번 초기화한 뒤 `migrations/schema.sql`을 다시 적용해야 합니다.

## MCP API 키

마이페이지에서 용도별 이름을 붙여 API 키를 추가하거나 개별 삭제할 수 있습니다. 동시에 유효한 키는 최고 관리자 3개, 관리자 2개, 일반 유저·토론 관리자 각 1개까지 허용합니다. 새 키를 발급해도 기존 키는 유지됩니다.

키마다 **30일** 또는 **무기한**을 선택하며 기본값은 30일입니다. 무기한 키는 직접 삭제할 때까지 유효합니다. 만료된 키는 발급 한도에서 제외하며, 역할이 내려가 기존 키 수가 한도를 넘더라도 자동 삭제하지 않고 추가 발급을 제한합니다. 키 전체는 발급 직후 한 번만 표시하고 DB에는 해시와 마스킹된 표시값만 보관합니다.

기존 설치는 **새 코드 배포 전에** `npm run db:migrate:remote`로 `0003_multiple_mcp_api_keys.sql`을 적용해야 합니다. 기존 단일 키는 해시·발급일·만료일을 그대로 보존하고 이름을 `기존 API 키`로 표시합니다. 검증은 `node --test scripts/mcp-api-keys.test.mjs`로 실행합니다.

## 개인 편집 초안

문서 편집기의 **초안 저장** 버튼은 본문과 병합 기준본을 로그인한 계정의 D1 `editor_drafts`에 비공개로 저장합니다. 같은 계정이면 다른 브라우저나 기기에서도 편집 화면에서 복원할 수 있습니다. 전체 문서와 섹션 초안을 지원하며 자동 저장은 하지 않습니다.

서로 다른 문서의 초안은 각각 보관하며, 같은 문서·섹션에는 초안을 하나씩 저장합니다. 일반 유저·토론 관리자·관리자·최고 관리자 모두 마이페이지의 **내 초안**에서 문서명·저장 시각을 최신순으로 보고, **미리보기**로 최신 저장본을 위키 형식으로 확인하거나 편집 화면에서 불러오고 개별 삭제할 수 있습니다. 미리보기는 초안을 변경하거나 소비하지 않으며, 데이터 문서나 렌더러를 사용할 수 없는 경우에는 원문을 표시합니다. 목록에는 본인의 초안만 표시하며, 목록을 본 뒤 다른 기기에서 바뀐 초안은 삭제하지 않습니다.

일반 유저·토론 관리자는 문서·섹션 초안을 합해 최대 4개를 보관합니다. 새 초안 저장 시 마지막 저장 시각이 가장 오래된 초안부터 자동 삭제하며, 저장과 정리는 같은 트랜잭션에서 처리합니다. 기존 초안 갱신이나 목록 조회로는 다른 초안을 정리하지 않습니다. 관리자·최고 관리자는 개수 제한이 없습니다.

저장 중에는 버튼에 진행 상태를 표시하며 각 요청은 최대 15초 기다립니다. 저장 응답이 끊기면 DB 사본과 본문·기준본·버전을 비교해 성공 여부를 확인합니다. 확인 요청도 실패하면 편집 내용을 유지하고, 다시 저장할 때 이전 저장 결과부터 확인합니다.

다른 기기에서 바뀐 초안은 덮어쓰거나 삭제하지 않습니다. 복원한 초안은 문서 저장·편집 요청 제출이 성공한 뒤 정리합니다. 기존 `wiki_draft_*` 브라우저 초안은 본인 확인 후 가져오기를 선택할 때만 업로드하며, DB 저장에 성공한 뒤 로컬 사본을 정리합니다. 계정 통합 시 초안도 이동하고, 같은 키의 초안이 양쪽에 있으면 통합을 중단해 보존합니다. 회원 탈퇴 시 개인 초안도 삭제합니다.

신규 설치는 `migrations/schema.sql`에 포함되어 있습니다. 기존 설치는 `npm run db:migrate:remote`로 `0002_editor_drafts.sql`을 적용할 수 있으며, 런타임에서도 최초 접근 시 테이블을 준비합니다. 관련 검증은 `node --test scripts/editor-drafts.test.mjs scripts/account-merge.test.mjs`로 실행합니다.

### API 토큰으로 내 초안 사용

마이페이지에서 발급한 API 키를 `Authorization: Bearer <API 키>`로 보내면 같은 계정의 **내 초안**을 저장·조회·수정·삭제할 수 있습니다. API와 브라우저가 같은 초안을 사용하므로 일반 유저·토론 관리자의 4개 보관 한도도 합산합니다. 토큰을 명시하면 쿠키보다 토큰 소유자를 우선하며, 만료·폐기·차단·탈퇴한 토큰은 거부합니다. 이 인증은 개인 초안 API에만 추가되며 다른 계정 관리 API에는 적용되지 않습니다.

| 요청 | 동작 |
| --- | --- |
| `GET /api/editor-drafts/overview` | 본인의 초안 요약 목록과 보관 한도(`limit: null`이면 무제한) |
| `GET /api/editor-drafts/:key` | 본문·기준본·`revision` 조회 |
| `PUT /api/editor-drafts/:key` | 초안 생성·수정 |
| `DELETE /api/editor-drafts/:key` | `expectedRevision`이 일치하는 초안 삭제 |

`:key`는 `wiki_draft_문서슬러그`를 URL 인코딩한 값입니다. 섹션 초안은 `wiki_draft_문서슬러그#section=0` 형식이고 `payload.sectionIndex`와 `payload.sectionHeading`을 함께 보냅니다. JSON 요청은 `Content-Type: application/json`을 지정합니다. 새 초안은 `expectedRevision: null`, 기존 초안 수정·삭제는 가장 최근 조회 응답의 `revision`을 `expectedRevision`으로 보내며 충돌은 HTTP 409입니다. 기준본과 버전은 편집을 시작할 때 읽은 문서의 값이고, 새 문서나 알 수 없는 값은 `null`로 보냅니다. 기준 버전을 모르는 기존 문서는 브라우저 복원 시 충돌 확인이 필요할 수 있습니다.

```json
{
  "expectedRevision": null,
  "payload": {
    "content": "작성 중인 본문",
    "version": null,
    "base": null
  }
}
```

저장 응답의 `draft.revision`은 다음 수정에 사용하고, `removedKeys`는 보관 한도로 자동 삭제된 초안 목록입니다. 본인의 `user_id`나 작성 시각을 지정할 수는 없습니다.

MCP에서도 `save_personal_draft`, `list_personal_drafts`, `read_personal_draft` 도구로 같은 초안을 다룹니다. 저장 도구는 `title`, `content`, `base_version`, `base_content`, `expected_revision`을 받으며 선택적으로 `section_index`·`section_heading`을 지정합니다. 본문 읽기는 목록에서 받은 `key`를 사용합니다. 일반 기여자도 개인 초안을 저장할 수 있지만 직접 게시 권한은 달라지지 않습니다. 기존 `create_or_update_page`·`list_drafts`는 승인용 MCP 편집안을 계속 다루며 개인 초안과 섞지 않습니다. MCP 도구는 `MCP_MODE`가 활성화된 경우에만 제공됩니다.

연결 검증: `node --test scripts/personal-drafts-api.test.mjs`. 추가 DB 마이그레이션은 없습니다.

## 라이선스

MIT. 이 프로젝트는 [CloudWiki](https://github.com/eoeoe22/cloudwiki-public) (© 2026 eoeoe22)를 기반으로 합니다.
