import { Process, Processor, OnQueueCompleted, OnQueueFailed } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { PrismaService } from '../common/prisma.service';
import { EmailService } from '../email/email.service';
import { TemplatesService } from '../templates/templates.service';
import { ConfigService } from '@nestjs/config';

interface EmailJobData {
  uploadId: string;
  contactId: string;
  templateId: string;
}

@Processor('email-send-queue')
export class EmailProcessor {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(
    private prisma: PrismaService,
    private emailService: EmailService,
    private templatesService: TemplatesService,
    private configService: ConfigService,
  ) {}

  @Process({ concurrency: 2 })
  async handleEmailSend(job: Job<EmailJobData>) {
    const { uploadId, contactId, templateId } = job.data;

    this.logger.log(
      `Processing job ${job.id} for contact ${contactId} in upload ${uploadId}`,
    );

    try {
      // Fetch contact
      const contact = await this.prisma.contact.findUnique({
        where: { id: contactId },
      });

      if (!contact) {
        this.logger.error(`Contact ${contactId} not found`);
        return;
      }

      // Check if already sent
      if (contact.deliveryStatus === 'sent') {
        this.logger.warn(`Contact ${contactId} already sent, skipping`);
        return;
      }

      // Check if email is unsubscribed
      const isUnsubscribed = await this.prisma.unsubscribed.findUnique({
        where: { email: contact.email },
      });

      if (isUnsubscribed) {
        await this.prisma.contact.update({
          where: { id: contactId },
          data: { deliveryStatus: 'skipped', deliveryError: 'Email is unsubscribed' },
        });
        await this.prisma.upload.update({
          where: { id: uploadId },
          data: {
            skippedCount: { increment: 1 },
            pendingCount: { decrement: 1 },
          },
        });
        this.logger.log(`Skipped unsubscribed email: ${contact.email}`);
        return;
      }

      // Fetch template
      const template = await this.prisma.template.findUnique({
        where: { id: templateId },
      });

      if (!template) {
        throw new Error(`Template ${templateId} not found`);
      }

      // Generate unsubscribe link
      const frontendUrl = this.configService.get('FRONTEND_URL', 'http://localhost:5173');
      
      // Generate a deterministic token for the email
      const crypto = require('crypto');
      const token = crypto
        .createHash('sha256')
        .update(contact.email + 'vuf-unsubscribe-salt')
        .digest('hex')
        .substring(0, 32);

      const unsubscribeLink = `${frontendUrl}/unsubscribe/${token}`;

      // Render template
      const rendered = this.templatesService.renderTemplate(template, {
        name: contact.name,
        email: contact.email,
        unsubscribeLink,
      });

      // Send email
      const result = await this.emailService.sendEmail({
        to: contact.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      // Update contact delivery status
      await this.prisma.contact.update({
        where: { id: contactId },
        data: {
          deliveryStatus: 'sent',
          deliveryError: null,
          sentAt: new Date().toISOString(),
        },
      });

      // Update upload counters
      await this.prisma.upload.update({
        where: { id: uploadId },
        data: {
          sentCount: { increment: 1 },
          pendingCount: { decrement: 1 },
        },
      });

      this.logger.log(
        `Email sent to ${contact.email} via ${result.provider} (${result.messageId})`,
      );

      // Rate limiting delay (200ms)
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      this.logger.error(
        `Failed to send email for contact ${contactId}: ${error.message}`,
      );

      // Update contact status on final failure
      if (job.attemptsMade >= (job.opts.attempts || 3) - 1) {
        await this.prisma.contact.update({
          where: { id: contactId },
          data: {
            deliveryStatus: 'failed',
            deliveryError: error.message,
          },
        });

        await this.prisma.upload.update({
          where: { id: uploadId },
          data: {
            failedCount: { increment: 1 },
            pendingCount: { decrement: 1 },
          },
        });
      }

      throw error; // Re-throw to trigger Bull retry
    }
  }

  @OnQueueCompleted()
  async onCompleted(job: Job<EmailJobData>) {
    const { uploadId } = job.data;
    await this.checkUploadCompletion(uploadId);
  }

  @OnQueueFailed()
  async onFailed(job: Job<EmailJobData>, error: Error) {
    this.logger.error(`Job ${job.id} failed: ${error.message}`);
    if (job.attemptsMade >= (job.opts.attempts || 3)) {
      const { uploadId } = job.data;
      await this.checkUploadCompletion(uploadId);
    }
  }

  private async checkUploadCompletion(uploadId: string) {
    const upload = await this.prisma.upload.findUnique({
      where: { id: uploadId },
    });

    if (!upload) return;

    const pendingContacts = await this.prisma.contact.count({
      where: {
        uploadId,
        deliveryStatus: 'pending',
      },
    });

    if (pendingContacts === 0 && upload.status === 'processing') {
      const finalStatus =
        upload.failedCount > 0 && upload.sentCount === 0
          ? 'failed'
          : 'completed';

      await this.prisma.upload.update({
        where: { id: uploadId },
        data: { status: finalStatus },
      });

      this.logger.log(
        `Upload Sending ${uploadId} ${finalStatus}: ${upload.sentCount} sent, ${upload.failedCount} failed, ${upload.skippedCount} skipped`,
      );
    }
  }
}
