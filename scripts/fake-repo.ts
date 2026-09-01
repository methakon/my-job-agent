/** FakeRepo — minimal in-memory stand-in for the TypeORM Repository surface
 * used by FnfTradingService + AstroMuhurtaService in this smoke test.
 *
 * It is deliberately loose internally (any[] storage, any params) so the smoke
 * harness can throw any entity shape at it; only the public surface is typed
 * enough to be usable. This is a throwaway smoke harness, not production code.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDoc = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWhere = any;

interface DeleteResult {
  affected: number;
  raw: unknown[];
}

class FakeRepo {
  private docs: AnyDoc[] = [];
  private seq = 1;

  async save(input: AnyDoc): Promise<AnyDoc>;
  async save(input: AnyDoc[]): Promise<AnyDoc[]>;
  async save(input: AnyDoc | AnyDoc[]): Promise<AnyDoc | AnyDoc[]> {
    if (Array.isArray(input)) {
      return Promise.all(input.map((doc) => this.saveOne(doc)));
    }
    return this.saveOne(input);
  }

  private async saveOne(doc: AnyDoc): Promise<AnyDoc> {
    const id = doc?.id ?? (this.seq++);
    doc.id = id;
    const existing = this.docs.find((d) => d?.id === id);
    if (existing) {
      Object.assign(existing, doc);
      return existing;
    }
    this.docs.push(doc);
    return doc;
  }

  create(partial: Partial<AnyDoc>): AnyDoc {
    const id = this.seq++;
    const doc: AnyDoc = Object.assign({ id }, partial);
    return doc;
  }

  async findOne(opts?: { where?: AnyWhere; relations?: Record<string, boolean> }): Promise<AnyDoc | null> {
    if (!opts || opts.where == null) return null;
    return this.findByWhere(opts.where) ?? null;
  }

  async find(opts?: {
    where?: AnyWhere;
    order?: Record<string, 'ASC' | 'DESC'>;
    take?: number;
  }): Promise<AnyDoc[]> {
    let out: AnyDoc[];
    if (opts?.where) {
      out = this.docs.filter((d) => this.makePredicate(opts.where)(d));
    } else {
      out = [...this.docs];
    }
    if (opts?.order) {
      const [[key, dir]] = Object.entries(opts.order);
      out = [...out].sort((a, b) => {
        const av = a?.[key];
        const bv = b?.[key];
        if (av === bv) return 0;
        return dir === 'ASC' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
      });
    }
    if (opts?.take != null) out = out.slice(0, opts.take);
    return out;
  }

  createQueryBuilder(alias?: string): {
    select(columns: string | string[], selectedAlias?: string): {
      getRawMany<O = unknown>(): Promise<O[]>;
    };
  } {
    const self = this;
    return {
      select(rawCols: string | string[], selectedAlias?: string) {
        const cols = Array.isArray(rawCols) ? rawCols : [rawCols];
        const label = selectedAlias ?? alias ?? 'x';
        // Normalize the selected columns to (propertyKey, label) pairs.
        // TypeORM syntax we actually see in the smoke path:
        //   .select('DISTINCT s.instrument', 'instrument')
        //   -> property key = 'instrument', alias label = 'instrument'
        const parsed = cols.map((raw) => {
          const s = (raw || '').trim();
          if (/^DISTINCT\s+/i.test(s)) {
            const inner = s.replace(/^DISTINCT\s+/i, '').trim();
            const dotIdx = inner.lastIndexOf('.');
            const prop = dotIdx >= 0 ? inner.slice(dotIdx + 1) : inner;
            return { prop, label };
          }
          const dotIdx = s.lastIndexOf('.');
          const prop = dotIdx >= 0 ? s.slice(dotIdx + 1) : s;
          return { prop, label: prop };
        });

        return {
          async getRawMany<O = unknown>(): Promise<O[]> {
            const seen = new Set<string>();
            const out: Record<string, unknown>[] = [];
            for (const d of self.docs) {
              const key = parsed.map((p) => String(d?.[p.prop] ?? '')).join('\0');
              if (seen.has(key)) continue;
              seen.add(key);
              const row: Record<string, unknown> = {};
              parsed.forEach((p, i) => {
                row[`${label}_${i}`] = d?.[p.prop];
                row[p.label] = d?.[p.prop];
              });
              out.push(row);
            }
            return out as O[];
          },
        };
      },
    };
  }

  async delete(opts?: { where?: AnyWhere }): Promise<DeleteResult> {
    if (!opts?.where) {
      const n = this.docs.length;
      this.docs = [];
      return { affected: n, raw: [] };
    }
    const before = this.docs.length;
    const pred = this.makePredicate(opts.where);
    this.docs = this.docs.filter((d) => !pred(d));
    return { affected: before - this.docs.length, raw: [] };
  }

  async update(id: number | string, partial: Partial<AnyDoc>): Promise<AnyDoc | null> {
    const doc = this.docs.find((d) => d?.id === id);
    if (!doc) return null;
    Object.assign(doc, partial);
    return doc;
  }

  private findByWhere(where: AnyWhere): AnyDoc | null {
    return this.docs.find((d) => this.makePredicate(where)(d)) ?? null;
  }

  private makePredicate(where: AnyWhere): (doc: AnyDoc) => boolean {
    return (doc) => {
      for (const [k, v] of Object.entries(where)) {
        const dv = doc?.[k];
        if (v && typeof v === 'object' && '_type' in v && '_value' in v) {
          const operand = (v as { _type: string; _value: unknown })._value;
          if (v._type === 'isNull') {
            if (operand === true ? dv !== null && dv !== undefined : dv === null || dv === undefined) return false;
          } else if (v._type === 'lessThanOrEqual') {
            if (dv == null || operand == null || dv > operand) return false;
          } else if (v._type === 'lessThan') {
            if (dv == null || operand == null || dv >= operand) return false;
          } else if (v._type === 'moreThanOrEqual') {
            if (dv == null || operand == null || dv < operand) return false;
          } else if (v._type === 'moreThan') {
            if (dv == null || operand == null || dv <= operand) return false;
          } else if (dv !== operand) {
            return false;
          }
        } else if (v instanceof Date) {
          if (!(dv instanceof Date) || dv.getTime() !== v.getTime()) return false;
        } else if (v && typeof v === 'object' && !Array.isArray(v)) {
          if (!this.makePredicate(v as AnyWhere)(dv || {})) return false;
        } else if (dv !== v) {
          return false;
        }
      }
      return true;
    };
  }
}

export { FakeRepo };
export type { DeleteResult };
