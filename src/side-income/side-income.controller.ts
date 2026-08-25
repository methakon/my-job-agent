import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { SideIncomeService } from './side-income.service';

class UpdateStatusDto {
	@IsIn(['researched', 'applied', 'in_progress', 'rejected'])
	status!: string;
}

@ApiTags('side-income')
@Controller('side-income')
export class SideIncomeController {
	constructor(private readonly service: SideIncomeService) {}

	/** Dashboard list — all researched opportunities ranked by fit. */
	@Get()
	async list() {
		const all = await this.service.list();
		return all.map((o) => this.service.toDashboard(o));
	}

	@Get(':id')
	async detail(@Param('id') id: string) {
		const o = await this.service.detail(id);
		return o ? this.service.toDashboard(o) : null;
	}

	@Post(':id/status')
	async setStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto) {
		await this.service.markStatus(id, dto.status);
		return { ok: true };
	}
}
