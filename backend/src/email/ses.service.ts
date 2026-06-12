import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SendEmailOptions } from './email.service';

@Injectable()
export class SesService {
  private readonly logger = new Logger(SesService.name);
  private client: SESClient;
  private fromEmail: string;

  constructor(private configService: ConfigService) {
    this.fromEmail = this.configService.get('SES_FROM_EMAIL', 'noreply@vuf.org');

    this.client = new SESClient({
      region: this.configService.get('AWS_REGION', 'ap-south-1'),
      credentials: {
        accessKeyId: this.configService.get('AWS_ACCESS_KEY_ID', ''),
        secretAccessKey: this.configService.get('AWS_SECRET_ACCESS_KEY', ''),
      },
    });
  }

  async send(options: SendEmailOptions): Promise<string> {
    const command = new SendEmailCommand({
      Source: this.fromEmail,
      Destination: {
        ToAddresses: [options.to],
      },
      Message: {
        Subject: {
          Data: options.subject,
          Charset: 'UTF-8',
        },
        Body: {
          Html: {
            Data: options.html,
            Charset: 'UTF-8',
          },
          Text: {
            Data: options.text,
            Charset: 'UTF-8',
          },
        },
      },
    });

    const response = await this.client.send(command);
    const messageId = response.MessageId || 'unknown';
    this.logger.debug(`SES MessageId: ${messageId}`);
    return messageId;
  }
}
