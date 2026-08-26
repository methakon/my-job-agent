import { Controller, Get, Post, Param, Body, Query, UseInterceptors, UploadedFile, Res, BadRequestException, NotFoundException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { mkdirSync, existsSync, createReadStream } from 'fs';
import { PreApplyService } from './pre-apply.service';
import { AstroMuhurtaService } from './astro-muhurta.service';
import { AstroLeadScoringService } from './astro-lead-scoring.service';

const UPLOAD_DIR = join(process.cwd(), 'uploads', 'user-cvs');

@Controller()
export class AstroController {
	constructor(
		private readonly preApply: PreApplyService,
		private readonly muhurta: AstroMuhurtaService,
		private readonly astroScoring: AstroLeadScoringService,
	) {}

	// ------------------------------------------------------------ muhurta API

	/** Next shubh muhurta windows (recomputed live). */
	@Get('astro/muhurta')
	async windows(@Query('hours') hours?: string) {
		return this.muhurta.nextWindows(new Date(), Number(hours ?? 24));
	}
	/** Latest persisted windows (no recompute — dashboard friendly). */
	@Get('astro/muhurta/latest')
	async latest() {
		return this.muhurta.latest(10);
	}

	/** Astro match breakdown for a job lead. */
	@Post('astro/score')
	async score(@Body() body: { title?: string; company?: string; description?: string }) {
		if (!body.title) throw new BadRequestException('title required');
		return this.astroScoring.score(body.title, body.company ?? '', body.description ?? '');
	}

	// ------------------------------------------------------------ pre-apply API

	/** All pre-apply queue items (dashboard). */
	@Get('pre-apply')
	async list() {
		return this.preApply.listAll();
	}

	/** Items awaiting user action: ready + approved. */
	@Get('pre-apply/pending')
	async pending() {
		return this.preApply.listPending();
	}

	/** Prepare an application for a lead — builds everything, sends nothing. */
	@Post('pre-apply/prepare/:leadId')
	async prepare(@Param('leadId') leadId: string) {
		return this.preApply.prepare(leadId);
	}

	/** User approves → sent at the next shubh muhurta (unless already shubh). */
	@Post('pre-apply/:id/approve')
	async approve(@Param('id') id: string) {
		return this.preApply.approve(id);
	}

	/** User holds the item (e.g. while correcting the CV). */
	@Post('pre-apply/:id/hold')
	async hold(@Param('id') id: string) {
		return this.preApply.hold(id);
	}

	/** Resume a held item back to ready. */
	@Post('pre-apply/:id/resume')
	async resume(@Param('id') id: string) {
		return this.preApply.resume(id);
	}

	/** User rule: manually upload a corrected CV to attach instead of the tailored one. */
	@Post('pre-apply/:id/upload-cv')
	@UseInterceptors(FileInterceptor('file', {
		storage: diskStorage({
			destination: (_req, _file, cb) => {
				mkdirSync(UPLOAD_DIR, { recursive: true });
				cb(null, UPLOAD_DIR);
			},
			filename: (_req, file, cb) => {
				const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
				cb(null, `${Date.now()}-${safe}`);
			},
		}),
		fileFilter: (_req, file, cb) => {
			if (!/\.(pdf|docx?)$/i.test(file.originalname)) {
				return cb(new BadRequestException('only .pdf/.doc/.docx allowed'), false);
			}
			cb(null, true);
		},
	}))
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async uploadCv(@Param('id') id: string, @UploadedFile() file: any) {
		if (!file || !file.path) throw new BadRequestException('file required');
		return this.preApply.uploadCv(id, file.path as string);
	}

	/** Download the CV that would be attached (user CV overrides tailored). */
	@Get('pre-apply/:id/cv')
	async cv(@Param('id') id: string, @Res() res: Response) {
		const item = await this.preApply.get(id);
		if (!item) throw new NotFoundException('not found');
		const path = item.userCvPath ?? item.cvPath;
		if (!path || !existsSync(path)) throw new NotFoundException('no CV on this item');
		res.setHeader('Content-Type', extname(path) === '.pdf' ? 'application/pdf' : 'application/octet-stream');
		res.setHeader('Content-Disposition', `inline; filename="${path.split(/[\\/]/).pop()}"`);
		createReadStream(path).pipe(res);
	}
}
