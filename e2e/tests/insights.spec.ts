import { test, expect } from '../fixtures';

test.describe('Insights Panel', () => {
  test('should open and close insights panel', async ({ authedPage: page }) => {
    await page.getByTitle('Insights').click();
    await expect(page.locator('.insights-panel.open')).toBeVisible();
    // Should show empty state
    await expect(page.locator('.insights-empty')).toBeVisible();
    // Close
    await page.locator('.insights-close').click();
    await expect(page.locator('.insights-panel.open')).not.toBeVisible();
  });

  test('should display pinned insights', async ({ authedPage: page }) => {
    // Pin an insight via API
    await page.request.post('/api/insights', {
      data: {
        title: 'Test KPI Insight',
        content: 'Revenue is up 15% YoY',
        category: 'kpi',
      },
    });

    await page.getByTitle('Insights').click();
    await expect(page.locator('.insight-card')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.insight-card-title')).toContainText('Test KPI Insight');
  });

  test('should filter insights by category', async ({ authedPage: page }) => {
    // Pin insights of different categories
    await page.request.post('/api/insights', {
      data: { title: 'Risk Item', content: 'Churn increasing', category: 'risk' },
    });

    await page.getByTitle('Insights').click();
    // Filter to risk only
    await page.locator('.insights-filter-chip', { hasText: 'Risk' }).click();
    await expect(page.locator('.insight-card-title').filter({ hasText: 'Risk Item' })).toBeVisible();
  });

  test('should delete an insight', async ({ authedPage: page }) => {
    // Pin one
    const res = await page.request.post('/api/insights', {
      data: { title: 'To Delete', content: 'Will be removed', category: 'general' },
    });
    const insight = await res.json();

    await page.getByTitle('Insights').click();
    await expect(page.locator('.insight-card-title', { hasText: 'To Delete' })).toBeVisible({ timeout: 5_000 });

    // Click delete on the card
    await page.locator('.insight-card', { hasText: 'To Delete' }).hover();
    await page.locator('.insight-card', { hasText: 'To Delete' }).locator('.insight-delete-btn').click();
    // Confirm
    await page.locator('.insight-delete-yes').click();

    // Should be gone
    await expect(page.locator('.insight-card-title', { hasText: 'To Delete' })).not.toBeVisible({ timeout: 3_000 });
  });
});
