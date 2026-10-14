# 브랜드 자산

`public/brand/` 의 서빙용 파생본을 다시 만들 때 쓰는 원본이다. 이 디렉터리는 `public/` 밖이라
배포에 포함되지 않는다(원본 3장이 900KB 를 넘어 서빙할 이유가 없다).

## 세 가지를 구분한다

| | 무엇 | 원본 | 서빙본 |
| --- | --- | --- | --- |
| **심볼** (symbol) | 그림만 | `kiwi-symbol.png` 525×515 | `public/brand/kiwi-symbol-128.png`, `-256.png` |
| **워드마크** (wordmark) | 글자만 | `kiwi-wordmark.png` 1014×276 | `public/brand/kiwi-wordmark.png` 480px |
| **시그니처** (signature) | 심볼 + 워드마크 | `kiwi-signature.png` 1774×887 | `public/brand/kiwi-signature.png` 720px |

영어로는 심볼 = logomark/brandmark, 워드마크 = logotype, 시그니처 = lockup/combination mark.
"CI" 는 이 셋과 전용색·전용서체·여백 규정까지 묶은 **시스템 전체**를 가리키는 말이라 파일 한
장의 이름으로는 쓰지 않는다.

## 어디에 쓰나

- **심볼** — 헤더 브랜드(40px)와 홈의 키위 일러스트. 헤더에는 128px, 홈에는 256px 파생본을 쓴다. 위키 이름은 접근 가능한 텍스트로 따로 표시한다.
- **시그니처** — 심볼과 워드마크를 함께 쓰는 자산. 현재 홈은 검색과 안내 문구를 중심으로 구성하며 시그니처를 사용하지 않는다.
- **워드마크** — 현재 미사용. 심볼이 이미 옆에 있어 중복인 자리(좁은 모바일 헤더, 푸터 한 줄)
  용으로 준비해 뒀다. **밝은 연두 배경에는 올리지 말 것** — 워드마크가 밝은 초록에서 진한
  초록으로 흐르는 그라데이션이라 앞 두 글자("키즈")가 `kiwi-flesh` 헤더색(#8fbc45) 위에서
  거의 사라진다(브라우저 확인). 흰·크림·어두운 배경에서는 네 글자 모두 또렷하다.

## 파생본 만들기

```sh
sips -Z 128 brand/kiwi-symbol.png    --out public/brand/kiwi-symbol-128.png
sips -Z 256 brand/kiwi-symbol.png    --out public/brand/kiwi-symbol-256.png
sips -Z 720 brand/kiwi-signature.png --out public/brand/kiwi-signature.png
sips -Z 480 brand/kiwi-wordmark.png  --out public/brand/kiwi-wordmark.png
```

## 알아둘 것

- **워드마크는 임시본이다.** 디자이너가 준 시그니처에서 글자 영역(x600,y317,1014×276)을 잘라
  만들었다. 경계는 알파 채널을 열·행 단위로 스캔해 찾은 값이라 잘림은 없지만, 원래 시그니처
  기준으로 잡힌 자간·여백을 그대로 물려받았다. 단독으로 쓸 때 어색하면 디자이너에게 워드마크
  단독본을 따로 요청하는 게 맞다.
- **파비콘(`public/favicon.svg`)은 이 원본들의 축소본이 아니다.** 따로 그린 단순화 마크다.
  로우폴리 면과 씨앗 고리는 16px 에서 초록 덩어리로 뭉개져 축소본을 쓸 수 없다(측정 확인).

## Not By AI 배지 — 수익화 전에 반드시 정리할 것

`public/badges/written-by-humans-*.svg` 는 **서드파티(notbyai.fyi) 자산**이며 우리가 만든 게
아니다. 문서별 "사람이 쓴 글" 선언 배지로 쓰고 있다.

### 라이선스 상태: 미정

notbyai.fyi 는 **상업/비상업의 정의를 공개하지 않는다**(`/business`, `/help` 확인). 대신
가격이 매출 구간으로 짜여 있다:

| 티어 | 가격 | 대상 |
| --- | --- | --- |
| Starter | $5/월 | 매출 $100K 미만 |
| Business | $7/월 | 매출 $1M 미만 |
| Enterprise | $12/월 | 매출 $1M 이상 |
| 배지만 | $99 일회성 | 프로젝트 페이지 없음 |

매출 구간으로 나뉜다는 것은 **수익이 발생하면 유료 구간에 들어간다는 전제**를 시사한다.
광고 게재, 제휴·중계 수수료, 후원은 모두 매출이므로 여기 해당할 가능성이 높다. 다만 이는
해석이고 그쪽이 명시한 문구는 아니다. 홈페이지의 "비상업은 100% 무료" 와 `/help` 의
"Personal Use Only 도 일회성 요금" 표기가 서로 어긋나 있는 점도 함께 감안해야 한다.

### 그래서 수익화(광고·중계·후원 등)를 시작하기 전에 셋 중 하나를 해야 한다

1. **유료 라이선스를 산다** — 배지만 필요하면 $99 일회성이 가장 단순하다.
2. **배지를 내린다** — 아래 "제거 방법" 참고. 선언 기능 자체는 남기고 표시만 우리 표기로
   바꾸는 것도 가능하다.
3. **notbyai.fyi 에 직접 문의해 서면 확인을 받는다.**

정의가 공개돼 있지 않으므로 "괜찮겠지" 로 넘기지 말 것. 배지는 신뢰를 목적으로 다는 표시인데
라이선스 문제가 생기면 그 신뢰가 먼저 깨진다.

### 제거 방법

선언 기능(체크박스·`revisions.human_authored` 컬럼·편집 이력 기록)은 우리 것이므로 그대로
두고, **표시만** 교체하거나 숨기면 된다.

- 표시만 숨기기: `src/astro/pages/index.astro` 의 `#humanAuthoredBadge` 블록 제거
  (또는 `public/css/style.css` 의 `.human-authored-badge { display: none }`).
- 우리 표기로 교체: 같은 자리에 자체 문구·자체 SVG 를 넣는다. 데이터는 이미 리비전에 있다.
- 자산 삭제: `public/badges/written-by-humans-black.svg`, `-white.svg`.
