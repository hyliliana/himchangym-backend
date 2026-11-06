# 계약·시설·공개 슬롯 API

모든 시간은 한국시간 기준 1시간 정각입니다. JSON은 camelCase이며 인증·최초 비밀번호 변경 규칙은 API.md와 같습니다. 운영 DB는 자동 변경하지 않습니다. 백업 후 `pnpm db:migrate`로 `20261106_z_scheduling.sql`을 적용합니다. 기존 예약은 수정하지 않고, 신규 예약과 실제 시간 이동만 공개 슬롯을 요구합니다.

## 직원·관리자

- `GET /admin/facility` → `{facility:{startHour,endHour,capacity}}`. 최초 예시 기본값 9,22,2. 실제 운영에 맞게 관리자가 설정합니다.
- `PATCH /admin/facility {startHour?,endHour?,capacity?}` → 같은 응답. 관리자만 수정. 미래 공개·검토 슬롯과 기존 예약이 새 운영시간/정원을 위반하면 409입니다. 같은 트레이너의 슬롯·예약은 한 자리로 계산합니다.
- `GET /admin/trainers/:id/contract` → `{contract,progress,contracts}`.
- `PATCH /admin/trainers/:id/contract ContractInput` → 같은 응답. 관리자만 현재 계약 수정 또는 최초 등록.
- `POST /admin/trainers/:id/contracts ContractInput` → 같은 응답. 관리자만 새 기간 계약 등록. 이전 계약·실적은 남기고 새 계약을 현재 계약으로 지정합니다. 기간 중복은 409입니다.
- `GET /admin/trainers/:id/schedule` → `Schedule`.
- `GET /admin/trainers/:id/slot-candidates?from=YYYY-MM-DD&to=YYYY-MM-DD&excludeSlotId?` → `Candidates`.
- `POST /admin/trainers/:id/slots {startsAt}` → `{slot}`. 직원이 미연결 트레이너를 대신해 등록할 수 있습니다.
- `PATCH /admin/slots/:id {startsAt}` → `{slot}`.
- `DELETE /admin/slots/:id` → `{ok:true}`. 물리 삭제 없이 withdrawn으로 보존합니다.
- `GET /admin/slots?status=pending` → `{slots}`. 생략하면 전체이며 approved/pending/rejected/withdrawn 필터를 지원합니다.
- `PATCH /admin/slots/:id/decision {status:'approved'|'rejected',expectedStartsAt,reason?}` → `{slot}`. 관리자만 검토 중 신청 처리. 잠금 이후 시각이 달라졌으면 409, expectedStartsAt 누락은 400입니다.

직원 읽기·대리 슬롯 운영과 관리자 계약·시설·예외승인 권한을 분리합니다. 회원/트레이너는 모든 `/admin/...` 경로에서 403입니다.

## 트레이너

- `GET /trainer/schedule` → `Schedule`.
- `GET /trainer/slot-candidates?from=YYYY-MM-DD&to=YYYY-MM-DD&excludeSlotId?` → `Candidates`. 최대 63일. 조회기간에 해당하는 이전/현재/갱신 계약을 날짜별로 탐색합니다.
- `POST /trainer/slots {startsAt}` → `{slot}`.
- `PATCH /trainer/slots/:id {startsAt}` → `{slot}`.
- `DELETE /trainer/slots/:id` → `{ok:true}`.

본인 프로필만 처리하며 trainerId 위조 입력과 다른 트레이너의 슬롯 변경은 거절합니다. 만료·삭제 계정/프로필과 비밀번호 변경 전 세션은 사용할 수 없습니다.

## 필드

```text
ContractInput = {startDate,endDate,minSlots,maxSlots,allowedWeekdays:number[],startHour,endHour}
Contract = ContractInput + {id}
Progress = {approved,pending,total} // 현재 계약의 누적; total=approved+pending
Schedule = {contract:Contract|null,progress:Progress,contracts:[Contract & {progress}],slots:Slot[]}
Slot = {id,trainerId,trainerName,contractId,startsAt,status,withinScope,reason,hasReservation}
Candidates = {candidates:[{startsAt,withinScope}],facility,contract,progress}
```

최소는 목표 진행도이며 공개를 차단하지 않습니다. 최대는 계약 전체 기간의 공개·검토 슬롯 수에 강제 적용하고, 지난 공개 실적도 포함합니다. 거절·철회는 제외합니다. 계약 갱신은 별도 계약으로 보존하므로 과거 실적이 새 계약 한도를 소비하지 않습니다.

계약기간·시설시간은 예외로 넘을 수 없습니다. 계약 허용요일/시각 안이면 자동 approved, 밖이면 pending으로 관리자 검토를 받습니다. pending도 시설 자리와 계약 최대 한도를 점유하며 회원에게는 보이지 않습니다. 기존 workingDays 정보로 공개 승인 슬롯을 다시 제한하지 않습니다.

예약 status가 cancelled가 아닌 슬롯은 변경·철회할 수 없습니다. 지난 공개 슬롯은 실적으로 보존합니다. 지난 pending 신청은 승인할 수 없지만 관리자 거절과 철회는 가능하므로 미처리 신청이 계약 한도를 영구 점유하지 않습니다. 거절된 미래 슬롯은 수정 후 다시 신청할 수 있습니다. 기존 published slot과 다른 시각으로 변경할 때는 범위·정원·계약 최대를 다시 검사합니다. 삭제된 트레이너의 미예약 슬롯은 시설 정원을 점유하지 않으며 회원 후보에서 제외합니다.

## 회원 공개 시간

`GET /member/availability?passId=&trainerId=&month=YYYY-MM[&reservationId=]`

→ `{days:[{date:'YYYY-MM-DD',slots:[{id,startsAt,endsAt}]}]}`

본인 이용권만 조회합니다. 미래 approved 슬롯 중 이용권 기간, 활성 트레이너, 회원/트레이너 중복 예약, 남은 횟수를 검사합니다. 소진·만료 이용권은 빈 days입니다. reservationId는 본인 booked 예약이며, 해당 예약의 점유 횟수는 제외하되 원래 시각은 후보에서 제외합니다. 마지막 한 회를 이미 예약했어도 다른 시간 변경 후보를 볼 수 있습니다. 실제 신규 예약/변경 승인 시 다시 검사하므로 후보 조회가 자리를 보장하지 않습니다.

기존 슬롯 없는 예약은 열람·취소·완료할 수 있으며 실제 이용권 차감 규칙은 보존합니다. 해당 예약도 시설 운영 정원 계산에 포함합니다. 승인되지 않은 시간·만료/소진 이용권·중복 시간의 직접 POST를 서버에서 거절합니다. 계약/시설/슬롯/예약의 새 자리 변경은 공통 transaction advisory lock을 먼저 취득하여 정원과 최대 한도 경쟁을 직렬화합니다.
