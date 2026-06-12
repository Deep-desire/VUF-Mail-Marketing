import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { SendEmailOptions } from './email.service';

@Injectable()
export class SmtpService {
  private readonly logger = new Logger(SmtpService.name);
  private transporter: nodemailer.Transporter;
  private fromEmail: string;

  constructor(private configService: ConfigService) {
    this.fromEmail = this.configService.get('SES_FROM_EMAIL', 'noreply@vuf.org');

    this.transporter = nodemailer.createTransport({
      host: this.configService.get('SMTP_HOST', ''),
      port: parseInt(this.configService.get('SMTP_PORT', '587'), 10),
      secure: false,
      auth: {
        user: this.configService.get('SMTP_USER', ''),
        pass: this.configService.get('SMTP_PASS', ''),
      },
    });
  }

  async send(options: SendEmailOptions): Promise<string> {
    const info = await this.transporter.sendMail({
      from: this.fromEmail,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });

    const messageId = info.messageId || 'unknown';
    this.logger.debug(`SMTP MessageId: ${messageId}`);
    return messageId;
  }
}
