import { test, expect } from '../fixtures';

test.describe('Workspace', () => {
  test('should display workspace name in header', async ({ authedPage: page }) => {
    await expect(page.locator('.chat-header h2')).toBeVisible();
  });

  test('should open and close settings modal', async ({ authedPage: page }) => {
    await page.getByTitle('Settings').click();
    await expect(page.locator('.settings-modal')).toBeVisible();
    // Should have tabs
    await expect(page.getByText('AI Agent')).toBeVisible();
    await expect(page.getByText('Tools')).toBeVisible();
    // Close
    await page.locator('.settings-close').click();
    await expect(page.locator('.settings-modal')).not.toBeVisible();
  });

  test('should toggle code panel', async ({ authedPage: page }) => {
    const toggleBtn = page.getByTitle('Code Explorer');
    await toggleBtn.click();
    await expect(page.locator('.code-panel.open')).toBeVisible();
    await toggleBtn.click();
    // Panel should close (width transitions to 0)
    await expect(page.locator('.code-panel.open')).not.toBeVisible();
  });

  test('should show presence bar', async ({ authedPage: page }) => {
    await expect(page.locator('.presence-bar')).toBeVisible();
  });
});
