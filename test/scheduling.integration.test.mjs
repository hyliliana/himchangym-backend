import './require-isolated-database.mjs';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {bootstrap} from '../dist/main.js';
import {pool} from '../dist/db.js';
import {hashPassword,temporaryPassword,kstDate,addDays} from '../dist/rules.js';

test('계약·센터 정원·공개 시간과 회원 후보를 직렬화하고 권한·이력을 보존한다',{timeout:180000},async t=>{
 const app=await bootstrap(0),base='http://127.0.0.1:'+app.getHttpServer().address().port,password=temporaryPassword();let sequence=0;
 const api=async(method,path,token,body)=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json()};};
 const ok=async(method,path,token,body)=>{const x=await api(method,path,token,body);assert.ok([200,201].includes(x.status),`${method} ${path}: ${x.status} ${x.data.message}`);return x.data;};
 const staff=async(role)=>{const email=`schedule-${role}@example.com`;await pool.query("INSERT INTO hw2.accounts(email,password_hash,name,kind,role) VALUES($1,$2,$3,'staff',$3)",[email,hashPassword(password),role]);return (await ok('POST','/auth/login',null,{email,password,kind:'staff'})).token;};
 const day=addDays(kstDate(),45),end=addDays(day,10),at=(hour,date=day)=>`${date}T${String(hour).padStart(2,'0')}:00:00+09:00`;
 try{
  const admin=await staff('admin'),desk=await staff('employee');
  // Other suites deliberately retain fixture histories. Use a disjoint future period.
  await pool.query('UPDATE hw2.facility_settings SET start_hour=9,end_hour=22,capacity=2 WHERE id=1');
  const makeTrainer=async()=>{const trainer=(await ok('POST','/admin/trainers',desk,{name:'시간검수'+(++sequence),workingDays:[]})).trainer;const email=`schedule-trainer${sequence}@example.com`;const initial=(await ok('POST',`/admin/trainers/${trainer.id}/account`,admin,{email})).temporaryPassword;const login=await ok('POST','/auth/login',null,{email,password:initial,kind:'trainer'});await ok('POST','/auth/change-password',login.token,{currentPassword:initial,newPassword:password});return {...trainer,token:login.token};};
  const tr=await makeTrainer(),other=await makeTrainer(),third=await makeTrainer();
  const contract={startDate:day,endDate:end,minSlots:2,maxSlots:4,allowedWeekdays:[0,1,2,3,4,5,6],startHour:10,endHour:12};
  for(const trainer of [tr,other,third])await ok('PATCH',`/admin/trainers/${trainer.id}/contract`,admin,contract);
  const member=(await ok('POST','/auth/signup',null,{email:'schedule-member@example.com',password,name:'시간검수 회원',phone:'01092345678'}));
  const memberId=(await ok('GET','/member/dashboard',member.token)).member.id;
  const type=(await ok('POST','/admin/pass-types',desk,{name:'시간검수 이용권',totalSessions:10,listPrice:1,validDays:100})).passType;
  const pass=(await ok('POST','/admin/passes',desk,{memberId,typeId:type.id,purchasedOn:kstDate(),expiresOn:end,paidAmount:1})).pass;
  const create=(trainer,hour,date=day)=>ok('POST','/trainer/slots',trainer.token,{startsAt:at(hour,date)});
  const availability=(extra='')=>ok('GET',`/member/availability?passId=${pass.id}&trainerId=${tr.id}&month=${day.slice(0,7)}${extra}`,member.token);
  await t.test('역할·다른 트레이너·위조 필드·관리자 전용 설정을 서버에서 차단',async()=>{
   const probes=[['GET','/trainer/schedule',member.token],['GET','/admin/facility',tr.token],['GET',`/admin/trainers/${tr.id}/schedule`,tr.token],['PATCH','/admin/facility',desk,{capacity:3}],['PATCH',`/admin/trainers/${tr.id}/contract`,desk,contract],['GET',`/member/availability?passId=${pass.id}&trainerId=${tr.id}&month=${day.slice(0,7)}`,tr.token]];
   for(const [method,path,token,body]of probes)assert.equal((await api(method,path,token,body)).status,403,path);
   assert.equal((await api('PATCH','/admin/facility',admin,{capacity:0})).status,400);
   assert.equal((await api('POST','/trainer/slots',tr.token,{startsAt:at(10),trainerId:other.id})).status,400);
  });
  let regular,exception;
  await t.test('계약 안 자동공개·밖 검토·원본 시각 비교·예외요일 예약',async()=>{
   regular=(await create(tr,10)).slot;exception=(await create(tr,13)).slot;
   assert.equal(regular.status,'approved');assert.equal(exception.status,'pending');
   const before=await availability();assert.ok(before.days.flatMap(v=>v.slots).some(v=>v.id===regular.id));assert.ok(!before.days.flatMap(v=>v.slots).some(v=>v.id===exception.id));
   assert.equal((await api('PATCH',`/admin/slots/${exception.id}/decision`,desk,{status:'approved',expectedStartsAt:exception.startsAt})).status,403);
   assert.equal((await api('PATCH',`/admin/slots/${exception.id}/decision`,admin,{status:'approved',expectedStartsAt:at(14)})).status,409);
   await ok('PATCH',`/admin/slots/${exception.id}/decision`,admin,{status:'approved',expectedStartsAt:exception.startsAt,reason:'계약 외 시간 허용'});
   assert.ok((await availability()).days.flatMap(v=>v.slots).some(v=>v.id===exception.id));
   // workingDays=[] is legacy metadata; published contract exceptions are bookable.
   const booking=(await ok('POST','/member/reservations',member.token,{passId:pass.id,trainerId:tr.id,startsAt:exception.startsAt})).reservation;
   assert.equal(booking.approval,'pending');
   assert.ok(!(await availability('&reservationId='+booking.id)).days.flatMap(v=>v.slots).some(v=>Date.parse(v.startsAt)===Date.parse(exception.startsAt)));
   for(const [method,path,token,body]of [['PATCH',`/trainer/slots/${exception.id}`,other.token,{startsAt:at(14)}],['DELETE',`/trainer/slots/${exception.id}`,other.token],['PATCH',`/trainer/slots/${exception.id}`,tr.token,{startsAt:at(14)}],['DELETE',`/trainer/slots/${exception.id}`,tr.token]])assert.equal((await api(method,path,token,body)).status,method==='PATCH'&&token===other.token||method==='DELETE'&&token===other.token?403:409);
   await ok('POST',`/member/reservations/${booking.id}/cancel`,member.token);await ok('DELETE',`/trainer/slots/${exception.id}`,tr.token);
  });
  await t.test('최대 시간·최소 진행·정원 경쟁·시설 축소·범위 한도',async()=>{
   await ok('PATCH',`/admin/trainers/${tr.id}/contract`,admin,{...contract,maxSlots:2});
   const last=(await create(tr,11)).slot;
   assert.equal((await api('POST','/trainer/slots',tr.token,{startsAt:at(12)})).status,409);
   let schedule=await ok('GET','/trainer/schedule',tr.token);assert.deepEqual(schedule.progress,{approved:2,pending:0,total:2});
   assert.equal((await api('PATCH',`/admin/trainers/${tr.id}/contract`,admin,{...contract,minSlots:0,maxSlots:1})).status,409);
   const race=await Promise.all([other,third].map(v=>api('POST','/trainer/slots',v.token,{startsAt:at(10)})));assert.deepEqual(race.map(v=>v.status).sort(),[201,409]);
   assert.equal((await api('PATCH','/admin/facility',admin,{capacity:1})).status,409);
   assert.equal((await api('PATCH','/admin/facility',admin,{startHour:11})).status,409);
   assert.equal((await api('POST','/trainer/slots',tr.token,{startsAt:at(8)})).status,409);
   assert.equal((await api('POST','/trainer/slots',tr.token,{startsAt:at(10,addDays(end,1))})).status,409);
   await ok('DELETE',`/trainer/slots/${last.id}`,tr.token);schedule=await ok('GET','/trainer/schedule',tr.token);assert.equal(schedule.progress.total,1);
   const pending=(await create(tr,15)).slot;assert.equal(pending.status,'pending');assert.equal((await ok('GET','/trainer/schedule',tr.token)).progress.total,2);
   await ok('PATCH',`/admin/slots/${pending.id}/decision`,admin,{status:'rejected',expectedStartsAt:pending.startsAt});assert.equal((await ok('GET','/trainer/schedule',tr.token)).progress.total,1);
  });
  await t.test('기존 계약·실적 보존과 신규 갱신 기간 후보',async()=>{
   const nextStart=addDays(end,1),nextEnd=addDays(end,10);
   await ok('POST',`/admin/trainers/${tr.id}/contracts`,admin,{...contract,startDate:nextStart,endDate:nextEnd,maxSlots:3});
   const schedule=await ok('GET','/trainer/schedule',tr.token);assert.equal(schedule.contracts.length,2);assert.equal(schedule.contract.startDate,nextStart);assert.equal(schedule.contracts.find(v=>v.startDate===day).progress.approved,1);
   const candidates=await ok('GET',`/trainer/slot-candidates?from=${nextStart}&to=${nextStart}`,tr.token);assert.ok(candidates.candidates.some(v=>Date.parse(v.startsAt)===Date.parse(at(10,nextStart))));
   assert.equal((await api('POST',`/admin/trainers/${tr.id}/contracts`,admin,{...contract,startDate:day,endDate:end})).status,409);
  });
  await t.test('동시에 마지막 계약 한도를 신청해도 한 개만 등록',async()=>{
   const limited=await makeTrainer();await ok('PATCH',`/admin/trainers/${limited.id}/contract`,admin,{...contract,minSlots:0,maxSlots:1});
   const race=await Promise.all([17,18].map(hour=>api('POST','/trainer/slots',limited.token,{startsAt:at(hour)})));
   assert.deepEqual(race.map(v=>v.status).sort(),[201,409]);assert.equal((await ok('GET','/trainer/schedule',limited.token)).progress.total,1);
  });
  await t.test('슬롯 없는 기존 예약도 시설 운영시간·정원 축소를 차단',async()=>{
   const a=await makeTrainer(),b=await makeTrainer(),legacyDay=addDays(day,2);
   for(const [trainer,hour]of [[a,20],[b,20]])await pool.query('INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at) VALUES($1,$2,$3,$4)',[memberId,pass.id,trainer.id,at(hour,legacyDay)]).catch(async error=>{
    // Use a distinct member/pass to avoid member simultaneous reservation uniqueness.
    if(error.code!=='23505')throw error;
    const account=(await pool.query("INSERT INTO hw2.accounts(email,password_hash,name,kind) VALUES($1,$2,'과거데이터','member') RETURNING id",['legacy-schedule'+trainer.id+'@example.com',hashPassword(password)])).rows[0];
    const m=(await pool.query("INSERT INTO hw2.members(account_id,name,phone) VALUES($1,'과거데이터',$2) RETURNING id",[account.id,'010'+String(70000000+trainer.id)])).rows[0];
    const p=(await pool.query('INSERT INTO hw2.passes(member_id,type_id,purchased_on,paid_amount,expires_on,total_sessions) VALUES($1,$2,$3,1,$4,10) RETURNING id',[m.id,type.id,kstDate(),end])).rows[0];
    await pool.query('INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at) VALUES($1,$2,$3,$4)',[m.id,p.id,trainer.id,at(hour,legacyDay)]);
   });
   assert.equal((await api('PATCH','/admin/facility',admin,{endHour:20})).status,409);
   const candidateTrainer=await makeTrainer();await ok('PATCH',`/admin/trainers/${candidateTrainer.id}/contract`,admin,contract);
   assert.equal((await api('POST','/trainer/slots',candidateTrainer.token,{startsAt:at(20,legacyDay)})).status,409);
  });
  await t.test('과거 공개 실적은 최소·최대 계산에 남고 철회 불가',async()=>{
   const historical=await makeTrainer(),past=addDays(kstDate(),-1);
   const c=await ok('PATCH',`/admin/trainers/${historical.id}/contract`,admin,{...contract,startDate:past,endDate:end,minSlots:1,maxSlots:1});
   const accountId=(await ok('GET','/auth/me',admin)).user.id;
   const slot=(await pool.query("INSERT INTO hw2.trainer_slots(trainer_id,contract_id,starts_at,status,within_scope,created_by) VALUES($1,$2,$3,'approved',true,$4) RETURNING id",[historical.id,c.contract.id,at(10,past),accountId])).rows[0];
   assert.deepEqual((await ok('GET','/trainer/schedule',historical.token)).progress,{approved:1,pending:0,total:1});
   assert.equal((await api('DELETE',`/trainer/slots/${slot.id}`,historical.token)).status,409);
   assert.equal((await api('POST','/trainer/slots',historical.token,{startsAt:at(19)})).status,409);
  });
  await t.test('스케줄 마이그레이션 반복 실행이 계약·슬롯·기존 예약을 보존',async()=>{
   const before=(await pool.query('SELECT (SELECT count(*) FROM hw2.trainer_contracts)::int AS contracts,(SELECT count(*) FROM hw2.trainer_slots)::int AS slots,(SELECT count(*) FROM hw2.reservations)::int AS reservations')).rows[0];
   const sql=await readFile(new URL('../scripts/migrations/20261106_z_scheduling.sql',import.meta.url),'utf8');await pool.query(sql);await pool.query(sql);
   assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM hw2.trainer_contracts)::int AS contracts,(SELECT count(*) FROM hw2.trainer_slots)::int AS slots,(SELECT count(*) FROM hw2.reservations)::int AS reservations')).rows[0],before);
  });
  await t.test('소진·만료·공개안함 후보와 직접 예약 차단',async()=>{
   await pool.query('UPDATE hw2.passes SET expires_on=$1 WHERE id=$2',[kstDate(),pass.id]);assert.deepEqual((await availability()).days,[]);await pool.query('UPDATE hw2.passes SET expires_on=$1 WHERE id=$2',[end,pass.id]);
   assert.equal((await api('POST','/member/reservations',member.token,{passId:pass.id,trainerId:tr.id,startsAt:at(16)})).status,409);
   const otherMember=await ok('POST','/auth/signup',null,{email:'schedule-other-member@example.com',password,name:'다른 회원',phone:'01092345679'});
   assert.equal((await api('GET',`/member/availability?passId=${pass.id}&trainerId=${tr.id}&month=${day.slice(0,7)}`,otherMember.token)).status,403);
   const fake=await makeTrainer();await ok('PATCH',`/admin/trainers/${fake.id}/contract`,admin,contract);const future=(await create(fake,16)).slot;
   await ok('DELETE',`/admin/trainers/${fake.id}`,admin);
   assert.ok(!(await ok('GET',`/member/availability?passId=${pass.id}&trainerId=${fake.id}&month=${day.slice(0,7)}`,member.token)).days.length);
   const newAtDeletedTime=await create(other,16);assert.equal(newAtDeletedTime.slot.status,'pending');assert.ok(future.id);
  });
  await t.test('데스크 변경 승인이 잠금 대기 중이면 정지된 권한을 다시 검사',async()=>{
   const unlinked=(await ok('POST','/admin/trainers',desk,{name:'데스크 시간변경',workingDays:[]})).trainer;
   await ok('PATCH',`/admin/trainers/${unlinked.id}/contract`,admin,contract);
   const raceDay=addDays(day,3);for(const hour of [10,11])await ok('POST',`/admin/trainers/${unlinked.id}/slots`,desk,{startsAt:at(hour,raceDay)});
   const original=(await ok('POST','/member/reservations',member.token,{passId:pass.id,trainerId:unlinked.id,startsAt:at(10,raceDay)})).reservation;
   const pending=(await ok('POST',`/member/reservations/${original.id}/reschedule`,member.token,{startsAt:at(11,raceDay)})).reservation.pendingChange;
   const gate=await pool.connect();const deskId=(await ok('GET','/auth/me',desk)).user.id;
   try{
    await gate.query('BEGIN');await gate.query('SELECT pg_advisory_xact_lock(209051107)');
    const resolving=api('POST',`/admin/reservations/${original.id}/changes/${pending.id}/decision`,desk,{decision:'approve'});
    let waiting=false;for(let n=0;n<200;n++){const rows=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query='SELECT pg_advisory_xact_lock(209051107)'" )).rows;if(rows.length){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
    assert.ok(waiting,'승인 요청이 스케줄 잠금에서 기다림');
    await pool.query('UPDATE hw2.accounts SET is_active=false WHERE id=$1',[deskId]);await gate.query('COMMIT');
    assert.equal((await resolving).status,401);
    const preserved=(await ok('GET','/member/dashboard',member.token)).reservations.find(v=>v.id===original.id);
    assert.equal(Date.parse(preserved.startsAt),Date.parse(original.startsAt));assert.equal(preserved.pendingChange.id,pending.id);
   }finally{await gate.query('ROLLBACK');gate.release();await pool.query('UPDATE hw2.accounts SET is_active=true WHERE id=$1',[deskId]);}
   await ok('POST',`/member/reservations/${original.id}/cancel`,member.token);
  });
 }finally{await app.close();await pool.end();}
});
