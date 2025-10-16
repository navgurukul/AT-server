import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Permissions } from '../../common/decorators/permissions.decorator';
import { PreviewNotificationDto } from './dto/preview.dto';
import { NotifyService } from './notify.service';

@ApiTags('notify')
@Controller('notify')
export class NotifyController {
  constructor(private readonly notifyService: NotifyService) {}

  @Post('preview')
  @Permissions('notifications:preview')
  preview(@Body() payload: PreviewNotificationDto) {
    return this.notifyService.previewTemplate(payload.template, payload.payload);
  }
}
