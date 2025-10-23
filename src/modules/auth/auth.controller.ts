import { Body, Controller, Get, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() payload: LoginDto) {
    return this.authService.login(payload);
  }

  @Public()
  @Post('refresh')
  refresh(@Body() payload: RefreshDto) {
    return this.authService.refreshToken(payload.refreshToken);
  }

  @Post('logout')
  logout(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Headers('authorization') authorization?: string,
  ) {
    if (!user) {
      return { success: true };
    }

    if (!authorization) {
      throw new UnauthorizedException('Authorization header missing');
    }

    const token = authorization.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      throw new UnauthorizedException('Access token missing');
    }

    return this.authService.logout(user.id, token);
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser | undefined) {
    return user ? this.authService.getProfile(user) : null;
  }
}
