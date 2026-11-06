import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { pool } from './db.js';

type Event = 'requested'|'approved_change'|'rejected_change'|'withdrawn'|'booked'|'approval'|'status'|'feedback';
type Actor = {id:number; name:string; kind:string; role:string|null};
type Changes = Record<string,unknown>;

export async function appendLessonEvent(c:PoolClient,id:number,actor:Actor,event:Event,before:Changes,after:Changes) {
  await c.query(`INSERT INTO hw2.lesson_history
    (reservation_id,actor_id,actor_name,actor_role,event,previous_values,new_values)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id,actor.id,actor.name,actor.kind==='staff'?actor.role:actor.kind,event,before,after]);
}

export async function recordLessonEdits(c:PoolClient,old:any,actor:Actor,edit:{status?:string;approval?:string;note?:string}) {
  if(edit.approval!==undefined && edit.approval!==old.approval)
    await appendLessonEvent(c,old.id,actor,'approval',{approval:old.approval},{approval:edit.approval});
  if(edit.status!==undefined && edit.status!==old.status) {
    await appendLessonEvent(c,old.id,actor,'status',{status:old.status},{status:edit.status});
    if(edit.status!=='booked'){
      const {rows}=await c.query(`UPDATE hw2.lesson_time_requests SET state='withdrawn',resolved_by=$2,resolved_at=clock_timestamp()
        WHERE reservation_id=$1 AND state='pending' RETURNING proposed_start`,[old.id,actor.id]);
      if(rows[0])await appendLessonEvent(c,old.id,actor,'withdrawn',{startsAt:rows[0].proposed_start},{startsAt:old.starts_at});
    }
  }
  if(edit.note!==undefined && edit.note!==old.note)
    await appendLessonEvent(c,old.id,actor,'feedback',{note:old.note},{note:edit.note});
}

export async function readLessonHistory(id:number,actor:Actor,scope:'member'|'trainer'|'staff') {
  if(actor.kind!==scope)throw new ForbiddenException('접근 권한이 없습니다.');
  const {rows}=await pool.query(`SELECT v.id FROM hw2.reservations v
    JOIN hw2.members m ON m.id=v.member_id JOIN hw2.trainers t ON t.id=v.trainer_id
    WHERE v.id=$1 AND ($2='staff' OR ($2='member' AND m.account_id=$3 AND m.deleted_at IS NULL)
      OR ($2='trainer' AND t.account_id=$3 AND t.deleted_at IS NULL))`,[id,scope,actor.id]);
  if(!rows[0])throw new NotFoundException('조회할 수 있는 수업을 찾지 못했어요.');
  const history=await pool.query(`SELECT id,event,actor_name AS "actorName",actor_role AS "actorRole",
    changed_at AS "changedAt",previous_values AS "before",new_values AS "after"
    FROM hw2.lesson_history WHERE reservation_id=$1 ORDER BY id DESC`,[id]);
  return {history:history.rows};
}
