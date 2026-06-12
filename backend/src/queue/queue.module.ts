import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { EmailProcessor } from './email.processor';
import { EmailModule } from '../email/email.module';
import { TemplatesModule } from '../templates/templates.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'email-send-queue',
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: false,
        removeOnFail: false,
      },
    }),
    EmailModule,
    TemplatesModule,
  ],
  providers: [EmailProcessor],
  exports: [BullModule],
})
export class QueueModule {}
