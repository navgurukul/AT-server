import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ description: 'Google ID token received from the frontend' })
  @IsString()
  idToken!: string;

  @ApiProperty({ description: 'Email address of the signing-in user' })
  @IsEmail()
  email!: string;
}
