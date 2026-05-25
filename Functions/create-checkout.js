// netlify/functions/create-checkout.js
// Creates a Stripe Checkout session for a specific exam (r01 or r02)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Price IDs for each exam
const PRICE_IDS = {
  r01: process.env.STRIPE_PRICE_ID_R01,
  r02: process.env.STRIPE_PRICE_ID_R02,
};

const EXAM_NAMES = {
  r01: 'R01 — Financial Services, Regulation & Ethics',
  r02: 'R02 — Investment Principles & Risk',
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': process.env.SITE_URL || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Verify auth token
  const token = (event.headers.authorization || '').replace('Bearer ', '');
  if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };

  try {
    const { exam, userId, userEmail, userName } = JSON.parse(event.body || '{}');

    // Validate exam
    if (!exam || !PRICE_IDS[exam]) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid exam. Must be r01 or r02' }) };
    }

    // Verify the userId matches the authenticated user
    if (userId !== user.id) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
    }

    // Check if user already has this exam
    const { data: profile } = await supabase
      .from('profiles')
      .select(`${exam}_active, ${exam}_subscription_end`)
      .eq('id', user.id)
      .single();

    if (profile?.[`${exam}_active`]) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `You already have access to ${exam.toUpperCase()}` }) };
    }

    // Create or retrieve Stripe customer
    let customer;
    const existing = await stripe.customers.list({ email: userEmail, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email: userEmail,
        name: userName || 'Student',
        metadata: { supabase_user_id: user.id },
      });
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: PRICE_IDS[exam], quantity: 1 }],
      success_url: `${process.env.SITE_URL}/?session_id={CHECKOUT_SESSION_ID}&exam=${exam}`,
      cancel_url: `${process.env.SITE_URL}/?cancelled=true`,
      metadata: { supabase_user_id: user.id, exam },
      subscription_data: {
        metadata: { supabase_user_id: user.id, exam },
      },
      allow_promotion_codes: true,
      custom_text: {
        submit: { message: `You're subscribing to ${EXAM_NAMES[exam]} at £20/month. Cancel anytime.` }
      },
    });

    return { statusCode: 200, headers, body: JSON.stringify({ url: session.url, sessionId: session.id }) };

  } catch (err) {
    console.error('Stripe checkout error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
