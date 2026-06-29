-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "sender_profile_id" TEXT;

-- CreateTable
CREATE TABLE "sender_profiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sender_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sender_profiles_email_key" ON "sender_profiles"("email");

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_sender_profile_id_fkey" FOREIGN KEY ("sender_profile_id") REFERENCES "sender_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
