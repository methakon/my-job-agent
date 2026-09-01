import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateOptionContractDto, IngestOptionQuoteDto } from './option-chain.dto';
import { FnfOptionChainService } from './fnf-option-chain.service';

@ApiTags('fno-options')
@Controller('trading/options')
export class FnfOptionChainController {
  constructor(private readonly chain: FnfOptionChainService) {}

  @Get('contracts')
  listContracts(@Query() query: Record<string, string | undefined>) {
    return this.chain.listContracts(query);
  }

  @Post('contracts')
  registerContract(@Body() dto: CreateOptionContractDto) {
    return this.chain.upsertContract(dto);
  }

  @Get('chain')
  findChain(@Query() query: Record<string, string | undefined>) {
    return this.chain.findChain(this.chain.parseQuery(query));
  }

  @Post('quotes')
  ingestQuote(@Body() dto: IngestOptionQuoteDto) {
    return this.chain.ingestQuote(dto);
  }
}
