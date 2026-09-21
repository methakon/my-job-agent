/**
 * JA-042 — Browser Field Mapping
 *
 * doneWhen: "Known forms populate reliably and changed forms trigger re-validation."
 */

import { Injectable } from '@nestjs/common';

export type ValidationStatus = 'valid' | 'changed' | 'unknown' | 'partial';

export interface FieldMapping {
  id?: string;
  portalName: string;
  formSignature: string;
  fieldMappings: Record<string, string>;
  lastValidated: string;
  validationStatus: ValidationStatus;
  mappingCount: number;
}

export interface FormSignature {
  portalName: string;
  formId?: string;
  fieldNames: string[];
  fieldTypes: Record<string, string>;
  actionUrl?: string;
  version?: string;
}

export interface MappingResult {
  mapped: Record<string, string>;
  unmapped: string[];
  signature: string;
  status: 'valid' | 'changed' | 'partial' | 'unknown';
  notes: string;
}

@Injectable()
export class BrowserFieldMappingService {
  constructor() {
    this.mappings = new Map<string, FieldMapping>();
  }

  private mappings: Map<string, FieldMapping>;

  generateSignature(form: FormSignature): string {
    const parts = [form.portalName, form.formId || 'default', ...form.fieldNames.sort(), form.actionUrl || ''];
    return parts.filter(Boolean).join('|');
  }

  learnMapping(signature: string, mappings: Record<string, string>, portalName: string): FieldMapping {
    const now = new Date().toISOString();
    const mapping: FieldMapping = {
      portalName, formSignature: signature, fieldMappings: mappings,
      lastValidated: now, validationStatus: 'valid', mappingCount: Object.keys(mappings).length,
    };
    this.mappings.set(signature, mapping);
    return mapping;
  }

  getMapping(signature: string): FieldMapping | undefined {
    return this.mappings.get(signature);
  }

  validateForm(currentForm: FormSignature, knownSignature: string): MappingResult {
    const known = this.mappings.get(knownSignature);
    if (!known) {
      return { mapped: {}, unmapped: currentForm.fieldNames, signature: this.generateSignature(currentForm), status: 'unknown', notes: 'No known mapping for this form' };
    }
    const currentSig = this.generateSignature(currentForm);
    const unmapped: string[] = [];
    const mapped: Record<string, string> = {};
    for (const fn of currentForm.fieldNames) {
      if (known.fieldMappings[fn]) mapped[fn] = known.fieldMappings[fn];
      else unmapped.push(fn);
    }
    let status: 'valid' | 'changed' | 'partial' | 'unknown' = 'valid';
    let notes = 'All fields mapped';
    if (currentSig !== knownSignature) { status = 'changed'; notes = 'Form structure changed — re-validation recommended'; }
    else if (unmapped.length > 0) { status = 'partial'; notes = `${unmapped.length} fields unmapped`; }
    return { mapped, unmapped, signature: currentSig, status, notes };
  }

  listMappings(): FieldMapping[] { return Array.from(this.mappings.values()); }
  getMappingCount(): number { return this.mappings.size; }
}
