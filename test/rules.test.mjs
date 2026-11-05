import test from 'node:test';
import assert from 'node:assert/strict';
import * as r from '../dist/rules.js';

test('비밀번호는 매번 다른 salt, 검증 및 손상된 해시 거절',()=>{
 const a=r.hashPassword('test-strong-password'),b=r.hashPassword('test-strong-password');
 assert.notEqual(a,b);assert.ok(a.startsWith('scrypt:'));assert.equal(r.verifyPassword('test-strong-password',a),true);assert.equal(r.verifyPassword('wrong',a),false);assert.equal(r.verifyPassword('x','scrypt:bad:bad'),false);
 assert.notEqual(r.tokenHash(r.newToken()),r.tokenHash(r.newToken()));
});
test('한국 날짜 경계, 윤일 및 정각/시간대 입력',()=>{
 assert.equal(r.kstDate(new Date('2026-11-05T15:00:00Z')),'2026-11-06');
 assert.equal(r.date('2028-02-29'),'2028-02-29');assert.throws(()=>r.date('2026-02-29'));
 assert.equal(r.reservationTime('2026-11-06T10:00:00+09:00').toISOString(),'2026-11-06T01:00:00.000Z');
 for(const t of ['2026-11-06T10:00:00','2026-11-06T10:30:00+09:00','bad'])assert.throws(()=>r.reservationTime(t));
});
test('만료일 당일 예약, 확보 횟수, 휴무일 및 구매 이전 거절',()=>{
 const now=new Date('2026-11-05T00:00:00Z'),pass={purchased_on:'2026-11-01',expires_on:'2026-11-06',total_sessions:10};
 const friday={working_days:[5]};
 assert.doesNotThrow(()=>r.assertBookable(pass,friday,new Date('2026-11-06T10:00:00+09:00'),{used:8,booked:1},now));
 assert.throws(()=>r.assertBookable(pass,friday,new Date('2026-11-06T10:00:00+09:00'),{used:8,booked:2},now));
 assert.throws(()=>r.assertBookable(pass,{working_days:[1]},new Date('2026-11-06T10:00:00+09:00'),{used:0,booked:0},now));
 assert.throws(()=>r.assertBookable(pass,friday,new Date('2026-11-13T10:00:00+09:00'),{used:0,booked:0},now));
});
test('완료/노쇼/취소 이후 상태 재변경 거절하여 이중 차감 방지',()=>{
 for(const next of ['completed','noshow','cancelled'])assert.doesNotThrow(()=>r.assertTransition('booked',next));
 for(const previous of ['completed','noshow','cancelled'])assert.throws(()=>r.assertTransition(previous,'completed'));
 assert.throws(()=>r.assertTransition('booked','booked'));
});
test('형식 정규화 및 범위 검증',()=>{
 assert.equal(r.phone('010-1234-5678'),'01012345678');assert.equal(r.email(' USER@Example.com '),'user@example.com');
 assert.throws(()=>r.phone('123'));assert.throws(()=>r.password('short'));assert.throws(()=>r.int(10.5,'금액'));assert.throws(()=>r.workingDays([1,1]));assert.throws(()=>r.workingDays([7]));
});
test('영수증은 실제 이미지 magic·MIME·정규 base64·2MB·파일이름 제한',()=>{
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4iQAAAAASUVORK5CYII=';
 const input={fileName:'가상 영수증.png',mimeType:'image/png',dataBase64:png};
 assert.equal(r.receiptInput(input).data.toString('base64'),png);
 assert.throws(()=>r.receiptInput({...input,mimeType:'image/jpeg'}));
 assert.throws(()=>r.receiptInput({...input,mimeType:'image/svg+xml'}));
 assert.throws(()=>r.receiptInput({...input,dataBase64:Buffer.from('<html>bad</html>').toString('base64')}));
 assert.throws(()=>r.receiptInput({...input,dataBase64:png+'\n'}));
 assert.throws(()=>r.receiptInput({...input,fileName:'../receipt.png'}));
 assert.throws(()=>r.receiptInput({...input,fileName:'a'.repeat(121)}));
 const huge=Buffer.alloc(2097153);Buffer.from(png,'base64').copy(huge);assert.throws(()=>r.receiptInput({...input,dataBase64:huge.toString('base64')}));
 const jpeg=Buffer.from([255,216,255,224,255,217]);assert.equal(r.receiptInput({fileName:'receipt.jpg',mimeType:'image/jpeg',dataBase64:jpeg.toString('base64')}).data.length,6);
 const webp=Buffer.alloc(20);webp.write('RIFF');webp.writeUInt32LE(12,4);webp.write('WEBP',8);webp.write('VP8 ',12);assert.equal(r.receiptInput({fileName:'receipt.webp',mimeType:'image/webp',dataBase64:webp.toString('base64')}).data.length,20);
 webp.writeUInt32LE(50,4);assert.throws(()=>r.receiptInput({fileName:'receipt.webp',mimeType:'image/webp',dataBase64:webp.toString('base64')}));
});
