import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { ContactStatus } from '../common/types';

@Injectable()
export class ContactsService {
  constructor(private prisma: PrismaService) {}

  async getValidContactsByUploadId(uploadId: string) {
    return this.prisma.contact.findMany({
      where: {
        uploadId,
        status: ContactStatus.valid,
      },
    });
  }

  async getContactsByUploadId(uploadId: string) {
    return this.prisma.contact.findMany({
      where: { uploadId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
