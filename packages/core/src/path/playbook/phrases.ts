import type { VentureStage } from '@foundry/contracts';

/** What a criterion produces, as something they have or still miss ("a test with a pass line"). */
export const CRITERION_NAMES: Readonly<Record<string, string>> = {
  'idea-one-page': 'the idea on one page',
  'idea-who-pays': 'who uses it and who pays',
  'idea-biggest-risk': 'the thing most likely to sink it',
  'discovery-ten-conversations': 'ten customer talks',
  'discovery-pattern': 'the pattern in what people said',
  'discovery-alternatives': 'what you compete with',
  'discovery-first-group': 'the one group to serve first',
  'validation-promise': 'a promise in one clear sentence',
  'validation-test-card': 'a test with a pass line',
  'validation-commitment': 'money or a signature from strangers',
  'validation-decision': 'a decision from the result',
  'model-canvas': 'the Business Model Canvas',
  'model-price': 'a price tried on buyers',
  'model-unit-economics': 'what one sale leaves over',
  'model-money-needed': 'the money to get going',
  'sales-ten-customers': 'ten customers who are not friends',
  'sales-channel': 'one channel that is ahead',
  'sales-metric': 'one number that runs the week',
  'sales-pitch': 'the pitch',
  'growth-customers-stay': 'customers who come back',
  'growth-repeatable': 'sales that repeat without you',
  'growth-plan': 'the business plan',
  'transition-ready': 'the readiness check',
  'transition-next-home': 'the next home',
  'transition-handover': 'a handover',
};

/** What a venture at a stage is doing, said of it ("proving someone wants it"). */
export const STAGE_DOING: Readonly<Record<VentureStage, string>> = {
  idea: 'pinning down the idea',
  discovery: 'talking to customers',
  validation: 'proving someone wants it',
  business_model: 'making the numbers work',
  commercialization: 'winning first customers',
  growth: 'growing what works',
  transition: 'getting ready to leave the Ain Center',
};
