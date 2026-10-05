import { MAX_DOCUMENT_BYTES } from '@foundry/contracts';
import { describe, expect, it } from 'vitest';

import { fileRejection, validateUploadFiles } from './upload-validation';

function file(name: string, size: number, type = ''): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('fileRejection', () => {
  it('accepts supported types by MIME type or extension', () => {
    expect(fileRejection(file('plan.pdf', 1000, 'application/pdf'))).toBeNull();
    expect(fileRejection(file('notes.md', 1000))).toBeNull();
    expect(fileRejection(file('NOTES.TXT', 1000))).toBeNull();
    expect(
      fileRejection(
        file('deck.docx', 1000, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      ),
    ).toBeNull();
  });

  it('rejects unsupported types', () => {
    expect(fileRejection(file('photo.png', 1000, 'image/png'))?.code).toBe('unsupported_type');
    expect(fileRejection(file('legacy.doc', 1000, 'application/msword'))?.code).toBe('unsupported_type');
    expect(fileRejection(file('archive', 1000))?.code).toBe('unsupported_type');
  });

  it('rejects empty and oversized files with the size in the message', () => {
    expect(fileRejection(file('empty.txt', 0))?.code).toBe('empty');
    const big = fileRejection(file('big.pdf', MAX_DOCUMENT_BYTES + 1, 'application/pdf'));
    expect(big?.code).toBe('too_large');
    expect(big?.message).toBe('This file is 10.1 MB. The limit is 10 MB.');
    expect(fileRejection(file('edge.pdf', MAX_DOCUMENT_BYTES, 'application/pdf'))).toBeNull();
  });

  it('rejects names the API would refuse', () => {
    expect(fileRejection(file(`${'a'.repeat(201)}.md`, 10))?.code).toBe('invalid_name');
    expect(fileRejection(file('   ', 10))?.code).toBe('invalid_name');
  });
});

describe('validateUploadFiles', () => {
  it('splits a selection into accepted and rejected files', () => {
    const result = validateUploadFiles([
      file('plan.pdf', 2000, 'application/pdf'),
      file('photo.jpg', 2000, 'image/jpeg'),
      file('notes.md', 300),
    ]);
    expect(result.accepted.map((c) => [c.file.name, c.contentType])).toEqual([
      ['plan.pdf', 'application/pdf'],
      ['notes.md', 'text/markdown'],
    ]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ name: 'photo.jpg', code: 'unsupported_type' }),
    ]);
  });

  it('rejects duplicates within the selection and against existing documents (case-insensitive)', () => {
    const result = validateUploadFiles(
      [
        file('Plan.pdf', 10, 'application/pdf'),
        file('plan.PDF', 10, 'application/pdf'),
        file('memo.txt', 10),
      ],
      {
        existingNames: ['memo.txt'],
      },
    );
    expect(result.accepted.map((c) => c.file.name)).toEqual(['Plan.pdf']);
    expect(result.rejected.map((r) => [r.name, r.code])).toEqual([
      ['plan.PDF', 'duplicate'],
      ['memo.txt', 'duplicate'],
    ]);
  });

  it('caps the batch size', () => {
    const files = Array.from({ length: 4 }, (_, i) => file(`n${i}.txt`, 10));
    const result = validateUploadFiles(files, { maxFiles: 3 });
    expect(result.accepted).toHaveLength(3);
    expect(result.rejected).toEqual([expect.objectContaining({ name: 'n3.txt', code: 'too_many' })]);
  });

  it('honours a custom size limit', () => {
    const result = validateUploadFiles([file('a.txt', 2048)], { maxBytes: 1024 });
    expect(result.rejected[0]?.code).toBe('too_large');
  });
});
