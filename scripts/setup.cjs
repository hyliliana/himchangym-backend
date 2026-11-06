require('dotenv').config({quiet:true});
const {Pool}=require('pg');
const fs=require('node:fs');
async function run(){
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL 필요');
 const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:undefined});
 const c=await pool.connect();
 try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(209051104)");await c.query(fs.readFileSync(__dirname+'/schema.sql','utf8'));for(const name of fs.readdirSync(__dirname+'/migrations').filter(n=>n.endsWith('.sql')).sort())await c.query(fs.readFileSync(__dirname+'/migrations/'+name,'utf8'));await c.query('COMMIT');console.log('hw2 스키마 준비 완료 (다른 스키마 변경 없음)');}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await pool.end();}
}
run().catch(e=>{console.error('스키마 준비 실패:',e.code||e.message);process.exitCode=1;});
