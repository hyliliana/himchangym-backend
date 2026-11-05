import { Injectable, UnauthorizedException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { pool, transaction } from './db.js';
import * as r from './rules.js';

const passSelect = `SELECT p.id,p.member_id AS "memberId",m.name AS "memberName",p.type_id AS "typeId",t.name AS "typeName",
p.purchased_on AS "purchasedOn",p.paid_amount AS "paidAmount",p.expires_on AS "expiresOn",p.total_sessions AS "totalSessions",
count(v.id) FILTER (WHERE v.status IN ('completed','noshow'))::int AS "usedSessions",
count(v.id) FILTER (WHERE v.status='booked')::int AS "bookedSessions"
FROM hw2.passes p JOIN hw2.members m ON m.id=p.member_id JOIN hw2.pass_types t ON t.id=p.type_id LEFT JOIN hw2.reservations v ON v.pass_id=p.id`;
const reservationSelect = `SELECT v.id,v.member_id AS "memberId",m.name AS "memberName",v.pass_id AS "passId",pt.name AS "typeName",v.trainer_id AS "trainerId",t.name AS "trainerName",v.starts_at AS "startsAt",v.status,v.note FROM hw2.reservations v JOIN hw2.members m ON m.id=v.member_id JOIN hw2.passes p ON p.id=v.pass_id JOIN hw2.pass_types pt ON pt.id=p.type_id JOIN hw2.trainers t ON t.id=v.trainer_id`;
const userView = (a: any) => ({ id: a.id, email: a.email, name: a.name, kind: a.kind, role: a.role, mustChangePassword: a.must_change_password });
const staffView = (a: any) => ({ id:a.id,email:a.email,name:a.name,role:a.role,isActive:a.is_active,mustChangePassword:a.must_change_password });
const trainerView = (a: any) => ({id:a.id,name:a.name,workingDays:a.working_days});
const typeView = (a: any) => ({id:a.id,name:a.name,totalSessions:a.total_sessions,listPrice:a.list_price,validDays:a.valid_days});
function passView(p:any) {
  const remainingSessions = p.totalSessions-p.usedSessions, availableSessions=remainingSessions-p.bookedSessions;
  return {...p,remainingSessions,availableSessions,isUsable:p.expiresOn>=r.kstDate() && p.purchasedOn<=r.kstDate() && availableSessions>0};
}
const dummyHash = r.hashPassword('dummy-nonexistent-account');
const loginAttempts = new Map<string,{count:number,until:number}>();

@Injectable()
export class GymService {
  async authenticate(header?:string, allowPasswordChange=false) {
    if (!header?.startsWith('Bearer ') || header.length>200) throw new UnauthorizedException('로그인이 필요합니다.');
    const {rows} = await pool.query(`SELECT a.* FROM hw2.sessions s JOIN hw2.accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.is_active`,[r.tokenHash(header.slice(7))]);
    if (!rows[0]) throw new UnauthorizedException('세션이 만료되었거나 계정이 정지되었습니다.');
    if (rows[0].must_change_password && !allowPasswordChange) throw new ForbiddenException('최초 비밀번호를 변경해 주세요.');
    return rows[0];
  }
  requireStaff(a:any,admin=false) { if(a.kind!=='staff'||(admin&&a.role!=='admin')) throw new ForbiddenException('접근 권한이 없습니다.'); }
  async member(a:any) { if(a.kind!=='member') throw new ForbiddenException('회원 전용 기능입니다.'); const {rows}=await pool.query('SELECT * FROM hw2.members WHERE account_id=$1',[a.id]); if(!rows[0]) throw new NotFoundException('회원이 없습니다.'); return rows[0]; }
  async createSession(c:PoolClient,a:any) { const token=r.newToken(); await c.query('INSERT INTO hw2.sessions(account_id,token_hash) VALUES($1,$2)',[a.id,r.tokenHash(token)]); return {token,user:userView(a)}; }
  async signup(b:any) {
    const email=r.email(b.email),password=r.password(b.password),name=r.str(b.name,'이름'),phone=r.phone(b.phone);
    return transaction(async c=>{ const {rows}=await c.query(`INSERT INTO hw2.accounts(email,password_hash,name,kind) VALUES($1,$2,$3,'member') RETURNING *`,[email,r.hashPassword(password),name]); await c.query('INSERT INTO hw2.members(account_id,name,phone) VALUES($1,$2,$3)',[rows[0].id,name,phone]); return this.createSession(c,rows[0]); });
  }
  async login(b:any,ip:string) {
    const email=r.email(b.email),password=r.password(b.password);
    if(!['member','staff'].includes(b.kind)) r.fail('로그인 유형을 확인해 주세요.');
    const key=`${ip}:${email}`; const old=loginAttempts.get(key);
    if(old&&old.until>Date.now()&&old.count>=10) throw new UnauthorizedException('로그인 시도가 많습니다. 15분 후 다시 시도해 주세요.');
    return transaction(async c=>{
      const {rows}=await c.query('SELECT * FROM hw2.accounts WHERE email=$1 AND kind=$2 FOR UPDATE',[email,b.kind]); const a=rows[0];
      const valid=r.verifyPassword(password,a?.password_hash??dummyHash);
      if(!a||!valid||!a.is_active) { loginAttempts.set(key,{count:old&&old.until>Date.now()?old.count+1:1,until:Date.now()+900000}); if(loginAttempts.size>10000) { for(const [k,v] of loginAttempts) if(v.until<Date.now()) loginAttempts.delete(k); } throw new UnauthorizedException('이메일 또는 비밀번호를 확인해 주세요.'); }
      loginAttempts.delete(key); await c.query('DELETE FROM hw2.sessions WHERE account_id=$1 AND expires_at<now()',[a.id]); return this.createSession(c,a);
    });
  }
  async logout(header:string) { await pool.query('DELETE FROM hw2.sessions WHERE token_hash=$1',[r.tokenHash(header.slice(7))]); return {ok:true}; }
  async changePassword(a:any,b:any,header:string) {
    const current=r.password(b.currentPassword),next=r.password(b.newPassword); if(current===next) r.fail('새 비밀번호는 현재 비밀번호와 달라야 합니다.');
    return transaction(async c=>{ const {rows}=await c.query('SELECT * FROM hw2.accounts WHERE id=$1 FOR UPDATE',[a.id]); if(!r.verifyPassword(current,rows[0].password_hash)) throw new UnauthorizedException('현재 비밀번호가 맞지 않습니다.');
      await c.query('UPDATE hw2.accounts SET password_hash=$1,must_change_password=false WHERE id=$2',[r.hashPassword(next),a.id]);
      await c.query('DELETE FROM hw2.sessions WHERE account_id=$1 AND token_hash<>$2',[a.id,r.tokenHash(header.slice(7))]); return {ok:true,user:userView({...rows[0],must_change_password:false})}; });
  }
  async catalog() { const [trainers,types]=await Promise.all([pool.query('SELECT * FROM hw2.trainers ORDER BY id'),pool.query('SELECT * FROM hw2.pass_types ORDER BY id')]); return {trainers:trainers.rows.map(trainerView),passTypes:types.rows.map(typeView)}; }
  async passes(memberId?:number,c:any=pool,passId?:number) { const conditions:string[]=[];const args:number[]=[];if(memberId){args.push(memberId);conditions.push(`p.member_id=$${args.length}`);}if(passId){args.push(passId);conditions.push(`p.id=$${args.length}`);}const {rows}=await c.query(`${passSelect} ${conditions.length?'WHERE '+conditions.join(' AND '):''} GROUP BY p.id,m.id,t.id ORDER BY p.expires_on DESC,p.id DESC`,args);return rows.map(passView); }
  async reservations(memberId?:number,date?:string,status?:string) { const conditions:string[]=[];const args:any[]=[]; if(memberId){args.push(memberId);conditions.push(`v.member_id=$${args.length}`);}if(date){args.push(r.date(date));conditions.push(`(v.starts_at AT TIME ZONE 'Asia/Seoul')::date=$${args.length}::date`);}if(status){if(!['booked','completed','cancelled','noshow'].includes(status))r.fail('예약 상태를 확인해 주세요.');args.push(status);conditions.push(`v.status=$${args.length}`);}const {rows}=await pool.query(`${reservationSelect} ${conditions.length?'WHERE '+conditions.join(' AND '):''} ORDER BY v.starts_at DESC,v.id DESC`,args);return rows; }
  async memberDashboard(a:any) { const m=await this.member(a);return {member:{id:m.id,name:m.name,phone:m.phone,joinedAt:m.joined_at},passes:await this.passes(m.id),reservations:await this.reservations(m.id)}; }
  async updateMember(memberId:number,b:any) { const name=r.str(b.name,'이름'),phone=r.phone(b.phone);return transaction(async c=>{const {rows}=await c.query('UPDATE hw2.members SET name=$1,phone=$2 WHERE id=$3 RETURNING account_id',[name,phone,memberId]);if(!rows[0])throw new NotFoundException('회원을 찾을 수 없습니다.');await c.query('UPDATE hw2.accounts SET name=$1 WHERE id=$2',[name,rows[0].account_id]);return {ok:true};}); }
  async book(a:any,b:any) {
    const member=await this.member(a),passId=r.id(b.passId),trainerId=r.id(b.trainerId),startsAt=r.reservationTime(b.startsAt);
    const reservationId=await transaction(async c=>{
      // Every reservation/status mutation locks pass first, then reservation. This serializes capacity checks.
      const {rows}=await c.query('SELECT * FROM hw2.passes WHERE id=$1 FOR UPDATE',[passId]);const pass=rows[0];
      if(!pass||pass.member_id!==member.id)throw new ForbiddenException('본인의 이용권만 예약할 수 있습니다.');
      const trainer=(await c.query('SELECT * FROM hw2.trainers WHERE id=$1 FOR SHARE',[trainerId])).rows[0];if(!trainer)throw new NotFoundException('트레이너를 찾을 수 없습니다.');
      const counts=(await c.query(`SELECT count(*) FILTER (WHERE status IN ('completed','noshow'))::int AS used,count(*) FILTER (WHERE status='booked')::int AS booked FROM hw2.reservations WHERE pass_id=$1`,[passId])).rows[0];
      r.assertBookable(pass,trainer,startsAt,counts);
      const result=await c.query('INSERT INTO hw2.reservations(member_id,pass_id,trainer_id,starts_at) VALUES($1,$2,$3,$4) RETURNING id',[member.id,passId,trainerId,startsAt]);return result.rows[0].id;
    });
    const result=await pool.query(`${reservationSelect} WHERE v.id=$1`,[reservationId]);return {reservation:result.rows[0]};
  }
  async updateReservation(reservationId:number,b:any,memberId?:number) {
    if(b.status===undefined&&b.note===undefined) r.fail('변경할 항목이 없습니다.');
    if(b.note!==undefined&&(typeof b.note!=='string'||b.note.length>5000))r.fail('운동메모는 5,000자 이내로 입력해 주세요.');
    return transaction(async c=>{
      const initial=(await c.query('SELECT pass_id FROM hw2.reservations WHERE id=$1',[reservationId])).rows[0];if(!initial)throw new NotFoundException('예약을 찾을 수 없습니다.');
      await c.query('SELECT id FROM hw2.passes WHERE id=$1 FOR UPDATE',[initial.pass_id]);
      const v=(await c.query('SELECT * FROM hw2.reservations WHERE id=$1 FOR UPDATE',[reservationId])).rows[0];
      if(memberId!==undefined&&v.member_id!==memberId)throw new ForbiddenException('본인의 예약만 취소할 수 있습니다.');
      if(b.status!==undefined){ r.assertTransition(v.status,b.status);if(memberId!==undefined&&b.status!=='cancelled')throw new ForbiddenException('회원은 취소만 가능합니다.');if(memberId!==undefined&&new Date(v.starts_at)<=new Date())r.fail('시작된 예약은 직원에게 문의해 주세요.');if(['completed','noshow'].includes(b.status)&&new Date(v.starts_at)>new Date())r.fail('미래 예약은 완료·노쇼로 변경할 수 없습니다.'); }
      await c.query('UPDATE hw2.reservations SET status=$1,note=$2 WHERE id=$3',[b.status??v.status,b.note??v.note,reservationId]);return {ok:true};
    });
  }
  async members(q='') { if(q.length>100)r.fail('검색어는 100자 이내로 입력해 주세요.'); const term=q.trim();const digits=term.replace(/\D/g,'');const {rows}=await pool.query(`SELECT m.id,m.name,m.phone,a.email,m.joined_at AS "joinedAt" FROM hw2.members m JOIN hw2.accounts a ON a.id=m.account_id WHERE $1='' OR position(lower($1) in lower(m.name))>0 OR ($2<>'' AND right(m.phone,length($2))=$2) ORDER BY m.id DESC`,[term,digits]);return {members:rows}; }
  async issuePass(b:any) {
    const memberId=r.id(b.memberId),typeId=r.id(b.typeId),purchasedOn=r.date(b.purchasedOn),paid=r.int(b.paidAmount,'실결제액',0);
    if(purchasedOn>r.kstDate())r.fail('구매일은 미래일 수 없습니다.');
    return transaction(async c=>{const type=(await c.query('SELECT * FROM hw2.pass_types WHERE id=$1 FOR SHARE',[typeId])).rows[0];if(!type)throw new NotFoundException('이용권 종류를 찾을 수 없습니다.');const expiresOn=b.expiresOn?r.date(b.expiresOn):r.addDays(purchasedOn,type.valid_days-1);if(expiresOn<purchasedOn)r.fail('만료일은 구매일 이후여야 합니다.');const {rows}=await c.query('INSERT INTO hw2.passes(member_id,type_id,purchased_on,paid_amount,expires_on,total_sessions) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[memberId,typeId,purchasedOn,paid,expiresOn,type.total_sessions]);return {pass:(await this.passes(undefined,c,rows[0].id))[0]};});
  }
  async trainer(b:any,trainerId?:number) {const name=r.str(b.name,'트레이너 이름'),days=r.workingDays(b.workingDays);const {rows}=trainerId?await pool.query('UPDATE hw2.trainers SET name=$1,working_days=$2 WHERE id=$3 RETURNING *',[name,days,trainerId]):await pool.query('INSERT INTO hw2.trainers(name,working_days) VALUES($1,$2) RETURNING *',[name,days]);if(!rows[0])throw new NotFoundException('트레이너를 찾을 수 없습니다.');return trainerId?{ok:true}:{trainer:trainerView(rows[0])};}
  async passType(b:any,typeId?:number) {const name=r.str(b.name,'이용권 이름'),total=r.int(b.totalSessions,'총 횟수'),price=r.int(b.listPrice,'정가',0),days=r.int(b.validDays,'유효기간',1,3650);if(![10,20,30].includes(total))r.fail('이용권은 10·20·30회 중 선택해 주세요.');const {rows}=typeId?await pool.query('UPDATE hw2.pass_types SET name=$1,total_sessions=$2,list_price=$3,valid_days=$4 WHERE id=$5 RETURNING *',[name,total,price,days,typeId]):await pool.query('INSERT INTO hw2.pass_types(name,total_sessions,list_price,valid_days) VALUES($1,$2,$3,$4) RETURNING *',[name,total,price,days]);if(!rows[0])throw new NotFoundException('이용권 종류를 찾을 수 없습니다.');return typeId?{ok:true}:{passType:typeView(rows[0])};}
  async adminDashboard() {
    const [counts,passes,stats]=await Promise.all([
      pool.query(`SELECT (SELECT count(*)::int FROM hw2.members) AS "membersCount",count(*) FILTER(WHERE status='booked')::int AS "bookedCount",count(*) FILTER(WHERE status<>'cancelled' AND (starts_at AT TIME ZONE 'Asia/Seoul')::date=(now() AT TIME ZONE 'Asia/Seoul')::date)::int AS "todayCount" FROM hw2.reservations`),
      this.passes(),pool.query(`SELECT t.id,t.name,count(v.id)::int AS "completedCount" FROM hw2.trainers t LEFT JOIN hw2.reservations v ON v.trainer_id=t.id AND v.status='completed' AND date_trunc('month',v.starts_at AT TIME ZONE 'Asia/Seoul')=date_trunc('month',now() AT TIME ZONE 'Asia/Seoul') GROUP BY t.id ORDER BY t.id`)
    ]);const today=r.kstDate(),until=r.addDays(today,14);return {...counts.rows[0],expiringPasses:passes.filter((p:any)=>p.expiresOn>=today&&p.expiresOn<=until&&p.remainingSessions>0),trainerStats:stats.rows};
  }
  async staff() {return {staff:(await pool.query(`SELECT * FROM hw2.accounts WHERE kind='staff' ORDER BY id`)).rows.map(staffView)};}
  async createStaff(b:any) {const email=r.email(b.email),name=r.str(b.name,'직원 이름');if(!['admin','employee'].includes(b.role))r.fail('직원 역할을 확인해 주세요.');const temporaryPassword=r.temporaryPassword();const {rows}=await pool.query(`INSERT INTO hw2.accounts(email,password_hash,name,kind,role,must_change_password) VALUES($1,$2,$3,'staff',$4,true) RETURNING *`,[email,r.hashPassword(temporaryPassword),name,b.role]);return {staff:staffView(rows[0]),temporaryPassword};}
  async updateStaff(actor:any,staffId:number,b:any) {
    if(b.name===undefined&&b.role===undefined&&b.isActive===undefined)r.fail('변경할 항목이 없습니다.');
    if(b.role!==undefined&&!['admin','employee'].includes(b.role))r.fail('직원 역할을 확인해 주세요.');if(b.isActive!==undefined&&typeof b.isActive!=='boolean')r.fail('활성 상태를 확인해 주세요.');
    if(actor.id===staffId&&b.isActive===false)r.fail('자신의 계정은 정지할 수 없습니다.');
    return transaction(async c=>{
      // Serialize staff mutations so two admins cannot concurrently remove the final admin.
      await c.query('SELECT pg_advisory_xact_lock(209051105)');
      const a=(await c.query(`SELECT * FROM hw2.accounts WHERE id=$1 AND kind='staff' FOR UPDATE`,[staffId])).rows[0];if(!a)throw new NotFoundException('직원을 찾을 수 없습니다.');
      const role=b.role??a.role,active=b.isActive??a.is_active;
      if(a.role==='admin'&&a.is_active&&(role!=='admin'||!active)){const {rows}=await c.query(`SELECT count(*)::int AS n FROM hw2.accounts WHERE kind='staff' AND role='admin' AND is_active`);if(rows[0].n<=1)r.fail('마지막 활성 관리자는 유지해야 합니다.');}
      await c.query('UPDATE hw2.accounts SET name=$1,role=$2,is_active=$3 WHERE id=$4',[b.name===undefined?a.name:r.str(b.name,'직원 이름'),role,active,staffId]);
      if(!active)await c.query('DELETE FROM hw2.sessions WHERE account_id=$1',[staffId]);return {ok:true};
    });
  }
  async resetPassword(staffId:number) {const temporaryPassword=r.temporaryPassword();return transaction(async c=>{const {rows}=await c.query(`UPDATE hw2.accounts SET password_hash=$1,must_change_password=true WHERE id=$2 AND kind='staff' RETURNING id`,[r.hashPassword(temporaryPassword),staffId]);if(!rows[0])throw new NotFoundException('직원을 찾을 수 없습니다.');await c.query('DELETE FROM hw2.sessions WHERE account_id=$1',[staffId]);return {temporaryPassword};});}
  async receipts(passId:number,memberId?:number,c:any=pool) {
    const p=(await c.query('SELECT member_id FROM hw2.passes WHERE id=$1',[passId])).rows[0];
    if(!p)throw new NotFoundException('이용권을 찾을 수 없습니다.');
    if(memberId!==undefined&&p.member_id!==memberId)throw new ForbiddenException('본인의 이용권 영수증만 볼 수 있습니다.');
    const {rows}=await c.query(`SELECT id,file_name AS "fileName",mime_type AS "mimeType",image_data,created_at AS "createdAt" FROM hw2.pass_receipts WHERE pass_id=$1 ORDER BY created_at,id`,[passId]);
    return {receipts:rows.map((v:any)=>({id:v.id,fileName:v.fileName,mimeType:v.mimeType,dataUrl:`data:${v.mimeType};base64,${v.image_data.toString('base64')}`,createdAt:v.createdAt}))};
  }
  async attachReceipt(actor:any,passId:number,body:any) {
    this.requireStaff(actor);
    const input=r.receiptInput(body);
    return transaction(async c=>{
      const p=(await c.query('SELECT id FROM hw2.passes WHERE id=$1 FOR UPDATE',[passId])).rows[0];
      if(!p)throw new NotFoundException('이용권을 찾을 수 없습니다.');
      const capacity=(await c.query('SELECT count(*)::int AS n,coalesce(sum(octet_length(image_data)),0)::int AS bytes FROM hw2.pass_receipts WHERE pass_id=$1',[passId])).rows[0];
      if(capacity.n>=5)r.fail('이용권당 이미지는 최대 5개까지 첨부할 수 있습니다.');
      if(capacity.bytes+input.data.length>3000000)r.fail('이 이용권 첨부 용량을 초과했어요. 이미지를 줄여 주세요.');
      await c.query('INSERT INTO hw2.pass_receipts(pass_id,uploader_id,file_name,mime_type,image_data) VALUES($1,$2,$3,$4,$5)',[passId,actor.id,input.fileName,input.mimeType,input.data]);
      return this.receipts(passId,undefined,c);
    });
  }
}
