import { test as base, expect } from '@playwright/test';

const TEST_USER = {
  username: 'e2e_tester',
  password: 'TestPass123!',
  displayName: 'E2E Tester',
};

// Custom fixture that provides an authenticated page
export const test = base.extend<{ authedPage: ReturnType<typeof base['page']> extends Promise<infer P> ? P : never }>({
  authedPage: async ({ page }, use) => {
    // Try to register (ignore if already exists)
    await page.request.post('/api/auth/register', {
      data: {
        username: TEST_USER.username,
        password: TEST_USER.password,
        displayName: TEST_USER.displayName,
      },
    }).catch(() => {});

    // Login
    const loginRes = await page.request.post('/api/auth/login', {
      data: {
        username: TEST_USER.username,
        password: TEST_USER.password,
      },
    });
    expect(loginRes.ok()).toBeTruthy();

    // Navigate to workspace
    await page.goto('/');
    await page.waitForSelector('.chat-messages', { timeout: 10_000 });

    await use(page);
  },
});

export { expect, TEST_USER };
