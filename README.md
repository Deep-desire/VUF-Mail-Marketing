# VUF Mail Marketing System

A production-ready email marketing system for VUF.org built with React + NestJS.

---

## 🏗️ Tech Stack

### Frontend
- React 18 + TypeScript
- Vite
- Tailwind CSS 3
- React Router 6
- React Hook Form
- TanStack Table
- Axios
- Lucide React Icons

### Backend
- NestJS 10 + TypeScript
- Prisma ORM + Supabase (PostgreSQL)
- Redis + BullMQ (job queue)
- Amazon SES (primary email)
- Nodemailer SMTP (fallback)
- Handlebars (template rendering)
- Multer (file uploads)
- xlsx (Excel parsing)
- JWT Authentication
- Passport.js

---

## 🚀 Quick Start with Docker

### Prerequisites
- Docker & Docker Compose installed

### Steps

```bash
# 1. Clone the repository
cd "Mail Marketing VUF"

# 2. Copy environment variables
cp backend/.env.example backend/.env

# 3. Edit backend/.env with your credentials (AWS SES, SMTP, and Supabase Database URLs)

# 4. Start all services
docker-compose up -d --build

# 5. Access the application
# Frontend: http://localhost
# Backend API: http://localhost:3000/api
```

### Default Admin Login
- **Email:** admin@vuf.org
- **Password:** admin123

---

## 🛠️ Manual Development Setup

### Prerequisites
- Node.js 20+
- Redis 7
- Supabase Project (PostgreSQL)

### Backend Setup

1. **Configure Environment Variables**:
   Go to your Supabase Project -> **Settings** -> **Database** -> **Connection string** -> **URI**. Copy your connection URLs:
   - For `DATABASE_URL`, copy the **Transaction Mode** URI (uses port `6543`, ends with `?pgbouncer=true`).
   - For `DIRECT_URL`, copy the **Session Mode** URI (uses port `5432`).

   Create your `.env` file in the `backend/` folder:
   ```bash
   cd backend
   cp .env.example .env
   ```
   Open `.env` and fill in `DATABASE_URL` and `DIRECT_URL` (replacing `[YOUR-PASSWORD]` and `[YOUR-REGION]` with your Supabase DB password and region).

2. **Install & Sync Database**:
   ```bash
   # Install dependencies
   npm install

   # Generate Prisma client types
   npx prisma generate

   # Push schema to your Supabase database
   npx prisma db push

   # Seed default admin login credentials
   npm run prisma:seed

   # Start development server
   npm run start:dev
   ```

### Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm run dev
```

---

## 📋 API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/login | Admin login |
| GET | /api/auth/me | Get current admin |

### Uploads & Sending
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/uploads/excel | Upload Excel file & validate |
| GET | /api/uploads | List all uploads |
| GET | /api/uploads/:id | Get upload details |
| GET | /api/uploads/:id/contacts | Get contacts in upload |
| POST | /api/uploads/:id/send | Start sending template to upload |
| GET | /api/uploads/stats/dashboard | Dashboard metrics stats |

### Templates
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/templates | Create template |
| GET | /api/templates | List all templates |
| GET | /api/templates/:id | Get template |
| PUT | /api/templates/:id | Update template |
| DELETE | /api/templates/:id | Delete template |
| POST | /api/templates/:id/test | Send test email |

### Unsubscribe (Public)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/unsubscribe/:token | Get unsubscribe status |
| POST | /api/unsubscribe/:token | Process unsubscribe |

---

## 📧 Email Sending Flow

1. **Upload Excel**: Admin uploads an Excel file with `name` and `email` columns. The backend validates email formats, filters duplicates, and checks unsubscribes.
2. **Create Template**: Admin designs an email template using variables `{{name}}`, `{{email}}`, and `{{unsubscribeLink}}`.
3. **Send Emails**: Admin opens the upload's details page, clicks **Send Email Template**, selects the template, and initiates sending.
4. **Queue Processing**: Backend marks contacts as `pending` and adds bulk jobs into the BullMQ queue.
5. **Worker Execution**: The BullMQ processor executes sends with a 200ms delay to prevent rate issues, rendering HTML body with Handlebars and sending via AWS SES (with Nodemailer SMTP fallback).
6. **Live Report**: The upload details page tracks sent, failed, pending, and skipped counts in real-time.

---

## 🔧 Environment Variables

| Variable | Description |
|----------|-------------|
| DATABASE_URL | Supabase pooled connection string (port 6543) |
| DIRECT_URL | Supabase direct connection string for migrations (port 5432) |
| REDIS_HOST | Redis host (default: localhost) |
| REDIS_PORT | Redis port (default: 6379) |
| JWT_SECRET | JWT token secret |
| JWT_EXPIRES_IN| JWT token expiry (default: 24h) |
| AWS_REGION | AWS region for SES |
| AWS_ACCESS_KEY_ID | AWS access key |
| AWS_SECRET_ACCESS_KEY | AWS secret key |
| SES_FROM_EMAIL | Sender email address (default: noreply@vuf.org) |
| SMTP_HOST | SMTP server host (fallback) |
| SMTP_PORT | SMTP server port |
| SMTP_USER | SMTP username |
| SMTP_PASS | SMTP password |
| FRONTEND_URL | Frontend URL (for unsubscribe links) |
| APP_PORT | Backend port (default: 3000) |

---

## 📁 Project Structure

```
├── docker-compose.yml
├── README.md
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── package.json
│   ├── tailwind.config.js
│   ├── vite.config.ts
│   └── src/
│       ├── api/          # API helper callers
│       ├── components/   # Reusable layouts, cards, status badges
│       ├── pages/        # Login, Dashboard, Uploads, Templates
│       ├── types/        # TypeScript interfaces
│       ├── App.tsx
│       └── main.tsx
└── backend/
    ├── Dockerfile
    ├── package.json
    ├── nest-cli.json
    ├── prisma/
    │   ├── schema.prisma
    │   └── seed.ts
    └── src/
        ├── auth/         # JWT authentication
        ├── uploads/      # Upload parsing & sending execution
        ├── contacts/     # Contacts retrieval
        ├── templates/    # Templates CRUD
        ├── email/        # SES + SMTP drivers
        ├── queue/        # BullMQ email queue processor
        ├── unsubscribe/  # Unsubscribe endpoints
        ├── common/       # Prisma service, JWT guards
        ├── app.module.ts
        └── main.ts
```

---

## ⚠️ Production Notes

- Always use BullMQ queue for email sending (never send directly in API handlers).
- All emails include an unsubscribe link.
- Failed emails are retried up to 3 times with exponential backoff.
- 200ms delay between emails to respect rate limits.
- Duplicate emails are automatically removed during upload.
- Unsubscribed emails are automatically skipped.

---

## 📄 License

Private — VUF.org
