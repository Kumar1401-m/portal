/**
 * Central API router — mounts every module. Adding a new module means adding
 * one folder under src/modules and one line here.
 */
'use strict';

const express = require('express');

const router = express.Router();

router.use('/auth', require('./modules/auth/auth.routes'));
router.use('/users', require('./modules/users/users.routes'));
router.use('/clients', require('./modules/clients/clients.routes'));
router.use('/deliverables', require('./modules/deliverables/deliverables.routes'));
router.use('/captions', require('./modules/captions/captions.routes'));
router.use('/ai', require('./modules/ai/ai.routes'));
router.use('/payments', require('./modules/payments/payments.routes'));
router.use('/analytics', require('./modules/analytics/analytics.routes'));
router.use('/dashboard', require('./modules/dashboard/dashboard.routes'));
router.use('/notifications', require('./modules/notifications/notifications.routes'));
router.use('/reports', require('./modules/reports/reports.routes'));
router.use('/search', require('./modules/search/search.routes'));
router.use('/activity', require('./modules/activity/activity.routes'));
router.use('/settings', require('./modules/settings/settings.routes'));
router.use('/library', require('./modules/library/library.routes'));

module.exports = router;
