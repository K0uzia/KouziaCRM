export default function globalSetup() {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "file:./test.db";
  if (!process.env.SESSION_SECRET)
    process.env.SESSION_SECRET = "test-session-secret-32chars-min";
  if (!process.env.ENCRYPTION_KEY)
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  if (!process.env.WEB_ORIGIN) process.env.WEB_ORIGIN = "http://localhost:5173";
}
