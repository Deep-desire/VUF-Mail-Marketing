import { Injectable, NotFoundException } from '@nestjs/common';
import * as Handlebars from 'handlebars';
import { PrismaService } from '../common/prisma.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';

@Injectable()
export class TemplatesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateTemplateDto) {
    return this.prisma.template.create({
      data: {
        name: dto.name,
        subject: dto.subject,
        htmlBody: dto.htmlBody,
        plainTextBody: dto.plainTextBody,
      },
    });
  }

  async findAll() {
    return this.prisma.template.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const template = await this.prisma.template.findUnique({
      where: { id },
    });
    if (!template) {
      throw new NotFoundException('Template not found');
    }
    return template;
  }

  async update(id: string, dto: UpdateTemplateDto) {
    await this.findOne(id);
    return this.prisma.template.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.subject && { subject: dto.subject }),
        ...(dto.htmlBody && { htmlBody: dto.htmlBody }),
        ...(dto.plainTextBody && { plainTextBody: dto.plainTextBody }),
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.template.delete({
      where: { id },
    });
  }

  renderTemplate(
    template: { subject: string; htmlBody: string; plainTextBody: string },
    variables: { name: string; email: string; unsubscribeLink: string },
  ) {
    const subjectTemplate = Handlebars.compile(template.subject);
    const htmlTemplate = Handlebars.compile(template.htmlBody);
    const plainTemplate = Handlebars.compile(template.plainTextBody);

    return {
      subject: subjectTemplate(variables),
      html: htmlTemplate(variables),
      text: plainTemplate(variables),
    };
  }
}
