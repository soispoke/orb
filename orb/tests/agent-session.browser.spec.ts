import {test,expect} from '@playwright/test';
test('session recovery keeps identity, disclosures and genuine failures',async({page})=>{
 await page.goto('/tests/agent-session.html');
 const row=page.getByRole('button',{name:/Proof check\s*Status unconfirmed/});
 await row.click();
 await expect(row).toHaveAttribute('aria-expanded','true');
 await page.getByRole('button',{name:'Live progress',exact:true}).click();
 const live=page.getByRole('button',{name:/Proof check\s*Working/});
 await expect(live).toHaveAttribute('aria-expanded','true');
 await page.getByRole('button',{name:'Replay old notice',exact:true}).click();
 await expect(live).toHaveAttribute('aria-expanded','true');
 await expect(page.locator('.subagent')).toHaveAttribute('data-state','running');
 await expect(page.locator('.st-tool.is-failed')).toHaveCount(0);
 await page.getByRole('button',{name:'Real failure',exact:true}).click();
 await expect(page.locator('.subagent')).toHaveAttribute('data-state','failed');
 await expect(page.getByText('Build exited with code 1')).toBeVisible();
 await page.getByRole('button',{name:'Live progress',exact:true}).click();
 await expect(page.locator('.subagent')).toHaveAttribute('data-state','failed');
});
