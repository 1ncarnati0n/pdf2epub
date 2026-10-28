# pdf2epub

PDF → EPUB3 변환 편집기. 왼쪽 원본 PDF / 오른쪽 블록 편집 + 실시간 미리보기.
인식은 로컬 Codex CLI(`codex exec`, 기본 모델 `gpt-6.1-terra`)가 페이지 이미지 + PDF 텍스트 레이어 + 직전 페이지 문맥을 보고 수행하고,
수식은 LaTeX 로 저장 → `temml` 로 MathML 변환해 EPUB 에 넣습니다 (미리보기와 내보내기가 같은 렌더러).

```bash
codex login        # 최초 1회
pnpm install
pnpm dev           # http://localhost:5173  (API: 127.0.0.1:5174)
pnpm test          # EPUB 빌더 self-check
```

- 인식 프롬프트: `prompt.md`, 출력 형식: `schema.json`
- 프로젝트 데이터: `projects/<id>/` (project.json, source.pdf, pages/, images/)
- 블록 선택 후 PDF 위를 드래그하면 영역(bbox) 재지정, 그림은 폭/포맷/품질 조정 후 다시 크롭
- 수식 LaTeX 오류는 블록이 빨갛게 표시됨
- 오른쪽 패널 탭: 블록 편집 / EPUB 미리보기(epub.js, 선택 블록 위치로 따라감) / XHTML 소스
- 왼쪽 사이드바 탭: 페이지 썸네일 / 목차 / LaTeX 오류 목록
- LaTeX 오류 블록은 "✦ AI 로 다시 쓰기"로 페이지 이미지를 다시 보고 재작성(실패한 시도를 넘겨 최대 3회), "원래대로"로 되돌리기. 인식 직후 오류는 자동으로 최대 2회 재작성
- 단축키: ←/→ 쪽 · ↑/↓ 블록 · Enter 편집 · Esc 종료 · Alt+↑/↓ 이동 · Delete 삭제 · ⌘Enter 추가 · ⌘⇧Enter 분할 · R 인식 · A AI 재작성 · E 다음 오류 · P 미리보기
- 포트 변경: `PORT=5184 node server.ts`, `API_PORT=5184 vite`
- 책의 목차 페이지는 표가 아닌 `contents` 블록(쪽번호 제거, 공백 2칸 들여쓰기 = 하위 항목)으로 인식. 이미 표로 인식된 목차는 블록의 "⇄ 목차로 변환"
- 글자 스타일: `<b> <i> <u> <sup> <sub> <code>`, `<span class="sans|serif|mono">`, `<span style="color:#RRGGBB">` 만 허용(나머지는 escape). 블록 편집기 서식 버튼으로 선택 영역에 적용, 책 정보에서 본문 글꼴(명조/고딕) 선택
- 블록 스타일: 정렬(가운데/오른쪽), 인용·들여쓰기, 작게/크게, 상자(테두리/음영/옆줄 + 상자색). 같은 `group` 의 연속 블록은 한 상자(정의·정리·예제). 인라인 `<s> <mark>`, 배경색 span, `<span class="small|large">`
- 각주: `footnote` 블록("1 내용") + 본문 `<sup class="fn">1</sup>` → 같은 장 안에서 뒤따르는 같은 표시의 각주와 EPUB 팝업 각주로 연결. 책 정보에서 문단 첫 줄 들여쓰기
