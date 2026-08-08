import { describe, expect, it } from 'vitest';
import { applyFilePatches } from './file-patches.js';

const FIXTURE = 'line1\nline2\nline3\nline4\nline5';

describe('applyFilePatches', () => {
  it('applies replace, insert, and delete in original-file coordinates', () => {
    const result = applyFilePatches(FIXTURE, [
      { operation: 'delete', startLine: 4, endLine: 5 },
      { operation: 'replace', startLine: 2, content: 'patched2' },
      { operation: 'insert', startLine: 3, content: 'inserted' },
    ]);

    expect(result).toEqual({ ok: true, content: 'line1\npatched2\ninserted\nline3' });
  });

  it('allows insert at lineCount + 1', () => {
    expect(
      applyFilePatches(FIXTURE, [{ operation: 'insert', startLine: 6, content: 'line6' }]),
    ).toEqual({ ok: true, content: `${FIXTURE}\nline6` });
  });

  it('preserves trailing newlines', () => {
    expect(
      applyFilePatches('line1\nline2\n', [
        { operation: 'replace', startLine: 2, content: 'patched' },
      ]),
    ).toEqual({ ok: true, content: 'line1\npatched\n' });
  });

  it('allows multiple inserts at the same original line', () => {
    expect(
      applyFilePatches(FIXTURE, [
        { operation: 'insert', startLine: 2, content: 'first' },
        { operation: 'insert', startLine: 2, content: 'second' },
      ]),
    ).toEqual({ ok: true, content: 'line1\nsecond\nfirst\nline2\nline3\nline4\nline5' });
  });

  it('rejects replace and insert patches without content', () => {
    for (const operation of ['replace', 'insert'] as const) {
      expect(applyFilePatches(FIXTURE, [{ operation, startLine: 2 }])).toEqual({
        ok: false,
        error: `Invalid patch (${operation}): content is required`,
      });
    }
  });

  it('rejects invalid bounds', () => {
    expect(
      applyFilePatches(FIXTURE, [{ operation: 'replace', startLine: 0, content: 'x' }]),
    ).toEqual({
      ok: false,
      error: 'Invalid patch (replace): startLine 0 must be an integer >= 1',
    });
    expect(applyFilePatches(FIXTURE, [{ operation: 'delete', startLine: 6 }])).toEqual({
      ok: false,
      error: 'Invalid patch (delete): startLine 6 exceeds file length (5 lines)',
    });
  });

  it('rejects overlapping patch ranges', () => {
    expect(
      applyFilePatches(FIXTURE, [
        { operation: 'delete', startLine: 1, endLine: 5 },
        { operation: 'replace', startLine: 5, content: 'ghost' },
      ]),
    ).toEqual({
      ok: false,
      error:
        'Invalid patch set: delete at lines 1-5 overlaps replace at lines 5-5; line numbers refer to the original file content and patch ranges must not overlap',
    });
  });
});
