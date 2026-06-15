const { app } = require('@azure/functions');
const df = require('durable-functions');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { prisma, ContactStatus } = require('./prisma');
const { generateToken, comparePassword, hashPassword, authenticate } = require('./auth');
const { sendEmail } = require('./email');
const { renderTemplate } = require('./templates-service');

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

  if (!upload) return;

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
  }
}

// --- 1. HTTP Dispatcher & Route Handlers ---
app.http('api', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  route: '{*segments}',
  extraInputs: [df.input.durableClient()],
  handler: async (request, context) => {
    // Enable CORS preflight interceptor
    if (request.method === 'OPTIONS') {
      return {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': request.headers.get('origin') || '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Credentials': 'true',
        },
      };
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': request.headers.get('origin') || '*',
      'Access-Control-Allow-Credentials': 'true',
      'Content-Type': 'application/json',
    };

    const sendJson = (status, data) => ({
      status,
      headers: corsHeaders,
      body: JSON.stringify(data),
    });

    const url = new URL(request.url);
    // Normalize path by stripping trailing slash
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '');
    const method = request.method;

    context.log(`[Request Received] ${method} ${path}`);

    try {
      let match;

      // ──────────────────────────────────────────
      // AUTHENTICATION ROUTES
      // ──────────────────────────────────────────

      // POST /auth/login
      if (path === '/auth/login' && method === 'POST') {
        const body = await request.json();
        if (!body.email || !body.password) {
          return sendJson(400, { message: 'Email and password are required' });
        }

        const admin = await prisma.admin.findUnique({
          where: { email: body.email.toLowerCase() },
        });
        if (!admin) {
          return sendJson(401, { message: 'Invalid credentials' });
        }

        const isPasswordValid = await comparePassword(body.password, admin.password);
        if (!isPasswordValid) {
          return sendJson(401, { message: 'Invalid credentials' });
        }

        const token = generateToken({ id: admin.id, email: admin.email, name: admin.name });
        return sendJson(200, {
          access_token: token,
          admin: {
            id: admin.id,
            email: admin.email,
            name: admin.name,
          },
        });
      }

      // GET /auth/me
      if (path === '/auth/me' && method === 'GET') {
        const user = await authenticate(request);
        const admin = await prisma.admin.findUnique({
          where: { id: user.id },
          select: { id: true, email: true, name: true, createdAt: true },
        });
        if (!admin) {
          return sendJson(404, { message: 'Admin not found' });
        }
        return sendJson(200, admin);
      }

      // ──────────────────────────────────────────
      // UPLOADS ROUTES
      // ──────────────────────────────────────────

      // GET /uploads/stats/dashboard
      if (path === '/uploads/stats/dashboard' && method === 'GET') {
        await authenticate(request);
        const [totalUploads, totalTemplates, totalEmailsSent, totalFailedEmails] = await Promise.all([
          prisma.upload.count(),
          prisma.template.count(),
          prisma.contact.count({ where: { deliveryStatus: 'sent' } }),
          prisma.contact.count({ where: { deliveryStatus: 'failed' } }),
        ]);
        return sendJson(200, {
          totalUploads,
          totalTemplates,
          totalEmailsSent,
          totalFailedEmails,
        });
      }

      // GET /uploads
      if (path === '/uploads' && method === 'GET') {
        await authenticate(request);
        const uploads = await prisma.upload.findMany({
          include: { template: true },
          orderBy: { createdAt: 'desc' },
        });
        return sendJson(200, uploads);
      }

      // POST /uploads/excel (In-memory upload parsing)
      if (path === '/uploads/excel' && method === 'POST') {
        await authenticate(request);
        const formData = await request.formData();
        const fileEntry = formData.get('file');
        if (!fileEntry) {
          return sendJson(400, { message: 'No file uploaded' });
        }

        const buffer = Buffer.from(await fileEntry.arrayBuffer());
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet);

        if (rows.length === 0) {
          return sendJson(400, { message: 'Excel file is empty' });
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
          return sendJson(400, { message: 'Excel file must contain "name" and "email" columns' });
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
            fileName: fileEntry.name || 'uploaded_file.xlsx',
            originalName: fileEntry.name || 'uploaded_file.xlsx',
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

        return sendJson(201, upload);
      }

      // POST /uploads/:id/send (Trigger Durable Orchestration)
      if ((match = path.match(/^\/uploads\/([a-zA-Z0-9-]+)\/send$/)) && method === 'POST') {
        const id = match[1];
        await authenticate(request);
        const body = await request.json();
        const templateId = body.templateId;

        const upload = await prisma.upload.findUnique({
          where: { id },
        });

        if (!upload) {
          return sendJson(404, { message: 'Upload not found' });
        }
        if (upload.status !== 'idle') {
          return sendJson(400, { message: `Email sending has already been initiated (status: ${upload.status})` });
        }

        const template = await prisma.template.findUnique({
          where: { id: templateId },
        });
        if (!template) {
          return sendJson(404, { message: 'Template not found' });
        }

        const contacts = await prisma.contact.findMany({
          where: { uploadId: id, status: 'valid' },
        });
        if (contacts.length === 0) {
          return sendJson(400, { message: 'No valid contacts found in this upload' });
        }

        const unsubscribed = await prisma.unsubscribed.findMany();
        const unsubscribedSet = new Set(unsubscribed.map((u) => u.email.toLowerCase()));

        let pendingCount = 0;
        let skippedCount = 0;

        // Sync local states
        for (const contact of contacts) {
          const isUnsubscribed = unsubscribedSet.has(contact.email.toLowerCase());
          if (isUnsubscribed) {
            skippedCount++;
            await prisma.contact.update({
              where: { id: contact.id },
              data: { deliveryStatus: 'skipped', deliveryError: 'Email is unsubscribed' },
            });
          } else {
            pendingCount++;
            await prisma.contact.update({
              where: { id: contact.id },
              data: { deliveryStatus: 'pending' },
            });
          }
        }

        await prisma.upload.update({
          where: { id },
          data: {
            status: 'processing',
            templateId,
            totalCount: contacts.length,
            pendingCount,
            skippedCount,
          },
        });

        const queuedContacts = contacts.filter((c) => !unsubscribedSet.has(c.email.toLowerCase()));

        // Start Durable Orchestrator
        const client = df.getClient(context);
        const instanceId = await client.startNew('emailOrchestrator', {
          input: {
            uploadId: id,
            templateId,
            contacts: queuedContacts.map((c) => ({ id: c.id, email: c.email, name: c.name })),
          },
        });

        return sendJson(200, {
          message: 'Sending initiated',
          totalCount: contacts.length,
          queuedCount: pendingCount,
          skippedCount,
          instanceId,
        });
      }

      // GET /uploads/:id/contacts
      if ((match = path.match(/^\/uploads\/([a-zA-Z0-9-]+)\/contacts$/)) && method === 'GET') {
        const id = match[1];
        await authenticate(request);
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
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

        return sendJson(200, {
          contacts,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        });
      }

      // GET /uploads/:id
      if ((match = path.match(/^\/uploads\/([a-zA-Z0-9-]+)$/)) && method === 'GET') {
        const id = match[1];
        await authenticate(request);
        const upload = await prisma.upload.findUnique({
          where: { id },
          include: { template: true },
        });
        if (!upload) {
          return sendJson(404, { message: 'Upload not found' });
        }
        return sendJson(200, upload);
      }

      // PUT /uploads/:id
      if ((match = path.match(/^\/uploads\/([a-zA-Z0-9-]+)$/)) && method === 'PUT') {
        const id = match[1];
        await authenticate(request);
        const body = await request.json();
        const upload = await prisma.upload.findUnique({
          where: { id },
        });
        if (!upload) {
          return sendJson(404, { message: 'Upload not found' });
        }

        const updated = await prisma.upload.update({
          where: { id },
          data: {
            fileName: body.fileName || upload.fileName,
            originalName: body.originalName || upload.originalName,
          },
        });
        return sendJson(200, updated);
      }

      // DELETE /uploads/:id
      if ((match = path.match(/^\/uploads\/([a-zA-Z0-9-]+)$/)) && method === 'DELETE') {
        const id = match[1];
        await authenticate(request);
        const upload = await prisma.upload.findUnique({
          where: { id },
        });
        if (!upload) {
          return sendJson(404, { message: 'Upload not found' });
        }
        await prisma.upload.delete({
          where: { id },
        });
        return sendJson(200, { message: 'Upload deleted successfully' });
      }

      // ──────────────────────────────────────────
      // TEMPLATES ROUTES
      // ──────────────────────────────────────────

      // GET /templates
      if (path === '/templates' && method === 'GET') {
        await authenticate(request);
        const templates = await prisma.template.findMany({
          orderBy: { createdAt: 'desc' },
        });
        return sendJson(200, templates);
      }

      // POST /templates
      if (path === '/templates' && method === 'POST') {
        await authenticate(request);
        const body = await request.json();
        if (!body.name || !body.subject || !body.htmlBody || !body.plainTextBody) {
          return sendJson(400, { message: 'name, subject, htmlBody, and plainTextBody are required' });
        }
        const template = await prisma.template.create({
          data: {
            name: body.name,
            subject: body.subject,
            htmlBody: body.htmlBody,
            plainTextBody: body.plainTextBody,
          },
        });
        return sendJson(201, template);
      }

      // POST /templates/:id/test
      if ((match = path.match(/^\/templates\/([a-zA-Z0-9-]+)\/test$/)) && method === 'POST') {
        const id = match[1];
        await authenticate(request);
        const body = await request.json();
        if (!body.testEmail) {
          return sendJson(400, { message: 'testEmail is required' });
        }

        const template = await prisma.template.findUnique({
          where: { id },
        });
        if (!template) {
          return sendJson(404, { message: 'Template not found' });
        }

        const rendered = renderTemplate(
          { subject: template.subject, htmlBody: template.htmlBody, plainTextBody: template.plainTextBody },
          { name: 'Test User', email: body.testEmail, unsubscribeLink: '#' }
        );

        await sendEmail({
          to: body.testEmail,
          subject: `[TEST] ${rendered.subject}`,
          html: rendered.html,
          text: rendered.text,
        });

        return sendJson(200, { message: 'Test email sent successfully' });
      }

      // GET /templates/:id
      if ((match = path.match(/^\/templates\/([a-zA-Z0-9-]+)$/)) && method === 'GET') {
        const id = match[1];
        await authenticate(request);
        const template = await prisma.template.findUnique({
          where: { id },
        });
        if (!template) {
          return sendJson(404, { message: 'Template not found' });
        }
        return sendJson(200, template);
      }

      // PUT /templates/:id
      if ((match = path.match(/^\/templates\/([a-zA-Z0-9-]+)$/)) && method === 'PUT') {
        const id = match[1];
        await authenticate(request);
        const body = await request.json();
        const template = await prisma.template.findUnique({
          where: { id },
        });
        if (!template) {
          return sendJson(404, { message: 'Template not found' });
        }

        const updated = await prisma.template.update({
          where: { id },
          data: {
            name: body.name || template.name,
            subject: body.subject || template.subject,
            htmlBody: body.htmlBody || template.htmlBody,
            plainTextBody: body.plainTextBody || template.plainTextBody,
          },
        });
        return sendJson(200, updated);
      }

      // DELETE /templates/:id
      if ((match = path.match(/^\/templates\/([a-zA-Z0-9-]+)$/)) && method === 'DELETE') {
        const id = match[1];
        await authenticate(request);
        const template = await prisma.template.findUnique({
          where: { id },
        });
        if (!template) {
          return sendJson(404, { message: 'Template not found' });
        }
        await prisma.template.delete({
          where: { id },
        });
        return sendJson(200, { message: 'Template deleted successfully' });
      }

      // ──────────────────────────────────────────
      // UNSUBSCRIBE ROUTES
      // ──────────────────────────────────────────

      // GET /unsubscribe/:token
      if ((match = path.match(/^\/unsubscribe\/([a-zA-Z0-9]+)$/)) && method === 'GET') {
        const token = match[1];
        const existing = await prisma.unsubscribed.findUnique({
          where: { token },
        });

        if (existing) {
          return sendJson(200, {
            alreadyUnsubscribed: true,
            email: maskEmail(existing.email),
          });
        }
        return sendJson(200, {
          alreadyUnsubscribed: false,
          email: null,
        });
      }

      // POST /unsubscribe/:token
      if ((match = path.match(/^\/unsubscribe\/([a-zA-Z0-9]+)$/)) && method === 'POST') {
        const token = match[1];
        const body = await request.json();
        const email = body.email;
        if (!email) {
          return sendJson(400, { message: 'Email is required' });
        }

        // Verify token match
        const expectedToken = crypto
          .createHash('sha256')
          .update(email.trim().toLowerCase() + 'vuf-unsubscribe-salt')
          .digest('hex')
          .substring(0, 32);

        if (expectedToken !== token) {
          return sendJson(404, { message: 'Invalid unsubscribe link' });
        }

        const existing = await prisma.unsubscribed.findUnique({
          where: { email: email.toLowerCase() },
        });

        if (existing) {
          return sendJson(200, { message: 'You are already unsubscribed', email: maskEmail(email) });
        }

        await prisma.unsubscribed.create({
          data: {
            email: email.toLowerCase(),
            token,
          },
        });

        console.log(`[Unsubscribed] Email unsubscribed: ${email}`);
        return sendJson(200, {
          message: 'You have been successfully unsubscribed',
          email: maskEmail(email),
        });
      }

      // Catch-all 404 Route
      return sendJson(404, { message: `Route ${method} ${path} not found` });
    } catch (error) {
      context.error(`API Error on ${method} ${path}: ${error.message}`);
      return sendJson(error.message === 'Unauthorized' ? 401 : 400, { message: error.message });
    }
  },
});

// --- 2. Durable Orchestrator ---
df.app.orchestration('emailOrchestrator', function* (context) {
  const input = context.df.getInput();
  const { uploadId, templateId, contacts } = input;

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];

    // Trigger sending activity
    yield context.df.callActivity('sendEmailActivity', {
      uploadId,
      contactId: contact.id,
      templateId,
    });

    // Enforce 200ms rate limiting delay
    const nextFireAt = new Date(context.df.currentUtcDateTime.getTime() + 200);
    yield context.df.createTimer(nextFireAt);
  }
});

// --- 3. Durable Activity ---
df.app.activity('sendEmailActivity', {
  handler: async (input, context) => {
    const { uploadId, contactId, templateId } = input;
    context.log(`[Activity Invoked] Sending email for contact ${contactId}`);

    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
    });

    if (!contact || contact.deliveryStatus === 'sent' || contact.deliveryStatus === 'skipped') {
      return;
    }

    // Double check unsubscribed list
    const isUnsubscribed = await prisma.unsubscribed.findUnique({
      where: { email: contact.email },
    });

    if (isUnsubscribed) {
      await prisma.contact.update({
        where: { id: contactId },
        data: { deliveryStatus: 'skipped', deliveryError: 'Email is unsubscribed' },
      });
      await prisma.upload.update({
        where: { id: uploadId },
        data: {
          skippedCount: { increment: 1 },
          pendingCount: { decrement: 1 },
        },
      });
      await checkUploadCompletion(uploadId);
      return;
    }

    const template = await prisma.template.findUnique({
      where: { id: templateId },
    });
    if (!template) {
      throw new Error(`Template ${templateId} not found`);
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const token = crypto
      .createHash('sha256')
      .update(contact.email + 'vuf-unsubscribe-salt')
      .digest('hex')
      .substring(0, 32);
    const unsubscribeLink = `${frontendUrl}/unsubscribe/${token}`;

    const rendered = renderTemplate(
      { subject: template.subject, htmlBody: template.htmlBody, plainTextBody: template.plainTextBody },
      { name: contact.name, email: contact.email, unsubscribeLink }
    );

    let attempts = 0;
    const maxAttempts = 3;
    let lastError = null;

    while (attempts < maxAttempts) {
      try {
        const result = await sendEmail({
          to: contact.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });

        // Log success in DB
        await prisma.contact.update({
          where: { id: contactId },
          data: {
            deliveryStatus: 'sent',
            deliveryError: null,
            sentAt: new Date().toISOString(),
          },
        });

        await prisma.upload.update({
          where: { id: uploadId },
          data: {
            sentCount: { increment: 1 },
            pendingCount: { decrement: 1 },
          },
        });

        console.log(`[Success] Email successfully sent to ${contact.email}`);
        await checkUploadCompletion(uploadId);
        return;
      } catch (err) {
        attempts++;
        lastError = err;
        console.warn(`[Retry Warning] Attempt ${attempts} failed for ${contact.email}: ${err.message}`);
        if (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    // All retries failed - log permanent failure in DB
    console.error(`[Permanent Failure] Failed to send email to ${contact.email} after ${maxAttempts} attempts`);
    await prisma.contact.update({
      where: { id: contactId },
      data: {
        deliveryStatus: 'failed',
        deliveryError: lastError?.message || 'All retry attempts failed',
      },
    });

    await prisma.upload.update({
      where: { id: uploadId },
      data: {
        failedCount: { increment: 1 },
        pendingCount: { decrement: 1 },
      },
    });

    await checkUploadCompletion(uploadId);
  },
});
