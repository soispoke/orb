import {defineConfig} from '@playwright/test';
const port = process.env.ORB_TEST_PORT || '1451';
export default defineConfig({
 testDir:'./tests',testMatch:'subagents.browser.spec.ts',workers:1,
 use:{baseURL:`http://127.0.0.1:${port}`,viewport:{width:1000,height:760}},
 webServer:{command:`./node_modules/.bin/vite --host 127.0.0.1 --port ${port}`,url:`http://127.0.0.1:${port}/tests/subagents.html`,reuseExistingServer:false},
});
