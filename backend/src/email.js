const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const nodemailer = require('nodemailer');
const path = require('path');

const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || 'noreply@vuf.org';
const AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || '';
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || '';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';

// Initialize AWS SES Client
const isSesConfigured =
  AWS_ACCESS_KEY_ID &&
  AWS_ACCESS_KEY_ID !== 'your-access-key' &&
  AWS_ACCESS_KEY_ID.trim() !== '' &&
  AWS_SECRET_ACCESS_KEY &&
  AWS_SECRET_ACCESS_KEY !== 'your-secret-key' &&
  AWS_SECRET_ACCESS_KEY.trim() !== '';

const sesClient = isSesConfigured ? new SESClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
}) : null;

// Parse all SMTP configurations
const smtpAccounts = [];

// Add default SMTP account if configured
if (SMTP_USER && SMTP_PASS) {
  smtpAccounts.push({
    user: SMTP_USER.trim(),
    pass: SMTP_PASS.trim(),
    host: SMTP_HOST || 'smtp.gmail.com',
    port: SMTP_PORT || 587,
  });
}

// Add numbered SMTP accounts (e.g., SMTP_USER_1, SMTP_USER_2...)
for (let i = 1; i <= 10; i++) {
  const user = process.env[`SMTP_USER_${i}`];
  const pass = process.env[`SMTP_PASS_${i}`];
  if (user && pass) {
    smtpAccounts.push({
      user: user.trim(),
      pass: pass.trim(),
      host: process.env[`SMTP_HOST_${i}`] || SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env[`SMTP_PORT_${i}`] || SMTP_PORT || '587', 10),
    });
  }
}

// Keep track of active connection-pooled transporters
const transporters = {};

/**
 * Returns a nodemailer transporter and the corresponding verified 'from' address
 * matching the selected email. Falls back to the primary SMTP user if not found.
 */
function getTransporter(email) {
  let config;
  
  if (email) {
    config = smtpAccounts.find(
      (acc) => acc.user.toLowerCase() === email.toLowerCase().trim()
    );
  }

  // Fallback to the first available SMTP configuration
  if (!config) {
    if (smtpAccounts.length > 0) {
      config = smtpAccounts[0];
    } else {
      throw new Error('No SMTP configurations found in environmental variables.');
    }
  }

  const key = `${config.host}:${config.port}:${config.user}`;
  if (!transporters[key]) {
    transporters[key] = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });
  }

  return {
    transporter: transporters[key],
    from: config.user,
  };
}

async function sendViaSES(options) {
  if (!sesClient) {
    throw new Error('SES client is not initialized');
  }
  const command = new SendEmailCommand({
    Source: SES_FROM_EMAIL,
    Destination: {
      ToAddresses: [options.to],
    },
    Message: {
      Subject: {
        Data: options.subject,
        Charset: 'UTF-8',
      },
      Body: {
        Html: {
          Data: options.html,
          Charset: 'UTF-8',
        },
        Text: {
          Data: options.text,
          Charset: 'UTF-8',
        },
      },
    },
  });

  const response = await sesClient.send(command);
  return response.MessageId || 'unknown';
}

async function sendViaSMTP(options) {
  const { transporter, from } = getTransporter(options.senderEmail);

  const info = await transporter.sendMail({
    from: `Vishv Umiya Foundation (VUF) <${from}>`,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
    attachments: options.attachments || [],
  });
  return info.messageId || 'unknown';
}

async function sendEmail(options) {
  if (isSesConfigured) {
    try {
      const messageId = await sendViaSES(options);
      console.log(`Email sent via SES to ${options.to}: ${messageId}`);
      return { messageId, provider: 'ses' };
    } catch (sesError) {
      console.warn(
        `SES failed for ${options.to}: ${sesError.message}. Falling back to SMTP.`,
      );
    }
  }

  try {
    const messageId = await sendViaSMTP(options);
    console.log(`Email sent via SMTP to ${options.to} using ${options.senderEmail || 'default'}: ${messageId}`);
    return { messageId, provider: 'smtp' };
  } catch (smtpError) {
    console.error(
      `SMTP failed for ${options.to}: ${smtpError.message}`,
    );
    throw new Error(
      `All email providers failed. SMTP Error: ${smtpError.message}`,
    );
  }
}

module.exports = {
  sendEmail,
  smtpAccounts,
};
