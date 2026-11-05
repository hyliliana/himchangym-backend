import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createIsolatedDatabase,backendRoot} from './local-postgres.mjs';

const database=await createIsolatedDatabase();
process.env.DATABASE_URL=database.url;process.env.DATABASE_SSL='false';process.env.NODE_ENV='test';process.env.GYM_ISOLATED_DB_TEST='1';
const {pool,transaction}=await import('../dist/db.js');
const {bootstrap}=await import('../dist/main.js');
const r=await import('../dist/rules.js');
const randomPassword=()=>`Qa!${randomBytes(15).toString('base64url')}`;
const credentials={admin:{email:'qa.admin@example.com',password:randomPassword()},employee:{email:'qa.employee@example.com',password:randomPassword()},member:{email:'qa.member@example.com',password:randomPassword()},otherMember:{email:'qa.other@example.com',password:randomPassword()},archivedMember:{email:'qa.archived@example.com',password:randomPassword()}};
let app;const accessFile=path.join(backendRoot,'.local/lifecycle-qa-access.json');
try{
 const fixture=await transaction(async c=>{
  const ids={};
  for(const [key,entry] of Object.entries(credentials)){
   const staff=['admin','employee'].includes(key),name=key==='member'?'가상 김하늘':key==='otherMember'?'가상 박회원':key==='archivedMember'?'가상 삭제회원':staff?'격리 검수직원':'격리회원';
   const a=(await c.query('INSERT INTO hw2.accounts(email,password_hash,name,kind,role) VALUES($1,$2,$3,$4,$5) RETURNING id',[entry.email,r.hashPassword(entry.password),name,staff?'staff':'member',staff?key:null])).rows[0];ids[key+'AccountId']=a.id;
   if(!staff){const phone=key==='member'?'01090004827':key==='otherMember'?'01090004828':'01090004829';const m=(await c.query('INSERT INTO hw2.members(account_id,name,phone,deleted_at) VALUES($1,$2,$3,$4) RETURNING id',[a.id,name,phone,key==='archivedMember'?new Date():null])).rows[0];ids[key+'Id']=m.id;}
  }
  const trainers=(await c.query(`INSERT INTO hw2.trainers(name,working_days,deleted_at) VALUES('가상 김힘찬',ARRAY[0,1,2,3,4,5,6],NULL),('가상 이건강',ARRAY[0,1,2,3,4,5,6],NULL),('가상 삭제트레이너',ARRAY[0,1,2,3,4,5,6],now()) RETURNING id`)).rows;
  const types=(await c.query(`INSERT INTO hw2.pass_types(name,total_sessions,list_price,valid_days,deleted_at) VALUES('PT 10회',10,500000,60,NULL),('PT 20회',20,900000,120,NULL),('PT 30회',30,1200000,180,NULL),('지난 판매종류',10,450000,60,now()) RETURNING id`)).rows;
  const today=r.kstDate(),tomorrow=r.addDays(today,1),purchased=r.addDays(today,-30),expires=r.addDays(today,30);
  const pass=async(memberId,typeIndex,total=10)=>{return (await c.query('INSERT INTO hw2.passes(member_id,type_id,purchased_on,paid_amount,expires_on,total_sessions) VALUES($1,$2,$3,450000,$4,$5) RETURNING id',[memberId,types[typeIndex].id,purchased,expires,total])).rows[0].id;};
  const passId=await pass(ids.memberId,0),sparePassId=await pass(ids.memberId,1,20),otherPassId=await pass(ids.otherMemberId,0),archivedPassId=await pass(ids.archivedMemberId,3);
  for(let i=1;i<=9;i++)await c.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at,status,note) VALUES($1,$2,$3,$4,'completed','격리 과거 PT 피드백')`,[ids.memberId,passId,trainers[0].id,`${r.addDays(today,-i)}T09:00:00+09:00`]);
  const reservation=(await c.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at) VALUES($1,$2,$3,$4) RETURNING id`,[ids.memberId,passId,trainers[0].id,`${tomorrow}T10:00:00+09:00`])).rows[0];
  await c.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at) VALUES($1,$2,$3,$4)`,[ids.otherMemberId,otherPassId,trainers[0].id,`${tomorrow}T11:00:00+09:00`]);
  await c.query(`INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at,status,note) VALUES($1,$2,$3,$4,'completed','삭제 전 이력 보존 fixture')`,[ids.archivedMemberId,archivedPassId,trainers[2].id,`${r.addDays(today,-1)}T15:00:00+09:00`]);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4iQAAAAASUVORK5CYII=','base64');
  await c.query(`INSERT INTO hw2.pass_receipts(pass_id,uploader_id,file_name,mime_type,image_data) VALUES($1,$2,'가상 과거 증빙.png','image/png',$3)`,[archivedPassId,ids.adminAccountId,png]);
  return {...ids,trainerId:trainers[0].id,otherTrainerId:trainers[1].id,deletedTrainerId:trainers[2].id,typeId:types[0].id,deletedTypeId:types[3].id,passId,sparePassId,otherPassId,archivedPassId,reservationId:reservation.id,bookingDate:tomorrow,collidingTime:`${tomorrow}T11:00:00+09:00`};
 });
 const port=Number(process.env.QA_PORT??4102);app=await bootstrap(port);
 await fs.writeFile(accessFile,JSON.stringify({scope:'ISOLATED_LOCAL_POSTGRES_ONLY',backendUrl:`http://127.0.0.1:${port}`,credentials,fixture,createdAt:new Date().toISOString()},null,2),{mode:0o600});await fs.chmod(accessFile,0o600);
 console.log(JSON.stringify({isolatedQaReady:true,backendUrl:`http://127.0.0.1:${port}`,accessFile}));
 const shutdown=async()=>{await app?.close();await pool.end();await database.stop();};
 process.once('SIGINT',()=>{void shutdown();});process.once('SIGTERM',()=>{void shutdown();});
}catch(error){await app?.close();await pool.end();await database.stop();console.error('격리 QA 시작 실패:',error.code??error.name);process.exitCode=1;}
