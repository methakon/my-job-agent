import { Injectable, Logger } from '@nestjs/common';
import { ScrapedLead, PortalAdapter, ApplyResult } from '../applications/portal-adapter.interface';
import { readFile } from 'fs/promises';

const BICOM_JOB_RE = /^https?:\/\/(www\.)?bicsom\.co\/jobs\/[a-z0-9-]+\/?$/i;

/**
 * BicsomAdapter — BiCSoM Technologies (bicsom.co) custom career page.
 *
 * BiCSoM hosts job postings directly on its own WordPress site under
 * /jobs/<slug>. Each posting embeds an AWSM/Fluent-Forms application
 * form posted to itself (no explicit action URL — falls back to the
 * page URL) with a hidden `awsm_job_id` identifying the posting.
 *
 * Form fields (from the live page for senior-node-js-developer):
 *   - awsm_applicant_name       (text, required)
 *   - awsm_applicant_email      (email, required)
 *   - awsm_applicant_phone      (tel, required)
 *   - awsm_file                 (file, required, accept .pdf/.doc/.docx)
 *   - awsm_number_1             (number, required)
 *   - awsm_number_2             (number, optional)
 *   - awsm_radio_1              (radio, required):
 *         Immediate joining | 15 days of notice period | 1 month | 2 months | 3 months and more
 *   - awsm_form_privacy_policy  (checkbox, required, value=yes)
 *   - awsm_job_id               (hidden, =18673 for this posting)
 *   - action                    (hidden, =awsm_applicant_form_submission)
 *
 * The form requires a resume file upload (awsm_file). apply() tries a
 * direct multipart POST via fetch + FormData when profile.resumePath is
 * available; otherwise reports needs_info with the apply URL and form
 * field list so the browser automation path can take over.
 */
@Injectable()
export class BicsomAdapter implements PortalAdapter {
	readonly source = 'bicsom';
	readonly label = 'BiCSoM Technologies (bicsom.co)';

	private readonly logger = new Logger(BicsomAdapter.name);

	/** BiCSoM has no public seeker-facing job search API; scraping is a no-op. */
	async scrape(): Promise<ScrapedLead[]> {
		this.logger.debug('bicsom: no public job search API — returning empty');
		return [];
	}

	/**
	 * Apply to a BiCSoM job posting.
	 *
	 * Strategy:
	 * 1. Validate the URL is a bicsom.co /jobs/ page.
	 * 2. Fetch the page to read the hidden awsm_job_id.
	 * 3. If profile.resumePath is available, attempt a direct multipart POST
	 *    (fetch + FormData) of the form fields + file; detect success from
	 *    the response body.
	 * 4. If no resume path, report needs_info with the apply URL and the
	 *    form field layout so the browser path can take over.
	 */
	async apply(
		lead: ScrapedLead,
		profile: Record<string, string>,
		answers: Record<string, string>,
	): Promise<ApplyResult> {
		const url = (lead.url ?? '').trim();
		if (!url || !BICOM_JOB_RE.test(url)) {
			return {
				ok: false,
				status: 'failed',
				errorDetail: `bicsom: not a BiCSoM job URL: ${url || '(empty)'}`,
			};
		}

		const name = profile['name'] || profile['firstName'] || profile['fullName'] || '';
		const email = profile['email'] || '';
		const phone = profile['phone'] || profile['mobile'] || '';

		if (!email) {
			return {
				ok: false,
				status: 'needs_info',
				errorDetail: 'bicsom: profile has no email — required by the application form',
			};
		}

		this.logger.log(`bicsom: applying to ${lead.company} — ${lead.title} at ${url}`);

		try {
			// Fetch the job page to read the live hidden fields.
			const pageRes = await fetch(url, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36',
					'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				},
			});
			if (!pageRes.ok) {
				return {
					ok: false,
					status: 'failed',
					errorDetail: `bicsom: could not fetch job page, HTTP ${pageRes.status}`,
				};
			}
			const pageHtml = await pageRes.text();
			const jobId = this._extractHidden(pageHtml, 'awsm_job_id');
			if (!jobId) {
				return {
					ok: false,
					status: 'needs_info',
					errorDetail: 'bicsom: could not read awsm_job_id from the job page — the page may have changed',
				};
			}

			const resumePath = profile['resumePath'] || profile['resume'] || profile['lastUploadedCvPath'] || answers['resumePath'] || answers['resume'] || '';

			// Build the form data object (text fields only; file added below if present).
			const formData = new FormData();
			formData.append('awsm_applicant_name', name);
			formData.append('awsm_applicant_email', email);
			formData.append('awsm_applicant_phone', phone);
			formData.append('awsm_radio_1', answers['awsm_radio_1'] || 'Immediate joining');
			formData.append('awsm_form_privacy_policy', 'yes');
			formData.append('awsm_job_id', jobId);
			formData.append('action', 'awsm_applicant_form_submission');

			// If we have a resume file, append it and attempt a direct multipart POST.
			if (resumePath) {
				this.logger.log(`bicsom: submitting application with resume ${resumePath}`);
				try {
					// Node's fetch supports FormData with Blob/File. Use a simple buffer read.
					const buf = await readFile(resumePath);
					const mime = this._guessMime(resumePath);
					formData.append('awsm_file', new Blob([buf], { type: mime }), this._fileName(resumePath));
				} catch (err) {
					this.logger.warn(`bicsom: could not read resume file ${resumePath}: ${err}`);
				}

				const submitRes = await fetch(url, {
					method: 'POST',
					body: formData,
					headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
				});
				const bodyText = await submitRes.text();
				const used = submitRes.status;

				const success = used >= 200 && used < 300 &&
					(bodyText.includes('thank you') || bodyText.includes('submitted') ||
					 bodyText.includes('application received') || bodyText.includes('shortlist') ||
					 (!bodyText.includes('error') && !bodyText.includes('required')));

				if (success) {
					this.logger.log(`bicsom: application submitted successfully for job ${jobId}`);
					return { ok: true, status: 'submitted' };
				}

				return {
					ok: false,
					status: 'needs_info',
					errorDetail: `bicsom: direct POST returned HTTP ${used} — response may require JS rendering or a CAPTCHA; browser path recommended. Response snippet: ${bodyText.slice(0, 300)}`,
				};
			}

			// No resume path — report needs_info with the apply URL and form layout.
			return {
				ok: false,
				status: 'needs_info',
				errorDetail: `bicsom: application requires a resume file upload (awsm_file field). Apply URL: ${url}. Form fields: name, email, phone, resume (pdf/doc/docx), number_1, number_2 (optional), notice period (Immediate joining|15 days|1 month|2 months|, privacy policy checkbox. awsm_job_id=${jobId}.`,
			};
		} catch (err) {
			this.logger.error(`bicsom: apply failed for ${lead.company} — ${lead.title}: ${err}`);
			return {
				ok: false,
				status: 'failed',
				errorDetail: `bicsom: apply error: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	private _extractHidden(html: string, name: string): string | null {
		// Match <input ... name="NAME" ... value="VALUE" ...> (order-insensitive)
		const re = new RegExp(
			`<input[^>]*\\bname=["']${this._esc(name)}["'][^>]*\\bvalue=["']([^\"']+)["']|` +
			`<input[^>]*\\bvalue=["']([^\"']+)["'][^>]*\\bname=["']${this._esc(name)}["']`,
			'i',
		);
		const m = html.match(re);
		return m ? (m[1] || m[2] || null) : null;
	}

	private _esc(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	private _guessMime(path: string): string {
		const ext = path.split('.').pop()?.toLowerCase() || '';
		return ext === 'pdf' ? 'application/pdf'
			: ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
			: ext === 'doc' ? 'application/msword'
			: 'application/octet-stream';
	}

	private _fileName(path: string): string {
		const parts = path.replace(/\\/g, '/').split('/');
		return parts[parts.length - 1] || 'resume.pdf';
	}
}