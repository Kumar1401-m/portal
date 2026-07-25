/**
 * Payments module — invoices + Razorpay checkout + history.
 */
'use strict';

const express = require('express');
const { body, param } = require('express-validator');

const { query, queryOne, transaction } = require('../../config/db');
const { asyncHandler, ok, paginated, getPagination } = require('../../utils/helpers');
const ApiError = require('../../utils/ApiError');
const validate = require('../../middleware/validate');
const { authenticate, requireAdmin } = require('../../middleware/auth');
const audit = require('../../middleware/audit');
const razorpay = require('../../services/razorpayService');
const settings = require('../../services/settingsService');
const { notifyAdmins, notifyClient } = require('../../services/notificationService');
const { sendInvoiceEmail, sendPaymentReceiptEmail } = require('../../services/emailService');
const env = require('../../config/env');

const router = express.Router();
router.use(authenticate);

/* ---------------------------- INVOICES --------------------------------- */

/* GET /api/payments/invoices */
router.get(
  '/invoices',
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query, 20);
    const conds = [];
    const params = [];
    if (req.user.role === 'client') {
      conds.push('i.client_id = ?');
      params.push(req.user.clientId || 0);
    } else if (req.query.client_id) {
      conds.push('i.client_id = ?');
      params.push(Number(req.query.client_id));
    }
    if (req.query.status) { conds.push('i.status = ?'); params.push(req.query.status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM invoices i ${where}`, params);
    const rows = await query(
      `SELECT i.*, c.company_name FROM invoices i JOIN clients c ON c.id = i.client_id
       ${where} ORDER BY i.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    paginated(res, rows, totalRow.n, page, limit);
  })
);

/* GET /api/payments/invoices/:id — printable invoice data */
router.get(
  '/invoices/:id',
  validate([param('id').isInt()]),
  asyncHandler(async (req, res) => {
    const inv = await queryOne(
      `SELECT i.*, c.company_name, c.contact_person, c.email AS client_email, c.phone AS client_phone
       FROM invoices i JOIN clients c ON c.id = i.client_id WHERE i.id = ?`,
      [Number(req.params.id)]
    );
    if (!inv) throw ApiError.notFound('Invoice not found');
    if (req.user.role === 'client' && req.user.clientId !== inv.client_id) throw ApiError.forbidden();
    const payments = await query(
      'SELECT id, amount, status, method, razorpay_payment_id, paid_at FROM payments WHERE invoice_id = ? ORDER BY id DESC',
      [inv.id]
    );
    const s = await settings.load();
    ok(res, {
      ...inv,
      payments,
      agency: {
        name: s.company_name || env.appName,
        logo: s.company_logo_url || '',
        email: s.company_email || '',
        contact: s.contact_number || '',
        address: s.business_address || '',
        powered_by: s.powered_by || 'Powered by Venkat',
      },
    });
  })
);

/* POST /api/payments/invoices — create invoice (admin) */
router.post(
  '/invoices',
  requireAdmin,
  validate([
    body('client_id').isInt(),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be positive'),
    body('tax').optional().isFloat({ min: 0 }),
    body('processing_fee').optional().isFloat({ min: 0 }),
    body('apply_processing_fee').optional().isBoolean(),
    body('due_date').optional({ values: 'falsy' }).isDate(),
    body('notes').optional({ values: 'falsy' }).isLength({ max: 2000 }),
    body('line_items').optional().isArray(),
  ]),
  asyncHandler(async (req, res) => {
    const clientId = Number(req.body.client_id);
    const client = await queryOne('SELECT id, company_name, contact_person, email FROM clients WHERE id = ?', [clientId]);
    if (!client) throw ApiError.notFound('Client not found');

    const amount = Number(req.body.amount);
    const tax = Number(req.body.tax || 0);

    // Processing fee: explicit value wins; otherwise derive from the agency's
    // configured percentage (Final = amount + fee%) unless the caller opts out.
    const feePercent = await settings.getProcessingFeePercent();
    let processingFee = 0;
    if (req.body.processing_fee !== undefined) {
      processingFee = Number(req.body.processing_fee);
    } else if (req.body.apply_processing_fee !== false) {
      processingFee = Math.round(amount * (feePercent / 100) * 100) / 100;
    }
    const total = Math.round((amount + tax + processingFee) * 100) / 100;

    const prefix = (await settings.get('invoice_prefix')) || 'INV';
    const year = new Date().getFullYear();
    const seqRow = await queryOne(
      'SELECT COUNT(*) AS n FROM invoices WHERE invoice_no LIKE ?', [`${prefix}-${year}-%`]
    );
    const invoiceNo = `${prefix}-${year}-${String(seqRow.n + 1).padStart(4, '0')}`;

    const lineItems = req.body.line_items || [{ description: 'Services', qty: 1, rate: amount }];
    if (processingFee > 0) {
      lineItems.push({ description: `Processing fee (${feePercent}%)`, qty: 1, rate: processingFee });
    }

    const r = await query(
      `INSERT INTO invoices (invoice_no, client_id, amount, tax, processing_fee, total, status, issue_date, due_date, period_month, notes, line_items, created_by)
       VALUES (?,?,?,?,?,?,'sent',CURDATE(),?,DATE_FORMAT(CURDATE(),'%Y-%m'),?,?,?)`,
      [
        invoiceNo, clientId, amount, tax, processingFee, total,
        req.body.due_date || null, req.body.notes || null,
        JSON.stringify(lineItems),
        req.user.id,
      ]
    );
    await query(
      'INSERT INTO payments (invoice_id, client_id, amount, status) VALUES (?,?,?,?)',
      [r.insertId, clientId, total, 'pending']
    );
    audit(req, 'create', 'invoice', r.insertId, `Invoice ${invoiceNo} for ${client.company_name} — ₹${total}`);
    // In-app notification (no generic email) + a formal invoice email.
    notifyClient(clientId, 'payment_pending', `New invoice ${invoiceNo}`,
      `Amount: ₹${total.toLocaleString('en-IN')}. Pay online from your portal.`, '#/payments', false);
    sendInvoiceEmail(client, {
      invoice_no: invoiceNo, total, issue_date: new Date().toISOString().slice(0, 10), due_date: req.body.due_date || null,
    }).catch(() => {});
    ok(res, { id: r.insertId, invoice_no: invoiceNo }, 'Invoice created', 201);
  })
);

/* ---------------------------- PAYMENTS --------------------------------- */

/* GET /api/payments — payment history */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query, 20);
    const conds = [];
    const params = [];
    if (req.user.role === 'client') {
      conds.push('p.client_id = ?');
      params.push(req.user.clientId || 0);
    } else if (req.query.client_id) {
      conds.push('p.client_id = ?');
      params.push(Number(req.query.client_id));
    }
    if (req.query.status) { conds.push('p.status = ?'); params.push(req.query.status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM payments p ${where}`, params);
    const rows = await query(
      `SELECT p.*, i.invoice_no, c.company_name
       FROM payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id
       JOIN clients c ON c.id = p.client_id
       ${where} ORDER BY p.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    paginated(res, rows, totalRow.n, page, limit);
  })
);

/* POST /api/payments/order — start online payment for an invoice (client) */
router.post(
  '/order',
  validate([body('invoice_id').isInt()]),
  asyncHandler(async (req, res) => {
    const inv = await queryOne('SELECT * FROM invoices WHERE id = ?', [Number(req.body.invoice_id)]);
    if (!inv) throw ApiError.notFound('Invoice not found');
    if (req.user.role === 'client' && req.user.clientId !== inv.client_id) throw ApiError.forbidden();
    if (inv.status === 'paid') throw ApiError.badRequest('Invoice already paid');

    const { order, mock, keyId } = await razorpay.createOrder(Number(inv.total), inv.invoice_no);
    await query(
      `UPDATE payments SET razorpay_order_id = ? WHERE invoice_id = ? AND status = 'pending'
       ORDER BY id DESC LIMIT 1`,
      [order.id, inv.id]
    );
    ok(res, {
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: keyId,
      mock,
      invoice_no: inv.invoice_no,
    }, mock ? 'Demo order created (Razorpay keys not configured)' : 'Order created');
  })
);

/* POST /api/payments/verify — confirm checkout result */
router.post(
  '/verify',
  validate([
    body('razorpay_order_id').isString().notEmpty(),
    body('razorpay_payment_id').optional({ values: 'falsy' }).isString(),
    body('razorpay_signature').optional({ values: 'falsy' }).isString(),
  ]),
  asyncHandler(async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id = null, razorpay_signature = null } = req.body;
    const payment = await queryOne(
      `SELECT p.*, i.invoice_no FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id
       WHERE p.razorpay_order_id = ?`,
      [razorpay_order_id]
    );
    if (!payment) throw ApiError.notFound('Payment record not found');
    if (req.user.role === 'client' && req.user.clientId !== payment.client_id) throw ApiError.forbidden();

    const valid = await razorpay.verifySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!valid) {
      await query("UPDATE payments SET status = 'failed' WHERE id = ?", [payment.id]);
      throw ApiError.badRequest('Payment verification failed');
    }

    await transaction(async (conn) => {
      await conn.execute(
        `UPDATE payments SET status='paid', method='razorpay', razorpay_payment_id=?, razorpay_signature=?, paid_at=NOW()
         WHERE id = ?`,
        [razorpay_payment_id || 'mock_payment', razorpay_signature || 'mock_sig', payment.id]
      );
      if (payment.invoice_id) {
        await conn.execute("UPDATE invoices SET status='paid' WHERE id = ?", [payment.invoice_id]);
      }
    });

    audit(req, 'payment_received', 'payment', payment.id,
      `Payment received for ${payment.invoice_no || 'invoice'} — ₹${payment.amount}`);
    notifyAdmins('payment_received', 'Payment received',
      `₹${Number(payment.amount).toLocaleString('en-IN')} received (${payment.invoice_no || 'direct'}).`, '#/payments');
    notifyClient(payment.client_id, 'payment_received', 'Payment successful',
      `We received ₹${Number(payment.amount).toLocaleString('en-IN')}. Thank you!`, '#/payments', false);
    const rc = await queryOne('SELECT company_name, contact_person, email FROM clients WHERE id = ?', [payment.client_id]);
    if (rc) sendPaymentReceiptEmail(rc, { amount: payment.amount, invoice_no: payment.invoice_no, method: 'razorpay' }).catch(() => {});
    ok(res, null, 'Payment verified — thank you!');
  })
);

/* POST /api/payments/:id/mark-paid — manual settlement (admin) */
router.post(
  '/:id/mark-paid',
  requireAdmin,
  validate([param('id').isInt(), body('method').optional().isIn(['cash', 'bank', 'upi', 'other'])]),
  asyncHandler(async (req, res) => {
    const payment = await queryOne(
      `SELECT p.*, i.invoice_no FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id WHERE p.id = ?`,
      [Number(req.params.id)]
    );
    if (!payment) throw ApiError.notFound('Payment not found');
    const method = req.body.method || 'bank';
    await transaction(async (conn) => {
      await conn.execute(
        "UPDATE payments SET status='paid', method=?, paid_at=NOW() WHERE id = ?",
        [method, payment.id]
      );
      if (payment.invoice_id) {
        await conn.execute("UPDATE invoices SET status='paid' WHERE id = ?", [payment.invoice_id]);
      }
    });
    audit(req, 'mark_paid', 'payment', payment.id, `Marked payment #${payment.id} as paid`);
    notifyClient(payment.client_id, 'payment_received', 'Payment recorded',
      `Your payment of ₹${Number(payment.amount).toLocaleString('en-IN')} has been recorded.`, '#/payments', false);
    const rc = await queryOne('SELECT company_name, contact_person, email FROM clients WHERE id = ?', [payment.client_id]);
    if (rc) sendPaymentReceiptEmail(rc, { amount: payment.amount, invoice_no: payment.invoice_no, method }).catch(() => {});
    ok(res, null, 'Payment marked as paid');
  })
);

module.exports = router;
