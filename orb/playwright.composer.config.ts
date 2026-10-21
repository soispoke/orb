import {defineConfig} from '@playwright/test';
import base from './playwright.config';
export default defineConfig({
 ...base,
 testMatch:['composer-scroll.browser.spec.ts','composer-layout.browser.spec.ts','launch.browser.spec.ts'],
 projects:[{name:'chromium',use:{browserName:'chromium'}},{name:'webkit',use:{browserName:'webkit'}}],
});
