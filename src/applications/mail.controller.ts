import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsOptional, IsString, Length } from 'class-validator';
import { MailService } from './mail.service';

export class SaveMailAccountDto {
	@IsEmail()
	email!: string;

	/** App-specific password (created after 2FA). Stored encrypted. */
	@IsString() @Length(8, 100)
	passwordPlain!: string;

	@IsOptional() @IsString() @Length(3, 20)
	provider?: string;

	@IsOptional() @IsBoolean()
	isPrimary?: boolean;
}

@ApiTags('mail')
@Controller('mail')
export class MailController {
	constructor(private readonly mail: MailService) {}

	@Get('accounts')
	list() {
		return this.mail.listAccounts().then((rows) =>
			rows.map(({ passwordEnc, ...rest }) => ({ ...rest, passwordSet: passwordEnc.length > 0 })),
		);
	}

	@Post('accounts')
	save(@Body() dto: SaveMailAccountDto) {
		return this.mail.saveAccount(dto);
	}
}
