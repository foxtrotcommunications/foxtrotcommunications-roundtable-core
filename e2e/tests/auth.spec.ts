import { test, expect } from '@playwright/test';

const UNIQUE_USER = `e2e_auth_${Date.now()}`;

test.describe('Authentication', () => {
  test('should show login page when not authenticated', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.login-card')).toBeVisible();
  });

  test('should register a new user', async ({ page }) => {
    await page.goto('/');
    // Click "Create account" link/button to switch to register mode
    await page.getByText('Create account').click();
    await page.fill('input[name="username"]', UNIQUE_USER);
    await page.fill('input[name="password"]', 'TestPass123!');
    await page.fill('input[name="displayName"]', 'Auth Test User');
    await page.getByRole('button', { name: /register|sign up|create/i }).click();
    // Should redirect to workspace
    await expect(page.locator('.chat-messages')).toBeVisible({ timeout: 10_000 });
  });

  test('should login with valid credentials', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[name="username"]', UNIQUE_USER);
    await page.fill('input[name="password"]', 'TestPass123!');
    await page.getByRole('button', { name: /login|sign in/i }).click();
    await expect(page.locator('.chat-messages')).toBeVisible({ timeout: 10_000 });
  });

  test('should reject invalid credentials', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[name="username"]', 'nonexistent_user');
    await page.fill('input[name="password"]', 'wrong_password');
    await page.getByRole('button', { name: /login|sign in/i }).click();
    // Should show error and stay on login page
    await expect(page.locator('.login-card')).toBeVisible();
  });

  test('should logout and return to login page', async ({ page }) => {
    // Login first
    await page.goto('/');
    await page.fill('input[name="username"]', UNIQUE_USER);
    await page.fill('input[name="password"]', 'TestPass123!');
    await page.getByRole('button', { name: /login|sign in/i }).click();
    await expect(page.locator('.chat-messages')).toBeVisible({ timeout: 10_000 });
    // Click logout
    await page.getByTitle('Logout').click();
    await expect(page.locator('.login-card')).toBeVisible({ timeout: 5_000 });
  });
});
