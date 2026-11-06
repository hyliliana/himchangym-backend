import {spawn} from 'node:child_process';
import {createIsolatedDatabase,backendRoot} from './local-postgres.mjs';
let database;
try{
 database=await createIsolatedDatabase();
 console.log('격리 로컬 PostgreSQL 준비 완료. .env/DATABASE_URL 운영 연결은 사용하지 않습니다.');
 const child=spawn(process.execPath,['--test','--test-concurrency=1','test/integration.test.mjs','test/lifecycle.integration.test.mjs','test/trainer.integration.test.mjs','test/scheduling.integration.test.mjs'],{cwd:backendRoot,stdio:'inherit',env:{...process.env,DATABASE_URL:database.url,DATABASE_SSL:'false',GYM_ISOLATED_DB_TEST:'1',NODE_ENV:'test'}});
 process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
}catch(error){console.error('격리 PostgreSQL 검증 실패:',error.code??error.name,error.message?.replace(/postgres(?:ql)?:\/\/\S+/g,'[database-url]'));process.exitCode=1;}
finally{await database?.stop();}
