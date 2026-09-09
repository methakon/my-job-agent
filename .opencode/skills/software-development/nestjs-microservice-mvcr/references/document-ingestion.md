# Document ingestion in NestJS (upload + parse PDF/DOCX/XLSX/images)

Working recipe from the MyLife `mylife-ai` service (2026-08-22). Use when a
service must accept user file uploads in chat (birth charts, spreadsheets,
scans) and extract text.

## Packages

```
npm i multer pdf-parse mammoth xlsx tesseract.js @nestjs/platform-express
npm i -D @types/multer
```

## Controller: FileInterceptor + mime allowlist

```ts
@Post('upload')
@UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
async upload(@Body('userId') userId: string, @UploadedFile() file?: Express.Multer.File)
```

- Keep an explicit `ALLOWED_MIME` array and reject anything else with a
  400 — never trust extension alone.
- Multer memory storage gives `file.buffer`; parse in-process, store only
  the extracted text (longtext column) plus fileName/mimeType/kind/
  detected language/charCount.

## Per-kind extraction

- **PDF**: `pdf-parse`
- **DOCX**: `mammoth.extractRawText({ buffer })`
- **XLSX/XLS/CSV**: `xlsx` — read workbook from buffer, `sheet_to_csv` per
  sheet, prefix each block with `# Sheet: <name>`
- **Images** (scanned docs): `tesseract.js` `createWorker(['eng','hin','ben','ell','san'])`
  for English/Hindi/Bengali/Greek/Sanskrit old documents;
  always `worker.terminate()` in a finally block
- **Plain text**: utf8 as-is

Return a clear BadRequestException when extraction yields empty text
("scanned document may need a clearer image") instead of storing blanks.

## Pitfalls

- **pdf-parse import**: `(await import('pdf-parse')).default` fails tsc on
  current typings ("Property 'default' does not exist"). Handle both shapes:
  ```ts
  const m = (await import('pdf-parse')) as unknown as {
    default?: (b: Buffer) => Promise<{ text: string }>;
    (b: Buffer): Promise<{ text: string }>;
  };
  const fn = m.default ?? m;
  ```
- **Language detection without a service**: script-range regexes on the
  first ~4000 chars are enough to tag bn/hi/el/ar/zh/ja/ko/ru/en — store
  the tag so downstream LLM answers can reply in the document's language.
- **Grounded Q&A over extracted text**: system-prompt rule "answer ONLY
  from the provided text, quote passages, say when the answer is absent";
  keep a keyword-line-match fallback for missing API key / API failure.
