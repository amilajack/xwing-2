## Browser playtesting

After changing gameplay or rendering:

1. Start the development server.
2. Open the game with Playwright in Chromium at 1440x900.
3. Wait for `window.__gameTest.ready`.
4. Check browser console errors.
5. Exercise the changed behavior using keyboard and mouse input.
6. Capture screenshots before and after the interaction.
7. Inspect structured state through `window.__gameTest.getState()`.
8. Run the relevant Playwright regression tests.
9. Do not claim success based only on the page loading.
