import { Injectable, Logger } from '@nestjs/common';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';

export interface FormFillPlan {
	url: string;
	/** profile-derived field values keyed by normalized field name */
	values: Record<string, string>;
	/** path of tailored CV PDF to upload into file inputs */
	cvPath?: string;
	/** submit without confirmation? default false (safety) */
	autoSubmit?: boolean;
}

export interface BrowserApplyResult {
	ok: boolean;
	status: 'filled' | 'submitted' | 'needs_info' | 'failed';
	filledFields: string[];
	unansweredQuestions: string[];
	screenshots: string[];
	errorDetail?: string;
}

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const SHOT_DIR = path.join(process.cwd(), 'generated', 'browser');

/**
 * BrowserFormService (FR-15) — drives a real headless Chromium via
 * playwright-core (system Chrome, no bundled download). Fills ATS portal
 * forms from profile data; stops before final submit unless explicitly
 * allowed. Screenshots every step to generated/browser/ for audit.
 */
@Injectable()
export class BrowserFormService {
	private readonly logger = new Logger(BrowserFormService.name);

	private async shot(page: Page, name: string): Promise<string> {
		fs.mkdirSync(SHOT_DIR, { recursive: true });
		const file = path.join(SHOT_DIR, `${Date.now()}-${name}.png`);
		await page.screenshot({ path: file, fullPage: true });
		return file;
	}

	async fillAndSubmit(plan: FormFillPlan): Promise<BrowserApplyResult> {
		const result: BrowserApplyResult = { ok: false, status: 'failed', filledFields: [], unansweredQuestions: [], screenshots: [] };
		let browser: Browser | null = null;
		try {
			browser = await chromium.launch({
				executablePath: CHROME_PATH,
				headless: true,
				args: ['--no-sandbox', '--disable-dev-shm-usage'],
			});
			const ctx: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			const page: Page = await ctx.newPage();

			await page.goto(plan.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
			result.screenshots.push(await this.shot(page, 'loaded'));

			// collect visible form fields (text/email/tel/url/textarea/select + file)
			const fields = await page.$$eval(
				'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select',
				(els) =>
					els
						.filter((el) => {
							const style = window.getComputedStyle(el);
							return style.display !== 'none' && style.visibility !== 'hidden' && (el as HTMLElement).offsetParent !== null;
						})
						.map((el) => ({
							tag: el.tagName.toLowerCase(),
							type: (el as HTMLInputElement).type || null,
							name: (el as HTMLInputElement).name || null,
							id: el.id || null,
							placeholder: (el as HTMLInputElement).placeholder || null,
							label:
								el.id &&
								document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
									? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`) as HTMLElement).innerText.trim()
									: null,
							required: (el as HTMLInputElement).required || el.hasAttribute('aria-required'),
						})),
			);

			const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z]/g, '');
			const valueFor = (f: (typeof fields)[number]): string | null => {
				const keys = [norm(f.label), norm(f.name), norm(f.id), norm(f.placeholder)].filter(Boolean);
				for (const key of keys) {
					for (const [vk, vv] of Object.entries(plan.values)) {
						if (key.includes(norm(vk)) || norm(vk).includes(key)) return vv;
					}
				}
				return null;
			};

			let filledCount = 0;
			for (const f of fields) {
				if (f.type === 'file') continue; // handled below
				const val = valueFor(f);
				if (!val) {
					if (f.required) result.unansweredQuestions.push(f.label ?? f.name ?? f.id ?? 'unknown required field');
					continue;
				}
				const sel = f.id ? `#${CSS.escape(f.id)}` : f.name ? `[name="${f.name}"]` : null;
				if (!sel) continue;
				try {
					if (f.tag === 'select') {
						await page.selectOption(sel, { label: val }).catch(async () => page.selectOption(sel, { value: val }));
					} else {
						await page.fill(sel, val);
					}
					result.filledFields.push(f.label ?? f.name ?? f.id ?? 'field');
					filledCount++;
				} catch {
					this.logger.warn(`could not fill field ${sel}`);
				}
			}

			// CV upload for any visible file input
			if (plan.cvPath && fs.existsSync(plan.cvPath)) {
				const fileInputs = await page.$$('input[type=file]');
				for (const input of fileInputs) {
					await input.setInputFiles(plan.cvPath).catch((e) => this.logger.warn(`cv upload failed: ${e}`));
				}
			}
			result.screenshots.push(await this.shot(page, 'filled'));

			if (result.unansweredQuestions.length > 0) {
				result.status = 'needs_info';
			} else if (plan.autoSubmit) {
				await page.locator('button[type=submit], input[type=submit], button:has-text("Submit"), button:has-text("Apply")').first().click();
				await page.waitForLoadState('domcontentloaded');
				result.screenshots.push(await this.shot(page, 'submitted'));
				result.status = 'submitted';
			} else {
				// safety default: leave filled for human review
				result.status = 'filled';
			}
			result.ok = true;
			this.logger.log(`browser form ${plan.url}: ${filledCount} filled, status=${result.status}, ${result.unansweredQuestions.length} unanswered`);
		} catch (err) {
			result.errorDetail = String(err).slice(0, 500);
			this.logger.warn(`browser apply failed: ${result.errorDetail}`);
		} finally {
			await browser?.close();
		}
		return result;
	}
}
