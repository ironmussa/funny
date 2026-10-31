import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

const clientRequire = createRequire(resolve('packages/client/package.json'));
const postcss = clientRequire('postcss');
const tailwind = clientRequire('@tailwindcss/postcss');

test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

// Exercise the actual application stylesheet without requiring a running server.
test('native scrollbars retain the shared thickness on both axes and on hover', async ({
  page,
}) => {
  const stylesheet = resolve('packages/client/src/globals.css');
  const { css } = await postcss([tailwind()]).process(await readFile(stylesheet, 'utf8'), {
    from: stylesheet,
  });
  await page.setContent(`
    <style>${css}</style>
    <div id="scroller" style="width:200px;height:200px;overflow:scroll">
      <div style="width:400px;height:400px"></div>
    </div>
  `);
  const scroller = page.locator('#scroller');
  for (const alwaysVisible of [false, true]) {
    await scroller.evaluate((element, visible) => {
      element.classList.toggle('scrollbar-visible', visible);
    }, alwaysVisible);
    for (const hovered of [false, true]) {
      if (hovered) await scroller.hover();
      else await page.mouse.move(500, 500);
      const dimensions = await scroller.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          vertical: element.offsetWidth - element.clientWidth,
          horizontal: element.offsetHeight - element.clientHeight,
          color: style.scrollbarColor,
          size: Number.parseFloat(style.getPropertyValue('--scrollbar-size')),
        };
      });
      expect(dimensions.color).toBe('auto');
      expect(dimensions.vertical).toBe(dimensions.size);
      expect(dimensions.horizontal).toBe(dimensions.size);
    }
  }
});
