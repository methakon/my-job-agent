import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { PortalCredentialService } from './portal-credential.service';

export class PortalCredentialDto {
	/** naukri | monster | linkedin … */
	@IsString() @Length(3, 20)
	portal!: string;

	@IsString() @Length(3, 180)
	username!: string;

	/** Password or session cookie — stored AES-256 encrypted. */
	@IsString() @Length(4, 500)
	secret!: string;
}

@ApiTags('portals')
@Controller('portals')
export class PortalCredentialController {
	constructor(private readonly creds: PortalCredentialService) {}

	@Post('credentials')
	save(@Body() dto: PortalCredentialDto) {
		return this.creds.savePortalCredential(dto.portal, dto.username, dto.secret).then((row) => ({
			ok: true,
			portal: dto.portal,
			username: dto.username,
			stored: row.passwordEnc.length > 0,
			encrypted: true,
		}));
	}
}
