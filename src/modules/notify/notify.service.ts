import { Injectable } from '@nestjs/common';

@Injectable()
export class NotifyService {
  async previewTemplate(template: string, payload: Record<string, unknown>) {
    return {
      rendered: `Preview of ${template}`,
      payload,
    };
  }
}
