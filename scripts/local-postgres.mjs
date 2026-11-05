import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const backendRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function createIsolatedDatabase(){
 const moduleFile=path.join(backendRoot,'.local/pg-runtime/node_modules/embedded-postgres/dist/index.js');
 try{await fs.access(moduleFile);}catch{throw new Error('먼저 pnpm test:setup을 실행해 테스트 전용 로컬 PG 런타임을 준비하세요.');}
 const {default:EmbeddedPostgres}=await import(pathToFileURL(moduleFile).href);
 await fs.mkdir(path.join(backendRoot,'.local'),{recursive:true});
 const dir=await fs.mkdtemp(path.join(backendRoot,'.local','integration-'));
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const database='gym_test_'+randomBytes(6).toString('hex'),user='gym_test',password=randomBytes(32).toString('hex');
 const cluster=new EmbeddedPostgres({databaseDir:path.join(dir,'data'),user,password,port,persistent:false,authMethod:'scram-sha-256',autoRehydrateSymlinks:true,createPostgresUser:false,postgresFlags:['-h','127.0.0.1','-c','unix_socket_directories='],onLog:()=>{},onError:()=>{}});
 let started=false;
 const stop=async()=>{if(started)await cluster.stop();else await cluster.stop().catch(()=>{});await fs.rm(dir,{recursive:true,force:true});};
 try{
  await cluster.initialise();await cluster.start();started=true;await cluster.createDatabase(database);
  const client=cluster.getPgClient(database,'127.0.0.1');await client.connect();
  try{await client.query(await fs.readFile(path.join(backendRoot,'scripts/schema.sql'),'utf8'));for(const name of (await fs.readdir(path.join(backendRoot,'scripts/migrations'))).filter(n=>n.endsWith('.sql')).sort())await client.query(await fs.readFile(path.join(backendRoot,'scripts/migrations',name),'utf8'));}finally{await client.end();}
  return {url:`postgresql://${user}:${password}@127.0.0.1:${port}/${database}`,stop};
 }catch(error){await stop();throw error;}
}
