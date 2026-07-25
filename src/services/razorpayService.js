/**
 * Razorpay integration. Credentials come from agency settings (UI) first, then
 * .env. With keys configured it creates real orders and verifies payment
 * signatures; without keys it runs in "mock mode" so the payment flow remains
 * demonstrable end-to-end. The client is (re)built whenever the key id changes,
 * so updating keys in Settings takes effect without a restart.
 */
'use strict';

const crypto = require('crypto');
const settings = require('./settingsService');
const logger = require('../utils/logger');

let cached = { keyId: null, client: null };

/** Build (or reuse) a Razorpay client from the current effective config. */
async function getClient() {
  const cfg = await settings.getRazorpayConfig();
  if (!cfg.enabled) { cached = { keyId: null, client: null }; return { client: null, cfg }; }
  if (cached.keyId !== cfg.keyId || !cached.client) {
    try {
      const Razorpay = require('razorpay');
      cached = { keyId: cfg.keyId, client: new Razorpay({ key_id: cfg.keyId, key_secret: cfg.keySecret }) };
    } catch (err) {
      logger.warn('Razorpay SDK unavailable:', err.message);
      cached = { keyId: null, client: null };
    }
  }
  return { client: cached.client, cfg };
}

async function isLive() {
  const { client } = await getClient();
  return Boolean(client);
}

/**
 * Create a payment order.
 * @param {number} amountInr amount in rupees
 * @param {string} receipt   internal receipt id (e.g. invoice number)
 */
async function createOrder(amountInr, receipt) {
  const amountPaise = Math.round(amountInr * 100);
  const { client, cfg } = await getClient();
  if (client) {
    const order = await client.orders.create({ amount: amountPaise, currency: 'INR', receipt });
    return { order, mock: false, keyId: cfg.keyId };
  }
  // Mock mode: fabricate an order so the UI flow can complete.
  return {
    order: {
      id: `order_mock_${crypto.randomBytes(8).toString('hex')}`,
      amount: amountPaise,
      currency: 'INR',
      receipt,
      status: 'created',
    },
    mock: true,
    keyId: null,
  };
}

/**
 * Verify the checkout signature returned by Razorpay.
 * In mock mode any payment against a mock order verifies successfully.
 */
async function verifySignature(orderId, paymentId, signature) {
  const cfg = await settings.getRazorpayConfig();
  if (!cfg.enabled || orderId.startsWith('order_mock_')) return true;
  const expected = crypto
    .createHmac('sha256', cfg.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
}

module.exports = { createOrder, verifySignature, isLive };
