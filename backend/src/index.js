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

// Helper to re-evaluate duplicate status for specific emails in an upload
async function revalidateDuplicatesForEmails(uploadId, emails) {
  const uniqueEmails = [...new Set(emails.filter(Boolean).map(e => e.trim().toLowerCase()))];
  if (uniqueEmails.length === 0) return;
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
  const unsubscribedList = await prisma.unsubscribed.findMany({
    where: { email: { in: uniqueEmails } }
  });
  const unsubscribedSet = new Set(unsubscribedList.map(u => u.email.toLowerCase()));
  
  for (const email of uniqueEmails) {
    const contacts = await prisma.contact.findMany({
      where: { uploadId, email },
    });
    
    if (contacts.length === 0) continue;
    
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
  }
}

// --- 1. HTTP Dispatcher & Route Handlers ---
app.http('api', {
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  route: '{*segments}',
  authLevel: 'anonymous',
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
        const unsubscribedArray = [...unsubscribedSet];

        // Batch update all contacts in 2 queries instead of N individual updates
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
          },
        });

        const queuedContacts = contacts.filter((c) => !unsubscribedSet.has(c.email.toLowerCase()));

        // Start Durable Orchestrator
        const client = df.getClient(context);
        const instanceId = await client.startNew('emailOrchestrator', {
          input: {
            uploadId: id,
            templateId,
            templateSubject: template.subject,
            templateHtmlBody: template.htmlBody,
            templatePlainTextBody: template.plainTextBody,
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

      // PUT /contacts/:id
      if ((match = path.match(/^\/contacts\/([a-zA-Z0-9-]+)$/)) && method === 'PUT') {
        const id = match[1];
        await authenticate(request);
        const body = await request.json();
        const { name, email } = body;

        const contact = await prisma.contact.findUnique({
          where: { id },
        });
        if (!contact) {
          return sendJson(404, { message: 'Contact not found' });
        }

        const oldEmail = contact.email;
        const newEmail = email !== undefined ? email.trim().toLowerCase() : contact.email;
        const newName = name !== undefined ? name.trim() : contact.name;

        // Perform validation for the updated contact
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        let newStatus = 'valid';
        let newError = null;

        if (!newEmail) {
          newStatus = 'invalid';
          newError = 'Email is empty';
        } else if (!emailRegex.test(newEmail.toLowerCase())) {
          newStatus = 'invalid';
          newError = 'Invalid email format';
        } else {
          // Check unsubscribe
          const isUnsubscribed = await prisma.unsubscribed.findUnique({
            where: { email: newEmail.toLowerCase() },
          });
          if (isUnsubscribed) {
            newStatus = 'unsubscribed';
            newError = 'Email is unsubscribed';
          } else {
            // Check duplicate in same upload (excluding self)
            const duplicate = await prisma.contact.findFirst({
              where: {
                uploadId: contact.uploadId,
                email: newEmail.toLowerCase(),
                id: { not: id },
              },
            });
            if (duplicate) {
              newStatus = 'duplicate';
              newError = 'Duplicate email in file';
            }
          }
        }

        // Update contact record
        const updatedContact = await prisma.contact.update({
          where: { id },
          data: {
            name: newName,
            email: newEmail,
            status: newStatus,
            error: newError,
          },
        });

        // Resolve duplicates across the upload for affected emails
        if (oldEmail.toLowerCase() !== newEmail.toLowerCase()) {
          await revalidateDuplicatesForEmails(contact.uploadId, [oldEmail, newEmail]);
        }

        // Recount upload stats to keep it 100% accurate and consistent
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

        return sendJson(200, updatedContact);
      }

      // DELETE /contacts/:id
      if ((match = path.match(/^\/contacts\/([a-zA-Z0-9-]+)$/)) && method === 'DELETE') {
        const id = match[1];
        await authenticate(request);

        const contact = await prisma.contact.findUnique({
          where: { id },
        });
        if (!contact) {
          return sendJson(404, { message: 'Contact not found' });
        }

        await prisma.contact.delete({
          where: { id },
        });

        // Resolve duplicates across the upload for this deleted contact's email
        await revalidateDuplicatesForEmails(contact.uploadId, [contact.email]);

        // Recount upload stats to keep it 100% accurate and consistent
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

        return sendJson(200, { message: 'Contact deleted successfully' });
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
  const { uploadId, templateId, templateSubject, templateHtmlBody, templatePlainTextBody, contacts } = input;

  const batchSize = parseInt(process.env.BATCH_SIZE || '25', 10);

  for (let i = 0; i < contacts.length; i += batchSize) {
    const batch = contacts.slice(i, i + batchSize);

    // Call sending activities concurrently
    const tasks = batch.map((contact) =>
      context.df.callActivity('sendEmailActivity', {
        uploadId,
        contactId: contact.id,
        email: contact.email,
        name: contact.name,
        templateSubject,
        templateHtmlBody,
        templatePlainTextBody,
      })
    );

    const results = yield context.df.Task.all(tasks);

    // Accumulate results for the batch
    let sentCount = 0;
    let failedCount = 0;
    for (const res of results) {
      if (res) {
        if (res.status === 'sent') sentCount++;
        if (res.status === 'failed') failedCount++;
      }
    }

    // Update upload stats in one query for this batch
    yield context.df.callActivity('updateUploadStatsActivity', {
      uploadId,
      sentCount,
      failedCount,
      pendingDecrement: batch.length,
    });

    // Short timer between batches to respect SMTP / SES rate limits
    const nextFireAt = new Date(context.df.currentUtcDateTime.getTime() + 200);
    yield context.df.createTimer(nextFireAt);
  }

  // Final check and complete status
  yield context.df.callActivity('finalizeUploadActivity', { uploadId });
});

// --- 3. Durable Activities ---

// Activity to send email to a single contact
df.app.activity('sendEmailActivity', {
  handler: async (input, context) => {
    const { uploadId, contactId, email, name, templateSubject, templateHtmlBody, templatePlainTextBody } = input;
    context.log(`[Activity Invoked] Sending email to ${email} (contact ${contactId})`);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const token = crypto
      .createHash('sha256')
      .update(email + 'vuf-unsubscribe-salt')
      .digest('hex')
      .substring(0, 32);
    const unsubscribeLink = `${frontendUrl}/unsubscribe/${token}`;

    const rendered = renderTemplate(
      { subject: templateSubject, htmlBody: templateHtmlBody, plainTextBody: templatePlainTextBody },
      { name, email, unsubscribeLink }
    );

    let attempts = 0;
    const maxAttempts = 3;
    let lastError = null;

    while (attempts < maxAttempts) {
      try {
        await sendEmail({
          to: email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });

        // Log success in DB for this contact
        await prisma.contact.update({
          where: { id: contactId },
          data: {
            deliveryStatus: 'sent',
            deliveryError: null,
            sentAt: new Date().toISOString(),
          },
        });

        console.log(`[Success] Email successfully sent to ${email}`);
        return { status: 'sent' };
      } catch (err) {
        attempts++;
        lastError = err;
        console.warn(`[Retry Warning] Attempt ${attempts} failed for ${email}: ${err.message}`);
        if (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    }

    // All retries failed - log permanent failure in DB
    console.error(`[Permanent Failure] Failed to send email to ${email} after ${maxAttempts} attempts`);
    await prisma.contact.update({
      where: { id: contactId },
      data: {
        deliveryStatus: 'failed',
        deliveryError: lastError?.message || 'All retry attempts failed',
      },
    });

    return { status: 'failed' };
  },
});

// Activity to update upload statistics for a batch
df.app.activity('updateUploadStatsActivity', {
  handler: async (input, context) => {
    const { uploadId, sentCount, failedCount, pendingDecrement } = input;
    context.log(`[Stats Update] Updating upload ${uploadId}: +${sentCount} sent, +${failedCount} failed`);

    await prisma.upload.update({
      where: { id: uploadId },
      data: {
        sentCount: { increment: sentCount },
        failedCount: { increment: failedCount },
        pendingCount: { decrement: pendingDecrement },
      },
    });
  },
});

// Activity to finalize the upload status
df.app.activity('finalizeUploadActivity', {
  handler: async (input, context) => {
    const { uploadId } = input;
    context.log(`[Finalize Campaign] Finalizing status for upload ${uploadId}`);
    await checkUploadCompletion(uploadId);
  },
});
