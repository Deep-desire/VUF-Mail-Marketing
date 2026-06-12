import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import * as XLSX from 'xlsx';
import { PrismaService } from '../common/prisma.service';
import { ContactStatus } from '../common/types';

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    private prisma: PrismaService,
    @InjectQueue('email-send-queue') private emailQueue: Queue,
  ) {}

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  async processExcelUpload(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }

    // Read Excel file
    const workbook = XLSX.readFile(file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows: Array<Record<string, any>> = XLSX.utils.sheet_to_json(sheet);

    if (rows.length === 0) {
      throw new BadRequestException('Excel file is empty');
    }

    // Normalize keys of all rows (trim and lowercase) to handle trailing spaces or different casing
    const normalizedRows = rows.map((row) => {
      const normalized: Record<string, any> = {};
      for (const key of Object.keys(row)) {
        normalized[key.trim().toLowerCase()] = row[key];
      }
      return normalized;
    });

    // Validate required columns
    const firstRow = normalizedRows[0];
    if (!('name' in firstRow) || !('email' in firstRow)) {
      throw new BadRequestException(
        'Excel file must contain "name" and "email" columns',
      );
    }

    // Get unsubscribed emails
    const unsubscribedEmails = await this.prisma.unsubscribed.findMany();
    const unsubscribedSet = new Set(
      unsubscribedEmails.map((u) => u.email.toLowerCase()),
    );

    // Process contacts
    const seenEmails = new Set<string>();
    let validCount = 0;
    let invalidCount = 0;
    let duplicateCount = 0;
    let unsubscribedCount = 0;

    const contacts: Array<{
      name: string;
      email: string;
      status: ContactStatus;
      error: string | null;
    }> = [];

    for (const row of normalizedRows) {
      const name = String(row.name || '').trim();
      const email = String(row.email || '').trim().toLowerCase();

      if (!email) {
        contacts.push({
          name,
          email,
          status: ContactStatus.invalid,
          error: 'Email is empty',
        });
        invalidCount++;
        continue;
      }

      if (!this.isValidEmail(email)) {
        contacts.push({
          name,
          email,
          status: ContactStatus.invalid,
          error: 'Invalid email format',
        });
        invalidCount++;
        continue;
      }

      if (seenEmails.has(email)) {
        contacts.push({
          name,
          email,
          status: ContactStatus.duplicate,
          error: 'Duplicate email in file',
        });
        duplicateCount++;
        continue;
      }

      if (unsubscribedSet.has(email)) {
        contacts.push({
          name,
          email,
          status: ContactStatus.unsubscribed,
          error: 'Email is unsubscribed',
        });
        unsubscribedCount++;
        seenEmails.add(email);
        continue;
      }

      seenEmails.add(email);
      contacts.push({
        name,
        email,
        status: ContactStatus.valid,
        error: null,
      });
      validCount++;
    }

    // Save upload record
    const upload = await this.prisma.upload.create({
      data: {
        fileName: file.filename,
        originalName: file.originalname,
        totalRows: normalizedRows.length,
        validEmails: validCount,
        invalidEmails: invalidCount,
        duplicateEmails: duplicateCount,
        unsubscribedEmails: unsubscribedCount,
        contacts: {
          create: contacts,
        },
      },
    });

    this.logger.log(
      `Upload ${upload.id}: ${normalizedRows.length} rows, ${validCount} valid, ${invalidCount} invalid, ${duplicateCount} duplicates, ${unsubscribedCount} unsubscribed`,
    );

    return upload;
  }

  async findAll() {
    return this.prisma.upload.findMany({
      include: { template: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    return this.prisma.upload.findUnique({
      where: { id },
      include: { template: true },
    });
  }

  async findContacts(id: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [contacts, total] = await Promise.all([
      this.prisma.contact.findMany({
        where: { uploadId: id },
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.contact.count({ where: { uploadId: id } }),
    ]);

    return {
      contacts,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async startSend(id: string, templateId: string) {
    const upload = await this.findOne(id);
    if (!upload) {
      throw new NotFoundException('Upload not found');
    }

    if (upload.status !== 'idle') {
      throw new BadRequestException(`Email sending has already been initiated (status: ${upload.status})`);
    }

    // Verify template exists
    const template = await this.prisma.template.findUnique({
      where: { id: templateId },
    });
    if (!template) {
      throw new NotFoundException('Template not found');
    }

    // Get all valid contacts for this upload
    const contacts = await this.prisma.contact.findMany({
      where: {
        uploadId: id,
        status: ContactStatus.valid,
      },
    });

    if (contacts.length === 0) {
      throw new BadRequestException('No valid contacts found in this upload');
    }

    // Get unsubscribed list to double check and skip if necessary
    const unsubscribed = await this.prisma.unsubscribed.findMany();
    const unsubscribedSet = new Set(unsubscribed.map(u => u.email.toLowerCase()));

    // Map each contact to its send/delivery state
    let pendingCount = 0;
    let skippedCount = 0;

    try {
      for (const contact of contacts) {
        const isUnsubscribed = unsubscribedSet.has(contact.email.toLowerCase());
        if (isUnsubscribed) {
          skippedCount++;
          await this.prisma.contact.update({
            where: { id: contact.id },
            data: {
              deliveryStatus: 'skipped',
              deliveryError: 'Email is unsubscribed',
            },
          });
        } else {
          pendingCount++;
          await this.prisma.contact.update({
            where: { id: contact.id },
            data: {
              deliveryStatus: 'pending',
            },
          });
        }
      }

      // Update upload record
      await this.prisma.upload.update({
        where: { id },
        data: {
          status: 'processing',
          templateId,
          totalCount: contacts.length,
          pendingCount,
          skippedCount,
        },
      });

      // Add jobs to queue
      const queuedContacts = contacts.filter(c => !unsubscribedSet.has(c.email.toLowerCase()));
      const jobs = queuedContacts.map(c => ({
        data: {
          uploadId: id,
          contactId: c.id,
          templateId,
        },
        opts: {
          attempts: 3,
          backoff: 1000,
        }
      }));

      await this.emailQueue.addBulk(jobs);
    } catch (queueError) {
      this.logger.error(`Failed to initiate email sending for upload ${id}: ${queueError.message}`, queueError.stack);
      
      // Rollback Upload status
      await this.prisma.upload.update({
        where: { id },
        data: {
          status: 'idle',
          templateId: null,
          totalCount: 0,
          pendingCount: 0,
          skippedCount: 0,
        },
      });

      // Rollback Contact statuses
      for (const contact of contacts) {
        await this.prisma.contact.update({
          where: { id: contact.id },
          data: {
            deliveryStatus: 'idle',
            deliveryError: null,
          },
        });
      }

      throw new BadRequestException(
        `Failed to queue emails. Please verify that your local Redis server is running. (Error: ${queueError.message})`
      );
    }

    this.logger.log(`Initiated email sending for upload ${id}: ${pendingCount} queued, ${skippedCount} skipped`);

    return {
      message: 'Sending initiated',
      totalCount: contacts.length,
      queuedCount: pendingCount,
      skippedCount,
    };
  }

  async getDashboardStats() {
    const [totalUploads, totalTemplates, totalEmailsSent, totalFailedEmails] = await Promise.all([
      this.prisma.upload.count(),
      this.prisma.template.count(),
      this.prisma.contact.count({ where: { deliveryStatus: 'sent' } }),
      this.prisma.contact.count({ where: { deliveryStatus: 'failed' } }),
    ]);

    return {
      totalUploads,
      totalTemplates,
      totalEmailsSent,
      totalFailedEmails,
    };
  }
}
