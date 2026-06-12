import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UploadsService } from './uploads.service';

@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  @Post('excel')
  @UseInterceptors(FileInterceptor('file'))
  async uploadExcel(@UploadedFile() file: Express.Multer.File) {
    return this.uploadsService.processExcelUpload(file);
  }

  @Get('stats/dashboard')
  async getDashboardStats() {
    return this.uploadsService.getDashboardStats();
  }

  @Get()
  async findAll() {
    return this.uploadsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.uploadsService.findOne(id);
  }

  @Get(':id/contacts')
  async findContacts(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.uploadsService.findContacts(
      id,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Post(':id/send')
  async startSend(
    @Param('id') id: string,
    @Body('templateId') templateId: string,
  ) {
    return this.uploadsService.startSend(id, templateId);
  }
}
