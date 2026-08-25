import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SideIncomeOpportunity } from './side-income-opportunity.entity';
import { SideIncomeService } from './side-income.service';
import { SideIncomeController } from './side-income.controller';
import { SideIncomeDashboardController } from './side-income-dashboard.controller';

@Module({
	imports: [TypeOrmModule.forFeature([SideIncomeOpportunity])],
	controllers: [SideIncomeController, SideIncomeDashboardController],
	providers: [SideIncomeService],
	exports: [SideIncomeService],
})
export class SideIncomeModule {}
