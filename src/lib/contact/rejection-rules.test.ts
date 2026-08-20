import { describe, expect, it } from 'vitest';
import { REAL_LINK_SETS } from './fixtures/real-link-sets.js';
import { extractEmailsWithRejections } from './email.js';
import { REJECTION_RULES, rejectionRule } from './rejection-rules.js';
import { extractSocialsWithRejections } from './social.js';
import type { RejectionRuleId } from './types.js';
import { extractWebsiteWithRejections } from './website.js';

/**
 * Every rule id, listed once. `Record<RejectionRuleId, true>` makes this a
 * compile error the moment a rule is added to the union without being
 * documented — the acceptance criterion is a list that stays complete.
 */
const ALL_RULES: Record<RejectionRuleId, true> = {
  email_empty_mailto: true,
  email_invalid_syntax: true,
  email_invalid_domain: true,
  email_asset_filename: true,
  email_placeholder: true,
  email_noreply_mailbox: true,
  email_directory_domain: true,
  email_source_owned: true,
  email_tracking_address: true,
  website_unparseable: true,
  website_source_domain: true,
  website_source_sibling: true,
  website_known_directory: true,
  website_social_network: true,
  website_share_intent: true,
  website_vendor_credit: true,
  website_advertising_banner: true,
  website_infrastructure: true,
  website_asset_or_document: true,
  website_ambiguous_link_farm: true,
  social_share_intent: true,
  social_platform_root: true,
  social_not_a_profile: true,
  social_directory_profile: true,
  social_no_stable_identifier: true,
};

describe('the documented rejection rules', () => {
  it('documents every rule id exactly once', () => {
    const documented = REJECTION_RULES.map((rule) => rule.id).sort();
    expect(documented).toEqual(Object.keys(ALL_RULES).sort());
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('gives every rule a channel, a summary and a real example', () => {
    for (const rule of REJECTION_RULES) {
      expect(['email', 'website', 'social']).toContain(rule.channel);
      expect(rule.summary.length).toBeGreaterThan(20);
      expect(rule.example.length).toBeGreaterThan(5);
    }
  });

  it('looks a rule up for the validation report', () => {
    expect(rejectionRule('website_vendor_credit').channel).toBe('website');
    expect(() => rejectionRule('nope' as RejectionRuleId)).toThrow(/Unknown rejection rule/);
  });

  it('reports only documented rules for every captured page', () => {
    const documented = new Set(REJECTION_RULES.map((rule) => rule.id));
    for (const set of REAL_LINK_SETS) {
      const hrefs = set.links.map((link) => link.href);
      const reported = [
        ...extractWebsiteWithRejections(set.links, { sourceDomain: set.sourceDomain }).rejected,
        ...extractSocialsWithRejections(set.links, { sourceDomain: set.sourceDomain }).rejected,
        ...extractEmailsWithRejections('', { sourceDomain: set.sourceDomain, links: hrefs })
          .rejected,
      ];
      for (const rejection of reported) {
        expect(documented.has(rejection.rule)).toBe(true);
      }
    }
  });
});
