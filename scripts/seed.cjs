require('dotenv').config({quiet:true});
async function run(){
 const {pool,transaction}=await import('../dist/db.js');
 const r=await import('../dist/rules.js');
 try{
  const adminEmail=r.email(process.env.INITIAL_ADMIN_EMAIL),adminPassword=r.password(process.env.INITIAL_ADMIN_PASSWORD),memberPassword=r.password(process.env.SAMPLE_MEMBER_PASSWORD);
  await transaction(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(209051104)');
   // Existing accounts/passwords are never overwritten on repeated seed.
   await c.query(`INSERT INTO hw2.accounts(email,password_hash,name,kind,role) VALUES($1,$2,'힘찬짐 관리자','staff','admin') ON CONFLICT(email) DO NOTHING`,[adminEmail,r.hashPassword(adminPassword)]);
   if((await c.query('SELECT count(*)::int AS n FROM hw2.trainers')).rows[0].n===0){
    await c.query(`INSERT INTO hw2.trainers(name,working_days) VALUES('김힘찬',ARRAY[1,2,3,4,5]),('이건강',ARRAY[0,2,3,4,6]),('박튼튼',ARRAY[0,1,2,3,4,5,6])`);
   }
   if((await c.query('SELECT count(*)::int AS n FROM hw2.pass_types')).rows[0].n===0){
    await c.query(`INSERT INTO hw2.pass_types(name,total_sessions,list_price,valid_days) VALUES('PT 10회',10,500000,60),('PT 20회',20,900000,120),('PT 30회',30,1200000,180)`);
   }
   const trainers=(await c.query('SELECT id FROM hw2.trainers ORDER BY id')).rows;const types=(await c.query('SELECT * FROM hw2.pass_types ORDER BY id')).rows;
   const today=r.kstDate();
   const samples=[['가상 김회원','01000000001','demo.member1@example.com','active'],['가상 이회원','01000000002','demo.member2@example.com','expiring'],['가상 박회원','01000000003','demo.member3@example.com','expired'],['가상 최회원','01000000004','demo.member4@example.com','used']];
   for(const [name,phone,email,mode] of samples){
    const account=(await c.query(`INSERT INTO hw2.accounts(email,password_hash,name,kind) VALUES($1,$2,$3,'member') ON CONFLICT(email) DO NOTHING RETURNING id`,[email,r.hashPassword(memberPassword),name])).rows[0];
    if(!account)continue;
    const m=(await c.query('INSERT INTO hw2.members(account_id,name,phone) VALUES($1,$2,$3) RETURNING id',[account.id,name,phone])).rows[0];
    const type=types[0];const expires=mode==='expired'?r.addDays(today,-5):mode==='expiring'?r.addDays(today,7):r.addDays(today,50);
    const p=(await c.query('INSERT INTO hw2.passes(member_id,type_id,purchased_on,paid_amount,expires_on,total_sessions) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[m.id,type.id,r.addDays(today,-30),480000,expires,type.total_sessions])).rows[0];
    const total=mode==='used'?type.total_sessions:2;
    for(let i=0;i<total;i++){
     const d=r.addDays(today,-(i+1+(mode==='expired'?5:0)));await c.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at,status,note) VALUES($1,$2,$3,$4,$5,$6)`,[m.id,p.id,trainers[2%trainers.length].id,`${d}T${String(9+samples.indexOf(samples.find(v=>v[2]===email))).padStart(2,'0')}:00:00+09:00`,i===1?'noshow':'completed',i===1?'가상 노쇼 기록':'스쿼트 자세와 호흡 연습']);
    }
    if(mode==='active'){
     await c.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at,status,note) VALUES($1,$2,$3,$4,'booked','')`,[m.id,p.id,trainers[2%trainers.length].id,`${r.addDays(today,1)}T14:00:00+09:00`]);
     const old=(await c.query('INSERT INTO hw2.passes(member_id,type_id,purchased_on,paid_amount,expires_on,total_sessions) VALUES($1,$2,$3,500000,$4,$5) RETURNING id',[m.id,type.id,r.addDays(today,-100),r.addDays(today,-40),type.total_sessions])).rows[0];
     await c.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at,status,note) VALUES($1,$2,$3,$4,'cancelled','취소 미차감 예시')`,[m.id,old.id,trainers[0].id,`${r.addDays(today,-60)}T14:00:00+09:00`]);
    }
   }
  });
  console.log('hw2 가상 시연 데이터 준비 완료. 암호는 환경변수 사용, 기존 계정 변경 없음.');
 }finally{await pool.end();}
}
run().catch(e=>{console.error('시드 실패:',e.code||e.message);process.exitCode=1;});
