import {defineConfig} from '@playwright/test';
export default defineConfig({
 testDir:'./tests',testMatch:'subagents.browser.spec.ts',workers:1,
 use:{baseURL:'http://127.0.0.1:1451',viewport:{width:1000,height:760},launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}},
 webServer:{command:'./node_modules/.bin/vite --host 127.0.0.1 --port 1451',url:'http://127.0.0.1:1451/tests/subagents.html',reuseExistingServer:false},
});
