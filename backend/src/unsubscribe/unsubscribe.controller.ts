import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { UnsubscribeService } from './unsubscribe.service';

@Controller('unsubscribe')
export class UnsubscribeController {
  constructor(private unsubscribeService: UnsubscribeService) {}

  @Get(':token')
  async getStatus(@Param('token') token: string) {
    return this.unsubscribeService.getUnsubscribeStatus(token);
  }

  @Post(':token')
  async unsubscribe(
    @Param('token') token: string,
    @Body('email') email: string,
  ) {
    return this.unsubscribeService.processUnsubscribe(token, email);
  }
}
