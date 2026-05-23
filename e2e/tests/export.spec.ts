import { test, expect } from '../fixtures';

test.describe('Export', () => {
  test('should open export dropdown', async ({ authedPage: page }) => {
    await page.getByTitle('Export conversation').click();
    await expect(page.locator('.export-dropdown')).toBeVisible();
    // Should show two options
    await expect(page.locator('.export-option')).toHaveCount(2);
    await expect(page.getByText('Export PDF')).toBeVisible();
    await expect(page.getByText('Copy Markdown')).toBeVisible();
  });

  test('should close export dropdown on outside click', async ({ authedPage: page }) => {
    await page.getByTitle('Export conversation').click();
    await expect(page.locator('.export-dropdown')).toBeVisible();
    // Click outside
    await page.locator('.chat-messages').click();
    await expect(page.locator('.export-dropdown')).not.toBeVisible();
  });
});
