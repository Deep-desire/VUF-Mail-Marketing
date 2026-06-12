export enum ContactStatus {
  valid = 'valid',
  invalid = 'invalid',
  duplicate = 'duplicate',
  unsubscribed = 'unsubscribed',
}

export enum CampaignStatus {
  draft = 'draft',
  processing = 'processing',
  completed = 'completed',
  failed = 'failed',
}

export enum RecipientStatus {
  pending = 'pending',
  sent = 'sent',
  failed = 'failed',
  skipped = 'skipped',
}
