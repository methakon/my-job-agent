import { IsString, IsOptional, IsNumber, IsBoolean, IsIn, IsDateString, Min } from 'class-validator';

export class CreatePortfolioDto {
	@IsOptional() @IsString()
	label?: string;

	@IsNumber() @Min(0)
	capital: number;

	@IsOptional() @IsNumber() @Min(0)
	ceiling?: number;

	@IsOptional() @IsBoolean()
	autoTradeEnabled?: boolean;

	@IsOptional() @IsBoolean()
	fridayTradingEnabled?: boolean;

	@IsOptional() @IsString()
	brokerConfig?: string;

	/** Isolation (Upstox task): false → sandbox envelope; provider/mode explicit. */
	@IsOptional() @IsBoolean()
	onRealData?: boolean;

	@IsOptional() @IsString()
	executionProvider?: string;

	@IsOptional() @IsString()
	executionMode?: string;
}

export class UpdatePortfolioDto {
	@IsOptional() @IsString()
	label?: string;

	@IsOptional() @IsNumber() @Min(0)
	capital?: number;

	@IsOptional() @IsNumber() @Min(0)
	ceiling?: number;

	@IsOptional() @IsBoolean()
	autoTradeEnabled?: boolean;

	@IsOptional() @IsBoolean()
	fridayTradingEnabled?: boolean;

	@IsOptional() @IsString()
	brokerConfig?: string;
}

export class CreateTradeDto {
	@IsString()
	portfolioId!: string;

	@IsString()
	instrument!: string;

	@IsIn(['BUY', 'SELL'])
	side!: string;

	@IsNumber() @Min(1)
	quantity!: number;

	@IsNumber() @Min(0)
	entryPrice!: number;

	@IsOptional() @IsString()
	algoSource?: string;

	/** Free-form JSON string capturing the full decision context
	 *  (target, stop-loss, confidence, scenarios, astro match, Friday flag). */
	@IsOptional() @IsString()
	decisionParams?: string;

	/** Decision ID from fnf_decision_journal.linkedDecisionId where available.
	 *  Null where the trade was not tied to a DecisionSnapshot (e.g., manual). */
	@IsOptional() @IsString()
	decisionId?: string | null;
}

export class CloseTradeDto {
	@IsNumber() @Min(0)
	exitPrice!: number;

	@IsOptional() @IsNumber() @Min(0)
	cost?: number;

	/** Why the position closed: target | stop | time | manual | flatten. */
	@IsOptional() @IsString()
	exitTrigger?: string;
}

export class IngestSnapshotDto {
	@IsString()
	instrument!: string;

	@IsNumber()
	price!: number;

	@IsOptional() @IsNumber()
	volume?: number;

	@IsOptional() @IsNumber()
	open?: number;

	@IsOptional() @IsNumber()
	high?: number;

	@IsOptional() @IsNumber()
	low?: number;

	@IsOptional() @IsNumber()
	close?: number;

	@IsOptional() @IsDateString()
	ts?: string;

	/** Feed provenance: 'fyers' | 'yahoo' | 'fyers-history' | 'import'. */
	@IsOptional() @IsString()
	source?: string;
}

export class SetDecayCalibrationDto {
	@IsOptional() @IsNumber()
	weekday?: number;

	@IsOptional() @IsNumber()
	decayRate?: number;

	@IsOptional() @IsNumber()
	windowStartHour?: number;

	@IsOptional() @IsNumber()
	windowEndHour?: number;
}
