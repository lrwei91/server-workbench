const { test, expect } = require('@playwright/test');

for (const [width, zoom] of [[1366, 1], [1024, 1], [1366, 2]]) {
  test(`批量入库准备可校验、留档并保留编辑会话 (${width}, ${zoom * 100}%)`, async ({ page, request }) => {
    // Browser zoom reduces the layout viewport (unlike CSS zoom on an iframe root).
    await page.setViewportSize({ width: Math.round(width / zoom), height: 768 / zoom });
    const loaded = await request.post('/cdr/api/load', { data: { filename: 'sample.json' } });
    expect(loaded.ok()).toBe(true);
    const before = await (await request.get('/cdr/api/session')).json();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/#/cdr');
    const frame = page.frameLocator('#cdrFrame');
    await expect(frame.locator('#sessionState')).toContainText('sample.json');
    await frame.getByRole('button', { name: '批量入库准备' }).click();
    const dialog = frame.getByRole('dialog', { name: '批量入库准备' });
    const submit = dialog.getByRole('button', { name: '校验并生成投递包' });
    await expect(submit).toBeDisabled();
    await dialog.getByRole('checkbox', { name: /^intake\.txt/ }).check();
    await dialog.getByRole('checkbox', { name: /^intake\.dat/ }).check();
    await dialog.getByLabel('按实际路由选择账期字段').selectOption('CJ_START_TIME');
    const period = dialog.getByLabel('目标账期（YYYYMM）');
    await period.fill('202610');
    await submit.click();
    await expect(dialog.locator('#intakeStatus')).toContainText('与目标账期 202610 不一致');
    await expect(dialog.locator('#intakeResult')).toBeHidden();
    await period.fill('202611');
    await submit.click();
    await expect(dialog.locator('#intakeStatus')).toContainText('2 个文件、2 条 · 尚未投递');
    await expect(dialog.locator('#intakePath')).toContainText('intake');
    await expect(dialog.locator('#intakeManifest li')).toHaveCount(2);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    expect(await (await request.get('/cdr/api/session')).json()).toEqual(before);
    expect(errors).toEqual([]);
  });
}
