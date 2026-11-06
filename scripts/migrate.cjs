require('dotenv').config({quiet:true});
const {Pool}=require('pg');
const fs=require('node:fs');
const path=require('node:path');
async function run(){
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL 필요');
 const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:undefined});
 let c;
 try{
  c=await pool.connect();
  await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(209051104)');
  for(const name of fs.readdirSync(path.join(__dirname,'migrations')).filter(n=>n.endsWith('.sql')).sort())await c.query(fs.readFileSync(path.join(__dirname,'migrations',name),'utf8'));
  await c.query('COMMIT');console.log('hw2 비파괴 마이그레이션 완료. 기존 기록 보존·예약 승인 기본값 적용, 동의값 변경 없음.');
 }catch(e){if(c)await c.query('ROLLBACK');throw e;}finally{c?.release();await pool.end();}
}
run().catch(e=>{console.error('마이그레이션 실패:',e.code||e.name||'unknown');process.exitCode=1;});
