const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const XLSX = require('xlsx');
const rateLimit = require('express-rate-limit');
const { prisma, ContactStatus } = require('./prisma');
const { generateToken, comparePassword, hashPassword, authenticate } = require('./auth');
const { sendEmail } = require('./email');
const { renderTemplate, invalidateTemplate } = require('./templates-service');

require('dotenv').config();

const app = express();

// --- CORS ---
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// Multer: memory storage, 10 MB hard cap
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// --- Rate limiters ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { message: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const batchLimiter = rateLimit({
  windowMs: 1000,
  max: 10,
  message: { message: 'Too many batch requests, slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Unsubscribed list in-memory cache (5-minute TTL) ---
let _unsubscribedCache = null;
let _unsubscribedCacheTime = 0;
const UNSUB_CACHE_TTL_MS = 5 * 60 * 1000;

async function getUnsubscribedSet() {
  const now = Date.now();
  if (_unsubscribedCache && now - _unsubscribedCacheTime < UNSUB_CACHE_TTL_MS) {
    return _unsubscribedCache;
  }
  const rows = await prisma.unsubscribed.findMany({ select: { email: true } });
  _unsubscribedCache = new Set(rows.map((r) => r.email.toLowerCase()));
  _unsubscribedCacheTime = now;
  return _unsubscribedCache;
}

function invalidateUnsubscribedCache() {
  _unsubscribedCache = null;
  _unsubscribedCacheTime = 0;
}

// --- Valid upload status transitions ---
const VALID_TRANSITIONS = {
  idle: ['processing'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: ['idle'],
};

function assertCanTransition(current, next) {
  if (!VALID_TRANSITIONS[current]?.includes(next)) {
    throw new Error(`Cannot transition upload from '${current}' to '${next}'`);
  }
}

// --- Helper: aggregate upload stats in ONE query ---
async function recountUploadStats(uploadId) {
  const [statusRows, deliveryRows] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        COUNT(*)::int                                          AS "totalRows",
        COUNT(*) FILTER (WHERE status = 'valid')::int         AS "validEmails",
        COUNT(*) FILTER (WHERE status = 'invalid')::int       AS "invalidEmails",
        COUNT(*) FILTER (WHERE status = 'duplicate')::int     AS "duplicateEmails",
        COUNT(*) FILTER (WHERE status = 'unsubscribed')::int  AS "unsubscribedEmails"
      FROM contacts
      WHERE upload_id = ${uploadId}
    `,
    prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE delivery_status = 'sent')::int     AS "sentCount",
        COUNT(*) FILTER (WHERE delivery_status = 'failed')::int   AS "failedCount",
        COUNT(*) FILTER (WHERE delivery_status = 'pending')::int  AS "pendingCount",
        COUNT(*) FILTER (WHERE delivery_status = 'skipped')::int  AS "skippedCount"
      FROM contacts
      WHERE upload_id = ${uploadId}
    `,
  ]);
  return { ...statusRows[0], ...deliveryRows[0] };
}

// --- Helper: mask email for GDPR compliance ---
function maskEmail(email) {
  const parts = email.split('@');
  if (parts.length !== 2) return '***@***.***';
  const [user, domain] = parts;
  const maskedUser = user.length > 2 ? user[0] + '***' + user[user.length - 1] : '***';
  return `${maskedUser}@${domain}`;
}

// --- Helper: finalize upload status after all batches done ---
async function checkUploadCompletion(uploadId) {
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!upload) return 'failed';

  const pendingCount = await prisma.contact.count({
    where: { uploadId, deliveryStatus: 'pending' },
  });

  if (pendingCount === 0 && upload.status === 'processing') {
    const finalStatus =
      upload.failedCount > 0 && upload.sentCount === 0 ? 'failed' : 'completed';
    await prisma.upload.update({ where: { id: uploadId }, data: { status: finalStatus } });
    return finalStatus;
  }
  return upload.status;
}

// --- Helper: re-evaluate duplicate status for specific emails ---
async function revalidateDuplicatesForEmails(uploadId, emails) {
  const uniqueEmails = [...new Set(emails.filter(Boolean).map((e) => e.trim().toLowerCase()))];
  if (uniqueEmails.length === 0) return;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const unsubSet = await getUnsubscribedSet();

  await Promise.all(
    uniqueEmails.map(async (email) => {
      const contacts = await prisma.contact.findMany({ where: { uploadId, email } });
      if (contacts.length === 0) return;

      if (contacts.length > 1) {
        await prisma.contact.updateMany({
          where: { uploadId, email },
          data: { status: 'duplicate', error: 'Duplicate email in file' },
        });
      } else {
        let status = 'valid';
        let error = null;
        if (!email) {
          status = 'invalid'; error = 'Email is empty';
        } else if (!emailRegex.test(email)) {
          status = 'invalid'; error = 'Invalid email format';
        } else if (unsubSet.has(email)) {
          status = 'unsubscribed'; error = 'Email is unsubscribed';
        }
        await prisma.contact.update({
          where: { id: contacts[0].id },
          data: { status, error },
        });
      }
    })
  );
}

// --- Async error wrapper ---
const catchAsync = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ============================================================
// API Router
// ============================================================
const apiRouter = express.Router();

// GET /health
apiRouter.get('/health', catchAsync(async (_req, res) => {
  const dbOk = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
  res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'degraded', db: dbOk });
}));

// POST /auth/login
apiRouter.post('/auth/login', loginLimiter, catchAsync(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }
  const admin = await prisma.admin.findUnique({ where: { email: email.toLowerCase() } });
  if (!admin) return res.status(401).json({ message: 'Invalid credentials' });

  const isValid = await comparePassword(password, admin.password);
  if (!isValid) return res.status(401).json({ message: 'Invalid credentials' });

  const token = generateToken({ id: admin.id, email: admin.email, name: admin.name });
  return res.status(200).json({
    access_token: token,
    admin: { id: admin.id, email: admin.email, name: admin.name },
  });
}));

// GET /auth/me
apiRouter.get('/auth/me', catchAsync(async (req, res) => {
  const user = await authenticate(req);
  const admin = await prisma.admin.findUnique({
    where: { id: user.id },
    select: { id: true, email: true, name: true, createdAt: true },
  });
  if (!admin) return res.status(404).json({ message: 'Admin not found' });
  return res.status(200).json(admin);
}));

// GET /uploads/stats/dashboard
apiRouter.get('/uploads/stats/dashboard', catchAsync(async (req, res) => {
  await authenticate(req);
  const [totalUploads, totalTemplates, totalEmailsSent, totalFailedEmails] = await Promise.all([
    prisma.upload.count(),
    prisma.template.count(),
    prisma.contact.count({ where: { deliveryStatus: 'sent' } }),
    prisma.contact.count({ where: { deliveryStatus: 'failed' } }),
  ]);
  return res.status(200).json({ totalUploads, totalTemplates, totalEmailsSent, totalFailedEmails });
}));

// GET /uploads
apiRouter.get('/uploads', catchAsync(async (req, res) => {
  await authenticate(req);
  const uploads = await prisma.upload.findMany({
    include: { template: true },
    orderBy: { createdAt: 'desc' },
  });
  return res.status(200).json(uploads);
}));

// POST /uploads/excel
apiRouter.post('/uploads/excel', uploadMiddleware.single('file'), catchAsync(async (req, res) => {
  await authenticate(req);
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

  // Validate XLSX magic bytes (PK zip header: 0x50 0x4B)
  const buf = req.file.buffer;
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4B) {
    return res.status(400).json({ message: 'Uploaded file is not a valid .xlsx file' });
  }

  const workbook = XLSX.read(buf, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet);

  if (rows.length === 0) return res.status(400).json({ message: 'Excel file is empty' });

  const normalizedRows = rows.map((row) => {
    const normalized = {};
    for (const key of Object.keys(row)) {
      normalized[key.trim().toLowerCase()] = row[key];
    }
    return normalized;
  });

  const firstRow = normalizedRows[0];
  if (!('name' in firstRow) || !('email' in firstRow)) {
    return res.status(400).json({ message: 'Excel file must contain "name" and "email" columns' });
  }

  const unsubscribedSet = await getUnsubscribedSet();
  const seenEmails = new Set();
  let validCount = 0, invalidCount = 0, duplicateCount = 0, unsubscribedCount = 0;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const contactsToCreate = [];

  for (const row of normalizedRows) {
    const name = String(row.name || '').trim();
    const email = String(row.email || '').trim().toLowerCase();

    if (!email) {
      contactsToCreate.push({ name, email, status: 'invalid', error: 'Email is empty' });
      invalidCount++; continue;
    }
    if (!emailRegex.test(email)) {
      contactsToCreate.push({ name, email, status: 'invalid', error: 'Invalid email format' });
      invalidCount++; continue;
    }
    if (seenEmails.has(email)) {
      contactsToCreate.push({ name, email, status: 'duplicate', error: 'Duplicate email in file' });
      duplicateCount++; continue;
    }
    if (unsubscribedSet.has(email)) {
      contactsToCreate.push({ name, email, status: 'unsubscribed', error: 'Email is unsubscribed' });
      unsubscribedCount++;
      seenEmails.add(email); continue;
    }
    seenEmails.add(email);
    contactsToCreate.push({ name, email, status: 'valid', error: null });
    validCount++;
  }

  const upload = await prisma.upload.create({
    data: {
      fileName: req.file.originalname || 'uploaded_file.xlsx',
      originalName: req.file.originalname || 'uploaded_file.xlsx',
      totalRows: normalizedRows.length,
      validEmails: validCount,
      invalidEmails: invalidCount,
      duplicateEmails: duplicateCount,
      unsubscribedEmails: unsubscribedCount,
      contacts: { create: contactsToCreate },
    },
  });

  return res.status(201).json(upload);
}));

// GET /uploads/:id/stats  — lightweight poll endpoint (no contacts list)
apiRouter.get('/uploads/:id/stats', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const upload = await prisma.upload.findUnique({
    where: { id },
    select: {
      id: true, status: true,
      totalCount: true, sentCount: true, failedCount: true,
      pendingCount: true, skippedCount: true,
    },
  });
  if (!upload) return res.status(404).json({ message: 'Upload not found' });
  return res.status(200).json(upload);
}));

// POST /uploads/:id/send
apiRouter.post('/uploads/:id/send', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { templateId } = req.body;

  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) return res.status(404).json({ message: 'Upload not found' });

  // State machine guard
  try { assertCanTransition(upload.status, 'processing'); }
  catch (e) { return res.status(400).json({ message: e.message }); }

  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) return res.status(404).json({ message: 'Template not found' });

  const contacts = await prisma.contact.findMany({ where: { uploadId: id, status: 'valid' } });
  if (contacts.length === 0) {
    return res.status(400).json({ message: 'No valid contacts found in this upload' });
  }

  const unsubscribedSet = await getUnsubscribedSet();
  const unsubscribedArray = [...unsubscribedSet];

  const [skippedResult, pendingResult] = await Promise.all([
    prisma.contact.updateMany({
      where: { uploadId: id, status: 'valid', email: { in: unsubscribedArray } },
      data: { deliveryStatus: 'skipped', deliveryError: 'Email is unsubscribed' },
    }),
    prisma.contact.updateMany({
      where: { uploadId: id, status: 'valid', email: { notIn: unsubscribedArray } },
      data: { deliveryStatus: 'pending' },
    }),
  ]);

  await prisma.upload.update({
    where: { id },
    data: {
      status: 'processing',
      templateId,
      totalCount: contacts.length,
      pendingCount: pendingResult.count,
      skippedCount: skippedResult.count,
      sentCount: 0,
      failedCount: 0,
    },
  });

  const queuedContacts = contacts.filter((c) => !unsubscribedSet.has(c.email.toLowerCase()));
  return res.status(200).json({
    message: 'Sending initiated',
    totalCount: contacts.length,
    queuedCount: pendingResult.count,
    skippedCount: skippedResult.count,
    queuedContacts: queuedContacts.map((c) => ({ id: c.id, email: c.email, name: c.name })),
  });
}));

// POST /uploads/:id/send-batch
apiRouter.post('/uploads/:id/send-batch', batchLimiter, catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { templateId, contactIds } = req.body;

  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ message: 'contactIds must be a non-empty array' });
  }

  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) return res.status(404).json({ message: 'Template not found' });

  const contacts = await prisma.contact.findMany({
    where: { id: { in: contactIds }, uploadId: id },
  });
  if (contacts.length === 0) {
    return res.status(400).json({ message: 'No matching contacts found for the specified IDs' });
  }

  // Templates are compiled once per batch — cache handles cross-batch reuse
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  const results = await Promise.all(
    contacts.map(async (contact) => {
      const token = crypto
        .createHash('sha256')
        .update(contact.email + 'vuf-unsubscribe-salt')
        .digest('hex')
        .substring(0, 32);
      const unsubscribeLink = `${frontendUrl}/unsubscribe/${token}`;

      const variables = { name: contact.name, email: contact.email, unsubscribeLink };
      // renderTemplate now uses LRU cache — no recompile on repeat calls
      const rendered = renderTemplate(
        { id: template.id, subject: template.subject, htmlBody: template.htmlBody, plainTextBody: template.plainTextBody },
        variables
      );

      let attempts = 0;
      const maxAttempts = 3;
      let lastError = null;

      while (attempts < maxAttempts) {
        try {
          await sendEmail({ to: contact.email, subject: rendered.subject, html: rendered.html, text: rendered.text });
          await prisma.contact.update({
            where: { id: contact.id },
            data: { deliveryStatus: 'sent', deliveryError: null, sentAt: new Date() },
          });
          return { id: contact.id, status: 'sent' };
        } catch (err) {
          attempts++;
          lastError = err;
          console.warn(`[Retry] Attempt ${attempts} failed for ${contact.email}: ${err.message}`);
          if (attempts < maxAttempts) await new Promise((r) => setTimeout(r, 2000));
        }
      }

      await prisma.contact.update({
        where: { id: contact.id },
        data: {
          deliveryStatus: 'failed',
          deliveryError: lastError?.message || 'All retry attempts failed',
        },
      });
      return { id: contact.id, status: 'failed' };
    })
  );

  let sentCount = 0, failedCount = 0;
  for (const r of results) {
    if (r.status === 'sent') sentCount++;
    if (r.status === 'failed') failedCount++;
  }

  await prisma.upload.update({
    where: { id },
    data: {
      sentCount:    { increment: sentCount },
      failedCount:  { increment: failedCount },
      pendingCount: { decrement: contacts.length },
    },
  });

  return res.status(200).json({ sent: sentCount, failed: failedCount });
}));

// POST /uploads/:id/finalize
apiRouter.post('/uploads/:id/finalize', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const status = await checkUploadCompletion(id);
  return res.status(200).json({ status });
}));

// GET /uploads/:id/contacts
apiRouter.get('/uploads/:id/contacts', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const page = parseInt(req.query.page || '1', 10);
  const limit = parseInt(req.query.limit || '50', 10);
  const skip = (page - 1) * limit;

  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({
      where: { uploadId: id },
      skip,
      take: limit,
      orderBy: { createdAt: 'asc' },
    }),
    prisma.contact.count({ where: { uploadId: id } }),
  ]);

  return res.status(200).json({
    contacts, total, page, limit,
    totalPages: Math.ceil(total / limit),
  });
}));

// GET /uploads/:id
apiRouter.get('/uploads/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const upload = await prisma.upload.findUnique({
    where: { id },
    include: { template: true },
  });
  if (!upload) return res.status(404).json({ message: 'Upload not found' });
  return res.status(200).json(upload);
}));

// PUT /uploads/:id
apiRouter.put('/uploads/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { fileName, originalName } = req.body;
  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) return res.status(404).json({ message: 'Upload not found' });

  const updated = await prisma.upload.update({
    where: { id },
    data: {
      fileName: fileName || upload.fileName,
      originalName: originalName || upload.originalName,
    },
  });
  return res.status(200).json(updated);
}));

// DELETE /uploads/:id
apiRouter.delete('/uploads/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) return res.status(404).json({ message: 'Upload not found' });
  await prisma.upload.delete({ where: { id } });
  return res.status(200).json({ message: 'Upload deleted successfully' });
}));

// PUT /contacts/:id
apiRouter.put('/contacts/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { name, email } = req.body;

  const contact = await prisma.contact.findUnique({ where: { id } });
  if (!contact) return res.status(404).json({ message: 'Contact not found' });

  const oldEmail = contact.email;
  const newEmail = email !== undefined ? email.trim().toLowerCase() : contact.email;
  const newName  = name  !== undefined ? name.trim()               : contact.name;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  let newStatus = 'valid';
  let newError = null;

  if (!newEmail) {
    newStatus = 'invalid'; newError = 'Email is empty';
  } else if (!emailRegex.test(newEmail)) {
    newStatus = 'invalid'; newError = 'Invalid email format';
  } else {
    const unsubSet = await getUnsubscribedSet();
    if (unsubSet.has(newEmail)) {
      newStatus = 'unsubscribed'; newError = 'Email is unsubscribed';
    } else {
      const duplicate = await prisma.contact.findFirst({
        where: { uploadId: contact.uploadId, email: newEmail, id: { not: id } },
      });
      if (duplicate) {
        newStatus = 'duplicate'; newError = 'Duplicate email in file';
      }
    }
  }

  const updatedContact = await prisma.contact.update({
    where: { id },
    data: { name: newName, email: newEmail, status: newStatus, error: newError },
  });

  if (oldEmail.toLowerCase() !== newEmail.toLowerCase()) {
    await revalidateDuplicatesForEmails(contact.uploadId, [oldEmail, newEmail]);
  }

  // Recount upload stats using ONE aggregate query
  const uploadId = contact.uploadId;
  const counts = await recountUploadStats(uploadId);
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });

  const updateData = {
    totalRows:          counts.totalRows,
    validEmails:        counts.validEmails,
    invalidEmails:      counts.invalidEmails,
    duplicateEmails:    counts.duplicateEmails,
    unsubscribedEmails: counts.unsubscribedEmails,
  };

  if (upload && upload.status !== 'idle') {
    updateData.totalCount    = counts.validEmails;
    updateData.sentCount     = counts.sentCount;
    updateData.failedCount   = counts.failedCount;
    updateData.pendingCount  = counts.pendingCount;
    updateData.skippedCount  = counts.skippedCount;
  }

  await prisma.upload.update({ where: { id: uploadId }, data: updateData });

  return res.status(200).json(updatedContact);
}));

// DELETE /contacts/:id
apiRouter.delete('/contacts/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);

  const contact = await prisma.contact.findUnique({ where: { id } });
  if (!contact) return res.status(404).json({ message: 'Contact not found' });

  await prisma.contact.delete({ where: { id } });
  await revalidateDuplicatesForEmails(contact.uploadId, [contact.email]);

  // Recount upload stats using ONE aggregate query
  const uploadId = contact.uploadId;
  const counts = await recountUploadStats(uploadId);
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });

  const updateData = {
    totalRows:          counts.totalRows,
    validEmails:        counts.validEmails,
    invalidEmails:      counts.invalidEmails,
    duplicateEmails:    counts.duplicateEmails,
    unsubscribedEmails: counts.unsubscribedEmails,
  };

  if (upload && upload.status !== 'idle') {
    updateData.totalCount    = counts.validEmails;
    updateData.sentCount     = counts.sentCount;
    updateData.failedCount   = counts.failedCount;
    updateData.pendingCount  = counts.pendingCount;
    updateData.skippedCount  = counts.skippedCount;
  }

  await prisma.upload.update({ where: { id: uploadId }, data: updateData });

  return res.status(200).json({ message: 'Contact deleted successfully' });
}));

// GET /templates
apiRouter.get('/templates', catchAsync(async (req, res) => {
  await authenticate(req);
  const templates = await prisma.template.findMany({ orderBy: { createdAt: 'desc' } });
  return res.status(200).json(templates);
}));

// POST /templates
apiRouter.post('/templates', catchAsync(async (req, res) => {
  await authenticate(req);
  const { name, subject, htmlBody, plainTextBody } = req.body;
  if (!name || !subject || !htmlBody || !plainTextBody) {
    return res.status(400).json({ message: 'name, subject, htmlBody, and plainTextBody are required' });
  }
  const template = await prisma.template.create({ data: { name, subject, htmlBody, plainTextBody } });
  return res.status(201).json(template);
}));

// POST /templates/:id/test
apiRouter.post('/templates/:id/test', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { testEmail } = req.body;
  if (!testEmail) return res.status(400).json({ message: 'testEmail is required' });

  const template = await prisma.template.findUnique({ where: { id } });
  if (!template) return res.status(404).json({ message: 'Template not found' });

  const rendered = renderTemplate(
    { id: template.id, subject: template.subject, htmlBody: template.htmlBody, plainTextBody: template.plainTextBody },
    { name: 'Test User', email: testEmail, unsubscribeLink: '#' }
  );
  await sendEmail({ to: testEmail, subject: `[TEST] ${rendered.subject}`, html: rendered.html, text: rendered.text });
  return res.status(200).json({ message: 'Test email sent successfully' });
}));

// GET /templates/:id
apiRouter.get('/templates/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const template = await prisma.template.findUnique({ where: { id } });
  if (!template) return res.status(404).json({ message: 'Template not found' });
  return res.status(200).json(template);
}));

// PUT /templates/:id
apiRouter.put('/templates/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { name, subject, htmlBody, plainTextBody } = req.body;
  const template = await prisma.template.findUnique({ where: { id } });
  if (!template) return res.status(404).json({ message: 'Template not found' });

  // Invalidate compiled cache so next render uses new content
  invalidateTemplate(id);

  const updated = await prisma.template.update({
    where: { id },
    data: {
      name:          name          || template.name,
      subject:       subject       || template.subject,
      htmlBody:      htmlBody      || template.htmlBody,
      plainTextBody: plainTextBody || template.plainTextBody,
    },
  });
  return res.status(200).json(updated);
}));

// DELETE /templates/:id
apiRouter.delete('/templates/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const template = await prisma.template.findUnique({ where: { id } });
  if (!template) return res.status(404).json({ message: 'Template not found' });
  invalidateTemplate(id);
  await prisma.template.delete({ where: { id } });
  return res.status(200).json({ message: 'Template deleted successfully' });
}));

// GET /unsubscribe/:token
apiRouter.get('/unsubscribe/:token', catchAsync(async (req, res) => {
  const { token } = req.params;
  const existing = await prisma.unsubscribed.findUnique({ where: { token } });
  if (existing) {
    return res.status(200).json({ alreadyUnsubscribed: true, email: maskEmail(existing.email) });
  }
  return res.status(200).json({ alreadyUnsubscribed: false, email: null });
}));

// POST /unsubscribe/:token
apiRouter.post('/unsubscribe/:token', catchAsync(async (req, res) => {
  const { token } = req.params;
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  const expectedToken = crypto
    .createHash('sha256')
    .update(email.trim().toLowerCase() + 'vuf-unsubscribe-salt')
    .digest('hex')
    .substring(0, 32);

  if (expectedToken !== token) return res.status(404).json({ message: 'Invalid unsubscribe link' });

  const existing = await prisma.unsubscribed.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    return res.status(200).json({ message: 'You are already unsubscribed', email: maskEmail(email) });
  }

  await prisma.unsubscribed.create({ data: { email: email.toLowerCase(), token } });
  invalidateUnsubscribedCache();

  return res.status(200).json({
    message: 'You have been successfully unsubscribed',
    email: maskEmail(email),
  });
}));

// --- Mount router for dual path support (/api and /) ---
app.use('/api', apiRouter);
app.use('/', apiRouter);

// Global error handler
app.use((err, req, res, next) => {
  console.error(`[Express Error] ${err.stack || err.message}`);
  const status = err.message === 'Unauthorized' ? 401 : 400;
  return res.status(status).json({ message: err.message });
});

const PORT = process.env.PORT || 7071;
app.listen(PORT, () => {
  console.log(`[Express Started] Backend listening on port ${PORT}`);
});

module.exports = app;
