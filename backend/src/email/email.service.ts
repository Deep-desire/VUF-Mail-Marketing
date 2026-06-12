import { Injectable, Logger } from '@nestjs/common';
import { SesService } from './ses.service';
import { SmtpService } from './smtp.service';

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendEmailResult {
  messageId: string;
  provider: 'ses' | 'smtp';
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private sesService: SesService,
    private smtpService: SmtpService,
  ) {}

  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    // Try Amazon SES first
    try {
      const messageId = await this.sesService.send(options);
      this.logger.log(`Email sent via SES to ${options.to}: ${messageId}`);
      return { messageId, provider: 'ses' };
    } catch (sesError) {
      this.logger.warn(
        `SES failed for ${options.to}: ${sesError.message}. Falling back to SMTP.`,
      );
    }

    // Fallback to SMTP
    try {
      const messageId = await this.smtpService.send(options);
      this.logger.log(`Email sent via SMTP to ${options.to}: ${messageId}`);
      return { messageId, provider: 'smtp' };
    } catch (smtpError) {
      this.logger.error(
        `SMTP also failed for ${options.to}: ${smtpError.message}`,
      );
      throw new Error(
        `All email providers failed: SES and SMTP both returned errors`,
      );
    }
  }
}
