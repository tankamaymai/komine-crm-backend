import {
  isReleaseDayReached,
  releaseDateInYear,
  shiftDateToReleaseTiming,
} from '../../src/collective-burials/releaseTiming';
import {
  jurinValidityYears,
  nokotsudoValidityYears,
  parseNotedCollectiveYear,
  parseSingleBodyCount,
} from '../../src/collective-burials/enrollmentRules';

describe('合祀の一斉解約日', () => {
  it('お盆は8月13日、10月は10月1日', () => {
    expect(releaseDateInYear(2035, 'obon').toISOString()).toBe('2035-08-13T00:00:00.000Z');
    expect(releaseDateInYear(2035, 'october').toISOString()).toBe('2035-10-01T00:00:00.000Z');
  });

  it('年は残して月日だけ揃える', () => {
    const shifted = shiftDateToReleaseTiming(new Date('2048-03-14T00:00:00Z'), 'october');
    expect(shifted.toISOString()).toBe('2048-10-01T00:00:00.000Z');
  });

  it('今年の解約日より前は、まだ解約しない', () => {
    expect(isReleaseDayReached(new Date('2026-09-27T00:00:00Z'), 'october')).toBe(false);
    expect(isReleaseDayReached(new Date('2026-10-01T00:00:00Z'), 'october')).toBe(true);
    expect(isReleaseDayReached(new Date('2026-08-12T00:00:00Z'), 'obon')).toBe(false);
    expect(isReleaseDayReached(new Date('2026-08-13T00:00:00Z'), 'obon')).toBe(true);
  });
});

describe('合祀年のルール', () => {
  it('納骨堂は契約日で7年・33年・13年', () => {
    expect(nokotsudoValidityYears(new Date('2015-06-30T00:00:00Z'))).toBe(7);
    expect(nokotsudoValidityYears(new Date('2015-07-01T00:00:00Z'))).toBe(33);
    expect(nokotsudoValidityYears(new Date('2021-03-31T00:00:00Z'))).toBe(33);
    expect(nokotsudoValidityYears(new Date('2021-04-01T00:00:00Z'))).toBe(13);
  });

  it('樹林は2014年6月30日まで13年、その後は33年', () => {
    expect(jurinValidityYears(new Date('2014-06-30T00:00:00Z'))).toBe(13);
    expect(jurinValidityYears(new Date('2014-07-01T00:00:00Z'))).toBe(33);
  });

  it('備考の体数と合祀年を読む', () => {
    expect(parseSingleBodyCount('３体\nB-15')).toBe(3);
    expect(parseSingleBodyCount('2体+ペット2')).toBeNull();
    expect(parseNotedCollectiveYear('2029年 合祀')).toBe(2029);
  });
});
