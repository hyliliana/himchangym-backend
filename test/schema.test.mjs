import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('../scripts/schema.sql',import.meta.url),'utf8');
test('DDL은 hw2에만 존재하며 소유권과 시간 중복을 DB에서 보장',()=>{
 assert.equal(/\b(?:DROP|TRUNCATE)\b/i.test(sql),false);
 const created=[...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\S+)/g)].map(x=>x[1]);assert.equal(created.length,8);assert.ok(created.every(x=>x.startsWith('hw2.')));
 assert.match(sql,/FOREIGN KEY\(pass_id,member_id\) REFERENCES hw2.passes\(id,member_id\)/);
 assert.match(sql,/UNIQUE INDEX.*trainer_time.*WHERE status <> 'cancelled'/);
 assert.match(sql,/UNIQUE INDEX.*member_time.*WHERE status <> 'cancelled'/);
 assert.match(sql,/token_hash text NOT NULL UNIQUE/);assert.match(sql,/EXTRACT\(MINUTE/);
});
