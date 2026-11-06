import './require-isolated-database.mjs';
import {kstDate,addDays} from '../dist/rules.js';
// Test data only. Production requires deliberate center/contract/slot registration via APIs.
export async function publishTestSlots(pool,trainerId,actorId){
 const today=kstDate(),start=addDays(today,1),end=addDays(today,11);
 await pool.query('UPDATE hw2.facility_settings SET start_hour=0,end_hour=24,capacity=100 WHERE id=1');
 const contract=(await pool.query(`INSERT INTO hw2.trainer_contracts(trainer_id,start_date,end_date,min_slots,max_slots,allowed_weekdays,start_hour,end_hour) VALUES($1,$2,$3,0,10000,ARRAY[0,1,2,3,4,5,6],0,24) RETURNING id`,[trainerId,start,end])).rows[0];
 await pool.query(`INSERT INTO hw2.trainer_slots(trainer_id,contract_id,starts_at,status,within_scope,created_by)
 SELECT $1,$2,(d::date+h*interval '1 hour') AT TIME ZONE 'Asia/Seoul','approved',true,$3
 FROM generate_series($4::date,$5::date,interval '1 day') d CROSS JOIN generate_series(0,23) h`,[trainerId,contract.id,actorId,start,end]);
}
