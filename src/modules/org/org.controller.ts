import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { OrgService } from './org.service';

@ApiTags('org')
@Controller('org')
export class OrgController {
  constructor(private readonly orgService: OrgService) {}

  @Get('config')
  getOrgConfig(@CurrentUser() user: AuthenticatedUser | undefined) {
    if (!user) {
      return null;
    }
    return this.orgService.getConfiguration(user.orgId);
  }
}
