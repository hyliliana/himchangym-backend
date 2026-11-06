# Shared API contract — camelCase JSON

Backend base no prefix, localhost :4100. `message` string on errors. IDs numeric. Status values `booked|completed|cancelled|noshow`. Dates YYYY-MM-DD; reservation startsAt is ISO timestamp WITH timezone (KST +09:00). All business date/month logic Asia/Seoul. Money KRW integers.

## Auth
- POST /auth/signup {email,password,name,phone} -> {token,user}; creates member only.
- POST /auth/login {email,password,kind:'member'|'staff'|'trainer'} -> {token,user}
- GET /auth/me -> {user}
- POST /auth/logout -> {ok:true}
- POST /auth/change-password {currentPassword,newPassword} -> {ok:true,user}
- user = {id,email,name,kind:'member'|'staff'|'trainer',role:'admin'|'employee'|null,mustChangePassword:boolean}
- Auth header `Authorization: Bearer TOKEN`. Disabled users rejected on every request. mustChangePassword users can access only me/change-password/logout.
- Frontends implement same-origin /api/[...path] proxy using BACKEND_URL; read/write `gym_session` HttpOnly SameSite=Lax cookie, Secure in production. On signup/login store token cookie and return only user. Forward cookie token as Bearer. Strip cookie/token from errors/logs. No client-visible secrets. Frontend functions fetch `/api/...`.

## Shared catalog
GET /catalog -> {trainers:Trainer[],passTypes:PassType[]}; requires login. Active entries only, even if includeDeleted is passed. workingDays Sun=0 ... Sat=6.
Trainer = {id,name,workingDays:number[],deletedAt:string|null}
PassType = {id,name,totalSessions,listPrice,validDays,deletedAt:string|null}

## Member
GET /member/dashboard -> {member:{id,name,phone,joinedAt,deletedAt:null},passes:Pass[],reservations:Reservation[]}
PATCH /member/profile {name?,phone?} -> {ok:true}; at least one field. joinedAt is forbidden here.
POST /member/reservations {passId,trainerId,startsAt} -> {reservation:Reservation}
POST /member/reservations/:id/cancel -> {ok:true}
POST /member/reservations/:id/reschedule {startsAt} -> {reservation:Reservation}
Only own booked reservation before its original start. Preserves the member/pass/trainer and row ID; checks future whole-hour time, pass dates and trainer working days/active state. Excludes this reservation from capacity count, so availableSessions=0 does not block moving the last reserved session. Conflict 409 rolls back to original time and counts.
GET /member/notification-preferences -> {preferences:{kakao:boolean,sms:boolean,updatedAt:string|null}}
PATCH /member/notification-preferences {kakao:boolean,sms:boolean} -> same response; both strict booleans, no extra fields. Default false/false/null; actual changes append an atomic audit record, repeated identical values preserve timestamp and audit count. Own member only; staff 403. PT feedback/reservation notice settings only; no message delivery or marketing consent integration.
Pass = {id,memberId,memberName,typeId,typeName,purchasedOn,paidAmount,expiresOn,totalSessions,usedSessions,bookedSessions,remainingSessions,availableSessions,isUsable:boolean}
Reservation = {id,memberId,memberName,passId,typeName,trainerId,trainerName,startsAt,status,approval:'pending'|'approved'|'rejected',note:string}

## Staff/admin operations (staff auth)
GET /admin/dashboard -> {membersCount,bookedCount,todayCount,expiringPasses:Pass[],trainerStats:[{id,name,completedCount,deletedAt:string|null}]}; active members count/expiring list, historical deleted trainer stats retained.
GET /admin/members?q=&includeDeleted=true|false -> {members:Member[]}; query name or last phone digits. Default active only; true includes active + deleted. Other includeDeleted values 400.
Member = {id,name,phone,email,joinedAt,deletedAt:string|null,mustChangePassword:boolean}
POST /admin/members {name,phone,email,joinedAt?} -> {member:Member,temporaryPassword:string}; random password, mustChangePassword true. No credentials in logs.
PATCH /admin/members/:id {name?,phone?,joinedAt?} -> {ok:true}; at least one; joinedAt <= today, omitted creation date defaults today.
GET /admin/catalog?includeDeleted=true|false -> {trainers:Trainer[],passTypes:PassType[]}; staff only. Trainer entries additionally contain hasAccount:boolean; no linked account email is exposed. Default active only, true includes active + deleted.
GET /admin/passes?memberId= -> {passes:Pass[]}
POST /admin/passes {memberId,typeId,purchasedOn,paidAmount,expiresOn?} -> {pass:Pass}
GET /admin/reservations?date=&status= -> {reservations:Reservation[]}; omitted filters = all.
PATCH /admin/reservations/:id {status?,note?} -> {ok:true}
POST /admin/trainers {name,workingDays} -> {trainer:Trainer}
PATCH /admin/trainers/:id {name,workingDays} -> {ok:true}
POST /admin/pass-types {name,totalSessions,listPrice,validDays} -> {passType:PassType}
PATCH /admin/pass-types/:id {name,totalSessions,listPrice,validDays} -> {ok:true}
DELETE /admin/members/:id -> {ok:true}
DELETE /admin/trainers/:id -> {ok:true}
DELETE /admin/pass-types/:id -> {ok:true}
POST /admin/members/:id/restore -> {ok:true}
POST /admin/trainers/:id/restore -> {ok:true}
POST /admin/pass-types/:id/restore -> {ok:true}
Delete/restore are idempotent soft state changes; existing records remain. Editing deleted rows returns 409. Member/trainer deletion is blocked by any booked reservation including past unprocessed bookings. Type deletion blocks new purchases but preserves sold pass validity. Member deletion revokes sessions and blocks login/own API/new purchases; restore requires fresh login. Email/phone uniqueness remains reserved. Staff history passes/reservations/receipts stay readable. Row locks recheck active state inside the transaction to serialize deletion against booking/rescheduling/purchase.

## Admin role only
GET /admin/staff -> {staff:[{id,email,name,role,isActive,mustChangePassword}]}
POST /admin/staff {email,name,role:'admin'|'employee'} -> {staff:...,temporaryPassword:string}
PATCH /admin/staff/:id {name?,role?,isActive?} -> {ok:true}; protect last active admin and accidental self-disable.
POST /admin/staff/:id/reset-password -> {temporaryPassword:string}; revoke existing sessions, require password change after next login.

## Trainer portal
- Trainers are separate kind='trainer' accounts with role=null, linked to exactly one trainer profile via unique nullable trainers.account_id. They are never included in the staff list and cannot use member/staff APIs.
- POST /admin/trainers/:id/account {email} -> {trainer:Trainer & {hasAccount:true},temporaryPassword}; admin role only. Creates a linked account once; duplicate link/email or deleted profile is 409. Existing reservations remain approved. Employee role is 403.
- POST /admin/trainers/:id/reset-password -> {temporaryPassword}; admin role only, linked active profile required; revokes all linked account sessions and requires first password change.
- GET /trainer/reservations -> {reservations:Reservation[]}; own trainer only, including historical/cancelled lessons. Contains standard reservation fields and approval, no member email/phone/password.
- PATCH /trainer/reservations/:id accepts exactly one operation: {approval:'approved'|'rejected',expectedStartsAt:string}, {status:'completed'|'noshow'}, or {note:string}; returns {ok:true}. Foreign lesson IDs are 403. expectedStartsAt is required for approval operations and must equal the latest startsAt after locks; stale value gives 409. Only booked/pending reservations can be approved/rejected. Rejection atomically sets approval=rejected,status=cancelled, releasing the slot and reserved session. Completion/noshow requires approved booked lesson at/before now; staff cannot bypass approval. Notes up to 5,000 characters can be saved on any own lesson.
- New bookings and reschedules for linked trainers get pending approval; unlinked trainers remain automatically approved. Pending bookings retain booked status, consume capacity and reserve the slot. Member cancellation is permitted as before. Changing the time of an approved linked lesson returns it to pending. Requests for the same time are a no-op and preserve approval.
- Deleted trainer profiles block login/current tokens/password change/portal actions. Deletion is blocked by booked reservations and revokes existing sessions. Restore requires a fresh login. Name edits synchronize the linked account name. Linked account IDs/emails never appear in /catalog; /admin/catalog exposes hasAccount only.
- Account creation/reset rechecks administrator rights inside the transaction. Trainer actions recheck current account/password/profile after locks. Per-trainer lifecycle advisory locks and account-before-profile row locks serialize account linking, edit, reset and deletion; pass/reservation locks serialize approval, reschedule, cancellation, notes and session accounting. Database checks reject completed/noshow without approval and rejected without cancellation.

## Setup and safety
Backend dotenv reads .env (never committed). Uses DATABASE_URL and DATABASE_SSL=true with certificate validation; only creates/changes hw2 schema. Separate tables from old assignments. Initial admin seed reads INITIAL_ADMIN_EMAIL/PASSWORD; no committed credentials. Idempotent seed includes fake members/passes/trainers/reservations sufficient to demonstrate expired/used/expiring/completed/noshow. Backend scripts db:setup and db:seed for initial setup; explicit db:migrate for existing DB after backup. No schema/seed on startup. Lifecycle migration only adds three nullable columns. Trainer portal migration safely expands account kind constraints and adds nullable unique trainer account linkage and reservation approval default approved; existing history is preserved. Both setup and migrate apply repeatable migrations under the schema advisory lock. Notification migration adds preference/audit tables with no member backfill/opt-in.
Each frontend own package.json, lockfile, Next.js app, README. Use versions from bookclub-level2 existing package if possible. Use Node.js 22 or later and pnpm.

Tests: pnpm test (9 unit/DDL cases), pnpm test:setup (ignored local PostgreSQL runtime only), pnpm test:integration (fresh loopback gym_test_* cluster; original + lifecycle regression 9 cases passed 2026-11-06). No operating .env DB use. Direct integration execution without isolated guard variables/loopback DB is rejected before loading dotenv. pnpm qa:isolated runs a separate temporary fixture API on 4102 and writes private credentials only to .local/lifecycle-qa-access.json (0600). Test runtime is absent from deploy dependencies/lockfile.

## Purchase receipt image attachment (implemented extension)
- POST /admin/passes/:id/receipts {fileName,mimeType,dataBase64} -> {receipts:Receipt[]} (staff only)
- GET /admin/passes/:id/receipts -> {receipts:Receipt[]} (staff only)
- GET /member/passes/:id/receipts -> {receipts:Receipt[]} (own member only)
- Receipt = {id,fileName,mimeType,dataUrl,createdAt}
- JPG/PNG/WebP only, actual file magic/MIME check, filename up to 120 characters, decoded file up to 2MB, up to 5 files per pass, total decoded files per pass <=3,000,000 bytes.
- Stored permanently as bytea in hw2.pass_receipts with pass/uploader foreign keys; no update/delete/OCR or payment verification.
