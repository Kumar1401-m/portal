/**
 * Settings module — agency-wide configuration (branding, Razorpay keys,
 * invoice prefix, processing fee). Read: any admin. Write: super admin only.
 */
'use strict';

const express = require('express');
const { body } = require('express-validator');

const { asyncHandler, ok } = require('../../utils/helpers');
const validate = require('../../middleware/validate');
const { authenticate, requireAdmin, requireSuperAdmin } = require('../../middleware/auth');
const audit = require('../../middleware/audit');
const settings = require('../../services/settingsService');

const router = express.Router();
router.use(authenticate);

/* GET /api/settings — public settings (secrets masked) */
router.get(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    ok(res, await settings.getPublic());
  })
);

/* PUT /api/settings — update settings (super admin) */
router.put(
  '/',
  requireSuperAdmin,
  validate([
    body('company_name').optional({ values: 'falsy' }).isLength({ max: 190 }),
    body('company_email').optional({ values: 'falsy' }).isEmail().withMessage('Invalid company email'),
    body('contact_number').optional({ values: 'falsy' }).isLength({ max: 40 }),
    body('company_logo_url').optional({ values: 'falsy' }).isURL().withMessage('Invalid logo URL'),
    body('business_address').optional({ values: 'falsy' }).isLength({ max: 500 }),
    body('invoice_prefix').optional({ values: 'falsy' }).matches(/^[A-Za-z0-9-]{1,12}$/)
      .withMessage('Prefix: letters/numbers/hyphen, max 12'),
    body('processing_fee_percent').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }),
    body('tax_percent').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }),
    body('razorpay_key_id').optional({ values: 'falsy' }).isLength({ max: 60 }),
    body('razorpay_key_secret').optional({ values: 'falsy' }).isLength({ max: 120 }),
  ]),
  asyncHandler(async (req, res) => {
    // Ignore an empty secret so a blank field never wipes a stored key.
    const patch = { ...req.body };
    if (patch.razorpay_key_secret === '' || patch.razorpay_key_secret == null) delete patch.razorpay_key_secret;

    await settings.setMany(patch);
    audit(req, 'update', 'settings', null, 'Updated agency settings');
    ok(res, await settings.getPublic(), 'Settings saved');
  })
);

module.exports = router;
