const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const nodemailer = require('nodemailer');

const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || 'noreply@vuf.org';
const AWS_REGION = process.env.AWS_REGION || 'ap-south-1';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || '';
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || '';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';

// Initialize AWS SES Client
const sesClient = new SESClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

// Initialize NodeMailer SMTP Transporter fallback
const smtpTransporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

async function sendViaSES(options) {
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
  const info = await smtpTransporter.sendMail({
    from: SES_FROM_EMAIL,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });
  return info.messageId || 'unknown';
}

async function sendEmail(options) {
  try {
    const messageId = await sendViaSES(options);
    console.log(`Email sent via SES to ${options.to}: ${messageId}`);
    return { messageId, provider: 'ses' };
  } catch (sesError) {
    console.warn(
      `SES failed for ${options.to}: ${sesError.message}. Falling back to SMTP.`,
    );
  }

  try {
    const messageId = await sendViaSMTP(options);
    console.log(`Email sent via SMTP to ${options.to}: ${messageId}`);
    return { messageId, provider: 'smtp' };
  } catch (smtpError) {
    console.error(
      `SMTP also failed for ${options.to}: ${smtpError.message}`,
    );
    throw new Error(
      `All email providers failed: SES and SMTP both returned errors. (SMTP Error: ${smtpError.message})`,
    );
  }
}

module.exports = { sendEmail };
