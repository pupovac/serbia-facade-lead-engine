/**
 * The matching rules, one test per rule and one per guard.
 *
 * The cases are the ones this market actually produces: the same fasader
 * spelled four ways across four directories, two businesses with the same
 * surname in two cities, a sole trader on a gmail address, a listing portal's
 * own contact address printed on every entry, and a call-centre number that
 * five unrelated companies publish. A rule that only survives the happy path is
 * a rule that ships duplicates.
 */
import { describe, expect, it } from 'vitest';
import { leadRecord } from './from-db.js';
import { scoreMatch } from './score.js';
import { STRUCTURAL_QUARANTINE, staticQuarantine } from './quarantine.js';
import { BANDS } from './weights.js';
import type { LeadRecord, SignalKind } from './types.js';

function kinds(match: ReturnType<typeof scoreMatch>): SignalKind[] {
  return match.signals.map((signal) => signal.kind);
}

/** Both directions must agree — a pair has no left and right. */
function bothWays(a: LeadRecord, b: LeadRecord, options?: Parameters<typeof scoreMatch>[2]) {
  const forward = scoreMatch(a, b, options);
  const backward = scoreMatch(b, a, options);
  expect(backward.decision).toBe(forward.decision);
  expect(backward.score).toBe(forward.score);
  return forward;
}

/* -------------------------------------------------------------------------- */
/* Rule 1 — the shared phone                                                  */
/* -------------------------------------------------------------------------- */

describe('rule 1: a shared normalized phone is decisive', () => {
  it('merges two records that share a number, however differently they are named', () => {
    const match = bothWays(
      leadRecord({
        name: 'Fasader Plus d.o.o.',
        cityId: 'novi-sad',
        phones: ['+381641112233'],
      }),
      leadRecord({
        name: 'Termoizolacija NS',
        cityId: 'novi-sad',
        phones: ['+381641112233'],
      }),
    );

    expect(match.decision).toBe('merge');
    expect(match.topSignal).toBe('phone');
    expect(match.topSignalValue).toBe('+381641112233');
    expect(match.score).toBeGreaterThanOrEqual(BANDS.merge.min);
  });

  it('merges two locations of one business even though the cities disagree', () => {
    const match = bothWays(
      leadRecord({ name: 'Gradnja Komerc', cityId: 'beograd', phones: ['+381641112233'] }),
      leadRecord({ name: 'Gradnja Komerc', cityId: 'novi-sad', phones: ['+381641112233'] }),
    );

    // One company, one phone, one sales call. The second city is not lost —
    // it is recorded as a field conflict on the merged lead.
    expect(match.decision).toBe('merge');
    expect(kinds(match)).toContain('city_conflict');
  });

  it('ignores a number only one side publishes', () => {
    const match = bothWays(
      leadRecord({ name: 'Fasade Novak', cityId: 'nis', phones: ['+381641112233'] }),
      leadRecord({ name: 'Izolacija Dunav', cityId: 'nis', phones: ['+381649998877'] }),
    );
    expect(match.decision).toBe('distinct');
  });
});

/* -------------------------------------------------------------------------- */
/* Rules 2 and 3 — domain and email                                           */
/* -------------------------------------------------------------------------- */

describe('rules 2 and 3: website domain and email are decisive', () => {
  it('merges on a shared registrable domain', () => {
    const match = bothWays(
      leadRecord({ name: 'Fasader Plus', cityId: 'novi-sad', websiteDomains: ['fasaderplus.rs'] }),
      leadRecord({
        name: 'FASADER PLUS DOO',
        cityId: 'novi-sad',
        websiteDomains: ['fasaderplus.rs'],
      }),
    );
    expect(match.decision).toBe('merge');
    expect(match.topSignal).toBe('website_domain');
  });

  it('merges on a shared business email', () => {
    const match = bothWays(
      leadRecord({ name: 'Gradjevinski centar Milic', emails: ['milic@gcm.rs'] }),
      leadRecord({ name: 'Građevinski centar Milić', emails: ['milic@gcm.rs'] }),
    );
    expect(match.decision).toBe('merge');
    expect(match.topSignal).toBe('email');
  });

  it('still merges on a free-provider address — a gmail mailbox is one business', () => {
    // Most fasaderi are sole traders and most sole traders are on gmail.
    // The *domain* identifies nothing; the address identifies a person.
    const match = bothWays(
      leadRecord({ name: 'Fasade Petrovic', emails: ['fasade.petrovic@gmail.com'] }),
      leadRecord({ name: 'SZR Petrovic', emails: ['fasade.petrovic@gmail.com'] }),
      { quarantine: STRUCTURAL_QUARANTINE },
    );
    expect(match.decision).toBe('merge');
  });

  it('refuses to be decided by a directory-owned address', () => {
    // Two unrelated businesses on one listing portal, which prints its own
    // contact address on every entry. Not the same business, and not a
    // question worth a reviewer's time either — the `shared_identifiers` row
    // is where that address gets looked at.
    const match = bothWays(
      leadRecord({ name: 'Fasade Jovanovic', cityId: 'beograd', emails: ['info@011info.com'] }),
      leadRecord({ name: 'Stovariste Dunav', cityId: 'beograd', emails: ['info@011info.com'] }),
      { quarantine: STRUCTURAL_QUARANTINE },
    );
    expect(match.decision).toBe('distinct');
    expect(kinds(match)).toContain('quarantined_identifier');
    expect(kinds(match)).not.toContain('email');
  });

  it('refuses to be decided by a listing portal domain', () => {
    const match = bothWays(
      leadRecord({
        name: 'Fasade Jovanovic',
        cityId: 'beograd',
        websiteDomains: ['portal-srbija.com'],
      }),
      leadRecord({
        name: 'Stovariste Dunav',
        cityId: 'beograd',
        websiteDomains: ['portal-srbija.com'],
      }),
      { quarantine: STRUCTURAL_QUARANTINE },
    );
    expect(match.decision).toBe('distinct');
    expect(match.score).toBeLessThan(BANDS.merge.min);
  });

  it('does send a quarantined signal to review when something else agrees', () => {
    // Same portal domain, but the names match in one city. Now the pair is a
    // real question, and the quarantine is why it is not merged outright.
    const match = bothWays(
      leadRecord({
        name: 'Fasade Jovanović',
        cityId: 'beograd',
        websiteDomains: ['portal-srbija.com'],
      }),
      leadRecord({
        name: 'Fasade Jovanovic',
        cityId: 'beograd',
        websiteDomains: ['portal-srbija.com'],
      }),
      { quarantine: STRUCTURAL_QUARANTINE },
    );
    expect(match.decision).toBe('review');
    expect(kinds(match)).toContain('quarantined_identifier');
  });
});

/* -------------------------------------------------------------------------- */
/* The state's own key                                                        */
/* -------------------------------------------------------------------------- */

describe('registration number', () => {
  it('merges two records registered under one maticni broj', () => {
    const match = bothWays(
      leadRecord({ name: 'Fasade Novak', registrationNumber: '20123456' }),
      leadRecord({ name: 'SZR Novak fasade', registrationNumber: '20123456' }),
    );
    expect(match.decision).toBe('merge');
    expect(match.topSignal).toBe('registration_number');
  });

  it('keeps two differently registered companies apart', () => {
    const match = bothWays(
      leadRecord({
        name: 'Fasader Plus',
        cityId: 'novi-sad',
        registrationNumber: '20123456',
      }),
      leadRecord({
        name: 'Fasader Plus',
        cityId: 'novi-sad',
        registrationNumber: '21999888',
      }),
    );
    expect(match.decision).toBe('distinct');
    expect(kinds(match)).toContain('registration_conflict');
  });

  it('sends a shared phone with conflicting registrations to a human', () => {
    // Two registered companies of one owner, on one line. Merging loses a
    // company; refusing ships a duplicate. Neither is ours to pick.
    const match = bothWays(
      leadRecord({
        name: 'Gradnja Komerc',
        cityId: 'cacak',
        phones: ['+381641112233'],
        registrationNumber: '20123456',
      }),
      leadRecord({
        name: 'Gradnja Komerc Trade',
        cityId: 'cacak',
        phones: ['+381641112233'],
        registrationNumber: '21999888',
      }),
    );
    expect(match.decision).toBe('review');
  });
});

/* -------------------------------------------------------------------------- */
/* Rule 4 — the name, which never decides alone                               */
/* -------------------------------------------------------------------------- */

describe('rule 4: name similarity plus city is strong, never decisive', () => {
  it('never merges on a name alone, however perfect the match', () => {
    const match = bothWays(
      leadRecord({ name: 'Fasade Petrović', cityId: 'nis', municipalityId: 'nis' }),
      leadRecord({ name: 'Fasade Petrovic', cityId: 'nis', municipalityId: 'nis' }),
    );
    expect(match.decision).toBe('review');
    expect(match.topSignal).toBe('name_city');
    expect(match.score).toBeLessThan(BANDS.merge.min);
    expect(match.score).toBeGreaterThanOrEqual(BANDS.review.min);
  });

  it('keeps the same name in two cities apart', () => {
    const match = bothWays(
      leadRecord({ name: 'Fasade Petrović', cityId: 'nis', municipalityId: 'nis' }),
      leadRecord({ name: 'Fasade Petrovic', cityId: 'novi-sad', municipalityId: 'novi-sad' }),
    );
    expect(match.decision).toBe('distinct');
    expect(kinds(match)).not.toContain('name_city');
  });

  it('merges a name match corroborated by a shared address', () => {
    const match = bothWays(
      leadRecord({
        name: 'Termo Fasade Marković',
        cityId: 'kragujevac',
        addressNormalized: 'kralja petra 12',
      }),
      leadRecord({
        name: 'Termofasade Markovic',
        cityId: 'kragujevac',
        addressNormalized: 'Kralja Petra 12',
      }),
    );
    expect(match.decision).toBe('merge');
    expect(match.topSignal).toBe('name_city');
    expect(kinds(match)).toContain('address');
  });

  it('merges a name match corroborated by an address two sources punctuate differently', () => {
    const match = bothWays(
      leadRecord({
        name: 'Mika Fasade',
        cityId: 'novi-sad',
        municipalityId: 'novi-sad',
        addressNormalized: 'Temerinska 12, 21000 Novi Sad',
      }),
      leadRecord({
        name: 'Mika Fasade doo',
        cityId: 'novi-sad',
        municipalityId: 'novi-sad',
        addressNormalized: 'Ul. Temerinska br. 12, 21000, Novi Sad',
      }),
    );
    expect(match.decision).toBe('merge');
    expect(kinds(match)).toContain('address');
  });

  it('will not let a neighbouring house number corroborate anything', () => {
    const match = bothWays(
      leadRecord({
        name: 'Mika Fasade',
        cityId: 'novi-sad',
        municipalityId: 'novi-sad',
        addressNormalized: 'Temerinska 12, Novi Sad',
      }),
      leadRecord({
        name: 'Mika Fasade doo',
        cityId: 'novi-sad',
        municipalityId: 'novi-sad',
        addressNormalized: 'Temerinska 12a, Novi Sad',
      }),
    );
    expect(match.decision).toBe('review');
    expect(kinds(match)).not.toContain('address');
  });

  it('will not let a street with no house number corroborate anything', () => {
    const match = bothWays(
      leadRecord({
        name: 'Mika Fasade',
        cityId: 'novi-sad',
        municipalityId: 'novi-sad',
        addressNormalized: 'Bulevar oslobođenja, Novi Sad',
      }),
      leadRecord({
        name: 'Mika Fasade doo',
        cityId: 'novi-sad',
        municipalityId: 'novi-sad',
        addressNormalized: 'Bulevar oslobodjenja 5, Novi Sad',
      }),
    );
    expect(match.decision).toBe('review');
    expect(kinds(match)).not.toContain('address');
  });

  it('merges a name match corroborated by a shared Facebook page', () => {
    const match = bothWays(
      leadRecord({
        name: 'Stovarište Gradnja',
        cityId: 'uzice',
        socialUrls: ['https://www.facebook.com/stovaristegradnja'],
      }),
      leadRecord({
        name: 'Stovariste Gradnja d.o.o.',
        cityId: 'uzice',
        socialUrls: ['https://www.facebook.com/stovaristegradnja'],
      }),
    );
    expect(match.decision).toBe('merge');
    expect(kinds(match)).toContain('social_profile');
  });

  it('merges a name match corroborated by two extensions of one switchboard', () => {
    const match = bothWays(
      leadRecord({ name: 'Izolacija Jovanović', cityId: 'beograd', phones: ['+381114445501'] }),
      leadRecord({ name: 'Izolacija Jovanovic PR', cityId: 'beograd', phones: ['+381114445502'] }),
    );
    expect(kinds(match)).toContain('phone_area_code');
    expect(match.decision).toBe('merge');
  });

  it('is not corroborated by a bare shared area code', () => {
    // Every business in Belgrade has an `011` number, and the name rule already
    // requires the same city. Sharing `011` adds nothing.
    const match = bothWays(
      leadRecord({ name: 'Izolacija Jovanović', cityId: 'beograd', phones: ['+381114445501'] }),
      leadRecord({ name: 'Izolacija Jovanovic PR', cityId: 'beograd', phones: ['+381117778899'] }),
    );
    expect(kinds(match)).toContain('phone_area_code');
    expect(match.decision).toBe('review');
  });

  it('is not corroborated by a shared mobile operator prefix', () => {
    // `064` says which operator sold the SIM. A quarter of Serbia would
    // "corroborate" every other lead if that counted.
    const match = bothWays(
      leadRecord({ name: 'Fasade Novak', cityId: 'nis', phones: ['+381641112233'] }),
      leadRecord({ name: 'Fasade Novak doo', cityId: 'nis', phones: ['+381649998877'] }),
    );
    expect(kinds(match)).not.toContain('phone_area_code');
    expect(match.decision).toBe('review');
  });

  it('counts two settlements of one municipality as the same place', () => {
    const match = bothWays(
      leadRecord({ name: 'Demit fasade Nikolić', cityId: 'zemun', municipalityId: 'beograd' }),
      leadRecord({
        name: 'Demit fasade Nikolic',
        cityId: 'novi-beograd',
        municipalityId: 'beograd',
      }),
    );
    expect(match.decision).toBe('review');
    expect(kinds(match)).toContain('name_city');
    expect(kinds(match)).not.toContain('city_conflict');
  });
});

/* -------------------------------------------------------------------------- */
/* Names that are close but not the same business                             */
/* -------------------------------------------------------------------------- */

describe('near-duplicate names that are two businesses', () => {
  it('keeps `Fasade Marković` and `Fasade Marko` apart in one city', () => {
    const match = bothWays(
      leadRecord({ name: 'Fasade Marković', cityId: 'kragujevac' }),
      leadRecord({ name: 'Fasade Marko', cityId: 'kragujevac' }),
    );
    expect(match.decision).toBe('distinct');
  });

  it('keeps a sub-threshold name pair apart even in one city', () => {
    const match = bothWays(
      leadRecord({ name: 'Stovariste Beton', cityId: 'beograd' }),
      leadRecord({ name: 'Stovariste Beton Plus', cityId: 'beograd' }),
    );
    expect(kinds(match)).toContain('name_weak');
    expect(match.decision).toBe('distinct');
  });

  it('sends a sub-threshold name at a shared address to a human', () => {
    const match = bothWays(
      leadRecord({
        name: 'Stovariste Beton',
        cityId: 'beograd',
        addressNormalized: 'bulevar oslobodjenja 5',
      }),
      leadRecord({
        name: 'Stovariste Beton Plus',
        cityId: 'beograd',
        addressNormalized: 'bulevar oslobodjenja 5',
      }),
    );
    expect(match.decision).toBe('review');
  });
});

/* -------------------------------------------------------------------------- */
/* The quarantine                                                             */
/* -------------------------------------------------------------------------- */

describe('the quarantine disarms a decisive signal', () => {
  const switchboard = '+381113334455';

  it('will not merge a pair whose only link is a quarantined number', () => {
    const match = bothWays(
      leadRecord({ name: 'Fasade Jovanović', cityId: 'beograd', phones: [switchboard] }),
      leadRecord({ name: 'Stovarište Dunav', cityId: 'beograd', phones: [switchboard] }),
      { quarantine: staticQuarantine([['phone', switchboard]]) },
    );

    // Not a review either: one switchboard on two hundred leads is twenty
    // thousand pairs, and a reviewer would be re-deciding what the guard
    // already decided. The record of that number is its `shared_identifiers` row.
    expect(match.decision).toBe('distinct');
    expect(kinds(match)).toContain('quarantined_identifier');
    expect(kinds(match)).not.toContain('phone');
    expect(match.score).toBeLessThan(BANDS.merge.min);
  });

  it('merges the same pair when the number is not quarantined', () => {
    const match = bothWays(
      leadRecord({ name: 'Fasade Jovanović', cityId: 'beograd', phones: [switchboard] }),
      leadRecord({ name: 'Stovarište Dunav', cityId: 'beograd', phones: [switchboard] }),
    );
    expect(match.decision).toBe('merge');
  });

  it('still merges when a second, untainted signal survives', () => {
    const match = bothWays(
      leadRecord({
        name: 'Fasade Jovanović',
        cityId: 'beograd',
        phones: [switchboard],
        emails: ['fasade.jovanovic@gmail.com'],
      }),
      leadRecord({
        name: 'Fasade Jovanovic PR',
        cityId: 'beograd',
        phones: [switchboard],
        emails: ['fasade.jovanovic@gmail.com'],
      }),
      { quarantine: staticQuarantine([['phone', switchboard]]) },
    );
    expect(match.decision).toBe('merge');
    expect(match.topSignal).toBe('email');
  });
});

/* -------------------------------------------------------------------------- */
/* The bands                                                                  */
/* -------------------------------------------------------------------------- */

describe('score bands', () => {
  it('puts every decision in its own band, with no overlap', () => {
    const merged = scoreMatch(
      leadRecord({ name: 'A', phones: ['+381641112233'] }),
      leadRecord({ name: 'B', phones: ['+381641112233'] }),
    );
    const review = scoreMatch(
      leadRecord({ name: 'Fasade Petrović', cityId: 'nis' }),
      leadRecord({ name: 'Fasade Petrovic', cityId: 'nis' }),
    );
    const distinct = scoreMatch(
      leadRecord({ name: 'Fasade Petrović', cityId: 'nis' }),
      leadRecord({ name: 'Stovarište Dunav', cityId: 'beograd' }),
    );

    expect(merged.score).toBeGreaterThanOrEqual(BANDS.merge.min);
    expect(review.score).toBeGreaterThanOrEqual(BANDS.review.min);
    expect(review.score).toBeLessThanOrEqual(BANDS.review.max);
    expect(distinct.score).toBeLessThanOrEqual(BANDS.distinct.max);
  });

  it('scores two unrelated records at nothing and explains why', () => {
    const match = scoreMatch(
      leadRecord({ name: 'Fasade Novak', cityId: 'nis' }),
      leadRecord({ name: 'Stovarište Dunav', cityId: 'nis' }),
    );
    expect(match.decision).toBe('distinct');
    expect(match.signals).toHaveLength(0);
    expect(match.score).toBe(0);
    expect(match.reason).toContain('no signal');
  });

  it('carries every signal it weighed, including the ones arguing against', () => {
    const match = scoreMatch(
      leadRecord({
        name: 'Gradnja Komerc',
        cityId: 'beograd',
        municipalityId: 'beograd',
        phones: ['+381641112233'],
      }),
      leadRecord({
        name: 'Gradnja Komerce',
        cityId: 'cacak',
        municipalityId: 'cacak',
        phones: ['+381641112233'],
      }),
    );
    expect(kinds(match)).toEqual(expect.arrayContaining(['phone', 'city_conflict']));
    expect(match.reason).toContain('decisive');
  });
});
