/**
 * SSO login helper — same code path as the splunk_login MCP tool.
 * Run: npm run login  (uses .env in project root for non-secret overrides)
 */
import { loginWithSSO, loginToolResultText } from "../src/auth.js";

const result = await loginWithSSO();
console.log(loginToolResultText(result));
