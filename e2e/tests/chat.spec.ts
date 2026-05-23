import { test, expect, TEST_USER } from '../fixtures';

test.describe('Chat', () => {
  test('should show welcome state when no messages', async ({ authedPage: page }) => {
    await expect(page.locator('.welcome-state')).toBeVisible();
    await expect(page.locator('.welcome-header h2')).toContainText('Welcome to Roundtable');
  });

  test('should show starter prompts', async ({ authedPage: page }) => {
    await expect(page.locator('.prompt-card')).toHaveCount(4);
  });

  test('should send a regular message', async ({ authedPage: page }) => {
    await page.fill('.chat-input', 'Hello, this is a test message');
    await page.click('.chat-send-btn');
    // Message should appear in the chat
    await expect(page.locator('.message').last()).toContainText('Hello, this is a test message');
  });

  test('should clear input after sending', async ({ authedPage: page }) => {
    await page.fill('.chat-input', 'Another test message');
    await page.click('.chat-send-btn');
    await expect(page.locator('.chat-input')).toHaveValue('');
  });

  test('should not send empty messages', async ({ authedPage: page }) => {
    const sendBtn = page.locator('.chat-send-btn');
    await expect(sendBtn).toBeDisabled();
  });

  test('should fill input when clicking starter prompt', async ({ authedPage: page }) => {
    await page.locator('.prompt-card').first().click();
    const inputValue = await page.locator('.chat-input').inputValue();
    expect(inputValue).toContain('@ai');
  });
});
