const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const XLSX = require('xlsx');
const Handlebars = require('handlebars');
const { prisma, ContactStatus } = require('./prisma');
const { generateToken, comparePassword, hashPassword, authenticate } = require('./auth');
const { sendEmail } = require('./email');
const { renderTemplate } = require('./templates-service');

require('dotenv').config();

const app = express();

// Enable CORS allowing credentials and matching front-end origins
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// Set up multer for memory storage uploads
const uploadMiddleware = multer({ storage: multer.memoryStorage() });

// --- Helper Functions ---

// Helper to mask emails for GDPR compliance
function maskEmail(email) {
  const parts = email.split('@');
  if (parts.length !== 2) return '***@***.***';
  const [user, domain] = parts;
  const maskedUser = user.length > 2 ? user[0] + '***' + user[user.length - 1] : '***';
  return `${maskedUser}@${domain}`;
}

// Helper to check and finalize upload status in DB
async function checkUploadCompletion(uploadId) {
  const upload = await prisma.upload.findUnique({
    where: { id: uploadId },
  });

  if (!upload) return 'failed';

  const pendingContacts = await prisma.contact.count({
    where: {
      uploadId,
      deliveryStatus: 'pending',
    },
  });

  if (pendingContacts === 0 && upload.status === 'processing') {
    const finalStatus =
      upload.failedCount > 0 && upload.sentCount === 0
        ? 'failed'
        : 'completed';

    await prisma.upload.update({
      where: { id: uploadId },
      data: { status: finalStatus },
    });
    console.log(`[Upload Finished] Upload ${uploadId} status updated to ${finalStatus}`);
    return finalStatus;
  }
  return upload.status;
}

// Helper to re-evaluate duplicate status for specific emails in an upload
async function revalidateDuplicatesForEmails(uploadId, emails) {
  const uniqueEmails = [...new Set(emails.filter(Boolean).map(e => e.trim().toLowerCase()))];
  if (uniqueEmails.length === 0) return;
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
  const unsubscribedList = await prisma.unsubscribed.findMany({
    where: { email: { in: uniqueEmails } }
  });
  const unsubscribedSet = new Set(unsubscribedList.map(u => u.email.toLowerCase()));
  
  await Promise.all(uniqueEmails.map(async (email) => {
    const contacts = await prisma.contact.findMany({
      where: { uploadId, email },
    });
    
    if (contacts.length === 0) return;
    
    if (contacts.length > 1) {
      await prisma.contact.updateMany({
        where: { uploadId, email },
        data: {
          status: 'duplicate',
          error: 'Duplicate email in file'
        }
      });
    } else {
      const contact = contacts[0];
      let status = 'valid';
      let error = null;
      
      if (!email) {
        status = 'invalid';
        error = 'Email is empty';
      } else if (!emailRegex.test(email)) {
        status = 'invalid';
        error = 'Invalid email format';
      } else if (unsubscribedSet.has(email)) {
        status = 'unsubscribed';
        error = 'Email is unsubscribed';
      }
      
      await prisma.contact.update({
        where: { id: contact.id },
        data: { status, error },
      });
    }
  }));
}

// Custom request error wrapper
const catchAsync = (fn) => (req, res, next) => {
  fn(req, res, next).catch(next);
};

// --- REST Endpoints ---

// POST /auth/login
app.post('/api/auth/login', catchAsync(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  const admin = await prisma.admin.findUnique({
    where: { email: email.toLowerCase() },
  });
  if (!admin) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const isPasswordValid = await comparePassword(password, admin.password);
  if (!isPasswordValid) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const token = generateToken({ id: admin.id, email: admin.email, name: admin.name });
  return res.status(200).json({
    access_token: token,
    admin: {
      id: admin.id,
      email: admin.email,
      name: admin.name,
    },
  });
}));

// GET /auth/me
app.get('/api/auth/me', catchAsync(async (req, res) => {
  const user = await authenticate(req);
  const admin = await prisma.admin.findUnique({
    where: { id: user.id },
    select: { id: true, email: true, name: true, createdAt: true },
  });
  if (!admin) {
    return res.status(404).json({ message: 'Admin not found' });
  }
  return res.status(200).json(admin);
}));

// GET /uploads/stats/dashboard
app.get('/api/uploads/stats/dashboard', catchAsync(async (req, res) => {
  await authenticate(req);
  const [totalUploads, totalTemplates, totalEmailsSent, totalFailedEmails] = await Promise.all([
    prisma.upload.count(),
    prisma.template.count(),
    prisma.contact.count({ where: { deliveryStatus: 'sent' } }),
    prisma.contact.count({ where: { deliveryStatus: 'failed' } }),
  ]);
  return res.status(200).json({
    totalUploads,
    totalTemplates,
    totalEmailsSent,
    totalFailedEmails,
  });
}));

// GET /uploads
app.get('/api/uploads', catchAsync(async (req, res) => {
  await authenticate(req);
  const uploads = await prisma.upload.findMany({
    include: { template: true },
    orderBy: { createdAt: 'desc' },
  });
  return res.status(200).json(uploads);
}));

// POST /uploads/excel (using multer storage middleware)
app.post('/api/uploads/excel', uploadMiddleware.single('file'), catchAsync(async (req, res) => {
  await authenticate(req);
  if (!req.file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  const buffer = req.file.buffer;
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet);

  if (rows.length === 0) {
    return res.status(400).json({ message: 'Excel file is empty' });
  }

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

  const unsubscribedEmails = await prisma.unsubscribed.findMany();
  const unsubscribedSet = new Set(unsubscribedEmails.map((u) => u.email.toLowerCase()));

  const seenEmails = new Set();
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;
  let unsubscribedCount = 0;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const contactsToCreate = [];

  for (const row of normalizedRows) {
    const name = String(row.name || '').trim();
    const email = String(row.email || '').trim().toLowerCase();

    if (!email) {
      contactsToCreate.push({ name, email, status: 'invalid', error: 'Email is empty' });
      invalidCount++;
      continue;
    }

    if (!emailRegex.test(email)) {
      contactsToCreate.push({ name, email, status: 'invalid', error: 'Invalid email format' });
      invalidCount++;
      continue;
    }

    if (seenEmails.has(email)) {
      contactsToCreate.push({ name, email, status: 'duplicate', error: 'Duplicate email in file' });
      duplicateCount++;
      continue;
    }

    if (unsubscribedSet.has(email)) {
      contactsToCreate.push({ name, email, status: 'unsubscribed', error: 'Email is unsubscribed' });
      unsubscribedCount++;
      seenEmails.add(email);
      continue;
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
      contacts: {
        create: contactsToCreate,
      },
    },
  });

  return res.status(201).json(upload);
}));

// POST /uploads/:id/send (Triggering Campaign send flow - Vercel Safe)
app.post('/api/uploads/:id/send', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { templateId } = req.body;

  const upload = await prisma.upload.findUnique({
    where: { id },
  });

  if (!upload) {
    return res.status(404).json({ message: 'Upload not found' });
  }
  if (upload.status !== 'idle') {
    return res.status(400).json({ message: `Email sending has already been initiated (status: ${upload.status})` });
  }

  const template = await prisma.template.findUnique({
    where: { id: templateId },
  });
  if (!template) {
    return res.status(404).json({ message: 'Template not found' });
  }

  const contacts = await prisma.contact.findMany({
    where: { uploadId: id, status: 'valid' },
  });
  if (contacts.length === 0) {
    return res.status(400).json({ message: 'No valid contacts found in this upload' });
  }

  const unsubscribed = await prisma.unsubscribed.findMany();
  const unsubscribedSet = new Set(unsubscribed.map((u) => u.email.toLowerCase()));
  const unsubscribedArray = [...unsubscribedSet];

  // Batch update all contacts in 2 queries
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

  const skippedCount = skippedResult.count;
  const pendingCount = pendingResult.count;

  await prisma.upload.update({
    where: { id },
    data: {
      status: 'processing',
      templateId,
      totalCount: contacts.length,
      pendingCount,
      skippedCount,
      sentCount: 0,
      failedCount: 0,
    },
  });

  const queuedContacts = contacts.filter((c) => !unsubscribedSet.has(c.email.toLowerCase()));

  // Return the contacts list to the client so the client can drive batch sending
  return res.status(200).json({
    message: 'Sending initiated',
    totalCount: contacts.length,
    queuedCount: pendingCount,
    skippedCount,
    queuedContacts: queuedContacts.map((c) => ({ id: c.id, email: c.email, name: c.name })),
  });
}));

// POST /uploads/:id/send-batch (Sends a single batch of emails - Vercel Safe)
app.post('/api/uploads/:id/send-batch', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { templateId, contactIds } = req.body;

  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ message: 'contactIds must be a non-empty array' });
  }

  const template = await prisma.template.findUnique({
    where: { id: templateId },
  });
  if (!template) {
    return res.status(404).json({ message: 'Template not found' });
  }

  const contacts = await prisma.contact.findMany({
    where: { id: { in: contactIds }, uploadId: id },
  });

  if (contacts.length === 0) {
    return res.status(400).json({ message: 'No matching contacts found for the specified IDs' });
  }

  // Precompile Handlebars templates once for the batch
  const subjectTemplate = Handlebars.compile(template.subject);
  const htmlTemplate = Handlebars.compile(template.htmlBody);
  const plainTemplate = Handlebars.compile(template.plainTextBody);

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  // Process concurrent email sending for this batch
  const results = await Promise.all(
    contacts.map(async (contact) => {
      const token = crypto
        .createHash('sha256')
        .update(contact.email + 'vuf-unsubscribe-salt')
        .digest('hex')
        .substring(0, 32);
      const unsubscribeLink = `${frontendUrl}/unsubscribe/${token}`;

      const variables = { name: contact.name, email: contact.email, unsubscribeLink };
      const rendered = {
        subject: subjectTemplate(variables),
        html: htmlTemplate(variables),
        text: plainTemplate(variables),
      };

      let attempts = 0;
      const maxAttempts = 3;
      let lastError = null;

      while (attempts < maxAttempts) {
        try {
          await sendEmail({
            to: contact.email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
          });

          await prisma.contact.update({
            where: { id: contact.id },
            data: {
              deliveryStatus: 'sent',
              deliveryError: null,
              sentAt: new Date(),
            },
          });
          return { id: contact.id, status: 'sent' };
        } catch (err) {
          attempts++;
          lastError = err;
          console.warn(`[Retry Warning] Attempt ${attempts} failed for ${contact.email}: ${err.message}`);
          if (attempts < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      }

      // Final failure
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

  // Accumulate results
  let sentCount = 0;
  let failedCount = 0;
  for (const r of results) {
    if (r.status === 'sent') sentCount++;
    if (r.status === 'failed') failedCount++;
  }

  // Update stats in the DB in a single operation
  await prisma.upload.update({
    where: { id },
    data: {
      sentCount: { increment: sentCount },
      failedCount: { increment: failedCount },
      pendingCount: { decrement: contacts.length },
    },
  });

  return res.status(200).json({ sent: sentCount, failed: failedCount });
}));

// POST /uploads/:id/finalize
app.post('/api/uploads/:id/finalize', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const status = await checkUploadCompletion(id);
  return res.status(200).json({ status });
}));

// GET /uploads/:id/contacts
app.get('/api/uploads/:id/contacts', catchAsync(async (req, res) => {
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
    contacts,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
}));

// GET /uploads/:id
app.get('/api/uploads/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const upload = await prisma.upload.findUnique({
    where: { id },
    include: { template: true },
  });
  if (!upload) {
    return res.status(404).json({ message: 'Upload not found' });
  }
  return res.status(200).json(upload);
}));

// PUT /uploads/:id
app.put('/api/uploads/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { fileName, originalName } = req.body;
  const upload = await prisma.upload.findUnique({
    where: { id },
  });
  if (!upload) {
    return res.status(404).json({ message: 'Upload not found' });
  }

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
app.delete('/api/uploads/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const upload = await prisma.upload.findUnique({
    where: { id },
  });
  if (!upload) {
    return res.status(404).json({ message: 'Upload not found' });
  }
  await prisma.upload.delete({
    where: { id },
  });
  return res.status(200).json({ message: 'Upload deleted successfully' });
}));

// PUT /contacts/:id
app.put('/api/contacts/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { name, email } = req.body;

  const contact = await prisma.contact.findUnique({
    where: { id },
  });
  if (!contact) {
    return res.status(404).json({ message: 'Contact not found' });
  }

  const oldEmail = contact.email;
  const newEmail = email !== undefined ? email.trim().toLowerCase() : contact.email;
  const newName = name !== undefined ? name.trim() : contact.name;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  let newStatus = 'valid';
  let newError = null;

  if (!newEmail) {
    newStatus = 'invalid';
    newError = 'Email is empty';
  } else if (!emailRegex.test(newEmail)) {
    newStatus = 'invalid';
    newError = 'Invalid email format';
  } else {
    const isUnsubscribed = await prisma.unsubscribed.findUnique({
      where: { email: newEmail },
    });
    if (isUnsubscribed) {
      newStatus = 'unsubscribed';
      newError = 'Email is unsubscribed';
    } else {
      const duplicate = await prisma.contact.findFirst({
        where: {
          uploadId: contact.uploadId,
          email: newEmail,
          id: { not: id },
        },
      });
      if (duplicate) {
        newStatus = 'duplicate';
        newError = 'Duplicate email in file';
      }
    }
  }

  const updatedContact = await prisma.contact.update({
    where: { id },
    data: {
      name: newName,
      email: newEmail,
      status: newStatus,
      error: newError,
    },
  });

  if (oldEmail.toLowerCase() !== newEmail.toLowerCase()) {
    await revalidateDuplicatesForEmails(contact.uploadId, [oldEmail, newEmail]);
  }

  // Recount upload stats
  const uploadId = contact.uploadId;
  const [
    totalRows,
    validEmails,
    invalidEmails,
    duplicateEmails,
    unsubscribedEmails,
  ] = await Promise.all([
    prisma.contact.count({ where: { uploadId } }),
    prisma.contact.count({ where: { uploadId, status: 'valid' } }),
    prisma.contact.count({ where: { uploadId, status: 'invalid' } }),
    prisma.contact.count({ where: { uploadId, status: 'duplicate' } }),
    prisma.contact.count({ where: { uploadId, status: 'unsubscribed' } }),
  ]);

  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  const updateData = {
    totalRows,
    validEmails,
    invalidEmails,
    duplicateEmails,
    unsubscribedEmails,
  };

  if (upload && upload.status !== 'idle') {
    const [sentCount, failedCount, pendingCount, skippedCount] = await Promise.all([
      prisma.contact.count({ where: { uploadId, deliveryStatus: 'sent' } }),
      prisma.contact.count({ where: { uploadId, deliveryStatus: 'failed' } }),
      prisma.contact.count({ where: { uploadId, deliveryStatus: 'pending' } }),
      prisma.contact.count({ where: { uploadId, deliveryStatus: 'skipped' } }),
    ]);
    updateData.totalCount = validEmails;
    updateData.sentCount = sentCount;
    updateData.failedCount = failedCount;
    updateData.pendingCount = pendingCount;
    updateData.skippedCount = skippedCount;
  }

  await prisma.upload.update({
    where: { id: uploadId },
    data: updateData,
  });

  return res.status(200).json(updatedContact);
}));

// DELETE /contacts/:id
app.delete('/api/contacts/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);

  const contact = await prisma.contact.findUnique({
    where: { id },
  });
  if (!contact) {
    return res.status(404).json({ message: 'Contact not found' });
  }

  await prisma.contact.delete({
    where: { id },
  });

  await revalidateDuplicatesForEmails(contact.uploadId, [contact.email]);

  // Recount upload stats
  const uploadId = contact.uploadId;
  const [
    totalRows,
    validEmails,
    invalidEmails,
    duplicateEmails,
    unsubscribedEmails,
  ] = await Promise.all([
    prisma.contact.count({ where: { uploadId } }),
    prisma.contact.count({ where: { uploadId, status: 'valid' } }),
    prisma.contact.count({ where: { uploadId, status: 'invalid' } }),
    prisma.contact.count({ where: { uploadId, status: 'duplicate' } }),
    prisma.contact.count({ where: { uploadId, status: 'unsubscribed' } }),
  ]);

  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  const updateData = {
    totalRows,
    validEmails,
    invalidEmails,
    duplicateEmails,
    unsubscribedEmails,
  };

  if (upload && upload.status !== 'idle') {
    const [sentCount, failedCount, pendingCount, skippedCount] = await Promise.all([
      prisma.contact.count({ where: { uploadId, deliveryStatus: 'sent' } }),
      prisma.contact.count({ where: { uploadId, deliveryStatus: 'failed' } }),
      prisma.contact.count({ where: { uploadId, deliveryStatus: 'pending' } }),
      prisma.contact.count({ where: { uploadId, deliveryStatus: 'skipped' } }),
    ]);
    updateData.totalCount = validEmails;
    updateData.sentCount = sentCount;
    updateData.failedCount = failedCount;
    updateData.pendingCount = pendingCount;
    updateData.skippedCount = skippedCount;
  }

  await prisma.upload.update({
    where: { id: uploadId },
    data: updateData,
  });

  return res.status(200).json({ message: 'Contact deleted successfully' });
}));

// GET /templates
app.get('/api/templates', catchAsync(async (req, res) => {
  await authenticate(req);
  const templates = await prisma.template.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return res.status(200).json(templates);
}));

// POST /templates
app.post('/api/templates', catchAsync(async (req, res) => {
  await authenticate(req);
  const { name, subject, htmlBody, plainTextBody } = req.body;
  if (!name || !subject || !htmlBody || !plainTextBody) {
    return res.status(400).json({ message: 'name, subject, htmlBody, and plainTextBody are required' });
  }
  const template = await prisma.template.create({
    data: {
      name,
      subject,
      htmlBody,
      plainTextBody,
    },
  });
  return res.status(201).json(template);
}));

// POST /templates/:id/test
app.post('/api/templates/:id/test', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { testEmail } = req.body;
  if (!testEmail) {
    return res.status(400).json({ message: 'testEmail is required' });
  }

  const template = await prisma.template.findUnique({
    where: { id },
  });
  if (!template) {
    return res.status(404).json({ message: 'Template not found' });
  }

  const rendered = renderTemplate(
    { subject: template.subject, htmlBody: template.htmlBody, plainTextBody: template.plainTextBody },
    { name: 'Test User', email: testEmail, unsubscribeLink: '#' }
  );

  await sendEmail({
    to: testEmail,
    subject: `[TEST] ${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
  });

  return res.status(200).json({ message: 'Test email sent successfully' });
}));

// GET /templates/:id
app.get('/api/templates/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const template = await prisma.template.findUnique({
    where: { id },
  });
  if (!template) {
    return res.status(404).json({ message: 'Template not found' });
  }
  return res.status(200).json(template);
}));

// PUT /templates/:id
app.put('/api/templates/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const { name, subject, htmlBody, plainTextBody } = req.body;
  const template = await prisma.template.findUnique({
    where: { id },
  });
  if (!template) {
    return res.status(404).json({ message: 'Template not found' });
  }

  const updated = await prisma.template.update({
    where: { id },
    data: {
      name: name || template.name,
      subject: subject || template.subject,
      htmlBody: htmlBody || template.htmlBody,
      plainTextBody: plainTextBody || template.plainTextBody,
    },
  });
  return res.status(200).json(updated);
}));

// DELETE /templates/:id
app.delete('/api/templates/:id', catchAsync(async (req, res) => {
  const { id } = req.params;
  await authenticate(req);
  const template = await prisma.template.findUnique({
    where: { id },
  });
  if (!template) {
    return res.status(404).json({ message: 'Template not found' });
  }
  await prisma.template.delete({
    where: { id },
  });
  return res.status(200).json({ message: 'Template deleted successfully' });
}));

// GET /unsubscribe/:token
app.get('/api/unsubscribe/:token', catchAsync(async (req, res) => {
  const { token } = req.params;
  const existing = await prisma.unsubscribed.findUnique({
    where: { token },
  });

  if (existing) {
    return res.status(200).json({
      alreadyUnsubscribed: true,
      email: maskEmail(existing.email),
    });
  }
  return res.status(200).json({
    alreadyUnsubscribed: false,
    email: null,
  });
}));

// POST /unsubscribe/:token
app.post('/api/unsubscribe/:token', catchAsync(async (req, res) => {
  const { token } = req.params;
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  const expectedToken = crypto
    .createHash('sha256')
    .update(email.trim().toLowerCase() + 'vuf-unsubscribe-salt')
    .digest('hex')
    .substring(0, 32);

  if (expectedToken !== token) {
    return res.status(404).json({ message: 'Invalid unsubscribe link' });
  }

  const existing = await prisma.unsubscribed.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (existing) {
    return res.status(200).json({ message: 'You are already unsubscribed', email: maskEmail(email) });
  }

  await prisma.unsubscribed.create({
    data: {
      email: email.toLowerCase(),
      token,
    },
  });

  console.log(`[Unsubscribed] Email unsubscribed: ${email}`);
  return res.status(200).json({
    message: 'You have been successfully unsubscribed',
    email: maskEmail(email),
  });
}));

// Global error handler middleware
app.use((err, req, res, next) => {
  console.error(`[Express Error] API Error: ${err.stack || err.message}`);
  const status = err.message === 'Unauthorized' ? 401 : 400;
  return res.status(status).json({ message: err.message });
});

// Start Express Server
const PORT = process.env.PORT || 7071;
app.listen(PORT, () => {
  console.log(`[Express Started] Backend server listening on port ${PORT}`);
});

module.exports = app;
