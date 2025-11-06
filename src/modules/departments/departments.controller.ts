import { Controller, Get, Query } from "@nestjs/common";
import { ApiQuery, ApiTags } from "@nestjs/swagger";

import { Permissions } from "../../common/decorators/permissions.decorator";
import { DepartmentsService } from "./departments.service";

@ApiTags("departments")
@Controller("departments")
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Get()
  // @Permissions('users:view')
  @ApiQuery({ name: "orgId", required: false, type: Number })
  list(@Query("orgId") orgId?: string) {
    return this.departmentsService.list(
      orgId ? Number.parseInt(orgId, 10) : undefined
    );
  }
}
