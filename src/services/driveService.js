/**
 * Google Drive helpers. The workflow stores Drive *links* (clients paste
 * share links), so the core need is validation + normalisation + preview
 * thumbnails. With an API key configured we can also fetch file metadata.
 */
'use strict';

const env = require('../config/env');
const logger = require('../utils/logger');

const DRIVE_PATTERNS = [
  /drive\.google\.com\/file\/d\/([\w-]+)/,
  /drive\.google\.com\/open\?id=([\w-]+)/,
  /docs\.google\.com\/\w+\/d\/([\w-]+)/,
  /drive\.google\.com\/drive\/folders\/([\w-]+)/,
];

/** Extract the Drive file/folder id from any share-link format. */
function extractFileId(link) {
  if (!link) return null;
  for (const p of DRIVE_PATTERNS) {
    const m = link.match(p);
    if (m) return m[1];
  }
  return null;
}

/** True if the link looks like a Google Drive/Docs link. */
function isDriveLink(link) {
  return Boolean(extractFileId(link));
}

/** Direct-preview URL for embedding. */
function previewUrl(link) {
  const id = extractFileId(link);
  return id ? `https://drive.google.com/file/d/${id}/preview` : null;
}

/** Thumbnail URL (works for public files without any API key). */
function thumbnailUrl(link, size = 400) {
  const id = extractFileId(link);
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w${size}` : null;
}

/** Optional: fetch file metadata via Drive API when a key is configured. */
async function getFileMeta(link) {
  const id = extractFileId(link);
  if (!id || !env.google.driveApiKey) return null;
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${id}?fields=id,name,mimeType,size,videoMediaMetadata&key=${env.google.driveApiKey}`
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    logger.warn('Drive metadata fetch failed:', err.message);
    return null;
  }
}

module.exports = { extractFileId, isDriveLink, previewUrl, thumbnailUrl, getFileMeta };
