# 파킹웹 사전할인등록 자동화

데스크탑을 켜두지 않아도 GitHub Actions에서 [parkingweb.kr](https://a16829.parkingweb.kr) 사전할인등록(차량등록)을 대신 실행해주는 스크립트입니다.

## 최초 설정 (1회)

저장소 **Settings > Secrets and variables > Actions**에서 아래 두 개를 등록하세요. (비밀번호를 채팅이나 코드에 직접 넣지 마세요.)

- `PARKINGWEB_USERNAME`: 파킹웹 로그인 아이디
- `PARKINGWEB_PASSWORD`: 파킹웹 로그인 비밀번호

## 실행 방법

1. GitHub 저장소의 **Actions** 탭 → **파킹웹 사전할인등록** 워크플로우 선택
2. **Run workflow** 클릭
3. 아래 값을 입력
   - `vehicle_number`: 차량번호 (공백 없이)
   - `start_date`: 시작일 (예: `2026-09-01`)
   - `end_date`: 종료일 (예: `2026-09-30`)
4. 실행이 끝나면 해당 run의 로그에서 "조회 결과" 및 Job Summary를 확인
5. 실행이 실패하면 run의 **Artifacts**에 업로드된 `screenshots`를 다운로드해 어느 단계에서 실패했는지 확인

## 알아두어야 할 점

- 이 스크립트는 실제 사이트에 대한 직접 접근 없이, 사용자가 설명한 화면 흐름(로그인 → 상단 삼선 메뉴 → 사전할인등록현황 → 등록/조회)을 바탕으로 작성되었습니다.
- 실제 페이지의 버튼/입력창 구조가 스크립트의 추정과 다르면 첫 실행이 실패할 수 있습니다. 이 경우 `screenshots` 아티팩트를 보고 `scripts/register-vehicle.js`의 셀렉터를 조정해야 합니다.
- 차량번호는 스페이스를 제거한 뒤 입력됩니다.
