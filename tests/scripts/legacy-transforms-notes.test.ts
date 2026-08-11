import { appendNoteIfMissing, mergeNoteParts } from '../../scripts/legacy-migration/transforms';

describe('mergeNoteParts / appendNoteIfMissing（碑文→備考統合）', () => {
  describe('mergeNoteParts', () => {
    it('note と grave_mei を改行結合する', () => {
      expect(mergeNoteParts('備考A', '碑文B')).toBe('備考A\n碑文B');
    });

    it('空・null は除外する', () => {
      expect(mergeNoteParts(null, '碑文のみ', '', '  ')).toBe('碑文のみ');
      expect(mergeNoteParts(null, undefined, '')).toBeNull();
    });

    it('完全一致の重複は除去する', () => {
      expect(mergeNoteParts('同じ', '同じ')).toBe('同じ');
    });
  });

  describe('appendNoteIfMissing', () => {
    it('空の備考へ碑文を入れる', () => {
      expect(appendNoteIfMissing(null, '期限付き解約者')).toBe('期限付き解約者');
    });

    it('既存備考へ改行追記する', () => {
      expect(appendNoteIfMissing('既存メモ', '碑文')).toBe('既存メモ\n碑文');
    });

    it('既に同じ行があれば冪等にスキップする', () => {
      expect(appendNoteIfMissing('既存\n碑文', '碑文')).toBe('既存\n碑文');
      expect(appendNoteIfMissing('碑文', '碑文')).toBe('碑文');
    });

    it('碑文が空なら既存を維持する', () => {
      expect(appendNoteIfMissing('既存', null)).toBe('既存');
      expect(appendNoteIfMissing(null, null)).toBeNull();
    });
  });
});
