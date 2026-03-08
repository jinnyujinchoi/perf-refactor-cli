# perf-refactor-cli

> Web(Lighthouse) 성능을 측정하고, AI가 개선 패치를 제안/적용해 as-is → to-be 비교 리포트(md/pdf)를 자동 생성하는 CLI 도구

---

## 설치 방법

```bash
git clone https://github.com/your-username/perf-refactor-cli.git
cd perf-refactor-cli
npm install
```

### 환경변수 설정

프로젝트 루트에 `.env` 파일을 생성하세요.

```dotenv
# Gemini API key (필수)
GEMINI_API_KEY=your_api_key_here

# 사용할 모델 (선택, 기본값: gemini-2.5-flash)
GEMINI_MODEL=gemini-2.5-flash
```

> API 키는 [Google AI Studio](https://aistudio.google.com)에서 발급받을 수 있습니다.

---

## 추천 실행 스텝

성능 최적화를 위한 권장 순서입니다.

```
1️⃣. measure   →   2️⃣. optimize   →   3️⃣. measure   →   4️⃣. report
  (as-is 측정)     (AI 패치 적용)     (to-be 재측정)    (비교 리포트)
```

### Step 1. as-is 측정

```bash
npm run start -- measure \
  --name as-is \
  --project MY_PROJECT \
  --web http://localhost:nnnn
```

### Step 2. AI 최적화 + 패치 자동 적용

```bash
npm run start -- optimize \
  --from MY_PROJECT_as-is_2026_03_08_v.1 \
  --name to-be \
  --project MY_PROJECT \
  --source /path/to/my-project \
  --prompt "LCP/TBT 개선, 이미지 최적화 위주로(예시)" \
  --apply \
  --yes
```

### Step 3. 패치 적용 후 재측정

```bash
npm run start -- measure \
  --name to-be-measured \
  --project MY_PROJECT \
  --web http://localhost:nnnn
```

### Step 4. 비교 리포트 생성

```bash
npm run start -- report \
  --from MY_PROJECT_as-is_2026_03_08_v.1 \
  --to MY_PROJECT_to-be-measured_2026_03_08_v.1 \
  --optimize MY_PROJECT_to-be_2026_03_08_v.1 \
  --format md,pdf
```

---

## 명령어 설명

### `measure` — 성능 측정

웹 페이지의 성능을 Lighthouse로 측정하고 결과를 저장합니다.

```bash
npm run start -- measure \
  --name <결과명> \
  --project <프로젝트명> \      # 없으면 현재 폴더명 자동 인식 또는 수동 입력
  --web <url>                   # 측정할 URL (http://localhost:3000 등)
```

**측정 지표:**

| 지표 | 설명 |
|---|---|
| Performance Score | 전체 성능 점수 (0-100) |
| LCP | Largest Contentful Paint (ms) |
| TBT / INP | Total Blocking Time / Interaction to Next Paint (ms) |
| CLS | Cumulative Layout Shift |
| Opportunities Top 5 | 개선 가능 항목 및 예상 절감량 |

> 측정 조건: mobile / simulate throttling / 3회 실행 후 median 값 사용

**결과 저장 경로:** `results/{PROJECT}_{name}_{date}_v.{n}.json`

---

### `optimize` — AI 최적화 + 패치 생성

측정 결과를 AI에 전달해 개선 계획을 수립하고, 패치 파일을 생성 및 자동 적용합니다.

```bash
npm run start -- optimize \
  --from <as-is 파일명> \
  --name <결과명> \
  --project <프로젝트명> \
  --source <소스코드 경로> \    # 프로젝트 소스코드 경로 (컨텍스트 분석용)
  --prompt "<최적화 지시>" \    # AI에게 전달할 최적화 목표
  [--apply] \                   # 패치 자동 적용 여부
  [--yes]                       # 확인 없이 바로 실행
```

**동작 흐름:**

```
1. as-is.json 읽기
2. 소스코드 분석 (--source 경로 기준)
3. AI → Plan 생성 (개선 항목 + 우선순위 + 대상 파일)
4. AI → Patch 생성 (unified diff 형식)
5. --apply 시: git apply → npm run build → 성공/실패 분기
   - 성공: 결과 저장
   - 실패: git checkout . 롤백 + 실패 리포트 저장
```

> ⚠️ `--apply` 사용 전 대상 프로젝트의 git 워킹트리가 clean한 상태여야 합니다.

**결과 저장 경로:**
- `results/{PROJECT}_{name}_{date}_v.{n}.json`
- `results/{PROJECT}_{name}_{date}_v.{n}-patches/patch-001.diff ...`

---

### `report` — 비교 리포트 생성

as-is와 to-be를 비교한 리포트를 생성합니다.

```bash
npm run start -- report \
  --from <as-is 파일명> \
  --to <to-be-measured 파일명> \
  --optimize <to-be 파일명> \   # Plan/Risks/Patches 정보 소스 (선택)
  --format md,pdf
```

**결과 저장 경로:** `reports/{from}--{to}.md / .pdf`

---

## 리포트 구성

생성되는 리포트는 아래 섹션으로 구성됩니다.

### 1. 헤더

```
✅ to-be 수치는 실제 측정값입니다
(또는)
⚠️ to-be 수치는 AI 추정치이며 실측값이 아닙니다
```

측정 소스, 생성 시각 등 메타 정보 포함

### 2. Metrics Comparison

as-is / to-be / Δ(delta) 비교 테이블

| Target | Metric | as-is | to-be | Δ |
|---|---|---|---|---|
| Web | Performance Score | 54 | 68 | +14 (improved) |
| Web | LCP (ms) | 140029 | 82933 | -57096 (improved) |
| Web | TBT (ms) | 136 | 63 | -73 (improved) |
| Web | CLS | 0 | 0 | 0 |

### 3. Plan

AI가 제안한 개선 항목 목록 (제목 / 근거 / 대상 지표)

### 4. Risks

패치 적용 시 고려해야 할 리스크 목록

### 5. Patches

생성된 패치 파일 목록 (파일명 / diff 파일 경로)

---

## 파일명 규칙

모든 결과 파일은 아래 형식으로 자동 저장됩니다.

```
{프로젝트명}_{결과명}_{YYYY_MM_DD}_v.{n}.json
```

같은 날 같은 프로젝트+결과명으로 여러 번 실행하면 버전이 자동으로 올라갑니다.

```
MY_PROJECT_as-is_2026_03_08_v.1.json
MY_PROJECT_as-is_2026_03_08_v.2.json   ← 같은 날 두 번째 실행
MY_PROJECT_to-be_2026_03_08_v.1.json
```

---

## 폴더 구조

```
perf-refactor-cli/
├── src/
│   ├── commands/
│   │   ├── measure.js
│   │   ├── optimize.js
│   │   └── report.js
│   ├── core/
│   ├── utils/
│   │   ├── context.js
│   │   ├── naming.js
│   │   └── patch.js
│   └── index.js
├── results/                # 측정/최적화 결과 (gitignore)
├── reports/                # 생성된 리포트 (gitignore)
├── .env                    # API 키 (gitignore 필수)
├── .env.sample
└── README.md
```

---

## 향후 업데이트 계획

### V2 (진행 중)
- [✅] 파일명 버전 관리 (타임스탬프 + 프로젝트명 자동 인식)
- [✅] 소스코드 컨텍스트 기반 AI 패치 퀄리티 향상
- [✅] 패치 자동 적용 + 롤백 루프
- [ ] `--latest` 옵션 (최신 as-is/to-be 자동 선택)

### V3 (예정)
- [ ] **React Native(Expo) 성능 측정 추가**
  - JS Bundle Size / Assets Size 측정
  - Heaviest Dependencies Top 5
  - RN 기반 프로젝트 패치 자동 적용
- [ ] 패치 적용 후 자동 재측정 루프
- [ ] GitHub Actions CI 연동
- [ ] `npm install -g perf-refactor-cli` 전역 설치 지원

---

## 주의사항

- `--apply` 옵션 사용 시 반드시 대상 프로젝트를 git으로 관리하고 있어야 합니다.
- AI가 생성한 패치는 자동으로 적용되지만, 커밋은 사용자가 직접 확인 후 진행하세요.
- 500줄 초과 파일은 패치 자동 적용이 불가하며 수동 적용 안내가 출력됩니다.
- localhost 환경에서의 LCP 수치는 throttling 왜곡으로 실제 배포 환경과 차이가 있을 수 있습니다.
