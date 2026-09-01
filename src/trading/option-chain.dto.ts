import { IsDateString, IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateOptionContractDto {
  @IsString()
  symbol!: string;

  @IsString()
  underlying!: string;

  @IsDateString()
  expiry!: string;

  @IsNumber() @Min(0)
  strike!: number;

  @IsIn(['CE', 'PE'])
  optionType!: string;

  @IsNumber() @Min(1)
  lotSize!: number;

  @IsOptional() @IsNumber() @Min(0)
  tickSize?: number;
}

export class IngestOptionQuoteDto {
  @IsString()
  contractSymbol!: string;

  @IsNumber() @Min(0)
  ltp!: number;

  @IsOptional() @IsNumber() @Min(0)
  bid?: number;

  @IsOptional() @IsNumber() @Min(0)
  ask?: number;

  @IsOptional() @IsNumber() @Min(0)
  volume?: number;

  @IsOptional() @IsNumber() @Min(0)
  openInterest?: number;

  @IsOptional() @IsNumber()
  impliedVolatility?: number;

  @IsOptional() @IsNumber()
  delta?: number;

  @IsOptional() @IsNumber()
  gamma?: number;

  @IsOptional() @IsNumber()
  theta?: number;

  @IsOptional() @IsNumber()
  vega?: number;

  @IsOptional() @IsDateString()
  ts?: string;

  @IsOptional() @IsString()
  provider?: string;
}
