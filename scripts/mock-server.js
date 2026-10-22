/** اجرای سرور mock برای تست دستی CLI */
import { startMockServer } from '../test/mock-server.js';

const mock = await startMockServer(8899);
console.log(`mock server: ${mock.baseUrl}  (key: ${mock.apiKey})`);
