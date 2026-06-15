# VUF Mail Marketing System

A production-ready email marketing system for VUF.org built with React (Vite + TS) on the frontend and **pure Node.js JavaScript Azure Functions (v4 programming model)** on the backend.

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

### Backend (Azure Functions v4 - Pure JavaScript)
- **Azure Functions Node.js Runtime (v4 model)**
- **Azure Durable Functions** (Orchestrator + Activity task framework replacing Redis/BullMQ)
- Prisma ORM + Supabase (PostgreSQL)
- AWS SES (primary email)
- Nodemailer SMTP (fallback)
- Handlebars (template rendering)
- xlsx (In-memory Excel parsing)
- JWT Authentication

---

## 🛠️ Manual Development Setup

### Prerequisites
- Node.js 20+
- Azure Functions Core Tools (`func`) installed globally
- Supabase Project (PostgreSQL)
- Azurite (or an Azure Storage Connection String) for running Durable Functions locally

---

### Backend Setup

1. **Configure Environment Variables**:
   Azure Functions use `local.settings.json` for local settings. Copy the example file:
   ```bash
   cd backend
   cp local.settings.json.example local.settings.json  # Or edit existing local.settings.json
   ```
   Open `local.settings.json` and verify the settings inside `"Values"`:
   *   `DATABASE_URL`: Your Supabase connection string.
   *   `JWT_SECRET`: Secret key for signing authorization tokens.
   *   `SMTP_*` / `AWS_*`: Configuration credentials for email delivery.
   *   `AzureWebJobsStorage`: Set to `UseDevelopmentStorage=true` for local development (ensure Azurite is running) or insert an Azure Storage account connection string.

2. **Install Dependencies & Generate Client**:
   ```bash
   # Install dependencies
   npm install

   # Generate Prisma client bindings
   npx prisma generate
   ```

3. **Push Schema & Seed Database**:
   ```bash
   # Push schema to your Supabase database
   npx prisma db push

   # Seed default admin login credentials
   npx prisma db seed
   ```

4. **Start Development Server**:
   Ensure **Azurite** (or Azure Storage emulator) is running, then start the Azure Function runtime:
   ```bash
   npm start
   ```
   The API will now be listening locally at `http://localhost:7071/api`.

---

### Frontend Setup

1. **Configure Environment Variables**:
   Create a `.env` file in the `frontend/` directory:
   ```env
   VITE_API_URL=http://localhost:7071/api
   ```

2. **Install & Run**:
   ```bash
   cd frontend
   
   # Install dependencies
   npm install

   # Start development server
   npm run dev
   ```
   Open `http://localhost:5173` in your browser.

---

### Default Admin Login
- **Email:** admin@vuf.org
- **Password:** admin123

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
| POST | /api/uploads/:id/send | Start sending template to upload (Triggers Durable Orchestrator) |
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

1. **Upload Excel**: Admin uploads an Excel file with `name` and `email` columns. The backend validates email formats, filters duplicates, and checks unsubscribes, storing everything to Postgres.
2. **Create Template**: Admin designs an email template using variables `{{name}}`, `{{email}}`, and `{{unsubscribeLink}}`.
3. **Send Emails**: Admin opens the upload's details page, clicks **Send Email Template**, selects the template, and initiates sending.
4. **Queue Processing**: Backend initiates a **Durable Orchestration** (`emailOrchestrator`).
5. **Orchestrator Execution**: The Durable Orchestrator loops through campaign contacts sequentially, calling `sendEmailActivity` and yielding a **Durable Timer** for a 200ms delay to prevent rate limit issues.
6. **Activity Execution**: `sendEmailActivity` renders the HTML body using Handlebars, delivers the mail via AWS SES (with Nodemailer SMTP fallback), and updates the status directly in Postgres. In case of transient failures, it retries up to 3 times with a delay.
7. **Live Report**: The upload details page tracks sent, failed, pending, and skipped counts in real-time.

---

## 📁 Project Structure

```
├── README.md
├── frontend/
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
    ├── host.json
    ├── local.settings.json
    ├── package.json
    ├── prisma/
    │   ├── schema.prisma
    │   └── seed.js       # JS database seeder
    └── src/
        ├── auth.js       # JWT & password bcrypt helper
        ├── email.js      # SES + SMTP delivery engine
        ├── prisma.js     # PrismaClient instantiation
        ├── templates-service.js # Handlebars compiler
        └── index.js      # Serverless HTTP endpoints, Durable Orchestrators, and Activities
```

---

## ⚠️ Production Notes

- Emails are processed sequentially using Azure Durable Functions.
- All emails include an unsubscribe link.
- Failed emails are retried up to 3 times.
- 200ms rate limiting delay between emails.
- Duplicate emails are automatically removed during upload.
- Unsubscribed emails are automatically skipped.

---

## 📄 License

Private — VUF.org
