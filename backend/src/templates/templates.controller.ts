import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { TemplatesService } from './templates.service';
import { EmailService } from '../email/email.service';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { SendTestDto } from './dto/send-test.dto';

@Controller('templates')
@UseGuards(JwtAuthGuard)
export class TemplatesController {
  constructor(
    private templatesService: TemplatesService,
    private emailService: EmailService,
  ) {}

  @Post()
  async create(@Body() dto: CreateTemplateDto) {
    return this.templatesService.create(dto);
  }

  @Get()
  async findAll() {
    return this.templatesService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.templatesService.findOne(id);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    return this.templatesService.update(id, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.templatesService.remove(id);
  }

  @Post(':id/test')
  async sendTest(@Param('id') id: string, @Body() dto: SendTestDto) {
    const template = await this.templatesService.findOne(id);
    const rendered = this.templatesService.renderTemplate(template, {
      name: 'Test User',
      email: dto.testEmail,
      unsubscribeLink: '#',
    });

    await this.emailService.sendEmail({
      to: dto.testEmail,
      subject: `[TEST] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
    });

    return { message: 'Test email sent successfully' };
  }
}
