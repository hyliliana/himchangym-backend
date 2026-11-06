import { Injectable, ForbiddenException, UnauthorizedException, NotFoundException, ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { transaction } from './db.js';
import * as r from './rules.js';

// Acquire before account/member/trainer/pass/reservation locks in every scheduling mutation.
// One narrow scheduling lock makes facility capacity, contract quotas and slot changes atomic.
export async function lockScheduling(c:PoolClient) { await c.query('SELECT pg_advisory_xact_lock(209051107)'); }
const slotSelect=`SELECT s.id,s.trainer_id AS "trainerId",t.name AS "trainerName",s.contract_id AS "contractId",s.starts_at AS "startsAt",s.status,s.within_scope AS "withinScope",s.reason,
 EXISTS(SELECT 1 FROM hw2.reservations v WHERE v.trainer_id=s.trainer_id AND v.starts_at=s.starts_at AND v.status<>'cancelled') AS "hasReservation"
 FROM hw2.trainer_slots s JOIN hw2.trainers t ON t.id=s.trainer_id`;
const contractView=(v:any)=>v?({id:v.id,startDate:v.start_date,endDate:v.end_date,minSlots:v.min_slots,maxSlots:v.max_slots,allowedWeekdays:v.allowed_weekdays,startHour:v.start_hour,endHour:v.end_hour}):null;
const facilityView=(v:any)=>({startHour:v.start_hour,endHour:v.end_hour,capacity:v.capacity});
const activeSlots=`status IN ('approved','pending')`;
const conflict=(message:string):never=>{throw new ConflictException(message);};
function object(b:any,keys:string[]) {if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!keys.includes(k)))r.fail('입력 항목을 확인해 주세요.');}
function hours(start:any,end:any) {const startHour=r.int(start,'시작 시각',0,23),endHour=r.int(end,'종료 시각',1,24);if(startHour>=endHour)r.fail('종료 시각은 시작 시각 이후여야 합니다.');return {startHour,endHour};}
function kstHour(value:Date) {return new Date(value.getTime()+9*3600000).getUTCHours();}
function within(contract:any,startsAt:Date) {return contract.allowed_weekdays.includes(new Date(startsAt.getTime()+9*3600000).getUTCDay())&&kstHour(startsAt)>=contract.start_hour&&kstHour(startsAt)+1<=contract.end_hour;}

// Existing lessons without a slot remain readable/cancellable/completable. Only a new place
// (new booking or approved time move) requires an approved, public, future slot.
export async function assertSlotBookable(c:PoolClient,trainerId:number,startsAt:Date,options:{excludeReservationId?:number}={}) {
 const slot=(await c.query(`SELECT s.id FROM hw2.trainer_slots s JOIN hw2.trainers t ON t.id=s.trainer_id JOIN hw2.trainer_contracts ct ON ct.id=s.contract_id
 WHERE s.trainer_id=$1 AND s.starts_at=$2 AND s.status='approved' AND t.deleted_at IS NULL
 AND (s.starts_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN ct.start_date AND ct.end_date FOR SHARE OF s`,[trainerId,startsAt])).rows[0];
 if(!slot||startsAt<=new Date())conflict('공개된 미래 예약 가능 시간을 선택해 주세요.');
 const occupied=(await c.query(`SELECT 1 FROM hw2.reservations WHERE trainer_id=$1 AND starts_at=$2 AND status<>'cancelled' AND ($3::integer IS NULL OR id<>$3) LIMIT 1`,[trainerId,startsAt,options.excludeReservationId??null])).rows[0];
 if(occupied)conflict('이미 예약된 시간입니다. 다른 공개 시간을 선택해 주세요.');
 return slot;
}

@Injectable()
export class ScheduleService {
 private async actor(c:PoolClient,a:any,adminOnly=false) {
  const actor=(await c.query('SELECT * FROM hw2.accounts WHERE id=$1 FOR SHARE',[a.id])).rows[0];
  if(!actor?.is_active)throw new UnauthorizedException('이용할 수 없는 계정입니다.');
  if(actor.must_change_password)throw new ForbiddenException('최초 비밀번호를 변경해 주세요.');
  if(adminOnly&&(actor.kind!=='staff'||actor.role!=='admin'))throw new ForbiddenException('관리자 권한이 필요합니다.');
  return actor;
 }
 private async trainer(c:PoolClient,a:any,trainerId?:number,write=false) {
  const actor=await this.actor(c,a);
  if(actor.kind==='trainer'){
   const own=(await c.query('SELECT * FROM hw2.trainers WHERE account_id=$1 FOR SHARE',[actor.id])).rows[0];
   if(!own||own.deleted_at)throw new UnauthorizedException('이용할 수 없는 트레이너 계정입니다.');
   if(trainerId!==undefined&&trainerId!==own.id)throw new ForbiddenException('본인 시간만 관리할 수 있습니다.');
   return own;
  }
  if(actor.kind!=='staff'||trainerId===undefined)throw new ForbiddenException('접근 권한이 없습니다.');
  const trainer=(await c.query('SELECT * FROM hw2.trainers WHERE id=$1 FOR SHARE',[trainerId])).rows[0];
  if(!trainer)throw new NotFoundException('트레이너를 찾을 수 없습니다.');
  if(write&&trainer.deleted_at)conflict('삭제된 트레이너는 복원한 뒤 시간을 등록해 주세요.');
  return trainer;
 }
 private async facilityRow(c:PoolClient) {return (await c.query('SELECT * FROM hw2.facility_settings WHERE id=1')).rows[0];}
 private async progress(c:PoolClient,contractId:number) {return (await c.query(`SELECT count(*) FILTER(WHERE status='approved')::int AS approved,count(*) FILTER(WHERE status='pending')::int AS pending,count(*) FILTER(WHERE ${activeSlots})::int AS total FROM hw2.trainer_slots WHERE contract_id=$1`,[contractId])).rows[0];}
 private async contracts(c:PoolClient,trainerId:number) {return (await c.query('SELECT * FROM hw2.trainer_contracts WHERE trainer_id=$1 ORDER BY is_current DESC,start_date DESC,id DESC',[trainerId])).rows;}
 private async scheduleView(c:PoolClient,trainerId:number) {
  const contracts=await this.contracts(c,trainerId),current=contracts.find(v=>v.is_current);
  const views=[];for(const row of contracts)views.push({...contractView(row),progress:await this.progress(c,row.id)});
  return {contract:contractView(current),progress:current?await this.progress(c,current.id):{approved:0,pending:0,total:0},contracts:views,slots:(await c.query(`${slotSelect} WHERE s.trainer_id=$1 ORDER BY s.starts_at DESC,s.id DESC`,[trainerId])).rows};
 }
 async facility(a:any,b?:any) {
  return transaction(async c=>{
   if(b!==undefined)await lockScheduling(c);
   const actor=await this.actor(c,a,b!==undefined);if(actor.kind!=='staff')throw new ForbiddenException('직원 전용 기능입니다.');
   const old=await this.facilityRow(c);if(b===undefined)return {facility:facilityView(old)};
   object(b,['startHour','endHour','capacity']);if(!Object.keys(b).length)r.fail('변경할 항목이 없습니다.');
   const {startHour,endHour}=hours(b.startHour??old.start_hour,b.endHour??old.end_hour),capacity=b.capacity===undefined?old.capacity:r.int(b.capacity,'시설 동시 정원',1,100);
   const futurePlaces=`WITH places AS (
    SELECT s.trainer_id,s.starts_at FROM hw2.trainer_slots s JOIN hw2.trainers t ON t.id=s.trainer_id WHERE s.status IN ('approved','pending') AND s.starts_at>now() AND t.deleted_at IS NULL
    UNION SELECT v.trainer_id,v.starts_at FROM hw2.reservations v WHERE v.status<>'cancelled' AND v.starts_at>now()
   ) `;
   const invalid=(await c.query(futurePlaces+`SELECT 1 FROM places WHERE extract(hour FROM starts_at AT TIME ZONE 'Asia/Seoul')<$1 OR extract(hour FROM starts_at AT TIME ZONE 'Asia/Seoul')+1>$2 LIMIT 1`,[startHour,endHour])).rows[0];
   const over=(await c.query(futurePlaces+`SELECT 1 FROM places GROUP BY starts_at HAVING count(*)>$1 LIMIT 1`,[capacity])).rows[0];
   if(invalid||over)conflict('기존 공개·검토 중인 시간이 새 운영시간 또는 정원을 벗어납니다. 먼저 해당 시간을 정리해 주세요.');
   await c.query('UPDATE hw2.facility_settings SET start_hour=$1,end_hour=$2,capacity=$3 WHERE id=1',[startHour,endHour,capacity]);return {facility:{startHour,endHour,capacity}};
  });
 }
 async schedule(a:any,trainerId?:number) {return transaction(async c=>{const trainer=await this.trainer(c,a,trainerId);return this.scheduleView(c,trainer.id);});}
 async contract(a:any,trainerId:number,b?:any,newPeriod=false) {
  return transaction(async c=>{
   if(b!==undefined)await lockScheduling(c);await this.actor(c,a,b!==undefined);await this.trainer(c,a,trainerId,b!==undefined);
   const existing=(await this.contracts(c,trainerId)).find(v=>v.is_current);
   if(b===undefined){const view=await this.scheduleView(c,trainerId);return {contract:view.contract,progress:view.progress,contracts:view.contracts};}
   object(b,['startDate','endDate','minSlots','maxSlots','allowedWeekdays','startHour','endHour']);
   const startDate=r.date(b.startDate),endDate=r.date(b.endDate);if(startDate>endDate)r.fail('계약 종료일은 시작일 이후여야 합니다.');
   const minSlots=r.int(b.minSlots,'최소 목표',0,10000),maxSlots=r.int(b.maxSlots,'최대 한도',1,10000);if(minSlots>maxSlots)r.fail('최소 목표는 최대 한도 이하여야 합니다.');
   const allowedWeekdays=r.workingDays(b.allowedWeekdays);if(!allowedWeekdays.length)r.fail('허용요일을 한 개 이상 선택해 주세요.');
   const {startHour,endHour}=hours(b.startHour,b.endHour),edit=existing&&!newPeriod?existing:undefined;
   const overlap=(await c.query('SELECT 1 FROM hw2.trainer_contracts WHERE trainer_id=$1 AND ($4::integer IS NULL OR id<>$4) AND start_date<=$3 AND end_date>=$2 LIMIT 1',[trainerId,startDate,endDate,edit?.id??null])).rows[0];
   if(overlap)conflict('기존 계약기간과 겹칩니다. 기존 계약을 수정하거나 겹치지 않는 새 기간을 등록해 주세요.');
   if(edit){
    const p=await this.progress(c,edit.id);if(p.total>maxSlots)conflict('이미 등록된 공개·검토 시간이 새 최대 한도를 초과합니다.');
    const outside=(await c.query(`SELECT 1 FROM hw2.trainer_slots WHERE contract_id=$1 AND ${activeSlots} AND (starts_at AT TIME ZONE 'Asia/Seoul')::date NOT BETWEEN $2::date AND $3::date LIMIT 1`,[edit.id,startDate,endDate])).rows[0];
    if(outside)conflict('기존 계약 실적을 기간 밖으로 옮길 수 없습니다. 갱신은 새 계약으로 등록해 주세요.');
    await c.query('UPDATE hw2.trainer_contracts SET start_date=$1,end_date=$2,min_slots=$3,max_slots=$4,allowed_weekdays=$5,start_hour=$6,end_hour=$7 WHERE id=$8',[startDate,endDate,minSlots,maxSlots,allowedWeekdays,startHour,endHour,edit.id]);
   }else{
    await c.query('UPDATE hw2.trainer_contracts SET is_current=false WHERE trainer_id=$1 AND is_current',[trainerId]);
    await c.query('INSERT INTO hw2.trainer_contracts(trainer_id,start_date,end_date,min_slots,max_slots,allowed_weekdays,start_hour,end_hour) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[trainerId,startDate,endDate,minSlots,maxSlots,allowedWeekdays,startHour,endHour]);
   }
   const view=await this.scheduleView(c,trainerId);return {contract:view.contract,progress:view.progress,contracts:view.contracts};
  });
 }
 private async validSlot(c:PoolClient,trainerId:number,startsAt:Date,excludeSlotId?:number) {
  if(startsAt<=new Date())r.fail('미래 시간만 등록할 수 있습니다.');
  const facility=await this.facilityRow(c),hour=kstHour(startsAt);
  if(hour<facility.start_hour||hour+1>facility.end_hour)conflict('시설 운영시간 안에서만 등록할 수 있습니다.');
  const contract=(await c.query('SELECT * FROM hw2.trainer_contracts WHERE trainer_id=$1 AND $2::date BETWEEN start_date AND end_date',[trainerId,r.kstDate(startsAt)])).rows[0];
  if(!contract)conflict('해당 날짜의 계약이 없습니다. 먼저 관리자에게 계약 등록을 요청해 주세요.');
  const count=(await c.query(`SELECT count(*)::int AS n FROM hw2.trainer_slots WHERE contract_id=$1 AND ${activeSlots} AND ($2::integer IS NULL OR id<>$2)`,[contract.id,excludeSlotId??null])).rows[0].n;
  if(count>=contract.max_slots)conflict('계약 최대 시간 한도에 도달했습니다.');
  const occupied=(await c.query(`SELECT 1 FROM hw2.trainer_slots WHERE trainer_id=$1 AND starts_at=$2 AND ${activeSlots} AND ($3::integer IS NULL OR id<>$3) LIMIT 1`,[trainerId,startsAt,excludeSlotId??null])).rows[0];
  if(occupied)conflict('이미 등록한 시간입니다.');
  // Legacy reservations have no slot. They still consume real facility capacity.
  const load=(await c.query(`SELECT (SELECT count(*) FROM hw2.trainer_slots s JOIN hw2.trainers t ON t.id=s.trainer_id WHERE t.deleted_at IS NULL AND s.starts_at=$1 AND s.${activeSlots} AND ($2::integer IS NULL OR s.id<>$2)) +
   (SELECT count(DISTINCT v.trainer_id) FROM hw2.reservations v WHERE v.starts_at=$1 AND v.status<>'cancelled' AND NOT EXISTS(SELECT 1 FROM hw2.trainer_slots s JOIN hw2.trainers t ON t.id=s.trainer_id WHERE t.deleted_at IS NULL AND s.trainer_id=v.trainer_id AND s.starts_at=v.starts_at AND s.${activeSlots})) AS n`,[startsAt,excludeSlotId??null])).rows[0].n;
  if(Number(load)>=facility.capacity)conflict('이 시간의 시설 동시 정원이 찼습니다.');
  const booking=(await c.query(`SELECT 1 FROM hw2.reservations WHERE trainer_id=$1 AND starts_at=$2 AND status<>'cancelled' LIMIT 1`,[trainerId,startsAt])).rows[0];
  if(booking)conflict('기존 수업이 있는 시간에는 새 슬롯을 등록할 수 없습니다.');
  return {contract,withinScope:within(contract,startsAt)};
 }
 async candidates(a:any,from:unknown,to:unknown,trainerId?:number,excludeSlotId?:number) {
  const start=r.date(from),end=r.date(to);if(end<start||Date.parse(end)-Date.parse(start)>62*86400000)r.fail('조회 기간은 63일 이내여야 합니다.');
  return transaction(async c=>{
   const trainer=await this.trainer(c,a,trainerId,true);const facility=await this.facilityRow(c);
   if(excludeSlotId){const own=(await c.query('SELECT trainer_id FROM hw2.trainer_slots WHERE id=$1',[excludeSlotId])).rows[0];if(!own||own.trainer_id!==trainer.id)throw new ForbiddenException('본인의 등록 시간만 변경할 수 있습니다.');}
   const contracts=await this.contracts(c,trainer.id);
   const active=(await c.query(`SELECT s.id,s.trainer_id,s.contract_id,s.starts_at FROM hw2.trainer_slots s JOIN hw2.trainers t ON t.id=s.trainer_id WHERE t.deleted_at IS NULL AND s.${activeSlots} AND ($1::integer IS NULL OR s.id<>$1)`,[excludeSlotId??null])).rows;
   const bookings=(await c.query(`SELECT DISTINCT trainer_id,starts_at FROM hw2.reservations WHERE status<>'cancelled' AND (starts_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN $1::date AND $2::date`,[start,end])).rows;
   const counts=new Map<number,number>(),load=new Map<number,Set<number>>(),ownTimes=new Set<number>();
   for(const slot of active){counts.set(slot.contract_id,(counts.get(slot.contract_id)??0)+1);const timestamp=new Date(slot.starts_at).getTime();if(!load.has(timestamp))load.set(timestamp,new Set());load.get(timestamp)!.add(slot.trainer_id);if(slot.trainer_id===trainer.id)ownTimes.add(timestamp);}
   for(const booking of bookings){const timestamp=new Date(booking.starts_at).getTime();if(!load.has(timestamp))load.set(timestamp,new Set());load.get(timestamp)!.add(booking.trainer_id);if(booking.trainer_id===trainer.id)ownTimes.add(timestamp);}
   const candidates=[];
   for(let day=start;day<=end;day=r.addDays(day,1)){
    const contract=contracts.find(v=>v.start_date<=day&&v.end_date>=day);if(!contract||(counts.get(contract.id)??0)>=contract.max_slots)continue;
    for(let h=facility.start_hour;h<facility.end_hour;h++){
     const startsAt=new Date(`${day}T${String(h).padStart(2,'0')}:00:00+09:00`),timestamp=startsAt.getTime();
     if(startsAt<=new Date()||ownTimes.has(timestamp)||(load.get(timestamp)?.size??0)>=facility.capacity)continue;
     candidates.push({startsAt:startsAt.toISOString(),withinScope:within(contract,startsAt)});
    }
   }
   const view=await this.scheduleView(c,trainer.id);return {candidates,facility:facilityView(facility),contract:view.contract,progress:view.progress};
  });
 }
 async saveSlot(a:any,b:any,trainerId?:number,slotId?:number) {
  object(b,['startsAt']);const startsAt=r.reservationTime(b.startsAt);
  return transaction(async c=>{
   await lockScheduling(c);
   const old=slotId?(await c.query('SELECT * FROM hw2.trainer_slots WHERE id=$1',[slotId])).rows[0]:undefined;
   if(slotId&&!old)throw new NotFoundException('등록 시간을 찾을 수 없습니다.');
   const trainer=await this.trainer(c,a,trainerId??old?.trainer_id,true);
   if(old&&old.trainer_id!==trainer.id)throw new ForbiddenException('본인의 등록 시간만 변경할 수 있습니다.');
   if(old){await this.assertEditable(c,old);if(old.status==='withdrawn')conflict('철회한 시간은 새로 등록해 주세요.');if(['approved','pending'].includes(old.status)&&new Date(old.starts_at).getTime()===startsAt.getTime())return {slot:(await c.query(`${slotSelect} WHERE s.id=$1`,[old.id])).rows[0]};}
   const check=await this.validSlot(c,trainer.id,startsAt,slotId),status=check.withinScope?'approved':'pending';
   let savedId=slotId;
   if(old)await c.query('UPDATE hw2.trainer_slots SET starts_at=$1,contract_id=$2,status=$3,within_scope=$4,reason=\'\',decided_by=NULL,updated_at=now() WHERE id=$5',[startsAt,check.contract.id,status,check.withinScope,slotId]);
   else savedId=(await c.query('INSERT INTO hw2.trainer_slots(trainer_id,contract_id,starts_at,status,within_scope,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[trainer.id,check.contract.id,startsAt,status,check.withinScope,a.id])).rows[0].id;
   return {slot:(await c.query(`${slotSelect} WHERE s.id=$1`,[savedId])).rows[0]};
  });
 }
 private async assertEditable(c:PoolClient,slot:any) {
  if(new Date(slot.starts_at)<=new Date()&&slot.status==='approved')conflict('지난 공개 시간은 실적으로 보존됩니다.');
  const booking=(await c.query(`SELECT 1 FROM hw2.reservations WHERE trainer_id=$1 AND starts_at=$2 AND status<>'cancelled' LIMIT 1`,[slot.trainer_id,slot.starts_at])).rows[0];
  if(booking)conflict('예약이 있는 시간은 변경·철회할 수 없습니다. 먼저 예약을 처리해 주세요.');
 }
 async withdraw(a:any,slotId:number) {
  return transaction(async c=>{await lockScheduling(c);const slot=(await c.query('SELECT * FROM hw2.trainer_slots WHERE id=$1',[slotId])).rows[0];if(!slot)throw new NotFoundException('등록 시간을 찾을 수 없습니다.');await this.trainer(c,a,slot.trainer_id,true);if(slot.status==='withdrawn')return {ok:true};await this.assertEditable(c,slot);await c.query("UPDATE hw2.trainer_slots SET status='withdrawn',updated_at=now() WHERE id=$1",[slotId]);return {ok:true};});
 }
 async slots(a:any,status?:string) {
  if(status!==undefined&&!['approved','pending','rejected','withdrawn'].includes(status))r.fail('등록 상태를 확인해 주세요.');
  return transaction(async c=>{const actor=await this.actor(c,a);if(actor.kind!=='staff')throw new ForbiddenException('직원 전용 기능입니다.');return {slots:(await c.query(`${slotSelect} ${status?'WHERE s.status=$1':''} ORDER BY s.starts_at,s.id`,status?[status]:[])).rows};});
 }
 async decide(a:any,slotId:number,b:any) {
  object(b,['status','reason','expectedStartsAt']);const expectedStartsAt=r.reservationTime(b.expectedStartsAt);if(!['approved','rejected'].includes(b.status))r.fail('승인 상태를 확인해 주세요.');const reason=b.reason===undefined?'':typeof b.reason==='string'&&b.reason.length<=1000?b.reason:r.fail('사유는 1,000자 이내로 입력해 주세요.');
  return transaction(async c=>{await lockScheduling(c);await this.actor(c,a,true);const slot=(await c.query('SELECT * FROM hw2.trainer_slots WHERE id=$1',[slotId])).rows[0];if(!slot)throw new NotFoundException('등록 시간을 찾을 수 없습니다.');await this.trainer(c,a,slot.trainer_id,true);if(new Date(slot.starts_at).getTime()!==expectedStartsAt.getTime())conflict('신청 시간이 변경되었습니다. 목록을 새로고침해 주세요.');if(slot.status!=='pending')conflict('검토 중인 신청만 승인·거절할 수 있습니다.');await this.assertEditable(c,slot);if(b.status==='approved')await this.validSlot(c,slot.trainer_id,new Date(slot.starts_at),slotId);await c.query('UPDATE hw2.trainer_slots SET status=$1,reason=$2,decided_by=$3,updated_at=now() WHERE id=$4',[b.status,reason,a.id,slotId]);return {slot:(await c.query(`${slotSelect} WHERE s.id=$1`,[slotId])).rows[0]};});
 }
 async availability(a:any,passId:number,trainerId:number,month:unknown,reservationId?:number) {
  if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))r.fail('월은 YYYY-MM 형식으로 입력해 주세요.');
  const from=r.date(`${month}-01`),to=r.addDays(new Date(Date.UTC(Number((month as string).slice(0,4)),Number((month as string).slice(5,7)),1)).toISOString().slice(0,10),-1);
  return transaction(async c=>{
   const actor=await this.actor(c,a);if(actor.kind!=='member')throw new ForbiddenException('회원 전용 기능입니다.');
   const member=(await c.query('SELECT * FROM hw2.members WHERE account_id=$1 AND deleted_at IS NULL FOR SHARE',[actor.id])).rows[0];if(!member)throw new UnauthorizedException('이용할 수 없는 회원 계정입니다.');
   const pass=(await c.query('SELECT * FROM hw2.passes WHERE id=$1 AND member_id=$2',[passId,member.id])).rows[0];if(!pass)throw new ForbiddenException('본인의 이용권만 조회할 수 있습니다.');
   let originalStartsAt:Date|undefined;
   if(reservationId){const own=(await c.query("SELECT * FROM hw2.reservations WHERE id=$1 AND member_id=$2 AND pass_id=$3 AND trainer_id=$4 AND status='booked'",[reservationId,member.id,passId,trainerId])).rows[0];if(!own)throw new ForbiddenException('본인의 예약된 수업만 변경할 수 있습니다.');if(new Date(own.starts_at)<=new Date())return {days:[]};originalStartsAt=new Date(own.starts_at);}
   const used=(await c.query(`SELECT count(*)::int AS n FROM hw2.reservations WHERE pass_id=$1 AND status IN ('booked','completed','noshow') AND ($2::integer IS NULL OR id<>$2)`,[passId,reservationId??null])).rows[0].n;
   if(used>=pass.total_sessions||pass.expires_on<r.kstDate())return {days:[]};
   const rows=(await c.query(`SELECT s.id,s.starts_at AS "startsAt",s.starts_at+interval '1 hour' AS "endsAt" FROM hw2.trainer_slots s JOIN hw2.trainers t ON t.id=s.trainer_id JOIN hw2.trainer_contracts ct ON ct.id=s.contract_id
    WHERE s.trainer_id=$1 AND s.status='approved' AND t.deleted_at IS NULL AND s.starts_at>now() AND ($8::timestamptz IS NULL OR s.starts_at<>$8)
    AND (s.starts_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN $2::date AND $3::date
    AND (s.starts_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN $4::date AND $5::date
    AND (s.starts_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN ct.start_date AND ct.end_date
    AND NOT EXISTS(SELECT 1 FROM hw2.reservations v WHERE v.starts_at=s.starts_at AND v.status<>'cancelled' AND (v.trainer_id=s.trainer_id OR v.member_id=$6) AND ($7::integer IS NULL OR v.id<>$7)) ORDER BY s.starts_at`,[trainerId,from,to,pass.purchased_on,pass.expires_on,member.id,reservationId??null,originalStartsAt??null])).rows;
   const days:{date:string;slots:any[]}[]=[];for(const slot of rows){const day=r.kstDate(new Date(slot.startsAt));let group=days.find(v=>v.date===day);if(!group){group={date:day,slots:[]};days.push(group);}group.slots.push(slot);}return {days};
  });
 }
}
