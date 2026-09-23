import {
  formatPermitPlotLabel,
  joinPermitPlotNumbers,
} from '../../../src/plots/services/permitPlotNumbers';

describe('許可証に載せる区画番号', () => {
  it('地区と番号を台帳と同じ並びにする', () => {
    expect(
      formatPermitPlotLabel({ areaName: '吉相', displayNumber: '10', plotNumber: 'G-10' })
    ).toBe('吉相 10');
  });

  it('表示用の番号が無ければ区画番号を使う', () => {
    expect(formatPermitPlotLabel({ areaName: 'A', displayNumber: null, plotNumber: 'A-2' })).toBe(
      'A A-2'
    );
  });

  it('複数区画は番号順で1つにまとめ、同じ番号は繰り返さない', () => {
    expect(
      joinPermitPlotNumbers([
        { areaName: 'B', displayNumber: '2', plotNumber: 'B-2' },
        { areaName: 'A', displayNumber: '10', plotNumber: 'A-10' },
        { areaName: 'A', displayNumber: '2', plotNumber: 'A-2' },
        { areaName: 'A', displayNumber: '2', plotNumber: 'A-2' },
      ])
    ).toBe('A 2、A 10、B 2');
  });
});
