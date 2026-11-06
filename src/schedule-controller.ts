import { Controller, Get, Post, Patch, Delete, Headers, Body, Param, Query, ForbiddenException } from '@nestjs/common';
import { GymService } from './service.js';
import { ScheduleService } from './schedule.js';
import { id } from './rules.js';

@Controller()
export class ScheduleController {
 constructor(private readonly gym:GymService,private readonly schedule:ScheduleService){}
 private async auth(h:string,kind:'staff'|'trainer'|'member'='staff'){const actor=await this.gym.authenticate(h);if(kind==='staff')this.gym.requireStaff(actor);else if(actor.kind!==kind)throw new ForbiddenException('접근 권한이 없습니다.');return actor;}
 @Get('admin/facility') async facility(@Headers('authorization') h:string){return this.schedule.facility(await this.auth(h));}
 @Patch('admin/facility') async saveFacility(@Headers('authorization') h:string,@Body() b:any){return this.schedule.facility(await this.auth(h),b??{});}
 @Get('admin/trainers/:id/contract') async contract(@Headers('authorization') h:string,@Param('id') v:string){return this.schedule.contract(await this.auth(h),id(v));}
 @Patch('admin/trainers/:id/contract') async saveContract(@Headers('authorization') h:string,@Param('id') v:string,@Body() b:any){return this.schedule.contract(await this.auth(h),id(v),b??{});}
 @Post('admin/trainers/:id/contracts') async newContract(@Headers('authorization') h:string,@Param('id') v:string,@Body() b:any){return this.schedule.contract(await this.auth(h),id(v),b??{},true);}
 @Get('admin/trainers/:id/schedule') async trainerSchedule(@Headers('authorization') h:string,@Param('id') v:string){return this.schedule.schedule(await this.auth(h),id(v));}
 @Get('trainer/schedule') async ownSchedule(@Headers('authorization') h:string){return this.schedule.schedule(await this.auth(h,'trainer'));}
 @Get('trainer/slot-candidates') async ownCandidates(@Headers('authorization') h:string,@Query('from') from?:string,@Query('to') to?:string,@Query('excludeSlotId') exclude?:string){return this.schedule.candidates(await this.auth(h,'trainer'),from,to,undefined,exclude?id(exclude):undefined);}
 @Get('admin/trainers/:id/slot-candidates') async candidates(@Headers('authorization') h:string,@Param('id') v:string,@Query('from') from?:string,@Query('to') to?:string,@Query('excludeSlotId') exclude?:string){return this.schedule.candidates(await this.auth(h),from,to,id(v),exclude?id(exclude):undefined);}
 @Post('trainer/slots') async ownSlot(@Headers('authorization') h:string,@Body() b:any){return this.schedule.saveSlot(await this.auth(h,'trainer'),b??{});}
 @Patch('trainer/slots/:id') async editOwnSlot(@Headers('authorization') h:string,@Param('id') v:string,@Body() b:any){return this.schedule.saveSlot(await this.auth(h,'trainer'),b??{},undefined,id(v));}
 @Delete('trainer/slots/:id') async withdrawOwnSlot(@Headers('authorization') h:string,@Param('id') v:string){return this.schedule.withdraw(await this.auth(h,'trainer'),id(v));}
 @Post('admin/trainers/:id/slots') async slot(@Headers('authorization') h:string,@Param('id') v:string,@Body() b:any){return this.schedule.saveSlot(await this.auth(h),b??{},id(v));}
 @Patch('admin/slots/:id') async editSlot(@Headers('authorization') h:string,@Param('id') v:string,@Body() b:any){return this.schedule.saveSlot(await this.auth(h),b??{},undefined,id(v));}
 @Delete('admin/slots/:id') async withdrawSlot(@Headers('authorization') h:string,@Param('id') v:string){return this.schedule.withdraw(await this.auth(h),id(v));}
 @Get('admin/slots') async slots(@Headers('authorization') h:string,@Query('status') status?:string){return this.schedule.slots(await this.auth(h),status);}
 @Patch('admin/slots/:id/decision') async decideSlot(@Headers('authorization') h:string,@Param('id') v:string,@Body() b:any){return this.schedule.decide(await this.auth(h),id(v),b??{});}
 @Get('member/availability') async availability(@Headers('authorization') h:string,@Query('passId') pass?:string,@Query('trainerId') trainer?:string,@Query('month') month?:string,@Query('reservationId') reservation?:string){return this.schedule.availability(await this.auth(h,'member'),id(pass),id(trainer),month,reservation?id(reservation):undefined);}
}
