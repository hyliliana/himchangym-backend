import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Module, Controller, Get, Post, Patch, Delete, Headers, Body, Param, Query, Req, Catch, ExceptionFilter, ArgumentsHost, HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { GymService } from './service.js';
import { id, queryBoolean } from './rules.js';
import { pool } from './db.js';

@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error:any,host:ArgumentsHost) {
    let status=500,message='서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
    if(error instanceof HttpException){status=error.getStatus();const response:any=error.getResponse();message=typeof response==='string'?response:typeof response.message==='string'?response.message:'입력값을 확인해 주세요.';}
    else if(error?.type==='entity.too.large'){status=413;message='요청이 너무 큽니다. 이미지는 2MB 이하로 첨부해 주세요.';}
    else if(error?.type==='entity.parse.failed'){status=400;message='JSON 입력 형식을 확인해 주세요.';}
    else if(error?.code==='23505'){status=409;message=error.constraint?.startsWith('reservation_')?'같은 시간에 이미 예약이 있습니다.':'이미 사용 중인 이메일 또는 연락처입니다.';}
    else if(error?.code==='23503'){status=400;message='연결된 회원·이용권·트레이너를 찾을 수 없습니다.';}
    else if(['23514','22P02','22007','22008','22003'].includes(error?.code)){status=400;message='입력값이 데이터 규칙에 맞지 않습니다.';}
    else if(['40P01','40001'].includes(error?.code)){status=409;message='다른 변경과 겹쳤습니다. 다시 시도해 주세요.';}
    // Never log raw request bodies, tokens, SQL parameters, or database error details.
    if(status===500)console.error('API error',error?.code??error?.name??'unknown');
    host.switchToHttp().getResponse().status(status).json({statusCode:status,message});
  }
}

@Controller()
class GymController {
  constructor(private readonly gym:GymService){}
  @Get('health') async health(){await pool.query('SELECT 1');return {ok:true,service:'himchangym'};}
  @Post('auth/signup') signup(@Body() b:any){return this.gym.signup(b??{});}
  @Post('auth/login') login(@Body() b:any,@Req() req:Request){return this.gym.login(b??{},req.ip??'unknown');}
  @Get('auth/me') async me(@Headers('authorization') h:string){const a=await this.gym.authenticate(h,true);return {user:{id:a.id,email:a.email,name:a.name,kind:a.kind,role:a.role,mustChangePassword:a.must_change_password}};}
  @Post('auth/logout') async logout(@Headers('authorization') h:string){await this.gym.authenticate(h,true);return this.gym.logout(h);}
  @Post('auth/change-password') async change(@Headers('authorization') h:string,@Body() b:any){return this.gym.changePassword(await this.gym.authenticate(h,true),b??{},h);}
  @Get('catalog') async catalog(@Headers('authorization') h:string){await this.gym.authenticate(h);return this.gym.catalog();}
  @Get('member/dashboard') async dashboard(@Headers('authorization') h:string){return this.gym.memberDashboard(await this.gym.authenticate(h));}
  @Patch('member/profile') async profile(@Headers('authorization') h:string,@Body() b:any){const m=await this.gym.member(await this.gym.authenticate(h));return this.gym.updateMember(m.id,b??{});}
  @Post('member/reservations') async book(@Headers('authorization') h:string,@Body() b:any){return this.gym.book(await this.gym.authenticate(h),b??{});}
  @Post('member/reservations/:id/cancel') async cancel(@Headers('authorization') h:string,@Param('id') v:string){const m=await this.gym.member(await this.gym.authenticate(h));return this.gym.updateReservation(id(v),{status:'cancelled'},m.id);}
  @Post('member/reservations/:id/reschedule') async reschedule(@Headers('authorization') h:string,@Param('id') v:string,@Body() b:any){return this.gym.reschedule(await this.gym.authenticate(h),id(v),b??{});}
  @Get('member/passes/:id/receipts') async memberReceipts(@Headers('authorization') h:string,@Param('id') v:string){const m=await this.gym.member(await this.gym.authenticate(h));return this.gym.receipts(id(v),m.id);}
  @Get('member/notification-preferences') async preferences(@Headers('authorization') h:string){return this.gym.notificationPreferences(await this.gym.authenticate(h));}
  @Patch('member/notification-preferences') async updatePreferences(@Headers('authorization') h:string,@Body() b:any){return this.gym.updateNotificationPreferences(await this.gym.authenticate(h),b);}
  private async staff(h:string,admin=false){const a=await this.gym.authenticate(h);this.gym.requireStaff(a,admin);return a;}
  @Get('admin/dashboard') async adminDashboard(@Headers('authorization') h:string){await this.staff(h);return this.gym.adminDashboard();}
  @Get('admin/members') async members(@Headers('authorization') h:string,@Query('q') q?:string,@Query('includeDeleted') deleted?:string){await this.staff(h);return this.gym.members(q,queryBoolean(deleted));}
  @Post('admin/members') async createMember(@Headers('authorization') h:string,@Body() b:any){await this.staff(h);return this.gym.createMember(b??{});}
  @Patch('admin/members/:id') async updateMember(@Headers('authorization') h:string,@Param('id') v:string,@Body() b:any){await this.staff(h);return this.gym.updateMember(id(v),b??{},true);}
  @Delete('admin/members/:id') async deleteMember(@Headers('authorization') h:string,@Param('id') v:string){await this.staff(h);return this.gym.entityState('members',id(v));}
  @Post('admin/members/:id/restore') async restoreMember(@Headers('authorization') h:string,@Param('id') v:string){await this.staff(h);return this.gym.entityState('members',id(v),true);}
  @Get('admin/catalog') async adminCatalog(@Headers('authorization') h:string,@Query('includeDeleted') deleted?:string){await this.staff(h);return this.gym.catalog(queryBoolean(deleted));}
  @Get('admin/passes') async passes(@Headers('authorization') h:string,@Query('memberId') m?:string){await this.staff(h);return {passes:await this.gym.passes(m?id(m):undefined)};}
  @Post('admin/passes') async issue(@Headers('authorization') h:string,@Body() b:any){await this.staff(h);return this.gym.issuePass(b??{});}
  @Get('admin/passes/:id/receipts') async adminReceipts(@Headers('authorization') h:string,@Param('id') v:string){await this.staff(h);return this.gym.receipts(id(v));}
  @Post('admin/passes/:id/receipts') async attachReceipt(@Headers('authorization') h:string,@Param('id') v:string,@Body() b:any){return this.gym.attachReceipt(await this.staff(h),id(v),b??{});}
  @Get('admin/reservations') async reservations(@Headers('authorization') h:string,@Query('date') d?:string,@Query('status') s?:string){await this.staff(h);return {reservations:await this.gym.reservations(undefined,d,s)};}
  @Patch('admin/reservations/:id') async updateReservation(@Headers('authorization') h:string,@Param('id') v:string,@Body() b:any){await this.staff(h);return this.gym.updateReservation(id(v),b??{});}
  @Post('admin/trainers') async trainer(@Headers('authorization') h:string,@Body() b:any){await this.staff(h);return this.gym.trainer(b??{});}
  @Patch('admin/trainers/:id') async updateTrainer(@Headers('authorization') h:string,@Param('id') v:string,@Body() b:any){await this.staff(h);return this.gym.trainer(b??{},id(v));}
  @Delete('admin/trainers/:id') async deleteTrainer(@Headers('authorization') h:string,@Param('id') v:string){await this.staff(h);return this.gym.entityState('trainers',id(v));}
  @Post('admin/trainers/:id/restore') async restoreTrainer(@Headers('authorization') h:string,@Param('id') v:string){await this.staff(h);return this.gym.entityState('trainers',id(v),true);}
  @Post('admin/pass-types') async passType(@Headers('authorization') h:string,@Body() b:any){await this.staff(h);return this.gym.passType(b??{});}
  @Patch('admin/pass-types/:id') async updatePassType(@Headers('authorization') h:string,@Param('id') v:string,@Body() b:any){await this.staff(h);return this.gym.passType(b??{},id(v));}
  @Delete('admin/pass-types/:id') async deletePassType(@Headers('authorization') h:string,@Param('id') v:string){await this.staff(h);return this.gym.entityState('pass_types',id(v));}
  @Post('admin/pass-types/:id/restore') async restorePassType(@Headers('authorization') h:string,@Param('id') v:string){await this.staff(h);return this.gym.entityState('pass_types',id(v),true);}
  @Get('admin/staff') async staffList(@Headers('authorization') h:string){await this.staff(h,true);return this.gym.staff();}
  @Post('admin/staff') async createStaff(@Headers('authorization') h:string,@Body() b:any){await this.staff(h,true);return this.gym.createStaff(b??{});}
  @Patch('admin/staff/:id') async updateStaff(@Headers('authorization') h:string,@Param('id') v:string,@Body() b:any){return this.gym.updateStaff(await this.staff(h,true),id(v),b??{});}
  @Post('admin/staff/:id/reset-password') async reset(@Headers('authorization') h:string,@Param('id') v:string){await this.staff(h,true);return this.gym.resetPassword(id(v));}
}
@Module({controllers:[GymController],providers:[GymService]})
class AppModule{}
export async function bootstrap(port=Number(process.env.PORT??4100)){
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
  const app=await NestFactory.create<NestExpressApplication>(AppModule,{logger:['error','warn'],bodyParser:false});
  app.useBodyParser('json',{limit:'3mb'});
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  await app.listen(port,'0.0.0.0');return app;
}
if(process.env.NODE_ENV!=='test') bootstrap().catch(()=>{console.error('API startup failed');process.exitCode=1;});
