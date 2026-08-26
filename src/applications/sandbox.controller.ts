import { Controller, Get, Post, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SandboxController — toggle/read SANDBOX mode. While ON, the agent runs the
 * full pipeline (scout, score, tailor CV, compose, detect channel) but does
 * NOT actually apply — applications are stored with is_sandbox=1 and status
 * 'sandboxed'. Turning it OFF returns to real submissions; sandbox rows are
 * ignored by real mode.
 */
const ENV_FILE = path.join(process.cwd(), '.env');

@ApiTags('sandbox')
@Controller('sandbox')
export class SandboxController {
	@Get()
	status() {
		return {
			sandbox: process.env.SANDBOX === 'true',
			hint: 'SANDBOX=true → full pipeline runs but nothing is actually sent (is_sandbox=1). OFF → real submissions.',
		};
	}

	@Post('toggle')
	toggle(@Body() dto: { enabled: boolean }) {
		const target = `SANDBOX=${dto.enabled ? 'true' : 'false'}`;
		let env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
		if (/^SANDBOX=.*$/m.test(env)) env = env.replace(/^SANDBOX=.*$/m, target);
		else env += (env.endsWith('\n') || !env ? '' : '\n') + target + '\n';
		fs.writeFileSync(ENV_FILE, env);
		process.env.SANDBOX = String(dto.enabled);
		return { ok: true, sandbox: dto.enabled };
	}
}
