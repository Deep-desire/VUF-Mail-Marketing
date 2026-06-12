import { IsEmail, IsNotEmpty } from 'class-validator';

export class SendTestDto {
  @IsEmail()
  @IsNotEmpty()
  testEmail: string;
}
