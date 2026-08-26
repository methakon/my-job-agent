/* Live test of FinnAdapter.login() — boots the Nest app for DI services,
 * constructs the adapter the same way ApplyEngine does, and runs the OTP flow.
 * Sends a real OTP email to the configured finn login address and reads it via IMAP.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PortalCredentialService } from '../src/applications/portal-credential.service';
import { InboxReaderService } from '../src/applications/inbox-reader.service';
import { FinnAdapter } from '../src/scout/finn.adapter';

async function main() {
	const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
	const creds = app.get(PortalCredentialService);
	const inbox = app.get(InboxReaderService);
	const adapter = new FinnAdapter(creds, inbox);
	console.log('finn email:', await adapter['loginEmail']());
	const t0 = Date.now();
	const ok = await adapter.login();
	console.log(`login result: ${ok ? 'SUCCESS' : 'FAILED'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
	if (ok) {
		const cookieNames = Object.keys(adapter['session']?.cookies ?? {});
		console.log('session cookies:', cookieNames.join(', '));
	}
	await app.close();
	process.exit(ok ? 0 : 1);
}
main().catch((e) => {
	console.error('TEST ERROR:', e);
	process.exit(1);
});
