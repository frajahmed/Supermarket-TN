import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.guard';
import { LicensingService } from '../licensing/licensing.service';

/** Öffentliche Erststart-Informationen; es werden keine Geheimnisse ausgegeben. */
@Controller('setup')
export class SetupController {
  constructor(private readonly licensing: LicensingService) {}

  @Get('info')
  @Public()
  info() {
    return {
      installationId: this.licensing.installationId,
      licenseServerUrl: process.env.LICENSE_SERVER_URL ?? '',
    };
  }
}
