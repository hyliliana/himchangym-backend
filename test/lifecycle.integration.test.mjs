import './require-isolated-database.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV='test';
const {bootstrap}=await import('../dist/main.js');
const {pool}=await import('../dist/db.js');
const r=await import('../dist/rules.js');

test('격리 PostgreSQL: 삭제·복원·시간 변경·수신 동의와 행 잠금 회귀', {timeout:180000},async t=>{
 const app=await bootstrap(0),base=`http://127.0.0.1:${app.getHttpServer().address().port}`;
 const password=r.temporaryPassword(),hash=r.hashPassword(password),today=r.kstDate(),tomorrow=r.addDays(today,1),past=r.addDays(today,-1);
 let sequence=0;
 const time=(day,hour)=>`${day}T${String(hour).padStart(2,'0')}:00:00+09:00`;
 const api=async(path,{method='GET',body,token}={})=>{const res=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json()};};
 const login=async(email,pw=password,kind='member')=>api('/auth/login',{method:'POST',body:{email,password:pw,kind}});
 const rawStaff=async(role)=>{const email=`lifecycle-${role}@example.com`;await pool.query(`INSERT INTO hw2.accounts(email,password_hash,name,kind,role) VALUES($1,$2,'가상직원','staff',$3)`,[email,hash,role]);return (await login(email,password,'staff')).data;};
 const admin=await rawStaff('admin'),employee=await rawStaff('employee');
 const staffApi=(path,options={})=>api(path,{token:admin.token,...options});
 const member=async()=>{const n=++sequence,email=`lifecycle-member${n}@example.com`,phone=`010${String(80000000+n)}`;const x=await api('/auth/signup',{method:'POST',body:{email,password,name:`가상회원${n}`,phone}});assert.equal(x.status,201);const m=(await api('/member/dashboard',{token:x.data.token})).data.member;return {...x.data,member:m,email,phone};};
 const trainer=async(days=[0,1,2,3,4,5,6])=>{const x=await staffApi('/admin/trainers',{method:'POST',body:{name:`가상트레이너${++sequence}`,workingDays:days}});assert.equal(x.status,201);return x.data.trainer;};
 const type=async()=>{const x=await staffApi('/admin/pass-types',{method:'POST',body:{name:`가상이용권${++sequence}`,totalSessions:10,listPrice:500000,validDays:30}});assert.equal(x.status,201);return x.data.passType;};
 const purchaseBody=(m,pt)=>({memberId:m.member.id,typeId:pt.id,purchasedOn:r.addDays(today,-20),paidAmount:450000,expiresOn:r.addDays(today,10)});
 const pass=async(m,pt)=>{const x=await staffApi('/admin/passes',{method:'POST',body:purchaseBody(m,pt)});assert.equal(x.status,201);return x.data.pass;};
 const book=(m,p,tr,startsAt)=>api('/member/reservations',{method:'POST',token:m.token,body:{passId:p.id,trainerId:tr.id,startsAt}});
 const move=(m,v,startsAt)=>api(`/member/reservations/${v.id}/reschedule`,{method:'POST',token:m.token,body:{startsAt}});
 const snapshot=async id=>(await pool.query('SELECT * FROM hw2.reservations WHERE id=$1',[id])).rows[0];
 const blocked=async(count,pattern)=>{const until=Date.now()+5000;while(Date.now()<until){const n=(await pool.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE $1`,[pattern])).rows[0].n;if(n>=count)return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('예상한 행 잠금 대기 상태에 도달하지 못했습니다.');};
 const gate=async(sql,args,work)=>{const c=await pool.connect();await c.query('BEGIN');try{await c.query(sql,args);await work(()=>c.query('COMMIT'));}finally{await c.query('ROLLBACK');c.release();}};
 try{
 await t.test('직원 회원 등록·가입일·임시 비밀번호와 필수 변경',async()=>{
  const body={name:'직원등록가상회원',phone:'01089990001',email:'lifecycle-created@example.com',joinedAt:past};
  assert.equal((await api('/admin/members',{method:'POST',token:(await member()).token,body})).status,403);
  const created=await api('/admin/members',{method:'POST',token:employee.token,body});assert.equal(created.status,201);assert.equal(created.data.member.deletedAt,null);assert.equal(created.data.member.mustChangePassword,true);assert.equal(created.data.member.joinedAt,past);assert.ok(typeof created.data.temporaryPassword==='string');
  const first=await login(body.email,created.data.temporaryPassword);assert.equal(first.status,201);assert.equal(first.data.user.mustChangePassword,true);
  assert.equal((await api('/member/dashboard',{token:first.data.token})).status,403);
  assert.equal((await api('/auth/change-password',{method:'POST',token:first.data.token,body:{currentPassword:created.data.temporaryPassword,newPassword:password}})).status,201);
  assert.equal((await api('/member/dashboard',{token:first.data.token})).status,200);
  assert.equal((await api('/member/profile',{method:'PATCH',token:first.data.token,body:{joinedAt:today}})).status,403);
  assert.equal((await staffApi(`/admin/members/${created.data.member.id}`,{method:'PATCH',body:{joinedAt:today}})).status,200);
  assert.equal((await staffApi(`/admin/members/${created.data.member.id}`,{method:'PATCH',body:{joinedAt:tomorrow}})).status,400);
  assert.equal((await staffApi('/admin/members',{method:'POST',body:{...body,email:'lifecycle-future@example.com',phone:'01089990002',joinedAt:tomorrow}})).status,400);
 });
 await t.test('삭제 회원·트레이너·종류의 과거 이력·고유 신원·복원과 세션 폐기',async()=>{
  const m=await member(),tr=await trainer(),pt=await type(),p=await pass(m,pt);
  const historical=(await pool.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at,status,note) VALUES($1,$2,$3,$4,'completed','과거 PT 피드백') RETURNING id`,[m.member.id,p.id,tr.id,time(past,9)])).rows[0];
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4iQAAAAASUVORK5CYII=';
  assert.equal((await staffApi(`/admin/passes/${p.id}/receipts`,{method:'POST',body:{fileName:'가상영수증.png',mimeType:'image/png',dataBase64:png}})).status,201);
  const before=(await staffApi('/admin/dashboard')).data.membersCount;
  for(const [path,id]of[['members',m.member.id],['trainers',tr.id],['pass-types',pt.id]])assert.equal((await staffApi(`/admin/${path}/${id}`,{method:'DELETE'})).status,200);
  assert.equal((await staffApi('/admin/dashboard')).data.membersCount,before-1);
  assert.ok(!(await staffApi('/admin/dashboard')).data.expiringPasses.some(x=>x.id===p.id));
  const stat=(await staffApi('/admin/dashboard')).data.trainerStats.find(x=>x.id===tr.id);assert.ok(stat.deletedAt);assert.equal(stat.completedCount,1);
  assert.ok(!(await staffApi('/admin/members')).data.members.some(x=>x.id===m.member.id));
  assert.ok((await staffApi('/admin/members?includeDeleted=true')).data.members.find(x=>x.id===m.member.id).deletedAt);
  assert.equal((await staffApi('/admin/members?includeDeleted=1')).status,400);
  const active=(await api('/catalog?includeDeleted=true',{token:(await member()).token})).data;assert.ok(!active.trainers.some(x=>x.id===tr.id));assert.ok(!active.passTypes.some(x=>x.id===pt.id));
  const all=(await staffApi('/admin/catalog?includeDeleted=true')).data;assert.ok(all.trainers.find(x=>x.id===tr.id).deletedAt);assert.ok(all.passTypes.find(x=>x.id===pt.id).deletedAt);
  assert.equal((await staffApi(`/admin/members/${m.member.id}`,{method:'PATCH',body:{name:'수정거절'}})).status,409);
  assert.equal((await staffApi(`/admin/trainers/${tr.id}`,{method:'PATCH',body:{name:'수정거절',workingDays:[]}})).status,409);
  assert.equal((await staffApi(`/admin/pass-types/${pt.id}`,{method:'PATCH',body:{name:'수정거절',totalSessions:10,listPrice:1,validDays:1}})).status,409);
  for(const path of['/auth/me','/member/dashboard',`/member/passes/${p.id}/receipts`,'/member/notification-preferences'])assert.equal((await api(path,{token:m.token})).status,401);
  assert.equal((await login(m.email)).status,401);
  assert.equal((await staffApi('/admin/members',{method:'POST',body:{name:'중복회원',phone:m.phone,email:'lifecycle-collision@example.com'}})).status,409);
  assert.equal((await staffApi('/admin/members',{method:'POST',body:{name:'중복회원',phone:'01089990003',email:m.email}})).status,409);
  assert.ok((await staffApi(`/admin/passes?memberId=${m.member.id}`)).data.passes.some(x=>x.id===p.id));
  assert.equal((await staffApi(`/admin/passes/${p.id}/receipts`)).data.receipts[0].dataUrl,`data:image/png;base64,${png}`);
  assert.ok((await staffApi('/admin/reservations')).data.reservations.some(x=>x.id===historical.id&&x.note==='과거 PT 피드백'));
  assert.equal((await staffApi('/admin/passes',{method:'POST',body:purchaseBody(m,pt)})).status,409);
  for(const [path,id]of[['members',m.member.id],['trainers',tr.id],['pass-types',pt.id]])for(let i=0;i<2;i++)assert.equal((await staffApi(`/admin/${path}/${id}/restore`,{method:'POST'})).status,201);
  assert.equal((await api('/auth/me',{token:m.token})).status,401);assert.equal((await login(m.email)).status,201);
  assert.equal((await staffApi('/admin/members?includeDeleted=true')).data.members.find(x=>x.id===m.member.id).deletedAt,null);
  assert.equal((await api('/admin/catalog?includeDeleted=true',{token:(await login(m.email)).data.token})).status,403);
  assert.equal((await api(`/admin/members/${m.member.id}`,{method:'DELETE',token:(await login(m.email)).data.token})).status,403);
 });
 await t.test('과거 미처리 booked도 회원·트레이너 삭제를 막고, 삭제된 종류는 기존 구매 효력을 유지',async()=>{
  const m=await member(),tr=await trainer(),pt=await type(),p=await pass(m,pt);
  const v=(await pool.query('INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at) VALUES($1,$2,$3,$4) RETURNING id',[m.member.id,p.id,tr.id,time(past,10)])).rows[0];
  for(const [path,id]of[['members',m.member.id],['trainers',tr.id]]){const x=await staffApi(`/admin/${path}/${id}`,{method:'DELETE'});assert.equal(x.status,409);assert.match(x.data.message,/과거 미처리/);}
  assert.equal((await staffApi(`/admin/reservations/${v.id}`,{method:'PATCH',body:{status:'cancelled'}})).status,200);
  assert.equal((await staffApi(`/admin/pass-types/${pt.id}`,{method:'DELETE'})).status,200);
  assert.equal((await staffApi('/admin/passes',{method:'POST',body:purchaseBody(m,pt)})).status,409);
  assert.equal((await book(m,p,tr,time(tomorrow,10))).status,201);
 });
 await t.test('마지막 1회 예약 이동·충돌 rollback·소유권·과거·휴무·만료 검증',async()=>{
  const m=await member(),other=await member(),tr=await trainer(),tr2=await trainer(),pt=await type(),p=await pass(m,pt),otherPass=await pass(other,pt);
  for(let i=1;i<=9;i++)await pool.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at,status) VALUES($1,$2,$3,$4,'completed')`,[m.member.id,p.id,tr.id,time(r.addDays(today,-i),8)]);
  const original=await book(m,p,tr,time(tomorrow,10));assert.equal(original.status,201);const v=original.data.reservation;
  assert.equal((await api('/member/dashboard',{token:m.token})).data.passes.find(x=>x.id===p.id).availableSessions,0);
  assert.equal((await move(other,v,time(tomorrow,12))).status,403);
  const moved=await move(m,v,time(tomorrow,12));assert.equal(moved.status,201);assert.equal(moved.data.reservation.id,v.id);assert.equal(moved.data.reservation.passId,p.id);assert.equal(moved.data.reservation.trainerId,tr.id);assert.equal(moved.data.reservation.memberId,m.member.id);
  const dash=(await api('/member/dashboard',{token:m.token})).data.passes.find(x=>x.id===p.id);assert.equal(dash.usedSessions,9);assert.equal(dash.bookedSessions,1);assert.equal(dash.availableSessions,0);
  assert.equal((await book(other,otherPass,tr,time(tomorrow,13))).status,201);
  assert.equal((await move(m,v,time(tomorrow,13))).status,409);assert.equal(new Date((await snapshot(v.id)).starts_at).toISOString(),new Date(time(tomorrow,12)).toISOString());
  const extraPass=await pass(m,pt);assert.equal((await book(m,extraPass,tr2,time(tomorrow,14))).status,201);
  assert.equal((await move(m,v,time(tomorrow,14))).status,409);assert.equal(new Date((await snapshot(v.id)).starts_at).toISOString(),new Date(time(tomorrow,12)).toISOString());
  for(const input of[time(past,10),`${tomorrow}T12:30:00+09:00`,time(r.addDays(today,11),10)])assert.equal((await move(m,v,input)).status,400);
  await pool.query('UPDATE hw2.trainers SET working_days=$1 WHERE id=$2',[[],tr.id]);assert.equal((await move(m,v,time(tomorrow,15))).status,400);await pool.query('UPDATE hw2.trainers SET working_days=$1 WHERE id=$2',[[0,1,2,3,4,5,6],tr.id]);
  await pool.query('UPDATE hw2.passes SET expires_on=$1 WHERE id=$2',[past,p.id]);assert.equal((await move(m,v,time(tomorrow,15))).status,400);await pool.query('UPDATE hw2.passes SET expires_on=$1 WHERE id=$2',[r.addDays(today,10),p.id]);
  await pool.query('UPDATE hw2.reservations SET starts_at=$1 WHERE id=$2',[time(past,12),v.id]);assert.equal((await move(m,v,time(tomorrow,15))).status,400);
  await pool.query("UPDATE hw2.reservations SET status='cancelled',starts_at=$1 WHERE id=$2",[time(tomorrow,12),v.id]);assert.equal((await move(m,v,time(tomorrow,15))).status,400);
  assert.equal((await api(`/member/reservations/${v.id}/reschedule`,{method:'POST',token:employee.token,body:{startsAt:time(tomorrow,15)}})).status,403);
 });
 await t.test('수신 동의 기본 false·엄격 boolean·본인 범위·정확한 감사 기록·멱등 변경',async()=>{
  const m=await member(),other=await member(),path='/member/notification-preferences';
  assert.deepEqual((await api(path,{token:m.token})).data.preferences,{kakao:false,sms:false,updatedAt:null});
  assert.equal((await pool.query('SELECT count(*)::int n FROM hw2.member_notification_preferences WHERE member_id=$1',[m.member.id])).rows[0].n,0);
  assert.equal((await api(path,{method:'PATCH',token:m.token,body:{kakao:false,sms:false}})).data.preferences.updatedAt,null);
  for(const body of[{kakao:'true',sms:false},{kakao:true},{kakao:1,sms:false},{kakao:true,sms:false,memberId:other.member.id}])assert.equal((await api(path,{method:'PATCH',token:m.token,body})).status,400);
  for(const method of['GET','PATCH'])assert.equal((await api(path,{method,token:employee.token,...(method==='PATCH'?{body:{kakao:true,sms:true}}:{})})).status,403);
  const changed=await api(path,{method:'PATCH',token:m.token,body:{kakao:true,sms:false}});assert.equal(changed.status,200);assert.equal(changed.data.preferences.kakao,true);assert.ok(changed.data.preferences.updatedAt);
  const audit=(await pool.query(`SELECT a.*,a.changed_at=p.updated_at AS exact_timestamp FROM hw2.notification_preference_audit a JOIN hw2.member_notification_preferences p USING(member_id) WHERE a.member_id=$1`,[m.member.id])).rows;assert.equal(audit.length,1);assert.equal(audit[0].actor_account_id,m.user.id);assert.equal(audit[0].before_kakao,false);assert.equal(audit[0].after_kakao,true);assert.equal(audit[0].after_sms,false);assert.equal(audit[0].exact_timestamp,true);
  assert.deepEqual((await api(path,{method:'PATCH',token:m.token,body:{kakao:true,sms:false}})).data,changed.data);
  assert.equal((await pool.query('SELECT count(*)::int n FROM hw2.notification_preference_audit WHERE member_id=$1',[m.member.id])).rows[0].n,1);
  assert.deepEqual((await api(path,{token:other.token})).data.preferences,{kakao:false,sms:false,updatedAt:null});
  assert.equal((await api(path,{method:'PATCH',token:m.token,body:{kakao:false,sms:false}})).status,200);assert.equal((await pool.query('SELECT count(*)::int n FROM hw2.notification_preference_audit WHERE member_id=$1',[m.member.id])).rows[0].n,2);
  assert.equal((await staffApi(`/admin/members/${m.member.id}`,{method:'DELETE'})).status,200);
  assert.equal((await api(path,{method:'PATCH',token:m.token,body:{kakao:true,sms:true}})).status,401);
 });
 await t.test('삭제가 먼저 잠기면 신규 예약·구매는 삭제 상태를 재검사',async()=>{
  const m=await member(),tr=await trainer(),pt=await type(),p=await pass(m,pt);
  const accountId=(await pool.query('SELECT account_id FROM hw2.members WHERE id=$1',[m.member.id])).rows[0].account_id;
  await gate('SELECT id FROM hw2.accounts WHERE id=$1 FOR UPDATE',[accountId],async release=>{
   const deletion=staffApi(`/admin/members/${m.member.id}`,{method:'DELETE'});await blocked(1,'SELECT id,is_active,kind FROM hw2.accounts%');
   const booking=book(m,p,tr,time(tomorrow,17));const purchase=staffApi('/admin/passes',{method:'POST',body:purchaseBody(m,pt)});await blocked(3,'SELECT id,is_active,kind FROM hw2.accounts%');await release();
   assert.equal((await deletion).status,200);assert.equal((await booking).status,409);assert.equal((await purchase).status,409);
  });
  assert.equal((await pool.query("SELECT count(*)::int n FROM hw2.reservations WHERE member_id=$1 AND status='booked'",[m.member.id])).rows[0].n,0);
  const m2=await member(),pt2=await type();
  await gate('SELECT id FROM hw2.pass_types WHERE id=$1 FOR UPDATE',[pt2.id],async release=>{
   const deletion=staffApi(`/admin/pass-types/${pt2.id}`,{method:'DELETE'});await blocked(1,'SELECT * FROM hw2.pass_types%');const purchase=staffApi('/admin/passes',{method:'POST',body:purchaseBody(m2,pt2)});await blocked(2,'SELECT * FROM hw2.pass_types%');await release();assert.equal((await deletion).status,200);assert.equal((await purchase).status,409);
  });
 });
 await t.test('예약·시간 변경이 먼저 잠기면 삭제는 완료된 결과를 보고 booked 409',async()=>{
  const m=await member(),tr=await trainer(),pt=await type(),p=await pass(m,pt);
  await gate('SELECT id FROM hw2.passes WHERE id=$1 FOR UPDATE',[p.id],async release=>{
   const booking=book(m,p,tr,time(tomorrow,18));await blocked(1,'SELECT * FROM hw2.passes%');const deletion=staffApi(`/admin/members/${m.member.id}`,{method:'DELETE'});await blocked(1,'SELECT id,is_active,kind FROM hw2.accounts%');await release();assert.equal((await booking).status,201);assert.equal((await deletion).status,409);
  });
  const v=(await pool.query("SELECT id FROM hw2.reservations WHERE pass_id=$1 AND status='booked'",[p.id])).rows[0];
  await gate('SELECT id FROM hw2.passes WHERE id=$1 FOR UPDATE',[p.id],async release=>{
   const moving=move(m,v,time(tomorrow,19));await blocked(1,'SELECT * FROM hw2.passes%');const deletion=staffApi(`/admin/trainers/${tr.id}`,{method:'DELETE'});await blocked(1,'SELECT * FROM hw2.trainers%');await release();assert.equal((await moving).status,201);assert.equal((await deletion).status,409);
  });
  assert.equal(new Date((await snapshot(v.id)).starts_at).toISOString(),new Date(time(tomorrow,19)).toISOString());
  assert.equal((await pool.query('SELECT deleted_at FROM hw2.members WHERE id=$1',[m.member.id])).rows[0].deleted_at,null);assert.equal((await pool.query('SELECT deleted_at FROM hw2.trainers WHERE id=$1',[tr.id])).rows[0].deleted_at,null);
 });
 }finally{await app.close();await pool.end();}
});
