import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsObject, IsString, IsUrl } from 'class-validator';
import { BrowserFormService } from './browser-form.service';

class BrowserFillDto {
	@IsUrl()
	url!: string;

	@IsObject()
	values!: Record<string, string>;

	@IsOptional()
	@IsString()
	cvPath?: string;

	@IsOptional()
	@IsBoolean()
	autoSubmit?: boolean;
}

@ApiTags('browser-forms')
@Controller('browser-forms')
export class BrowserFormController {
	constructor(private readonly service: BrowserFormService) {}

	/** Fill (and optionally submit) an ATS form in headless Chrome. */
	@Post('fill')
	fill(@Body() dto: BrowserFillDto) {
		return this.service.fillAndSubmit(dto);
	}
}
