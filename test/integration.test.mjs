import './require-isolated-database.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
process.env.NODE_ENV='test';
const {bootstrap}=await import('../dist/main.js');
const {pool}=await import('../dist/db.js');
const r=await import('../dist/rules.js');

test('실제 PostgreSQL: API 인증·소유권·직원권한·경쟁조건·상태/집계 일관성', {timeout:180000},async()=>{
 const app=await bootstrap(0);const address=app.getHttpServer().address();const base=`http://127.0.0.1:${address.port}`;
 const suffix=`${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
 const testEmail=(name)=>`integration-${name}-${suffix}@example.com`;
 const accountIds=[],memberIds=[],trainerIds=[],typeIds=[];
 const password=r.temporaryPassword();
 const api=async(path,{method='GET',body,token}={})=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};};
 const signup=async(n)=>{const phone=`010${String(Date.now()+n).slice(-8)}`;const x=await api('/auth/signup',{method:'POST',body:{email:testEmail(`member${n}`),password,name:`가상 검증회원${n}`,phone}});assert.equal(x.status,201);accountIds.push(x.data.user.id);return x.data;};
 const insertAdmin=async()=>{const {rows}=await pool.query(`INSERT INTO hw2.accounts(email,password_hash,name,kind,role) VALUES($1,$2,'가상 검증관리자','staff','admin') RETURNING id`,[testEmail('admin'),r.hashPassword(password)]);accountIds.push(rows[0].id);const x=await api('/auth/login',{method:'POST',body:{email:testEmail('admin'),password,kind:'staff'}});assert.equal(x.status,201);return x.data;};
 try{
  assert.equal((await api('/catalog')).status,401);
  const [a,b,admin]=await Promise.all([signup(1),signup(2),insertAdmin()]);
  assert.equal((await api('/admin/members',{token:a.token})).status,403);
  const am=(await api('/member/dashboard',{token:a.token})).data.member,bm=(await api('/member/dashboard',{token:b.token})).data.member;memberIds.push(am.id,bm.id);
  const trainer=(await api('/admin/trainers',{method:'POST',token:admin.token,body:{name:'가상 검증트레이너',workingDays:[0,1,2,3,4,5,6]}})).data.trainer;trainerIds.push(trainer.id);
  const trainer2=(await api('/admin/trainers',{method:'POST',token:admin.token,body:{name:'가상 휴무트레이너',workingDays:[]}})).data.trainer;trainerIds.push(trainer2.id);
  const type=(await api('/admin/pass-types',{method:'POST',token:admin.token,body:{name:'가상 검증이용권',totalSessions:10,listPrice:500000,validDays:30}})).data.passType;typeIds.push(type.id);
  const today=r.kstDate(),tomorrow=r.addDays(today,1),past=r.addDays(today,-1);
  const pass=async(memberId,extra={})=>{const x=await api('/admin/passes',{method:'POST',token:admin.token,body:{memberId,typeId:type.id,purchasedOn:r.addDays(today,-15),paidAmount:450000,expiresOn:r.addDays(today,10),...extra}});assert.equal(x.status,201);return x.data.pass;};
  const p=await pass(am.id),pb=await pass(bm.id);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4iQAAAAASUVORK5CYII=';
  const receiptBody={fileName:'가상영수증.png',mimeType:'image/png',dataBase64:png};
  const receiptPath=`/admin/passes/${p.id}/receipts`;
  assert.equal((await api(receiptPath,{method:'POST',token:a.token,body:receiptBody})).status,403);
  assert.equal((await api(receiptPath,{method:'POST',token:admin.token,body:{...receiptBody,mimeType:'image/jpeg'}})).status,400);
  const huge=Buffer.alloc(2097153);Buffer.from(png,'base64').copy(huge);
  assert.equal((await api(receiptPath,{method:'POST',token:admin.token,body:{...receiptBody,dataBase64:huge.toString('base64')}})).status,400);
  assert.equal((await api(receiptPath,{method:'POST',token:admin.token,body:{...receiptBody,dataBase64:'A'.repeat(3200000)}})).status,413);
  const uploaded=await api(receiptPath,{method:'POST',token:admin.token,body:receiptBody});assert.equal(uploaded.status,201);assert.equal(uploaded.data.receipts.length,1);assert.equal(uploaded.data.receipts[0].dataUrl,`data:image/png;base64,${png}`);
  const ownReceipts=await api(`/member/passes/${p.id}/receipts`,{token:a.token});assert.equal(ownReceipts.status,200);assert.equal(ownReceipts.data.receipts[0].fileName,'가상영수증.png');
  assert.equal((await api(`/member/passes/${p.id}/receipts`,{token:b.token})).status,403);
  assert.equal((await api(`/admin/passes/2147483647/receipts`,{token:admin.token})).status,404);
  const receiptRaces=await Promise.all(Array.from({length:5},(_,i)=>api(receiptPath,{method:'POST',token:admin.token,body:{...receiptBody,fileName:`검증${i}.png`}})));
  assert.deepEqual(receiptRaces.map(x=>x.status).sort(),[201,201,201,201,400]);
  const receiptRows=(await pool.query('SELECT image_data,uploader_id FROM hw2.pass_receipts WHERE pass_id=$1',[p.id])).rows;assert.equal(receiptRows.length,5);assert.equal(receiptRows[0].image_data.toString('base64'),png);assert.equal(receiptRows[0].uploader_id,admin.user.id);
  const bytes2m=Buffer.alloc(2000000);Buffer.from(png,'base64').copy(bytes2m);
  assert.equal((await api(`/admin/passes/${pb.id}/receipts`,{method:'POST',token:admin.token,body:{...receiptBody,dataBase64:bytes2m.toString('base64')}})).status,201);
  const bytes11m=Buffer.alloc(1100000);Buffer.from(png,'base64').copy(bytes11m);
  const totalRejected=await api(`/admin/passes/${pb.id}/receipts`,{method:'POST',token:admin.token,body:{...receiptBody,dataBase64:bytes11m.toString('base64')}});assert.equal(totalRejected.status,400);assert.match(totalRejected.data.message,/첨부 용량/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM hw2.pass_receipts WHERE pass_id=$1',[pb.id])).rows[0].n,1);
  const book=(token,passId,trainerId,day,hour)=>api('/member/reservations',{method:'POST',token,body:{passId,trainerId,startsAt:`${day}T${String(hour).padStart(2,'0')}:00:00+09:00`}});
  assert.equal((await book(b.token,p.id,trainer.id,tomorrow,9)).status,403);
  assert.equal((await book(a.token,p.id,trainer2.id,tomorrow,9)).status,400);
  const expired=await pass(am.id,{expiresOn:past});assert.equal((await book(a.token,expired.id,trainer.id,tomorrow,9)).status,400);
  // Fill nine sessions directly as historical data, leaving exactly one slot.
  for(let i=0;i<9;i++)await pool.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at,status) VALUES($1,$2,$3,$4,'completed')`,[am.id,p.id,trainer.id,`${r.addDays(today,-(i+1))}T09:00:00+09:00`]);
  const concurrent=await Promise.all([book(a.token,p.id,trainer.id,tomorrow,10),book(a.token,p.id,trainer.id,tomorrow,11)]);
  assert.deepEqual(concurrent.map(x=>x.status).sort(),[201,400]);
  const booked=concurrent.find(x=>x.status===201).data.reservation;
  let dash=(await api('/member/dashboard',{token:a.token})).data;let actual=dash.passes.find(x=>x.id===p.id);assert.equal(actual.remainingSessions,1);assert.equal(actual.bookedSessions,1);assert.equal(actual.availableSessions,0);
  assert.equal((await api(`/member/reservations/${booked.id}/cancel`,{method:'POST',token:b.token})).status,403);
  const clash=await book(b.token,pb.id,trainer.id,r.kstDate(new Date(booked.startsAt)),new Date(new Date(booked.startsAt).getTime()+9*3600000).getUTCHours());assert.equal(clash.status,409);
  assert.equal((await api(`/member/reservations/${booked.id}/cancel`,{method:'POST',token:a.token})).status,201);
  const rebook=await book(a.token,p.id,trainer.id,tomorrow,12);assert.equal(rebook.status,201);
  // Staff cannot count a future booking as completed.
  assert.equal((await api(`/admin/reservations/${rebook.data.reservation.id}`,{method:'PATCH',token:admin.token,body:{status:'completed'}})).status,400);
  await pool.query('UPDATE hw2.reservations SET starts_at=$1 WHERE id=$2',[`${past}T15:00:00+09:00`,rebook.data.reservation.id]);
  assert.equal((await api(`/admin/reservations/${rebook.data.reservation.id}`,{method:'PATCH',token:admin.token,body:{status:'noshow',note:'노쇼 검증'}})).status,200);
  assert.equal((await api(`/admin/reservations/${rebook.data.reservation.id}`,{method:'PATCH',token:admin.token,body:{status:'completed'}})).status,400);
  assert.equal((await api(`/admin/reservations/${rebook.data.reservation.id}`,{method:'PATCH',token:admin.token,body:{note:'메모 수정'}})).status,200);
  actual=(await api('/member/dashboard',{token:a.token})).data.passes.find(x=>x.id===p.id);assert.equal(actual.usedSessions,10);assert.equal(actual.remainingSessions,0);assert.equal(actual.bookedSessions,0);
  // Pass type edits never mutate a sold pass's session snapshot.
  assert.equal((await api(`/admin/pass-types/${type.id}`,{method:'PATCH',token:admin.token,body:{name:'가상 변경이용권',totalSessions:20,listPrice:900000,validDays:60}})).status,200);
  assert.equal((await api('/member/dashboard',{token:a.token})).data.passes.find(x=>x.id===p.id).totalSessions,10);
  const staff=await api('/admin/staff',{method:'POST',token:admin.token,body:{email:testEmail('employee'),name:'가상 검증직원',role:'employee'}});assert.equal(staff.status,201);accountIds.push(staff.data.staff.id);
  let login=await api('/auth/login',{method:'POST',body:{email:testEmail('employee'),password:staff.data.temporaryPassword,kind:'staff'}});assert.equal(login.status,201);let token=login.data.token;
  assert.equal((await api('/admin/dashboard',{token})).status,403);assert.equal((await api('/auth/me',{token})).status,200);
  const newPassword=r.temporaryPassword();assert.equal((await api('/auth/change-password',{method:'POST',token,body:{currentPassword:staff.data.temporaryPassword,newPassword}})).status,201);
  assert.equal((await api('/admin/dashboard',{token})).status,200);assert.equal((await api('/admin/staff',{token})).status,403);
  const reset=await api(`/admin/staff/${staff.data.staff.id}/reset-password`,{method:'POST',token:admin.token});assert.equal(reset.status,201);assert.equal((await api('/auth/me',{token})).status,401);
  login=await api('/auth/login',{method:'POST',body:{email:testEmail('employee'),password:reset.data.temporaryPassword,kind:'staff'}});token=login.data.token;
  assert.equal((await api(`/admin/staff/${staff.data.staff.id}`,{method:'PATCH',token:admin.token,body:{isActive:false}})).status,200);assert.equal((await api('/auth/me',{token})).status,401);
  assert.equal((await api(`/admin/staff/${admin.user.id}`,{method:'PATCH',token:admin.token,body:{isActive:false}})).status,400);
  assert.ok((await api(`/admin/members?q=${encodeURIComponent('검증회원')}`,{token:admin.token})).data.members.some(x=>x.id===am.id));
  // Raw DB must independently reject time conflicts, member/pass mismatch and off-hour data.
  const raw=await pool.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at) VALUES($1,$2,$3,$4) RETURNING id`,[bm.id,pb.id,trainer.id,`${tomorrow}T16:00:00+09:00`]);
  await assert.rejects(pool.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at) VALUES($1,$2,$3,$4)`,[bm.id,pb.id,trainer.id,`${tomorrow}T16:00:00+09:00`]),e=>e.code==='23505');
  await assert.rejects(pool.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at) VALUES($1,$2,$3,$4)`,[am.id,pb.id,trainer.id,`${tomorrow}T17:00:00+09:00`]),e=>e.code==='23503');
  await assert.rejects(pool.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at) VALUES($1,$2,$3,$4)`,[bm.id,pb.id,trainer.id,`${tomorrow}T17:30:00+09:00`]),e=>e.code==='23514');
  const stored=(await pool.query('SELECT password_hash FROM hw2.accounts WHERE id=$1',[a.user.id])).rows[0];assert.ok(stored.password_hash.startsWith('scrypt:'));assert.notEqual(stored.password_hash,password);
  const saved=(await pool.query('SELECT token_hash FROM hw2.sessions WHERE account_id=$1',[a.user.id])).rows[0];assert.notEqual(saved.token_hash,a.token);assert.equal(saved.token_hash,r.tokenHash(a.token));
  assert.equal((await api('/auth/logout',{method:'POST',token:a.token})).status,201);assert.equal((await api('/auth/me',{token:a.token})).status,401);
 }finally{
  // Only IDs created by this test are removed, strictly inside hw2.
  if(memberIds.length){await pool.query('DELETE FROM hw2.pass_receipts WHERE pass_id IN (SELECT id FROM hw2.passes WHERE member_id=ANY($1::int[]))',[memberIds]);await pool.query('DELETE FROM hw2.reservations WHERE member_id=ANY($1::int[])',[memberIds]);await pool.query('DELETE FROM hw2.passes WHERE member_id=ANY($1::int[])',[memberIds]);await pool.query('DELETE FROM hw2.members WHERE id=ANY($1::int[])',[memberIds]);}
  if(accountIds.length){await pool.query('DELETE FROM hw2.sessions WHERE account_id=ANY($1::int[])',[accountIds]);await pool.query('DELETE FROM hw2.accounts WHERE id=ANY($1::int[])',[accountIds]);}
  if(trainerIds.length)await pool.query('DELETE FROM hw2.trainers WHERE id=ANY($1::int[])',[trainerIds]);
  if(typeIds.length)await pool.query('DELETE FROM hw2.pass_types WHERE id=ANY($1::int[])',[typeIds]);
  await app.close();await pool.end();
 }
});
