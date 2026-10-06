import { connectUrl, loadDotEnv } from '@abc/db';
import { createApp } from './app';
import { configFromEnv } from './tokens';

loadDotEnv();
const config = configFromEnv();
const db = connectUrl();
const app = await createApp(db, config);
await app.listen(config.port);
console.log(`API listening on :${config.port}${config.demoSignIn ? ' (demo sign-in enabled)' : ''}`);
