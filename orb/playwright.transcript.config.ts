import {defineConfig} from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
 ...base,
 testMatch:'transcript.browser.spec.ts',
 projects:[{name:'chromium',use:{browserName:'chromium'}},{name:'webkit',use:{browserName:'webkit'}}],
});
