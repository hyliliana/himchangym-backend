import { Injectable, UnauthorizedException, ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common';
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
const trainerView = (a: any) => ({id:a.id,name:a.name,workingDays:a.working_days,deletedAt:a.deleted_at??null});
const typeView = (a: any) => ({id:a.id,name:a.name,totalSessions:a.total_sessions,listPrice:a.list_price,validDays:a.valid_days,deletedAt:a.deleted_at??null});
const memberView = (m:any) => ({id:m.id,name:m.name,phone:m.phone,email:m.email,joinedAt:m.joined_at,deletedAt:m.deleted_at??null,mustChangePassword:m.must_change_password});
type Entity = 'members'|'trainers'|'pass_types';
function passView(p:any) {
  const remainingSessions = p.totalSessions-p.usedSessions, availableSessions=remainingSessions-p.bookedSessions;
  return {...p,remainingSessions,availableSessions,isUsable:p.expiresOn>=r.kstDate() && p.purchasedOn<=r.kstDate() && availableSessions>0};
}
const dummyHash = r.hashPassword('dummy-nonexistent-account');
const loginAttempts = new Map<string,{count:number,until:number}>();

@Injectable()
export class GymService {
  // Mutations share this order: account -> member -> trainer -> pass -> reservation.
  // A type is locked after the member only when issuing a new purchase.
  private async lockMember(c:PoolClient,memberId:number,mode:'share'|'update'='share',includeDeleted=false) {
    const initial=(await c.query('SELECT account_id FROM hw2.members WHERE id=$1',[memberId])).rows[0];
    if(!initial)throw new NotFoundException('회원을 찾을 수 없습니다.');
    const clause=mode==='update'?'FOR UPDATE':'FOR SHARE';
    const account=(await c.query(`SELECT id,is_active,kind FROM hw2.accounts WHERE id=$1 ${clause}`,[initial.account_id])).rows[0];
    const member=(await c.query(`SELECT * FROM hw2.members WHERE id=$1 ${clause}`,[memberId])).rows[0];
    if(!member)throw new NotFoundException('회원을 찾을 수 없습니다.');
    if(!includeDeleted&&(member.deleted_at||!account?.is_active))throw new ConflictException('삭제되었거나 이용이 중지된 회원입니다. 먼저 회원을 복원해 주세요.');
    return member;
  }
  private async lockTrainer(c:PoolClient,trainerId:number,includeDeleted=false) {
    const trainer=(await c.query('SELECT * FROM hw2.trainers WHERE id=$1 FOR SHARE',[trainerId])).rows[0];
    if(!trainer)throw new NotFoundException('트레이너를 찾을 수 없습니다.');
    if(!includeDeleted&&trainer.deleted_at)throw new ConflictException('삭제된 트레이너는 신규 예약에 사용할 수 없습니다.');
    return trainer;
  }
  private async lockReservation(c:PoolClient,reservationId:number,actingMemberId?:number) {
    const initial=(await c.query('SELECT member_id,trainer_id,pass_id FROM hw2.reservations WHERE id=$1',[reservationId])).rows[0];
    if(!initial)throw new NotFoundException('예약을 찾을 수 없습니다.');
    if(actingMemberId!==undefined&&initial.member_id!==actingMemberId)throw new ForbiddenException('본인의 예약만 변경할 수 있습니다.');
    const member=await this.lockMember(c,initial.member_id,'share',actingMemberId===undefined);
    const trainer=await this.lockTrainer(c,initial.trainer_id,actingMemberId===undefined);
    const pass=(await c.query('SELECT * FROM hw2.passes WHERE id=$1 FOR UPDATE',[initial.pass_id])).rows[0];
    const reservation=(await c.query('SELECT * FROM hw2.reservations WHERE id=$1 FOR UPDATE',[reservationId])).rows[0];
    return {member,trainer,pass,reservation};
  }
  async authenticate(header?:string, allowPasswordChange=false) {
    if (!header?.startsWith('Bearer ') || header.length>200) throw new UnauthorizedException('로그인이 필요합니다.');
    const {rows} = await pool.query(`SELECT a.* FROM hw2.sessions s JOIN hw2.accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.is_active AND (a.kind='staff' OR EXISTS(SELECT 1 FROM hw2.members m WHERE m.account_id=a.id AND m.deleted_at IS NULL))`,[r.tokenHash(header.slice(7))]);
    if (!rows[0]) throw new UnauthorizedException('세션이 만료되었거나 계정이 정지되었습니다.');
    if (rows[0].must_change_password && !allowPasswordChange) throw new ForbiddenException('최초 비밀번호를 변경해 주세요.');
    return rows[0];
  }
  requireStaff(a:any,admin=false) { if(a.kind!=='staff'||(admin&&a.role!=='admin')) throw new ForbiddenException('접근 권한이 없습니다.'); }
  async member(a:any) { if(a.kind!=='member') throw new ForbiddenException('회원 전용 기능입니다.'); const {rows}=await pool.query('SELECT * FROM hw2.members WHERE account_id=$1 AND deleted_at IS NULL',[a.id]); if(!rows[0]) throw new UnauthorizedException('이용할 수 없는 회원 계정입니다.'); return rows[0]; }
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
      const memberActive=!a||a.kind!=='member'||!!(await c.query('SELECT id FROM hw2.members WHERE account_id=$1 AND deleted_at IS NULL FOR SHARE',[a.id])).rows[0];
      if(!a||!valid||!a.is_active||!memberActive) { loginAttempts.set(key,{count:old&&old.until>Date.now()?old.count+1:1,until:Date.now()+900000}); if(loginAttempts.size>10000) { for(const [k,v] of loginAttempts) if(v.until<Date.now()) loginAttempts.delete(k); } throw new UnauthorizedException('이메일 또는 비밀번호를 확인해 주세요.'); }
      loginAttempts.delete(key); await c.query('DELETE FROM hw2.sessions WHERE account_id=$1 AND expires_at<now()',[a.id]); return this.createSession(c,a);
    });
  }
  async logout(header:string) { await pool.query('DELETE FROM hw2.sessions WHERE token_hash=$1',[r.tokenHash(header.slice(7))]); return {ok:true}; }
  async changePassword(a:any,b:any,header:string) {
    const current=r.password(b.currentPassword),next=r.password(b.newPassword); if(current===next) r.fail('새 비밀번호는 현재 비밀번호와 달라야 합니다.');
    return transaction(async c=>{ const {rows}=await c.query('SELECT * FROM hw2.accounts WHERE id=$1 FOR UPDATE',[a.id]);if(!rows[0]?.is_active)throw new UnauthorizedException('이용할 수 없는 계정입니다.');if(a.kind==='member'&&!(await c.query('SELECT id FROM hw2.members WHERE account_id=$1 AND deleted_at IS NULL FOR SHARE',[a.id])).rows[0])throw new UnauthorizedException('이용할 수 없는 회원 계정입니다.'); if(!r.verifyPassword(current,rows[0].password_hash)) throw new UnauthorizedException('현재 비밀번호가 맞지 않습니다.');
      await c.query('UPDATE hw2.accounts SET password_hash=$1,must_change_password=false WHERE id=$2',[r.hashPassword(next),a.id]);
      await c.query('DELETE FROM hw2.sessions WHERE account_id=$1 AND token_hash<>$2',[a.id,r.tokenHash(header.slice(7))]); return {ok:true,user:userView({...rows[0],must_change_password:false})}; });
  }
  async catalog(includeDeleted=false) { const filter=includeDeleted?'':'WHERE deleted_at IS NULL';const [trainers,types]=await Promise.all([pool.query(`SELECT * FROM hw2.trainers ${filter} ORDER BY id`),pool.query(`SELECT * FROM hw2.pass_types ${filter} ORDER BY id`)]); return {trainers:trainers.rows.map(trainerView),passTypes:types.rows.map(typeView)}; }
  async passes(memberId?:number,c:any=pool,passId?:number,activeMembersOnly=false) { const conditions:string[]=[];const args:number[]=[];if(activeMembersOnly)conditions.push('m.deleted_at IS NULL');if(memberId){args.push(memberId);conditions.push(`p.member_id=$${args.length}`);}if(passId){args.push(passId);conditions.push(`p.id=$${args.length}`);}const {rows}=await c.query(`${passSelect} ${conditions.length?'WHERE '+conditions.join(' AND '):''} GROUP BY p.id,m.id,t.id ORDER BY p.expires_on DESC,p.id DESC`,args);return rows.map(passView); }
  async reservations(memberId?:number,date?:string,status?:string) { const conditions:string[]=[];const args:any[]=[]; if(memberId){args.push(memberId);conditions.push(`v.member_id=$${args.length}`);}if(date){args.push(r.date(date));conditions.push(`(v.starts_at AT TIME ZONE 'Asia/Seoul')::date=$${args.length}::date`);}if(status){if(!['booked','completed','cancelled','noshow'].includes(status))r.fail('예약 상태를 확인해 주세요.');args.push(status);conditions.push(`v.status=$${args.length}`);}const {rows}=await pool.query(`${reservationSelect} ${conditions.length?'WHERE '+conditions.join(' AND '):''} ORDER BY v.starts_at DESC,v.id DESC`,args);return rows; }
  async memberDashboard(a:any) { const m=await this.member(a);return {member:{id:m.id,name:m.name,phone:m.phone,joinedAt:m.joined_at,deletedAt:null},passes:await this.passes(m.id),reservations:await this.reservations(m.id)}; }
  async updateMember(memberId:number,b:any,allowJoinedAt=false) {
    if(b.name===undefined&&b.phone===undefined&&b.joinedAt===undefined)r.fail('변경할 항목이 없습니다.');
    if(b.joinedAt!==undefined&&!allowJoinedAt)throw new ForbiddenException('가입일은 직원만 변경할 수 있습니다.');
    const name=b.name===undefined?undefined:r.str(b.name,'이름'),phone=b.phone===undefined?undefined:r.phone(b.phone),joined=b.joinedAt===undefined?undefined:r.date(b.joinedAt);
    if(joined&&joined>r.kstDate())r.fail('가입일은 미래일 수 없습니다.');
    return transaction(async c=>{const m=await this.lockMember(c,memberId,'update');await c.query('UPDATE hw2.members SET name=$1,phone=$2,joined_at=$3 WHERE id=$4',[name??m.name,phone??m.phone,joined??m.joined_at,memberId]);await c.query('UPDATE hw2.accounts SET name=$1 WHERE id=$2',[name??m.name,m.account_id]);return {ok:true};});
  }
  async createMember(b:any) {
    const name=r.str(b.name,'이름'),phone=r.phone(b.phone),email=r.email(b.email),joined=b.joinedAt===undefined?r.kstDate():r.date(b.joinedAt);
    if(joined>r.kstDate())r.fail('가입일은 미래일 수 없습니다.');
    const temporaryPassword=r.temporaryPassword();
    try{return await transaction(async c=>{const a=(await c.query(`INSERT INTO hw2.accounts(email,password_hash,name,kind,must_change_password) VALUES($1,$2,$3,'member',true) RETURNING id`,[email,r.hashPassword(temporaryPassword),name])).rows[0];const m=(await c.query('INSERT INTO hw2.members(account_id,name,phone,joined_at) VALUES($1,$2,$3,$4) RETURNING *',[a.id,name,phone,joined])).rows[0];return {member:memberView({...m,email,must_change_password:true}),temporaryPassword};});}
    catch(error:any){if(error?.code==='23505')throw new ConflictException('이미 등록된 이메일 또는 연락처입니다. 삭제 회원 목록에서 기존 회원을 확인하고 복원해 주세요.');throw error;}
  }
  async book(a:any,b:any) {
    const member=await this.member(a),passId=r.id(b.passId),trainerId=r.id(b.trainerId),startsAt=r.reservationTime(b.startsAt);
    const reservationId=await transaction(async c=>{
      await this.lockMember(c,member.id);
      const trainer=await this.lockTrainer(c,trainerId);
      const {rows}=await c.query('SELECT * FROM hw2.passes WHERE id=$1 FOR UPDATE',[passId]);const pass=rows[0];
      if(!pass||pass.member_id!==member.id)throw new ForbiddenException('본인의 이용권만 예약할 수 있습니다.');
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
      const {reservation:v}=await this.lockReservation(c,reservationId,memberId);
      if(b.status!==undefined){ r.assertTransition(v.status,b.status);if(memberId!==undefined&&b.status!=='cancelled')throw new ForbiddenException('회원은 취소만 가능합니다.');if(memberId!==undefined&&new Date(v.starts_at)<=new Date())r.fail('시작된 예약은 직원에게 문의해 주세요.');if(['completed','noshow'].includes(b.status)&&new Date(v.starts_at)>new Date())r.fail('미래 예약은 완료·노쇼로 변경할 수 없습니다.'); }
      await c.query('UPDATE hw2.reservations SET status=$1,note=$2 WHERE id=$3',[b.status??v.status,b.note??v.note,reservationId]);return {ok:true};
    });
  }
  async reschedule(a:any,reservationId:number,b:any) {
    const member=await this.member(a),startsAt=r.reservationTime(b.startsAt);
    return transaction(async c=>{
      const {reservation:v,pass,trainer}=await this.lockReservation(c,reservationId,member.id);
      if(v.status!=='booked')r.fail('예약됨 상태의 수업만 시간을 변경할 수 있습니다.');
      if(new Date(v.starts_at)<=new Date())r.fail('시작된 예약은 시간을 변경할 수 없습니다. 직원에게 문의해 주세요.');
      const counts=(await c.query(`SELECT count(*) FILTER (WHERE status IN ('completed','noshow'))::int AS used,count(*) FILTER (WHERE status='booked' AND id<>$2)::int AS booked FROM hw2.reservations WHERE pass_id=$1`,[pass.id,reservationId])).rows[0];
      r.assertBookable(pass,trainer,startsAt,counts);
      await c.query('UPDATE hw2.reservations SET starts_at=$1 WHERE id=$2',[startsAt,reservationId]);
      return {reservation:(await c.query(`${reservationSelect} WHERE v.id=$1`,[reservationId])).rows[0]};
    });
  }
  async members(q='',includeDeleted=false) { if(typeof q!=='string'||q.length>100)r.fail('검색어는 100자 이내로 입력해 주세요.'); const term=q.trim();const digits=term.replace(/\D/g,'');const {rows}=await pool.query(`SELECT m.*,a.email,a.must_change_password FROM hw2.members m JOIN hw2.accounts a ON a.id=m.account_id WHERE ($3::boolean OR m.deleted_at IS NULL) AND ($1='' OR position(lower($1) in lower(m.name))>0 OR ($2<>'' AND right(m.phone,length($2))=$2)) ORDER BY m.id DESC`,[term,digits,includeDeleted]);return {members:rows.map(memberView)}; }
  async issuePass(b:any) {
    const memberId=r.id(b.memberId),typeId=r.id(b.typeId),purchasedOn=r.date(b.purchasedOn),paid=r.int(b.paidAmount,'실결제액',0);
    if(purchasedOn>r.kstDate())r.fail('구매일은 미래일 수 없습니다.');
    return transaction(async c=>{await this.lockMember(c,memberId);const type=(await c.query('SELECT * FROM hw2.pass_types WHERE id=$1 FOR SHARE',[typeId])).rows[0];if(!type)throw new NotFoundException('이용권 종류를 찾을 수 없습니다.');if(type.deleted_at)throw new ConflictException('삭제된 이용권 종류로는 새 구매를 등록할 수 없습니다. 먼저 복원해 주세요.');const expiresOn=b.expiresOn?r.date(b.expiresOn):r.addDays(purchasedOn,type.valid_days-1);if(expiresOn<purchasedOn)r.fail('만료일은 구매일 이후여야 합니다.');const {rows}=await c.query('INSERT INTO hw2.passes(member_id,type_id,purchased_on,paid_amount,expires_on,total_sessions) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[memberId,typeId,purchasedOn,paid,expiresOn,type.total_sessions]);return {pass:(await this.passes(undefined,c,rows[0].id))[0]};});
  }
  async trainer(b:any,trainerId?:number) {
    const name=r.str(b.name,'트레이너 이름'),days=r.workingDays(b.workingDays);
    return transaction(async c=>{if(trainerId){const old=(await c.query('SELECT * FROM hw2.trainers WHERE id=$1 FOR UPDATE',[trainerId])).rows[0];if(!old)throw new NotFoundException('트레이너를 찾을 수 없습니다.');if(old.deleted_at)throw new ConflictException('삭제된 트레이너는 복원한 뒤 수정해 주세요.');await c.query('UPDATE hw2.trainers SET name=$1,working_days=$2 WHERE id=$3',[name,days,trainerId]);return {ok:true};}const {rows}=await c.query('INSERT INTO hw2.trainers(name,working_days) VALUES($1,$2) RETURNING *',[name,days]);return {trainer:trainerView(rows[0])};});
  }
  async passType(b:any,typeId?:number) {
    const name=r.str(b.name,'이용권 이름'),total=r.int(b.totalSessions,'총 횟수'),price=r.int(b.listPrice,'정가',0),days=r.int(b.validDays,'유효기간',1,3650);if(![10,20,30].includes(total))r.fail('이용권은 10·20·30회 중 선택해 주세요.');
    return transaction(async c=>{if(typeId){const old=(await c.query('SELECT * FROM hw2.pass_types WHERE id=$1 FOR UPDATE',[typeId])).rows[0];if(!old)throw new NotFoundException('이용권 종류를 찾을 수 없습니다.');if(old.deleted_at)throw new ConflictException('삭제된 이용권 종류는 복원한 뒤 수정해 주세요.');await c.query('UPDATE hw2.pass_types SET name=$1,total_sessions=$2,list_price=$3,valid_days=$4 WHERE id=$5',[name,total,price,days,typeId]);return {ok:true};}const {rows}=await c.query('INSERT INTO hw2.pass_types(name,total_sessions,list_price,valid_days) VALUES($1,$2,$3,$4) RETURNING *',[name,total,price,days]);return {passType:typeView(rows[0])};});
  }
  async entityState(entity:Entity,entityId:number,restore=false) {
    return transaction(async c=>{
      const row=entity==='members'?await this.lockMember(c,entityId,'update',true):(await c.query(`SELECT * FROM hw2.${entity} WHERE id=$1 FOR UPDATE`,[entityId])).rows[0];
      if(!row)throw new NotFoundException('항목을 찾을 수 없습니다.');
      if(restore){if(row.deleted_at)await c.query(`UPDATE hw2.${entity} SET deleted_at=NULL WHERE id=$1`,[entityId]);return {ok:true};}
      if(row.deleted_at)return {ok:true};
      if(entity!=='pass_types'){
        const field=entity==='members'?'member_id':'trainer_id';
        const blocked=(await c.query(`SELECT 1 FROM hw2.reservations WHERE ${field}=$1 AND status='booked' LIMIT 1`,[entityId])).rows[0];
        if(blocked)throw new ConflictException('예약됨 상태의 수업이 있어 삭제할 수 없습니다. 과거 미처리 예약도 먼저 완료·노쇼·취소로 처리해 주세요.');
      }
      await c.query(`UPDATE hw2.${entity} SET deleted_at=now() WHERE id=$1`,[entityId]);
      if(entity==='members')await c.query('DELETE FROM hw2.sessions WHERE account_id=$1',[row.account_id]);
      return {ok:true};
    });
  }
  async adminDashboard() {
    const [counts,passes,stats]=await Promise.all([
      pool.query(`SELECT (SELECT count(*)::int FROM hw2.members WHERE deleted_at IS NULL) AS "membersCount",count(*) FILTER(WHERE status='booked')::int AS "bookedCount",count(*) FILTER(WHERE status<>'cancelled' AND (starts_at AT TIME ZONE 'Asia/Seoul')::date=(now() AT TIME ZONE 'Asia/Seoul')::date)::int AS "todayCount" FROM hw2.reservations`),
      this.passes(undefined,pool,undefined,true),pool.query(`SELECT t.id,t.name,t.deleted_at AS "deletedAt",count(v.id)::int AS "completedCount" FROM hw2.trainers t LEFT JOIN hw2.reservations v ON v.trainer_id=t.id AND v.status='completed' AND date_trunc('month',v.starts_at AT TIME ZONE 'Asia/Seoul')=date_trunc('month',now() AT TIME ZONE 'Asia/Seoul') GROUP BY t.id ORDER BY t.id`)
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
  async notificationPreferences(a:any) {
    const m=await this.member(a);
    const row=(await pool.query('SELECT kakao,sms,updated_at AS "updatedAt" FROM hw2.member_notification_preferences WHERE member_id=$1',[m.id])).rows[0];
    return {preferences:row??{kakao:false,sms:false,updatedAt:null}};
  }
  async updateNotificationPreferences(a:any,b:any) {
    const m=await this.member(a);
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['kakao','sms'].includes(k)))r.fail('수신설정 입력값을 확인해 주세요.');
    const kakao=r.boolean(b.kakao,'카카오톡 수신설정'),sms=r.boolean(b.sms,'문자 수신설정');
    return transaction(async c=>{
      await this.lockMember(c,m.id,'update');
      const previous=(await c.query('SELECT kakao,sms,updated_at AS "updatedAt" FROM hw2.member_notification_preferences WHERE member_id=$1 FOR UPDATE',[m.id])).rows[0]??{kakao:false,sms:false,updatedAt:null};
      if(previous.kakao===kakao&&previous.sms===sms)return {preferences:previous};
      const next=(await c.query(`WITH saved AS (
        INSERT INTO hw2.member_notification_preferences(member_id,kakao,sms,updated_at) VALUES($1,$2,$3,clock_timestamp())
        ON CONFLICT(member_id) DO UPDATE SET kakao=EXCLUDED.kakao,sms=EXCLUDED.sms,updated_at=EXCLUDED.updated_at
        RETURNING kakao,sms,updated_at
      ), logged AS (
        INSERT INTO hw2.notification_preference_audit(member_id,actor_account_id,before_kakao,before_sms,after_kakao,after_sms,changed_at)
        SELECT $1,$4,$5,$6,kakao,sms,updated_at FROM saved RETURNING id
      ) SELECT kakao,sms,updated_at AS "updatedAt" FROM saved CROSS JOIN logged`,[m.id,kakao,sms,a.id,previous.kakao,previous.sms])).rows[0];
      return {preferences:next};
    });
  }
}
