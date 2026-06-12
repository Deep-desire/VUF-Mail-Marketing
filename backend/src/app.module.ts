import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { UploadsModule } from './uploads/uploads.module';
import { ContactsModule } from './contacts/contacts.module';
import { TemplatesModule } from './templates/templates.module';
import { EmailModule } from './email/email.module';
import { QueueModule } from './queue/queue.module';
import { UnsubscribeModule } from './unsubscribe/unsubscribe.module';

@Module({
  imports: [
    // Global configuration and database settings (reloaded)
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        maxRetriesPerRequest: null,
      },
    }),
    CommonModule,
    AuthModule,
    UploadsModule,
    ContactsModule,
    TemplatesModule,
    EmailModule,
    QueueModule,
    UnsubscribeModule,
  ],
})
export class AppModule {}
