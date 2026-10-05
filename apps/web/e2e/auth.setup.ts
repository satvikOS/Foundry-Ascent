import { test as setup } from '@playwright/test';

import {
  ensureAuthDir,
  FOUNDER_NAME,
  FOUNDER_STATE,
  issueAccessCodeViaApi,
  OWNER_STATE,
  ownerAccessCode,
  signIn,
} from './support/fixtures';

/**
 * Signs in once as the platform owner and once as the seeded founder, and saves both browser states for
 * the accessibility and mobile checks. The founder's code is issued through the admin API here; the
 * journey spec covers issuing one through the admin UI.
 */
setup('owner and founder sessions', async ({ page }) => {
  ensureAuthDir();
  await signIn(page, ownerAccessCode());
  await page.context().storageState({ path: OWNER_STATE });

  const founderCode = await issueAccessCodeViaApi(page.request, FOUNDER_NAME);
  // Drop the owner's cookie without revoking it (the saved owner state stays valid), then sign in as the founder.
  await page.context().clearCookies();
  await signIn(page, founderCode);
  await page.context().storageState({ path: FOUNDER_STATE });
});
