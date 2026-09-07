import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TradeBookImporterService } from './trade-book-importer.service';
import { TradeBookPageController } from './trade-book-page.controller';
import { TradeBookImport, TradeBookImportLog } from './trade-book.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([TradeBookImport, TradeBookImportLog]),
  ],
  controllers: [TradeBookPageController],
  providers: [TradeBookImporterService],
  exports: [TradeBookImporterService],
})
export class TradeBookModule {}
