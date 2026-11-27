import { type Browser, type Page, expect, test } from '@playwright/test';

/** Opens the same room in a fresh browser context (separate storage = separate user). */
async function openBoard(browser: Browser, roomId: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/?room=${roomId}`);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  return page;
}

const stickies = (page: Page) => page.locator('[data-shape-kind="sticky"]');
const canvas = (page: Page) => page.getByRole('application', { name: 'Whiteboard canvas' });

test.describe('real-time collaboration', () => {
  test('two users see each other, their edits and their presence', async ({ browser }) => {
    const roomId = `e2e-${Date.now().toString(36)}`;
    const alice = await openBoard(browser, roomId);
    const bob = await openBoard(browser, roomId);

    // Presence: each side shows two people in the room.
    await expect(alice.getByRole('list', { name: '2 people in this room' })).toBeVisible();
    await expect(bob.getByRole('list', { name: '2 people in this room' })).toBeVisible();

    // Alice adds a sticky note and types into it.
    await alice.getByRole('button', { name: 'Sticky note' }).click();
    await canvas(alice).click({ position: { x: 400, y: 300 } });
    await alice.getByRole('textbox', { name: 'Sticky note text' }).fill('Hello from Alice');
    await alice.keyboard.press('Escape');

    await expect(stickies(bob)).toHaveCount(1);
    await expect(stickies(bob).first()).toContainText('Hello from Alice');

    // Bob moves it; Alice sees the new position.
    const note = stickies(bob).first();
    const before = await note.boundingBox();
    if (!before) throw new Error('sticky not laid out');
    await bob.mouse.move(before.x + 20, before.y + 20);
    await bob.mouse.down();
    await bob.mouse.move(before.x + 220, before.y + 120, { steps: 8 });
    await bob.mouse.up();

    await expect
      .poll(async () => (await stickies(alice).first().boundingBox())?.x)
      .toBeGreaterThan(before.x + 150);

    // Bob's cursor is visible to Alice while he hovers the canvas.
    await bob.mouse.move(600, 500);
    await expect(alice.getByTestId('remote-cursor')).toBeVisible();

    // Bob deletes it; it disappears for Alice.
    await bob.keyboard.press('Delete');
    await expect(stickies(alice)).toHaveCount(0);
  });

  test('a late joiner receives the existing board', async ({ browser }) => {
    const roomId = `e2e-late-${Date.now().toString(36)}`;
    const alice = await openBoard(browser, roomId);
    await alice.getByRole('button', { name: 'Rectangle' }).click();
    await canvas(alice).click({ position: { x: 300, y: 300 } });
    await alice.keyboard.press('o');
    await canvas(alice).click({ position: { x: 700, y: 300 } });
    await expect(alice.locator('[data-shape-id]')).toHaveCount(2);

    const carol = await openBoard(browser, roomId);
    await expect(carol.locator('[data-shape-kind="rect"]')).toHaveCount(1);
    await expect(carol.locator('[data-shape-kind="ellipse"]')).toHaveCount(1);
  });
});
