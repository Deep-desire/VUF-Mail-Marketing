import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { SesService } from './ses.service';
import { SmtpService } from './smtp.service';

@Module({
  providers: [EmailService, SesService, SmtpService],
  exports: [EmailService],
})
export class EmailModule {}
