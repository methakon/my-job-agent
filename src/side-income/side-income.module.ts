import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SideIncomeOpportunity } from './side-income-opportunity.entity';
import { SideIncomeService } from './side-income.service';
import { SideIncomeController } from './side-income.controller';

@Module({
	imports: [TypeOrmModule.forFeature([SideIncomeOpportunity])],
	controllers: [SideIncomeController],
	providers: [SideIncomeService],
	exports: [SideIncomeService],
})
export class SideIncomeModule {}
