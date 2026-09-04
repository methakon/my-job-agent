import { Controller, Get, Param } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CvRegionFormat } from './cv-region-format.entity';

/** J-10 — read API over the regional CV-conventions database. */
@Controller('cv-formats')
export class CvRegionFormatController {
	constructor(
		@InjectRepository(CvRegionFormat) private readonly repo: Repository<CvRegionFormat>,
	) {}

	@Get()
	list(): Promise<CvRegionFormat[]> {
		return this.repo.find({ order: { continent: 'ASC', country: 'ASC' } });
	}

	@Get('country/:country')
	byCountry(@Param('country') country: string): Promise<CvRegionFormat | null> {
		return this.repo.findOne({ where: { country } });
	}

	@Get('region/:region')
	byRegion(@Param('region') region: string): Promise<CvRegionFormat[]> {
		return this.repo.find({ where: { region }, order: { country: 'ASC' } });
	}
}
