// 페이퍼 · 잉크 — 중립 지면과 차콜 행동색, 작은 테라코타 강조.
// 기존 사용자 선택을 보존하기 위해 저장 키 kiwi-flesh 를 유지한다.
// 서체·레이아웃·모션은 공통 CSS, 이 스킨은 색의 역할만 정의한다.

/** @type {import('./index.mjs').ThemeDefinition} */
export default {
    root: {
        '--wiki-bg': 'light-dark(#f7f5f1, #1c1b1a)',
        '--wiki-bg-alt': 'light-dark(#eeebe5, #171615)',
        '--wiki-card-bg': 'light-dark(#fffdfa, #272523)',
        '--wiki-text': 'light-dark(#2b2926, #f0ebe4)',
        '--wiki-text-muted': 'light-dark(#6b655d, #b8afa5)',
        '--wiki-border': 'light-dark(#dfd8cf, #44403b)',
        '--wiki-border-focus': 'light-dark(#9b5038, #e1ac8d)',
        '--wiki-hr-color': 'light-dark(#dfd8cf, #44403b)',

        // 주요 행동색은 잉크/밝은 종이색. 강조색을 넓은 배경에 퍼뜨리지 않는다.
        '--wiki-primary': 'light-dark(#34312e, #eee7dd)',
        '--wiki-primary-hover': 'light-dark(#504941, #ffffff)',
        '--wiki-accent': 'light-dark(#9b5038, #e1ac8d)',
        '--wiki-btn-text': 'light-dark(#fffdfa, #292522)',
        '--wiki-primary-rgb': '52, 49, 46',
        '--wiki-focus-ring-color': 'rgba(155, 80, 56, 0.24)',

        // 지면·안내·기여 영역은 각각 역할에 맞는 중립/따뜻한 표면을 쓴다.
        '--wiki-feature-bg': 'light-dark(#eeeae3, #302d29)',
        '--wiki-feature-border': 'light-dark(#ded7cb, #494139)',
        '--wiki-accent-surface': 'light-dark(#f3e5da, #392d27)',
        '--wiki-code-bg': 'light-dark(#f1eee8, #201e1b)',
        '--wiki-toc-bg': 'light-dark(#f3f0ea, #302d29)',
        '--wiki-glass-bg': 'light-dark(#fffdfae6, #272523e6)',
        '--wiki-glass-border': 'light-dark(#dfd8cf, #44403b)',

        '--wiki-header-bg': 'light-dark(#fffdfa, #211f1d)',
        '--wiki-header-border': 'light-dark(#e7e0d7, #3e3934)',
        '--wiki-header-text': 'light-dark(#2b2926, #f0ebe4)',
        '--wiki-header-brand': 'light-dark(#2b2926, #f0ebe4)',
    },
    dark: {
        '--wiki-primary-rgb': '238, 231, 221',
        '--wiki-focus-ring-color': 'rgba(225, 172, 141, 0.45)',
        '--wiki-shadow-lg': '0 20px 25px -5px rgba(0, 0, 0, 0.35), 0 8px 10px -6px rgba(0, 0, 0, 0.2)',
    },
};
