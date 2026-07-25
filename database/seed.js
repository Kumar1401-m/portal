/**
 * Seed script: creates the super admin plus rich demo data so the app is
 * usable immediately after `npm run db:setup && npm run db:seed`.
 * Idempotent: skips seeding if the super admin already exists.
 */
'use strict';

const bcrypt = require('bcryptjs');
const env = require('../src/config/env');
const { query, queryOne, getPool } = require('../src/config/db');

const today = new Date();
const fmt = (d) => d.toISOString().slice(0, 10);
const monthKey = (d) => d.toISOString().slice(0, 7);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

async function main() {
  const existing = await queryOne('SELECT id FROM users WHERE email = ?', [env.superAdmin.email]);
  if (existing) {
    console.log('Seed skipped — super admin already exists.');
    process.exit(0);
  }

  console.log('Seeding database ...');
  const hash = await bcrypt.hash(env.superAdmin.password, env.bcryptRounds);

  // ---- Users -------------------------------------------------------------
  const superAdmin = await query(
    'INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)',
    [env.superAdmin.name, env.superAdmin.email, hash, 'super_admin']
  );
  const adminHash = await bcrypt.hash('Manager@123', env.bcryptRounds);
  const admin = await query(
    'INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)',
    ['Content Manager', 'manager@agency.com', adminHash, 'admin']
  );

  const clientDefs = [
    {
      company: 'Spice Route Restaurant', person: 'Ravi Teja', email: 'client1@demo.com',
      type: 'Restaurant', pkg: 'Growth Plan', amount: 25000, deliverables: 16,
    },
    {
      company: 'FitZone Gym', person: 'Anita Sharma', email: 'client2@demo.com',
      type: 'Fitness', pkg: 'Starter Plan', amount: 15000, deliverables: 10,
    },
    {
      company: 'Lumina Jewellers', person: 'Kiran Rao', email: 'client3@demo.com',
      type: 'Retail', pkg: 'Premium Plan', amount: 40000, deliverables: 24,
    },
  ];

  const clientIds = [];
  for (const c of clientDefs) {
    const uHash = await bcrypt.hash('Client@123', env.bcryptRounds);
    const u = await query(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)',
      [c.person, c.email, uHash, 'client']
    );
    const joining = addDays(today, -180);
    const renewal = addDays(today, 30);
    const cl = await query(
      `INSERT INTO clients
       (user_id, company_name, contact_person, phone, email, business_type,
        instagram_link, facebook_link, website, monthly_package, package_amount,
        joining_date, renewal_date, monthly_deliverables, payment_plan, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        u.insertId, c.company, c.person, '+91 9000000000', c.email, c.type,
        `https://instagram.com/${c.company.toLowerCase().replace(/\s+/g, '')}`,
        `https://facebook.com/${c.company.toLowerCase().replace(/\s+/g, '')}`,
        'https://example.com', c.pkg, c.amount,
        fmt(joining), fmt(renewal), c.deliverables, 'monthly', 'active', superAdmin.insertId,
      ]
    );
    clientIds.push(cl.insertId);
  }

  // ---- Deliverables across the current month -----------------------------
  const platforms = ['instagram_reel', 'facebook_post', 'youtube_short', 'instagram_story', 'poster'];
  const statuses = [
    'pending', 'waiting_for_raw', 'raw_uploaded', 'editing', 'caption_ready',
    'review', 'approved', 'scheduled', 'posted', 'completed',
  ];
  const titles = [
    'Weekend Special Promo', 'Behind the Scenes', 'Customer Testimonial',
    'New Arrival Teaser', 'Festive Offer Reel', 'How-It-Works Explainer',
    'Monday Motivation', 'Product Spotlight', 'Team Introduction', 'FAQ Short',
  ];

  let d = 0;
  for (const clientId of clientIds) {
    for (let i = 0; i < 10; i++) {
      const due = addDays(today, i - 4); // some overdue, some today, some upcoming
      const status = statuses[(d + i) % statuses.length];
      const platform = platforms[(d + i) % platforms.length];
      const approved = ['approved', 'scheduled', 'posted', 'completed'].includes(status);
      const posted = ['posted', 'completed'].includes(status);
      const res = await query(
        `INSERT INTO deliverables
         (client_id, title, platform, content_type, due_date, priority, status,
          approval_status, posting_status, caption, raw_drive_link, edited_link,
          month_key, created_by, ai_score)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          clientId,
          `${titles[(d + i) % titles.length]} #${i + 1}`,
          platform,
          platform.includes('reel') || platform.includes('short') ? 'video' : 'image',
          fmt(due),
          i % 4 === 0 ? 'high' : 'medium',
          status,
          approved ? 'approved' : 'pending',
          posted ? 'posted' : approved ? 'scheduled' : 'not_posted',
          approved ? 'Fresh flavours, crafted daily. Visit us this weekend! ✨' : null,
          ['raw_uploaded', 'editing', 'caption_ready', 'review', 'approved', 'scheduled', 'posted', 'completed'].includes(status)
            ? 'https://drive.google.com/file/d/demo-raw-link/view' : null,
          ['caption_ready', 'review', 'approved', 'scheduled', 'posted', 'completed'].includes(status)
            ? 'https://drive.google.com/file/d/demo-edited-link/view' : null,
          monthKey(due),
          admin.insertId,
          approved ? 78 + ((d + i) % 20) : null,
        ]
      );
      if (approved) {
        await query(
          `INSERT INTO captions (deliverable_id, client_id, platform, month_key, body, hashtags, cta, is_ai_generated, created_by)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            res.insertId, clientId, platform, monthKey(due),
            'Fresh flavours, crafted daily. Visit us this weekend! ✨',
            '#local #trending #weekend #offer', 'Book your table now — link in bio!', 1, admin.insertId,
          ]
        );
      }
      d++;
    }
  }

  // ---- Invoices & payments ----------------------------------------------
  let invNo = 1;
  for (const [idx, clientId] of clientIds.entries()) {
    const amount = clientDefs[idx].amount;
    for (let m = 2; m >= 0; m--) {
      const issue = new Date(today.getFullYear(), today.getMonth() - m, 1);
      const due = new Date(today.getFullYear(), today.getMonth() - m, 10);
      const paid = m > 0; // older invoices paid, current pending
      const inv = await query(
        `INSERT INTO invoices (invoice_no, client_id, amount, tax, total, status, issue_date, due_date, period_month, line_items)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          `INV-${today.getFullYear()}-${String(invNo++).padStart(4, '0')}`,
          clientId, amount, amount * 0.18, amount * 1.18,
          paid ? 'paid' : 'sent',
          fmt(issue), fmt(due), monthKey(issue),
          JSON.stringify([{ description: `${clientDefs[idx].pkg} — social media management`, qty: 1, rate: amount }]),
        ]
      );
      await query(
        `INSERT INTO payments (invoice_id, client_id, amount, status, method, paid_at)
         VALUES (?,?,?,?,?,?)`,
        [
          inv.insertId, clientId, amount * 1.18,
          paid ? 'paid' : 'pending',
          paid ? 'razorpay' : null,
          paid ? fmt(addDays(issue, 5)) + ' 10:30:00' : null,
        ]
      );
    }
  }

  // ---- Analytics snapshots (last 30 days) --------------------------------
  for (const [idx, clientId] of clientIds.entries()) {
    let followers = 4000 + idx * 2500;
    for (let i = 30; i >= 0; i--) {
      const day = addDays(today, -i);
      followers += Math.floor(Math.random() * 40) + 5;
      const reach = Math.floor(followers * (1.5 + Math.random()));
      const likes = Math.floor(reach * 0.06);
      const comments = Math.floor(likes * 0.08);
      const shares = Math.floor(likes * 0.12);
      const saves = Math.floor(likes * 0.15);
      await query(
        `INSERT INTO analytics_snapshots
         (client_id, platform, snapshot_date, followers, reach, impressions, views, likes, comments, shares, saves, engagement_rate)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          clientId, 'instagram', fmt(day), followers, reach,
          Math.floor(reach * 1.3), Math.floor(reach * 0.9),
          likes, comments, shares, saves,
          Number((((likes + comments + shares + saves) / Math.max(reach, 1)) * 100).toFixed(2)),
        ]
      );
    }
  }

  console.log('✔ Seed complete.');
  console.log('──────────────────────────────────────────────');
  console.log(`  Super Admin : ${env.superAdmin.email} / ${env.superAdmin.password}`);
  console.log('  Admin       : manager@agency.com / Manager@123');
  console.log('  Clients     : client1@demo.com, client2@demo.com, client3@demo.com / Client@123');
  console.log('──────────────────────────────────────────────');
  await getPool().end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
