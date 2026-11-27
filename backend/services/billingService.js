const Stripe = require('stripe');
const { db, createId } = require('./database');
const { logError } = require('./logger');

function positiveIntegerFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

const SUPPORTED_MANAGED_CREDIT_CURRENCIES = ['gbp', 'usd', 'eur'];
const MAX_MANAGED_CREDIT_MINOR_UNITS = { gbp: 800_000, usd: 1_000_000, eur: 900_000 };

function getManagedCreditExchangeRates() {
  const rates = {
    gbp: Number(process.env.GBP_TO_USD_RATE || '1.27'),
    eur: Number(process.env.EUR_TO_USD_RATE || '1.08'),
    usd: 1
  };
  for (const currency of SUPPORTED_MANAGED_CREDIT_CURRENCIES) {
    if (!Number.isFinite(rates[currency]) || rates[currency] <= 0) {
      throw new Error(`The configured ${currency.toUpperCase()} exchange rate is invalid.`);
    }
  }
  return rates;
}

function getManagedCreditMarkupBps() {
  const markupBps = positiveIntegerFromEnv('MANAGED_LLM_MARKUP_BPS', 3000);
  if (markupBps > 100_000) throw new Error('MANAGED_LLM_MARKUP_BPS must not exceed 100000.');
  return markupBps;
}

function estimateStripeFeeMicroUsd(currency, amountMinorUnits, usdPerUnit) {
  const fixedFeeMinorUnits = 30;
  return Math.round((amountMinorUnits * 29 / 1000 + fixedFeeMinorUnits) * usdPerUnit * 10_000);
}

function getManagedCreditConfig() {
  return {
    currencies: SUPPORTED_MANAGED_CREDIT_CURRENCIES,
    exchange_rates_usd_per_unit: getManagedCreditExchangeRates(),
    markup_basis_points: getManagedCreditMarkupBps(),
    stripe_fee_estimate_basis_points: 290,
    fixed_fee_minor_units: { gbp: 30, eur: 30, usd: 30 }
  };
}

function validateManagedCreditCurrency(currency) {
  const normalizedCurrency = String(currency).toLowerCase();
  if (!SUPPORTED_MANAGED_CREDIT_CURRENCIES.includes(normalizedCurrency)) {
    throw new Error('Managed API credits are available in GBP, USD, and EUR only.');
  }
  return normalizedCurrency;
}

function convertManagedCreditAmountToMinorUnits(amount, currency) {
  const normalizedCurrency = validateManagedCreditCurrency(currency);
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isSafeInteger(amount * 100)) {
    throw new Error('Enter a valid purchase amount with no more than two decimal places.');
  }
  const amountMinorUnits = Math.round(amount * 100);
  if (amountMinorUnits < 500) {
    throw new Error('Minimum credit purchase amount is $5.00 (or equivalent).');
  }
  if (amountMinorUnits > MAX_MANAGED_CREDIT_MINOR_UNITS[normalizedCurrency]) {
    throw new Error('Managed API credit purchase exceeds the allowed maximum.');
  }
  return amountMinorUnits;
}

function getBillingAccount(organizationId) {
  db.prepare(`
    INSERT OR IGNORE INTO billing_accounts (organization_id, mode, updated_at)
    VALUES (?, 'managed', ?)
  `).run(organizationId, new Date().toISOString());
  return db.prepare('SELECT * FROM billing_accounts WHERE organization_id = ?').get(organizationId);
}

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('Billing is not configured. Set STRIPE_SECRET_KEY.');
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function requireStripeWebhookSecret() {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('Stripe checkout is unavailable until STRIPE_WEBHOOK_SECRET is configured.');
  }
}

function planPrice(plan) {
  const envNames = {
    byok: 'STRIPE_PRICE_BYOK',
    team: 'STRIPE_PRICE_TEAM',
    business: 'STRIPE_PRICE_BUSINESS',
    payg: 'STRIPE_PRICE_PAYG'
  };
  const envName = envNames[plan];
  if (!envName) throw new Error('Choose the BYOK, Team, Business, or Pay as you go plan.');
  const price = process.env[envName];
  if (!price) throw new Error(`${envName} must be configured in Stripe before this plan can be purchased.`);
  return price;
}

async function createCheckoutSession(organization, user, plan, stripeClient) {
  requireStripeWebhookSecret();
  const stripe = stripeClient || getStripe();
  const price = planPrice(plan);
  if (plan === 'byok') {
    const configuredPrice = await stripe.prices.retrieve(price);
    if (!configuredPrice.active || configuredPrice.currency !== 'usd' ||
      configuredPrice.type !== 'recurring' ||
      configuredPrice.recurring?.interval !== 'month' ||
      configuredPrice.recurring?.usage_type !== 'licensed') {
      throw new Error('STRIPE_PRICE_BYOK must be an active fixed monthly USD subscription price.');
    }
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    allowed_payment_method_types: ['card'],
    customer_email: user.email,
    client_reference_id: organization.id,
    line_items: [{ price, quantity: 1 }],
    success_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/account.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/account.html`,
    metadata: {
      organization_id: organization.id,
      plan
    }
  });
  return session.url;
}

async function createManagedCreditsCheckout(organization, user, amountMinorUnits, currency = 'usd', stripeClient) {
  requireStripeWebhookSecret();
  const stripe = stripeClient || getStripe();
  const normalizedCurrency = validateManagedCreditCurrency(currency);
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits < 500) {
    throw new Error('Minimum credit purchase amount is $5.00 (or equivalent).');
  }
  if (amountMinorUnits > MAX_MANAGED_CREDIT_MINOR_UNITS[normalizedCurrency]) {
    throw new Error('Managed API credit purchase exceeds the allowed maximum.');
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    allowed_payment_method_types: ['card'],
    customer_email: user.email,
    client_reference_id: organization.id,
    line_items: [{
      price_data: {
        currency: normalizedCurrency,
        product_data: {
          name: 'Product Owner AI Managed Credits',
          description: 'Pre-paid API managed generation credits'
        },
        unit_amount: amountMinorUnits
      },
      quantity: 1
    }],
    success_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/account.html?credits_purchased=true`,
    cancel_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/account.html`,
    metadata: {
      organization_id: organization.id,
      type: 'managed_credits',
      amount_minor_units: String(amountMinorUnits),
      currency: normalizedCurrency,
      credits_micro_usd: String(Math.round(
        amountMinorUnits * getManagedCreditExchangeRates()[normalizedCurrency] * 10000
      ))
    }
  });
  return session.url;
}

async function createBillingPortal(organization) {
  requireStripeWebhookSecret();
  const stripe = getStripe();
  const account = getBillingAccount(organization.id);
  if (!account.stripe_customer_id) {
    throw new Error('No active Stripe customer found for this organization.');
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: account.stripe_customer_id,
    return_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/account.html`
  });
  return session.url;
}

function processStripeEvent(event) {
  if (!event?.id || typeof event.id !== 'string') {
    throw new Error('Stripe event is missing its ID.');
  }
  const timestamp = new Date().toISOString();
  return db.transaction(() => {
    const insertedEvent = db.prepare(`
      INSERT OR IGNORE INTO stripe_events (event_id, processed_at) VALUES (?, ?)
    `).run(event.id, timestamp);
    if (!insertedEvent.changes) return false;

    const object = event.data?.object || {};
    if (event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted') {
      const existingAccount = db.prepare(`
        SELECT organization_id FROM billing_accounts WHERE stripe_subscription_id = ?
      `).get(object.id);
      const organizationId = object.metadata?.organization_id || existingAccount?.organization_id;
      if (organizationId) {
        const plan = object.metadata?.plan || 'free';
        getBillingAccount(organizationId);
        db.prepare(`
          UPDATE billing_accounts
          SET stripe_customer_id = COALESCE(?, stripe_customer_id),
              stripe_subscription_id = ?,
              plan = ?,
              status = ?,
              mode = CASE WHEN ? = 'byok' THEN 'byok' ELSE mode END,
              updated_at = ?
          WHERE organization_id = ?
        `).run(object.customer || null, object.id, plan, object.status || 'active',
          plan, timestamp, organizationId);
        db.prepare(`
          INSERT INTO subscriptions (
            organization_id, stripe_customer_id, stripe_subscription_id, plan, status, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(organization_id) DO UPDATE SET
            stripe_customer_id = excluded.stripe_customer_id,
            stripe_subscription_id = excluded.stripe_subscription_id,
            plan = excluded.plan,
            status = excluded.status,
            updated_at = excluded.updated_at
        `).run(organizationId, object.customer || null, object.id, plan, object.status || 'active', timestamp);
      }
    } else if (event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded') {
      const organizationId = object.client_reference_id || object.metadata?.organization_id;
      if (organizationId) {
        getBillingAccount(organizationId);
        if (object.customer || object.subscription) {
          db.prepare(`
            UPDATE billing_accounts
            SET stripe_customer_id = COALESCE(?, stripe_customer_id),
                stripe_subscription_id = COALESCE(?, stripe_subscription_id),
                plan = COALESCE(?, plan),
                updated_at = ?
            WHERE organization_id = ?
          `).run(object.customer || null, object.subscription || null,
            object.metadata?.plan || null, timestamp, organizationId);
        }

        const isCreditPurchase = object.metadata?.type === 'managed_credits' ||
          object.metadata?.purpose === 'managed_api_credits' || object.mode === 'payment';
        if (isCreditPurchase && object.payment_status !== 'unpaid') {
          const currency = (object.currency || object.metadata?.currency || 'usd').toLowerCase();
          const rates = getManagedCreditExchangeRates();
          const amountMicroUsd = Number(object.metadata?.credits_micro_usd) ||
            Math.round((object.amount_total || 0) * (rates[currency] || 1) * 10000);
          if (!Number.isSafeInteger(amountMicroUsd) || amountMicroUsd <= 0) {
            throw new Error('Stripe credit purchase has an invalid amount.');
          }
          const referenceId = object.id || event.id;
          const insertedCredit = db.prepare(`
            INSERT OR IGNORE INTO billing_ledger (
              id, organization_id, entry_type, amount_micro_usd,
              reference_id, description, created_at
            ) VALUES (?, ?, 'credit', ?, ?, 'Managed API credit purchase', ?)
          `).run(createId(), organizationId, amountMicroUsd, referenceId, timestamp);
          if (insertedCredit.changes) {
            db.prepare(`
              UPDATE billing_accounts
              SET balance_micro_usd = balance_micro_usd + ?, updated_at = ?
              WHERE organization_id = ?
            `).run(amountMicroUsd, timestamp, organizationId);
          }
        }
      }
    }

    return true;
  })();
}

function recordUsage(organizationId, userId, eventType, units = 1, billable = true, sourceMode = 'byok') {
  const id = createId();
  const timestamp = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO usage_events (id, organization_id, user_id, event_type, units, billable, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, organizationId, userId, eventType, units, billable ? 1 : 0, sourceMode, timestamp);

    if (billable) {
      db.prepare(`
        INSERT INTO billing_outbox (usage_event_id, status, attempts, next_attempt_at, created_at, updated_at)
        VALUES (?, 'pending', 0, ?, ?, ?)
      `).run(id, timestamp, timestamp, timestamp);
    }
  })();
  return id;
}

async function reportMeteredUsage(organizationId, usageEventId, units) {
  const account = getBillingAccount(organizationId);
  if (!account.stripe_subscription_id) return;
  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(account.stripe_subscription_id);
  const subscriptionItem = subscription.items.data[0];
  if (!subscriptionItem) return;

  await stripe.subscriptionItems.createUsageRecord(subscriptionItem.id, {
    quantity: units,
    timestamp: Math.floor(Date.now() / 1000),
    action: 'increment'
  });
}

function getLlmRates() {
  return {
    input_micro_usd_per_million: positiveIntegerFromEnv('LLM_INPUT_COST_MICRO_USD_PER_MILLION', 150000),
    output_micro_usd_per_million: positiveIntegerFromEnv('LLM_OUTPUT_COST_MICRO_USD_PER_MILLION', 600000)
  };
}

function estimateManagedReservation(estimatedCharacters = 8000, callCount = 1) {
  if (!Number.isSafeInteger(estimatedCharacters) || estimatedCharacters < 0 ||
    !Number.isSafeInteger(callCount) || callCount < 1) {
    throw new Error('Managed credit reservation estimates must be non-negative integers.');
  }
  const rates = getLlmRates();
  const estimatedInputTokens = Math.ceil(estimatedCharacters / 4) * callCount;
  const estimatedOutputTokens = 1000 * callCount;
  const costMicroUsd = Math.ceil(
    (estimatedInputTokens * rates.input_micro_usd_per_million +
      estimatedOutputTokens * rates.output_micro_usd_per_million) / 1_000_000
  );
  return Math.ceil(costMicroUsd * (1 + getManagedCreditMarkupBps() / 10000));
}

function reserveManagedCredits(organizationId, userId, requestId, estimatedAmountMicroUsd) {
  if (typeof requestId !== 'string' || !requestId ||
    !Number.isSafeInteger(estimatedAmountMicroUsd) || estimatedAmountMicroUsd < 0) {
    throw new Error('Managed credit reservation details are invalid.');
  }

  const timestamp = new Date().toISOString();
  return db.transaction(() => {
    const account = getBillingAccount(organizationId);
    const existing = db.prepare(`
      SELECT organization_id, user_id, reserved_micro_usd, status
      FROM managed_credit_reservations WHERE id = ?
    `).get(requestId);
    if (existing) {
      if (existing.organization_id !== organizationId || existing.user_id !== userId ||
        existing.reserved_micro_usd !== estimatedAmountMicroUsd || existing.status !== 'reserved') {
        throw new Error('A conflicting managed credit reservation already exists.');
      }
      return requestId;
    }

    if (account.balance_micro_usd - account.reserved_micro_usd < estimatedAmountMicroUsd) {
      throw new Error('Managed credit balance is too low. Please top up your account balance.');
    }
    db.prepare(`
      UPDATE billing_accounts
      SET reserved_micro_usd = reserved_micro_usd + ?, updated_at = ?
      WHERE organization_id = ?
    `).run(estimatedAmountMicroUsd, timestamp, organizationId);
    db.prepare(`
      INSERT INTO managed_credit_reservations (
        id, organization_id, user_id, reserved_micro_usd, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'reserved', ?, ?)
    `).run(requestId, organizationId, userId, estimatedAmountMicroUsd, timestamp, timestamp);
    return requestId;
  })();
}

function recordLlmUsage(organizationId, userId, requestId, billingMode, usage) {
  const { provider, model, inputTokens, outputTokens, totalTokens } = usage || {};
  if (typeof provider !== 'string' || typeof model !== 'string' ||
    !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) || outputTokens < 0 ||
    !Number.isSafeInteger(totalTokens) || totalTokens !== inputTokens + outputTokens) {
    throw new Error('LLM usage telemetry must include exact non-negative token counts.');
  }
  if (!['byok', 'managed'].includes(billingMode)) {
    throw new Error('LLM usage billing mode is invalid.');
  }
  const rates = getLlmRates();
  const costMicroUsd = Math.round(
    (inputTokens * rates.input_micro_usd_per_million +
      outputTokens * rates.output_micro_usd_per_million) / 1_000_000
  );
  const chargedMicroUsd = billingMode === 'managed'
    ? Math.ceil(costMicroUsd * (1 + getManagedCreditMarkupBps() / 10000))
    : 0;
  const timestamp = new Date().toISOString();
  const id = createId();

  db.transaction(() => {
    const account = getBillingAccount(organizationId);
    if (billingMode === 'managed') {
      const reservation = db.prepare(`
        SELECT id FROM managed_credit_reservations
        WHERE id = ? AND organization_id = ? AND user_id = ? AND status = 'reserved'
      `).get(requestId, organizationId, userId);
      if (!reservation) {
        throw new Error('A valid managed credit reservation is required to record usage.');
      }
      if (account.balance_micro_usd < chargedMicroUsd) {
        throw new Error('Managed credit balance is too low to cover this usage.');
      }
      db.prepare(`
        UPDATE billing_accounts
        SET balance_micro_usd = balance_micro_usd - ?, updated_at = ?
        WHERE organization_id = ?
      `).run(chargedMicroUsd, timestamp, organizationId);
      if (chargedMicroUsd > 0) {
        db.prepare(`
          INSERT INTO billing_ledger (
            id, organization_id, user_id, entry_type, amount_micro_usd,
            reference_id, description, created_at
          ) VALUES (?, ?, ?, 'debit', ?, ?, 'Managed LLM usage', ?)
        `).run(id, organizationId, userId, chargedMicroUsd, id, timestamp);
      }
    }
    db.prepare(`
      INSERT INTO llm_usage (
        id, organization_id, user_id, request_id, provider, model,
        input_tokens, output_tokens, total_tokens,
        input_rate_micro_usd_per_million, output_rate_micro_usd_per_million,
        cost_micro_usd, charged_micro_usd, billing_mode, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, organizationId, userId, requestId, provider, model, inputTokens, outputTokens,
      totalTokens, rates.input_micro_usd_per_million, rates.output_micro_usd_per_million,
      costMicroUsd, chargedMicroUsd, billingMode, timestamp
    );
  })();

  return { cost_micro_usd: costMicroUsd, charged_micro_usd: chargedMicroUsd };
}

function releaseManagedReservation(requestId, organizationId) {
  if (!requestId) return;
  const timestamp = new Date().toISOString();

  return db.transaction(() => {
    const res = db.prepare(`
      SELECT reserved_micro_usd, status FROM managed_credit_reservations
      WHERE id = ? AND organization_id = ?
    `).get(requestId, organizationId);
    if (res && res.status === 'reserved') {
      db.prepare(`
        UPDATE managed_credit_reservations
        SET status = 'released', updated_at = ?
        WHERE id = ?
      `).run(timestamp, requestId);

      db.prepare(`
        UPDATE billing_accounts
        SET reserved_micro_usd = MAX(0, reserved_micro_usd - ?),
            updated_at = ?
        WHERE organization_id = ?
      `).run(res.reserved_micro_usd, timestamp, organizationId);
    }
  })();
}

function cleanupExpiredReservations() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const expired = db.prepare(`
    SELECT id, organization_id, reserved_micro_usd
    FROM managed_credit_reservations
    WHERE status = 'reserved' AND created_at <= ?
  `).all(oneHourAgo);

  for (const item of expired) {
    releaseManagedReservation(item.id, item.organization_id);
  }
}

function setBillingMode(organizationId, mode) {
  if (!['byok', 'managed'].includes(mode)) {
    throw new Error("Billing mode must be 'byok' or 'managed'.");
  }
  getBillingAccount(organizationId);
  db.prepare(`
    UPDATE billing_accounts
    SET mode = ?, updated_at = ?
    WHERE organization_id = ?
  `).run(mode, new Date().toISOString(), organizationId);
  return getBillingAccount(organizationId);
}

function getLlmUsage(organizationId, limit = 100) {
  const normalizedLimit = Number.isSafeInteger(limit) ? Math.min(1000, Math.max(1, limit)) : 100;
  return db.prepare(`
    SELECT id, organization_id, user_id, request_id, provider, model,
           input_tokens, output_tokens, total_tokens, cost_micro_usd,
           charged_micro_usd, billing_mode, created_at
    FROM llm_usage
    WHERE organization_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(organizationId, normalizedLimit);
}

let draining = false;
async function drainBillingOutbox() {
  if (draining) return;
  draining = true;
  try {
    const due = db.prepare(`
      SELECT u.id, u.organization_id, u.units, o.attempts
      FROM billing_outbox o JOIN usage_events u ON u.id = o.usage_event_id
      WHERE o.status = 'pending' AND o.next_attempt_at <= ?
      ORDER BY o.updated_at LIMIT 20
    `).all(new Date().toISOString());
    for (const event of due) {
      try {
        await reportMeteredUsage(event.organization_id, event.id, event.units);
        db.prepare(`
          UPDATE billing_outbox SET status = 'sent', last_error = NULL, updated_at = ?
          WHERE usage_event_id = ?
        `).run(new Date().toISOString(), event.id);
      } catch (error) {
        const attempts = event.attempts + 1;
        const delaySeconds = Math.min(3600, 30 * (2 ** Math.min(attempts, 7)));
        db.prepare(`
          UPDATE billing_outbox SET attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
          WHERE usage_event_id = ?
        `).run(
          attempts,
          String(error.message || 'Unknown metering error').slice(0, 500),
          new Date(Date.now() + delaySeconds * 1000).toISOString(),
          new Date().toISOString(),
          event.id
        );
        logError('stripe_meter_event_retry_scheduled', error, {
          usage_event_id: event.id,
          organization_id: event.organization_id,
          attempts
        });
      }
    }
  } finally {
    draining = false;
  }
}

module.exports = {
  getStripe,
  getManagedCreditConfig,
  convertManagedCreditAmountToMinorUnits,
  createCheckoutSession,
  createManagedCreditsCheckout,
  createBillingPortal,
  processStripeEvent,
  reportMeteredUsage,
  recordUsage,
  getBillingAccount,
  getLlmRates,
  estimateManagedReservation,
  reserveManagedCredits,
  recordLlmUsage,
  releaseManagedReservation,
  cleanupExpiredReservations,
  setBillingMode,
  getLlmUsage,
  drainBillingOutbox
};