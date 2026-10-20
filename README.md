# Interactive Planner

수업용 영상 제작 기획안 웹 앱입니다. 기획안 목록과 작성 내용은 Supabase에 저장하고, 정적 화면은 GitHub Pages에서 제공합니다.

## 구성

- `index.html`: 기획안 목록, 비밀번호 보호 편집 화면, 이미지 업로드, PDF 인쇄 화면
- `supabase/schema.sql`: 기획안·이미지·세션 테이블과 비공개 Storage 버킷 정의
- `supabase/functions/planner-api/index.ts`: 비밀번호 검증, 저장, 이미지 업로드, 관리자 기능을 처리하는 서버 함수
- Supabase Cron: 매일 만료된 지 100일이 지난 기획안과 이미지를 정리

## 배포 전 설정

1. Supabase Edge Function Secrets에 `ADMIN_MASTER_PASSWORD`를 추가합니다.
2. GitHub 저장소 설정에서 Pages를 `main` 브랜치의 `/ (root)`로 활성화합니다.
3. 학생에게는 GitHub Pages 주소만 공유합니다.

브라우저에는 Supabase publishable key만 포함되어 있으며, service role key는 Edge Function 내부에서만 사용합니다. 학생 비밀번호는 평문이 아니라 PBKDF2 해시로 저장됩니다.

