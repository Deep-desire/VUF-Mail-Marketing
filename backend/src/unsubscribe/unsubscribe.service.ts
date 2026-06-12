import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class UnsubscribeService {
  private readonly logger = new Logger(UnsubscribeService.name);

  constructor(private prisma: PrismaService) {}

  generateToken(email: string): string {
    return crypto
      .createHash('sha256')
      .update(email + 'vuf-unsubscribe-salt')
      .digest('hex')
      .substring(0, 32);
  }

  async getUnsubscribeStatus(token: string) {
    const existing = await this.prisma.unsubscribed.findUnique({
      where: { token },
    });

    if (existing) {
      return {
        alreadyUnsubscribed: true,
        email: this.maskEmail(existing.email),
      };
    }

    return {
      alreadyUnsubscribed: false,
      email: null,
    };
  }

  async processUnsubscribe(token: string, email: string) {
    // Verify token matches the email
    const expectedToken = this.generateToken(email);
    if (expectedToken !== token) {
      throw new NotFoundException('Invalid unsubscribe link');
    }

    // Check if already unsubscribed
    const existing = await this.prisma.unsubscribed.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existing) {
      return { message: 'You are already unsubscribed', email: this.maskEmail(email) };
    }

    // Create unsubscribe record
    await this.prisma.unsubscribed.create({
      data: {
        email: email.toLowerCase(),
        token,
      },
    });

    this.logger.log(`Email unsubscribed: ${email}`);

    return {
      message: 'You have been successfully unsubscribed',
      email: this.maskEmail(email),
    };
  }

  private maskEmail(email: string): string {
    const [user, domain] = email.split('@');
    const maskedUser =
      user.length > 2 ? user[0] + '***' + user[user.length - 1] : '***';
    return `${maskedUser}@${domain}`;
  }
}
