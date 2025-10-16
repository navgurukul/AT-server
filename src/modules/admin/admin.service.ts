import { Injectable } from '@nestjs/common';

@Injectable()
export class AdminService {
  async getStatus() {
    return { health: 'ok' };
  }
}
