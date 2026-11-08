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

async function createCheckoutSession(organization, user, plan) {
  const stripe = getStripe();
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
    payment_method_types: ['card'],
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

async function createManagedCreditsCheckout(organization, user, amountMinorUnits, currency = 'usd') {
  const stripe = getStripe();
  const normalizedCurrency = validateManagedCreditCurrency(currency);
  if (!Number.isInteger(amountMinorUnits) || amountMinorUnits < 500) {
    throw new Error('Minimum credit purchase amount is $5.00 (or equivalent).');
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
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
      currency: normalizedCurrency
    }
  });
  return session.url;
}

async function createBillingPortal(organization) {
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
  const accountId = event.id;
  const existing = db.prepare('SELECT id FROM stripe_processed_events WHERE id = ?').get(accountId);
  if (existing) return false;

  db.transaction(() => {
    db.prepare('INSERT INTO stripe_processed_events (id, created_at) VALUES (?, ?)').run(
      accountId,
      new Date().toISOString()
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const organizationId = session.client_reference_id || session.metadata?.organization_id;

      if (organizationId) {
        getBillingAccount(organizationId);

        if (session.customer) {
          db.prepare(`
            UPDATE billing_accounts
            SET stripe_customer_id = ?, updated_at = ?
            WHERE organization_id = ?
          `).run(session.customer, new Date().toISOString(), organizationId);
        }

        if (session.subscription) {
          db.prepare(`
            UPDATE billing_accounts
            SET stripe_subscription_id = ?, plan = ?, status = 'active', updated_at = ?
            WHERE organization_id = ?
          `).run(
            session.subscription,
            session.metadata?.plan || 'byok',
            new Date().toISOString(),
            organizationId
          );
        }

        if (session.metadata?.type === 'managed_credits' || session.mode === 'payment') {
          const amountTotal = session.amount_total || 0;
          const currency = (session.currency || 'usd').toLowerCase();
          const rates = getManagedCreditExchangeRates();
          const rateToUsd = rates[currency] || 1;
          const totalUsdMicro = Math.round(amountTotal * rateToUsd * 10000);

          db.prepare(`
            UPDATE billing_accounts
            SET managed_credit_balance_micro_usd = managed_credit_balance_micro_usd + ?,
                updated_at = ?
            WHERE organization_id = ?
          `).run(totalUsdMicro, new Date().toISOString(), organizationId);
        }
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const account = db.prepare('SELECT organization_id FROM billing_accounts WHERE stripe_subscription_id = ?').get(subscription.id);
      if (account) {
        db.prepare(`
          UPDATE billing_accounts
          SET status = ?, updated_at = ?
          WHERE organization_id = ?
        `).run(subscription.status, new Date().toISOString(), account.organization_id);
      }
    }
  })();

  return true;
}

function recordUsage(organizationId, userId, eventType, units = 1, billable = true, sourceMode = 'byok') {
  const id = createId();
  const timestamp = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO usage_events (id, organization_id, user_id, event_type, units, billable, source_mode, created_at)
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
    gpt4o: { input_micro_usd_per_1k: 2500, output_micro_usd_per_1k: 10000 },
    gpt4o_mini: { input_micro_usd_per_1k: 150, output_micro_usd_per_1k: 600 }
  };
}

function estimateManagedReservation(model = 'gpt-4o', estimatedInputTokens = 2000, estimatedOutputTokens = 1000) {
  const modelKey = model.includes('mini') ? 'gpt4o_mini' : 'gpt4o';
  const rates = getLlmRates()[modelKey];
  const costMicroUsd = Math.round(
    (estimatedInputTokens / 1000) * rates.input_micro_usd_per_1k +
    (estimatedOutputTokens / 1000) * rates.output_micro_usd_per_1k
  );
  const markupBps = getManagedCreditMarkupBps();
  return Math.round(costMicroUsd * (1 + markupBps / 10000));
}

function reserveManagedCredits(organizationId, estimatedAmountMicroUsd) {
  const account = getBillingAccount(organizationId);
  const availableBalance = account.managed_credit_balance_micro_usd - account.managed_credit_reserved_micro_usd;

  if (availableBalance < estimatedAmountMicroUsd) {
    throw new Error('Insufficient managed credit balance. Please top up your account balance.');
  }

  const reservationId = createId();
  const timestamp = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      UPDATE billing_accounts
      SET managed_credit_reserved_micro_usd = managed_credit_reserved_micro_usd + ?,
          updated_at = ?
      WHERE organization_id = ?
    `).run(estimatedAmountMicroUsd, timestamp, organizationId);

    db.prepare(`
      INSERT INTO managed_credit_reservations (id, organization_id, reserved_micro_usd, status, created_at, updated_at)
      VALUES (?, ?, ?, 'reserved', ?, ?)
    `).run(reservationId, organizationId, estimatedAmountMicroUsd, timestamp, timestamp);
  })();

  return reservationId;
}

function recordLlmUsage(organizationId, userId, reservationId, model, promptTokens, completionTokens) {
  const modelKey = model.includes('mini') ? 'gpt4o_mini' : 'gpt4o';
  const rates = getLlmRates()[modelKey];
  const rawCostMicroUsd = Math.round(
    (promptTokens / 1000) * rates.input_micro_usd_per_1k +
    (completionTokens / 1000) * rates.output_micro_usd_per_1k
  );
  const markupBps = getManagedCreditMarkupBps();
  const finalChargeMicroUsd = Math.round(rawCostMicroUsd * (1 + markupBps / 10000));
  const timestamp = new Date().toISOString();

  db.transaction(() => {
    let reservedMicroUsd = 0;
    if (reservationId) {
      const res = db.prepare('SELECT reserved_micro_usd FROM managed_credit_reservations WHERE id = ?').get(reservationId);
      if (res) {
        reservedMicroUsd = res.reserved_micro_usd;
        db.prepare(`
          UPDATE managed_credit_reservations
          SET status = 'fulfilled', updated_at = ?
          WHERE id = ?
        `).run(timestamp, reservationId);
      }
    }

    db.prepare(`
      UPDATE billing_accounts
      SET managed_credit_balance_micro_usd = MAX(0, managed_credit_balance_micro_usd - ?),
          managed_credit_reserved_micro_usd = MAX(0, managed_credit_reserved_micro_usd - ?),
          updated_at = ?
      WHERE organization_id = ?
    `).run(finalChargeMicroUsd, reservedMicroUsd, timestamp, organizationId);

    db.prepare(`
      INSERT INTO llm_usage_logs (id, organization_id, user_id, model, prompt_tokens, completion_tokens, charge_micro_usd, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createId(), organizationId, userId, model, promptTokens, completionTokens, finalChargeMicroUsd, timestamp);
  })();

  return finalChargeMicroUsd;
}

function releaseManagedReservation(organizationId, reservationId) {
  if (!reservationId) return;
  const timestamp = new Date().toISOString();

  db.transaction(() => {
    const res = db.prepare('SELECT reserved_micro_usd, status FROM managed_credit_reservations WHERE id = ?').get(reservationId);
    if (res && res.status === 'reserved') {
      db.prepare(`
        UPDATE managed_credit_reservations
        SET status = 'released', updated_at = ?
        WHERE id = ?
      `).run(timestamp, reservationId);

      db.prepare(`
        UPDATE billing_accounts
        SET managed_credit_reserved_micro_usd = MAX(0, managed_credit_reserved_micro_usd - ?),
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
    releaseManagedReservation(item.organization_id, item.id);
  }
}

function setBillingMode(organizationId, mode) {
  if (!['byok', 'managed'].includes(mode)) {
    throw new Error("Billing mode must be 'byok' or 'managed'.");
  }
  db.prepare(`
    UPDATE billing_accounts
    SET mode = ?, updated_at = ?
    WHERE organization_id = ?
  `).run(mode, new Date().toISOString(), organizationId);
}

function getLlmUsage(organizationId) {
  return db.prepare(`
    SELECT SUM(prompt_tokens) as total_prompt_tokens,
           SUM(completion_tokens) as total_completion_tokens,
           SUM(charge_micro_usd) as total_charge_micro_usd
    FROM llm_usage_logs
    WHERE organization_id = ?
  `).get(organizationId);
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