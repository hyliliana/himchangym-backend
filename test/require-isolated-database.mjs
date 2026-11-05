// Intentionally do not read .env here. Production URLs must never enter DB tests.
let database=null;
try{if(process.env.GYM_ISOLATED_DB_TEST==='1'&&process.env.DATABASE_URL)database=new URL(process.env.DATABASE_URL);}catch{/* Do not expose an invalid connection string in a native URL exception. */}
if(process.env.GYM_ISOLATED_DB_TEST!=='1'||!database||!['127.0.0.1','localhost'].includes(database.hostname)||!/^\/gym_test_[a-z0-9_]+$/.test(database.pathname)){
 throw new Error('격리 통합검증은 pnpm test:integration으로 실행하세요. .env/운영 DB 직접 실행은 차단합니다.');
}
