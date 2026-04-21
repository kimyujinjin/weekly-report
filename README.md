# 업무보고툴

Vite + React + Tailwind CSS 기반의 업무 보고 웹 앱입니다. PWA로 설치해 오프라인에서도 사용할 수 있습니다.

## 기술 스택

- **Vite 6** + **React 18** (JavaScript)
- **Tailwind CSS 3**
- **lucide-react** (아이콘)
- **vite-plugin-pwa** (PWA 지원)
- 데이터 저장: 브라우저 `localStorage`

## 로컬 실행 방법

### 1. 의존성 설치

```bash
npm install
```

### 2. 개발 서버 실행

```bash
npm run dev
```

기본 주소는 [http://localhost:5173](http://localhost:5173) 입니다.

### 3. 프로덕션 빌드

```bash
npm run build
```

빌드 결과물은 `dist/` 디렉토리에 생성됩니다.

### 4. 빌드 결과 미리보기

```bash
npm run preview
```

## Vercel 배포 방법

### 방법 1: Vercel 대시보드에서 배포 (권장)

1. 이 프로젝트를 GitHub(또는 GitLab / Bitbucket) 저장소에 푸시합니다.
2. [vercel.com](https://vercel.com) 에 로그인 후 **"Add New... → Project"** 를 선택합니다.
3. 방금 푸시한 저장소를 Import 합니다.
4. 프레임워크 프리셋은 **Vite** 가 자동 감지됩니다. 다음 값을 확인합니다.
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
   - **Install Command**: `npm install`
5. **Deploy** 버튼을 클릭합니다.

### 방법 2: Vercel CLI로 배포

```bash
# CLI 설치 (최초 1회)
npm install -g vercel

# 로그인
vercel login

# 프로젝트 루트에서 배포
vercel

# 프로덕션 배포
vercel --prod
```

## 데이터 저장소

모든 업무 기록은 브라우저의 `localStorage` 에 저장됩니다.
브라우저 캐시/사이트 데이터를 삭제하면 기록이 함께 삭제되니 주의하세요.

## PWA 설치

- Chrome / Edge: 주소창 우측 "앱 설치" 아이콘 클릭
- iOS Safari: 공유 → "홈 화면에 추가"
- Android Chrome: 메뉴 → "홈 화면에 추가"
