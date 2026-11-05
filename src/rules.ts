import { BadRequestException } from '@nestjs/common';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const fail = (message: string): never => { throw new BadRequestException(message); };
export function str(value: unknown, label: string, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label}을(를) 확인해 주세요.`);
  return (value as string).trim();
}
export function int(value: unknown, label: string, min = 1, max = 2147483647): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) fail(`${label}을(를) 확인해 주세요.`);
  return value as number;
}
export function id(value: unknown): number { return int(Number(value), 'ID'); }
export function boolean(value:unknown,label:string):boolean {if(typeof value!=='boolean')fail(`${label}은(는) true 또는 false여야 합니다.`);return value as boolean;}
export function queryBoolean(value:unknown):boolean {if(value===undefined||value==='false')return false;if(value==='true')return true;return fail('includeDeleted는 true 또는 false로 입력해 주세요.');}
export function email(value: unknown): string {
  const v = str(value, '이메일', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) fail('이메일 형식을 확인해 주세요.');
  return v;
}
export function phone(value: unknown): string {
  const v = str(value, '연락처', 30).replace(/\D/g, '');
  if (!/^0\d{8,10}$/.test(v)) fail('연락처는 숫자 9~11자리로 입력해 주세요.');
  return v;
}
export function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) fail('비밀번호는 8~128자로 입력해 주세요.');
  return value as string;
}
export function hashPassword(value: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}
export function verifyPassword(value: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split(':');
  if (algo !== 'scrypt' || !salt || !hash || hash.length !== 128) return false;
  try { return timingSafeEqual(scryptSync(value, salt, 64), Buffer.from(hash, 'hex')); } catch { return false; }
}
export const tokenHash = (v: string) => createHash('sha256').update(v).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const temporaryPassword = () => `Gym!${randomBytes(12).toString('base64url')}`;
export function kstDate(value = new Date()): string { return new Date(value.getTime() + 9 * 3600000).toISOString().slice(0, 10); }
export function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('날짜는 YYYY-MM-DD 형식이어야 합니다.');
  return value as string;
}
export function addDays(value: string, days: number): string { return new Date(Date.parse(value) + days * 86400000).toISOString().slice(0, 10); }
export function reservationTime(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail('예약 시간에는 시간대가 포함되어야 합니다.');
  date((value as string).slice(0,10));
  const result = new Date(value as string);
  if (Number.isNaN(result.getTime()) || result.getUTCMinutes() !== 0 || result.getUTCSeconds() !== 0 || result.getUTCMilliseconds() !== 0) fail('예약은 정각부터 1시간 단위로 가능합니다.');
  return result;
}
export function workingDays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 7 || !value.every(v => Number.isInteger(v) && v >= 0 && v <= 6) || new Set(value).size !== value.length) fail('근무요일을 확인해 주세요.');
  return [...value as number[]].sort();
}
export function assertBookable(pass: any, trainer: any, startsAt: Date, counts: any, now = new Date()): void {
  if (startsAt <= now) fail('미래 시간만 예약할 수 있습니다.');
  const day = kstDate(startsAt);
  if (day < pass.purchased_on || day > pass.expires_on || kstDate(now) > pass.expires_on) fail('이용권 사용 기간을 벗어난 예약입니다.');
  if (!trainer.working_days.includes(new Date(startsAt.getTime() + 9 * 3600000).getUTCDay())) fail('트레이너 휴무일입니다.');
  if (pass.total_sessions - Number(counts.used) - Number(counts.booked) <= 0) fail('예약 가능한 횟수가 없습니다.');
}
export function assertTransition(current: string, next: string): void {
  if (!['completed', 'cancelled', 'noshow'].includes(next) || current !== 'booked') fail('예약됨 상태에서만 취소·완료·노쇼로 변경할 수 있습니다.');
}
export function receiptInput(body: any): {fileName:string;mimeType:string;data:Buffer} {
  const fileName=str(body?.fileName,'파일 이름',120);
  if(/[\x00-\x1f\x7f/\\]/.test(fileName))fail('파일 이름에 경로나 제어문자를 사용할 수 없습니다.');
  const mimeType=body?.mimeType;
  if(!['image/jpeg','image/png','image/webp'].includes(mimeType))fail('JPG·PNG·WebP 이미지만 첨부할 수 있습니다.');
  const base64=body?.dataBase64;
  if(typeof base64!=='string'||!base64.length||base64.length>Math.ceil(2097152/3)*4||base64.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))fail('이미지 데이터를 확인해 주세요.');
  const data=Buffer.from(base64,'base64');
  if(data.length>2097152)fail('이미지는 2MB 이하로 첨부해 주세요.');
  if(data.toString('base64')!==base64)fail('이미지 데이터 형식이 올바르지 않습니다.');
  const jpeg=data.length>=4&&data[0]===0xff&&data[1]===0xd8&&data[2]===0xff&&data[data.length-2]===0xff&&data[data.length-1]===0xd9;
  const png=data.length>=24&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&data.toString('ascii',12,16)==='IHDR';
  const webp=data.length>=16&&data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP'&&['VP8 ','VP8L','VP8X'].includes(data.toString('ascii',12,16))&&data.readUInt32LE(4)+8===data.length;
  if(!(mimeType==='image/jpeg'&&jpeg||mimeType==='image/png'&&png||mimeType==='image/webp'&&webp))fail('파일 내용과 이미지 형식이 일치하지 않습니다.');
  return {fileName,mimeType,data};
}
