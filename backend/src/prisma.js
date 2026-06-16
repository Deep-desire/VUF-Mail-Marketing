const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasources: {
    db: {
      // Connection pool size passed via DATABASE_URL query params (?connection_limit=10)
      // when using Supabase PgBouncer (transaction mode, port 6543).
      // The env var already includes the full URL; no override needed here.
      url: process.env.DATABASE_URL,
    },
  },
});

const ContactStatus = {
  valid: 'valid',
  invalid: 'invalid',
  duplicate: 'duplicate',
  unsubscribed: 'unsubscribed',
};

module.exports = { prisma, ContactStatus };
