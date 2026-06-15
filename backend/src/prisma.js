const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const ContactStatus = {
  valid: 'valid',
  invalid: 'invalid',
  duplicate: 'duplicate',
  unsubscribed: 'unsubscribed',
};

module.exports = {
  prisma,
  ContactStatus,
};
