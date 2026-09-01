import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Explicit NSE option contract metadata. Symbols are supplied by FYERS/configuration, never guessed. */
@Entity('fnf_option_contracts')
@Index('uq_fnf_option_contracts_symbol', ['symbol'], { unique: true })
@Index('idx_fnf_option_contracts_chain', ['underlying', 'expiry', 'optionType', 'strike'])
export class FnfOptionContract {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 96 })
  symbol: string;

  @Column({ type: 'varchar', length: 32 })
  underlying: string;

  @Column({ type: 'date' })
  expiry: string;

  @Column({ type: 'decimal', precision: 14, scale: 4 })
  strike: number;

  @Column({ type: 'varchar', length: 2 })
  optionType: string;

  @Column({ type: 'int' })
  lotSize: number;

  @Column({ type: 'decimal', precision: 10, scale: 4, default: 0.05 })
  tickSize: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
