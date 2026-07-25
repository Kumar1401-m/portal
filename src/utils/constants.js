/**
 * Shared enums and constants used across backend and mirrored on the frontend.
 */
'use strict';

const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  CLIENT: 'client',
};

// Full deliverable/content workflow status set (matches spec).
const STATUS = {
  PENDING: 'pending',
  CONTENT_REVIEW: 'content_review',
  WAITING_FOR_RAW: 'waiting_for_raw',
  RAW_UPLOADED: 'raw_uploaded',
  EDITING: 'editing',
  CAPTION_READY: 'caption_ready',
  REVIEW: 'review',
  CHANGES_REQUESTED: 'changes_requested',
  RESOLVED: 'resolved',
  APPROVED: 'approved',
  SCHEDULED: 'scheduled',
  POSTED: 'posted',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
};

const STATUS_LIST = Object.values(STATUS);

// Statuses that must carry a reason.
const REASON_REQUIRED = [STATUS.REJECTED, STATUS.CHANGES_REQUESTED, STATUS.CANCELLED];

const PLATFORMS = [
  'instagram_reel',
  'instagram_post',
  'instagram_story',
  'facebook_post',
  'youtube_short',
  'youtube_long',
  'poster',
  'ad_creative',
  'other',
];

const PRIORITY = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', URGENT: 'urgent' };

const APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REJECTED: 'rejected',
};

const POSTING_STATUS = {
  NOT_POSTED: 'not_posted',
  SCHEDULED: 'scheduled',
  POSTED: 'posted',
  REJECTED: 'rejected',
};

const PAYMENT_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  PARTIAL: 'partial',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  CANCELLED: 'cancelled',
};

const CLIENT_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  PAUSED: 'paused',
  CHURNED: 'churned',
};

const NOTIFICATION_TYPES = {
  RAW_UPLOADED: 'raw_uploaded',
  EDITED_READY: 'edited_ready',
  APPROVAL_NEEDED: 'approval_needed',
  CHANGES_REQUESTED: 'changes_requested',
  PAYMENT_RECEIVED: 'payment_received',
  PAYMENT_PENDING: 'payment_pending',
  TASK_DUE: 'task_due',
  GENERAL: 'general',
};

module.exports = {
  ROLES,
  STATUS,
  STATUS_LIST,
  REASON_REQUIRED,
  PLATFORMS,
  PRIORITY,
  APPROVAL_STATUS,
  POSTING_STATUS,
  PAYMENT_STATUS,
  CLIENT_STATUS,
  NOTIFICATION_TYPES,
};
