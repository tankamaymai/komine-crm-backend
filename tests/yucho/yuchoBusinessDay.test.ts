import {
  getJapaneseHolidays,
  getYuchoClosedReason,
  isExistingDate,
} from '../../src/yucho/yuchoBusinessDay';

describe('yuchoBusinessDay', () => {
  it('lists the 2026 national holidays including substitute and citizens holidays', () => {
    expect([...getJapaneseHolidays(2026)].sort()).toEqual(
      [
        '1-1',
        '1-12',
        '2-11',
        '2-23',
        '3-20',
        '4-29',
        '5-3',
        '5-4',
        '5-5',
        '5-6',
        '7-20',
        '8-11',
        '9-21',
        '9-22',
        '9-23',
        '10-12',
        '11-3',
        '11-23',
      ].sort()
    );
  });

  it('moves a Sunday holiday to the next weekday (2025)', () => {
    const holidays = getJapaneseHolidays(2025);
    expect(holidays.has('2-24')).toBe(true);
    expect(holidays.has('5-6')).toBe(true);
    expect(holidays.has('11-24')).toBe(true);
  });

  it('tells why the bank is closed', () => {
    expect(getYuchoClosedReason(2026, 5, 16)).toBe('weekend');
    expect(getYuchoClosedReason(2026, 5, 6)).toBe('holiday');
    expect(getYuchoClosedReason(2026, 12, 31)).toBe('year_end');
    expect(getYuchoClosedReason(2027, 1, 4)).toBeNull();
    expect(getYuchoClosedReason(2026, 10, 15)).toBeNull();
    expect(getYuchoClosedReason(2026, 10, 16)).toBeNull();
  });

  it('rejects days that do not exist', () => {
    expect(isExistingDate(2026, 2, 28)).toBe(true);
    expect(isExistingDate(2026, 2, 29)).toBe(false);
    expect(isExistingDate(2028, 2, 29)).toBe(true);
    expect(isExistingDate(2026, 4, 31)).toBe(false);
  });
});
