import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export interface ApplicationEmail {
	to: string;
	subject: string;
	html: string;
	/** Absolute path of the ATS-friendly CV PDF/DOCX to attach. */
	cvPath?: string;
}

/**
 * DirectApplyMailer — sends applications straight to HR emails via SMTP.
 * Credentials come from SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD in .env
 * (an app-specific password; the raw password is never stored in code).
 */
@Injectable()
export class DirectApplyMailer {
	private readonly logger = new Logger(DirectApplyMailer.name);
	private transporter: nodemailer.Transporter | null = null;

	constructor(private readonly config: ConfigService) {}

	private getTransport(): nodemailer.Transporter | null {
		if (this.transporter) return this.transporter;
		const host = this.config.get<string>('SMTP_HOST');
		const user = this.config.get<string>('SMTP_USER');
		const pass = this.config.get<string>('SMTP_PASSWORD');
		if (!host || !user || !pass) {
			this.logger.warn('SMTP not configured (SMTP_HOST/SMTP_USER/SMTP_PASSWORD) — direct email apply disabled');
			return null;
		}
		this.transporter = nodemailer.createTransport({
			host,
			port: Number(this.config.get('SMTP_PORT', 587)),
			secure: Number(this.config.get('SMTP_PORT', 587)) === 465,
			auth: { user, pass },
		});
		return this.transporter;
	}

	async send(app: ApplicationEmail): Promise<{ ok: boolean; error?: string }> {
		const transport = this.getTransport();
		if (!transport) return { ok: false, error: 'smtp-not-configured' };
		try {
			await transport.sendMail({
				from: `"Swarna Sekhar Dhar" <${this.config.get('SMTP_USER')}>`,
				to: app.to,
				subject: app.subject,
				html: app.html.replace(/\n/g, '<br>'),
				attachments: app.cvPath ? [{ path: app.cvPath }] : [],
			});
			this.logger.log(`application email sent to ${app.to}: "${app.subject}"`);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: String(err).slice(0, 300) };
		}
	}
}
