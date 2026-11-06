import './require-isolated-database.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {publishTestSlots} from './published-slot-fixture.mjs';
import { bootstrap } from '../dist/main.js';
import { pool } from '../dist/db.js';
import { hashPassword, temporaryPassword, kstDate, addDays } from '../dist/rules.js';

test('담당 수업만 승인·거절하고 회원과 피드백 및 이용 횟수를 공유한다', async () => {
  const app = await bootstrap(0);
  const base = 'http://127.0.0.1:' + app.getHttpServer().address().port;
  async function request(method, path, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(base + path, { method, headers, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  async function ok(method, path, token, body) {
    const { status, data } = await request(method, path, token, body);
    assert.ok([200, 201].includes(status), method + ' ' + path + ' -> ' + status + ' ' + data.message);
    return data;
  }
  async function denied(method, path, token, body, statuses = [403, 404]) {
    const response = await request(method, path, token, body);
    assert.ok(statuses.includes(response.status), method + ' ' + path + ' -> ' + response.status);
  }
  try {
    const password = temporaryPassword();
    async function staff(role) {
      const email = 'trainer-test-' + role + '@example.com';
      await pool.query("INSERT INTO hw2.accounts(email,password_hash,name,kind,role) VALUES($1,$2,$3,'staff',$4)", [email, hashPassword(password), role, role]);
      return (await ok('POST', '/auth/login', null, { email, password, kind: 'staff' })).token;
    }
    const admin = await staff('admin');
    const desk = await staff('employee');
    const { token: member } = await ok('POST', '/auth/signup', null, { email:'trainer-test-member@example.com', password, name:'검수 회원', phone:'01000007634' });
    const dashboard = () => ok('GET', '/member/dashboard', member);
    const memberId = (await dashboard()).member.id;
    const adminId=(await ok('GET','/auth/me',admin)).user.id;
    const makeTrainer = async name => {const id=(await ok('POST', '/admin/trainers', desk, {name, workingDays:[0,1,2,3,4,5,6]})).trainer.id;await publishTestSlots(pool,id,adminId);return id;};
    const first = await makeTrainer('담당 트레이너');
    const second = await makeTrainer('다른 트레이너');
    const type = (await ok('POST','/admin/pass-types', desk, {name:'검수 PT', totalSessions:10, listPrice:500000, validDays:30})).passType;
    const today = kstDate();
    const pass = (await ok('POST','/admin/passes',desk,{ memberId, typeId:type.id, purchasedOn:addDays(today,-5), expiresOn:addDays(today,20), paidAmount:500000 })).pass;
    const start = hour => addDays(today, 1) + 'T' + hour + ':00:00+09:00';
    const book = async (trainerId, hour) => (await ok('POST','/member/reservations',member,{trainerId,passId:pass.id,startsAt:start(hour)})).reservation;
    const legacy = await book(first, '09');
    assert.equal(legacy.approval, 'approved');
    async function connect(id) {
      const url = '/admin/trainers/' + id + '/account';
      const email = 'trainer-test-' + id + '@example.com';
      await denied('POST', url, desk, {email});
      const { temporaryPassword: initial } = await ok('POST',url,admin,{email});
      const {token} = await ok('POST', '/auth/login', null, {email, password:initial, kind:'trainer'});
      await denied('GET','/trainer/reservations',token);
      await ok('POST','/auth/change-password',token,{currentPassword:initial,newPassword:password});
      return token;
    }
    const trainer = await connect(first);
    const other = await connect(second);
    await denied('GET','/trainer/reservations',member);
    await denied('GET','/admin/members',trainer);
    await denied('GET','/member/dashboard',trainer);
    const otherBooking = await book(second, '14');
    const own = async () => (await ok('GET','/trainer/reservations',trainer)).reservations;
    assert.ok(!(await own()).some(row => row.id === otherBooking.id));
    assert.equal((await own()).find(row => row.id === legacy.id).approval,'approved');
    const original = await book(first, '10');
    const route = '/trainer/reservations/' + original.id;
    const decision = (approval, expectedStartsAt) => ({approval,expectedStartsAt});
    assert.equal(original.approval,'pending');
    await denied('PATCH',route,other,decision('rejected',original.startsAt));
    await denied('PATCH',route,other,{note:'타인 예약'});
    await denied('PATCH',route,member,decision('approved',original.startsAt));
    await ok('PATCH',route,trainer,decision('approved',original.startsAt));
    const noChange = await ok('POST', '/member/reservations/' + original.id + '/reschedule',member,{startsAt:original.startsAt});
    assert.equal(noChange.reservation.approval,'approved');
    const moved = (await ok('POST','/member/reservations/' + original.id + '/reschedule',member,{startsAt:start('11')})).reservation;
    assert.equal(moved.approval,'approved');
    assert.equal(Date.parse(moved.startsAt),Date.parse(original.startsAt));
    assert.equal(Date.parse(moved.pendingChange.startsAt),Date.parse(start('11')));
    const changeDecision=route+'/changes/'+moved.pendingChange.id+'/decision';
    await denied('POST',changeDecision,other,{decision:'approve'});
    await denied('GET',route+'/history',other);
    await denied('POST','/admin/reservations/'+original.id+'/changes/'+moved.pendingChange.id+'/decision',desk,{decision:'approve'});
    await ok('POST',changeDecision,trainer,{decision:'reject'});
    const rejectedMove=(await dashboard()).reservations.find(row=>row.id===original.id);
    assert.equal(Date.parse(rejectedMove.startsAt),Date.parse(original.startsAt));
    assert.equal(rejectedMove.pendingChange,null);
    const nextMove=(await ok('POST','/member/reservations/'+original.id+'/reschedule',member,{startsAt:start('11')})).reservation;
    const simultaneous = await Promise.all(['approve','reject'].map(value =>
      request('POST',route+'/changes/'+nextMove.pendingChange.id+'/decision',trainer,{decision:value})));
    assert.equal(simultaneous.filter(x=>x.status===201).length,1);
    const historyUrl='/member/reservations/'+original.id+'/history';
    const log=(await ok('GET',historyUrl,member)).history;
    assert.deepEqual(log,(await ok('GET',route+'/history',trainer)).history);
    assert.ok(log.some(entry=>entry.event==='requested' && entry.actorRole==='member' && Date.parse(entry.after.startsAt)===Date.parse(start('11'))));
    assert.ok(log.some(entry=>entry.event==='rejected_change' && entry.actorRole==='trainer'));
    const rejected = await book(first,'12');
    const avail = async () => (await dashboard()).passes.find(row => row.id === pass.id);
    const before = await avail();
    await ok('PATCH','/trainer/reservations/' + rejected.id, trainer,decision('rejected',rejected.startsAt));
    const after = await avail();
    assert.equal(after.availableSessions,before.availableSessions + 1);
    assert.equal(after.usedSessions,before.usedSessions);
    const memberRow = (await dashboard()).reservations.find(row => row.id === rejected.id);
    assert.deepEqual([memberRow.status,memberRow.approval],['cancelled','rejected']);
    const replacement = await book(first,'12');
    const replacementRoute = '/trainer/reservations/' + replacement.id;
    await pool.query('UPDATE hw2.reservations SET starts_at=$1 WHERE id=$2',[addDays(today,-1) + 'T12:00:00+09:00', replacement.id]);
    await denied('PATCH','/admin/reservations/' + replacement.id,desk,{status:'completed'},[400,409]);
    // A legacy, confirmed class can be completed and its feedback read by the member.
    await pool.query('UPDATE hw2.reservations SET starts_at=$1 WHERE id=$2',[addDays(today,-1) + 'T09:00:00+09:00', legacy.id]);
    const legacyRoute = '/trainer/reservations/' + legacy.id;
    const used = (await avail()).usedSessions;
    await ok('PATCH',legacyRoute,trainer,{status:'completed'});
    await ok('PATCH',legacyRoute,trainer,{note:'다음 수업 전까지 스쿼트 호흡 연습'});
    assert.equal((await avail()).usedSessions,used+1);
    assert.equal((await dashboard()).reservations.find(row => row.id === legacy.id).note,'다음 수업 전까지 스쿼트 호흡 연습');
    await ok('PATCH',legacyRoute,trainer,{note:'호흡 연습과 런지 추가'});
    await ok('PATCH',legacyRoute,trainer,{note:'호흡 연습과 런지 추가'});
    const feedback=(await ok('GET','/member/reservations/'+legacy.id+'/history',member)).history.filter(x=>x.event==='feedback');
    assert.equal(feedback.length,2);
    assert.equal(feedback[0].before.note,'다음 수업 전까지 스쿼트 호흡 연습');
    assert.equal(feedback[0].after.note,'호흡 연습과 런지 추가');
    assert.ok(feedback[0].actorName && Number.isFinite(Date.parse(feedback[0].changedAt)));
    await denied('PATCH', replacementRoute, other, {status:'noshow'});

    // Target time can be taken after a change request: failed approval preserves the source.
    const conflictSource=await book(first,'17');
    await ok('PATCH','/trainer/reservations/'+conflictSource.id,trainer,decision('approved',conflictSource.startsAt));
    const conflictRequest=(await ok('POST','/member/reservations/'+conflictSource.id+'/reschedule',member,{startsAt:start('18')})).reservation.pendingChange;
    const targetBooking=await book(first,'18');
    const conflictDecision='/trainer/reservations/'+conflictSource.id+'/changes/'+conflictRequest.id+'/decision';
    await denied('POST',conflictDecision,trainer,{decision:'approve'},[409]);
    const preserved=(await dashboard()).reservations.find(row=>row.id===conflictSource.id);
    assert.equal(Date.parse(preserved.startsAt),Date.parse(conflictSource.startsAt));
    assert.equal(preserved.approval,'approved');assert.equal(preserved.pendingChange.id,conflictRequest.id);
    const failedLog=(await ok('GET','/member/reservations/'+conflictSource.id+'/history',member)).history;
    assert.ok(!failedLog.some(row=>row.event==='approved_change'));
    await ok('POST',conflictDecision,trainer,{decision:'reject'});
    await ok('POST','/member/reservations/'+targetBooking.id+'/cancel',member);
    await ok('POST','/member/reservations/'+conflictSource.id+'/cancel',member);

    const resetPath = '/admin/trainers/' + second + '/reset-password';
    await denied('POST', resetPath, desk);
    const reset = await ok('POST', resetPath, admin);
    await denied('GET', '/trainer/reservations', other, undefined, [401]);
    const email = 'trainer-test-' + second + '@example.com';
    const resetLogin = await ok('POST', '/auth/login', null, {email, password:reset.temporaryPassword, kind:'trainer'});
    await denied('GET', '/trainer/reservations', resetLogin.token);
    await ok('POST', '/auth/change-password',resetLogin.token,{currentPassword:reset.temporaryPassword,newPassword:password});
    await ok('POST', '/member/reservations/' + otherBooking.id + '/cancel', member);
    await ok('DELETE', '/admin/trainers/' + second, admin);
    await denied('GET', '/trainer/reservations', resetLogin.token, undefined, [401]);
    await denied('POST', '/auth/login', null, {email,password,kind:'trainer'}, [401]);
    await ok('POST', '/admin/trainers/' + second + '/restore', admin);
    await denied('GET', '/trainer/reservations', resetLogin.token, undefined, [401]);
    const restored = await ok('POST', '/auth/login', null, {email,password,kind:'trainer'});
    assert.ok((await ok('GET','/trainer/reservations',restored.token)).reservations.some(row => row.id === otherBooking.id));
  } finally {
    await app.close();
    await pool.end();
  }
});
