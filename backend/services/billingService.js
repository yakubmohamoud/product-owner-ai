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
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  client_reference_id: organizationId,
  metadata: {
    organization_id: organizationId,
    type: 'managed_credits'
  },
  // ... line items & URLs
});

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
  const current = db.prepare('SELECT * FROM subscriptions WHERE organization_id = ?')
    .get(organization.id);
  let customerId = current?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email || undefined,
      name: organization.name,
      metadata: { organization_id: organization.id }
    }, { idempotencyKey: `poai-customer-${organization.id}` });
    customerId = customer.id;
    db.prepare(`
      INSERT INTO subscriptions (organization_id, stripe_customer_id, plan, status, updated_at)
      VALUES (?, ?, 'free', 'active', ?)
      ON CONFLICT(organization_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id
    `).run(organization.id, customerId, new Date().toISOString());
  }

  const base = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}/?billing=success`,
    cancel_url: `${base}/?billing=cancelled`,
    client_reference_id: organization.id,
    metadata: { organization_id: organization.id, plan },
    subscription_data: { metadata: { organization_id: organization.id, plan } }
  }, { idempotencyKey: `poai-checkout-${organization.id}-${plan}-${Date.now()}` });
  return { url: session.url };
}

async function createManagedCreditsCheckout(organization, user, amount, currency = 'usd') {
  getBillingAccount(organization.id);
  const stripe = getStripe();
  const normalizedCurrency = validateManagedCreditCurrency(currency);
  const defaultPack = positiveIntegerFromEnv('MANAGED_CREDIT_PACK_MICRO_USD', 25_000_000);
  const purchaseAmount = amount === undefined ? defaultPack / 1_000_000 : Number(amount);
  const limits = { gbp: [5, 8000], usd: [5, 10000], eur: [5, 9000] };
  if (!Number.isFinite(purchaseAmount) || purchaseAmount < limits[normalizedCurrency][0] || purchaseAmount > limits[normalizedCurrency][1]) {
    throw new Error(`Managed API credits must be purchased for between ${limits[normalizedCurrency][0]} and ${limits[normalizedCurrency][1]} ${normalizedCurrency.toUpperCase()}.`);
  }
  if (!Number.isSafeInteger(Math.round(purchaseAmount * 100)) || !/^(\d+)(\.\d{1,2})?$/.test(String(purchaseAmount))) {
    throw new Error('Managed API credit amount must have at most two decimal places.');
  }
  const minorUnits = Math.round(purchaseAmount * 100);
  const usdPerUnit = getManagedCreditExchangeRates();
  if (!Number.isFinite(usdPerUnit[normalizedCurrency]) || usdPerUnit[normalizedCurrency] <= 0) {
    throw new Error('The configured currency exchange rate is invalid.');
  }
  const currencyValueMicroUsd = Math.round(minorUnits * 10_000 * usdPerUnit[normalizedCurrency]);
  if (!Number.isSafeInteger(currencyValueMicroUsd) || currencyValueMicroUsd <= 0) {
    throw new Error('Managed API credit amount is invalid.');
  }
  const credits = currencyValueMicroUsd;
  const markupBps = getManagedCreditMarkupBps();
  const markupMicroUsd = Math.round(currencyValueMicroUsd * markupBps / (10_000 + markupBps));
  const stripeFeeEstimateMicroUsd = estimateStripeFeeMicroUsd(normalizedCurrency, minorUnits, usdPerUnit[normalizedCurrency]);
  const purchaseBreakdown = {
    currency: normalizedCurrency.toUpperCase(),
    amount_minor_units: minorUnits,
    exchange_rate_usd_per_currency_unit: usdPerUnit[normalizedCurrency],
    currency_value_micro_usd: currencyValueMicroUsd,
    markup_micro_usd: markupMicroUsd,
    markup_basis_points: markupBps,
    stripe_fee_estimate_micro_usd: stripeFeeEstimateMicroUsd,
    credits_micro_usd: credits,
    estimated_gross_profit_micro_usd: markupMicroUsd,
    estimated_profit_after_processor_fee_micro_usd: markupMicroUsd - stripeFeeEstimateMicroUsd,
    estimates: { revenue: true, processor_fee: true }
  };
  const current = db.prepare('SELECT stripe_customer_id FROM subscriptions WHERE organization_id = ?')
    .get(organization.id);
  let customerId = current?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email || undefined,
      name: organization.name,
      metadata: { organization_id: organization.id }
    }, { idempotencyKey: `poai-customer-${organization.id}` });
    customerId = customer.id;
    db.prepare(`
      INSERT INTO subscriptions (organization_id, stripe_customer_id, plan, status, updated_at)
      VALUES (?, ?, 'managed', 'active', ?)
      ON CONFLICT(organization_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id
    `).run(organization.id, customerId, new Date().toISOString());
  }
  db.prepare(`
    UPDATE billing_accounts SET mode = 'managed', updated_at = ? WHERE organization_id = ?
  `).run(new Date().toISOString(), organization.id);
  const base = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    line_items: [{
      price_data: {
        currency: normalizedCurrency,
        unit_amount: minorUnits,
        product_data: { name: 'Product Owner AI managed API credits' }
      },
      quantity: 1
    }],
    success_url: `${base}/?billing=credits-added`,
    cancel_url: `${base}/?billing=cancelled`,
    client_reference_id: organization.id,
    metadata: {
      organization_id: organization.id,
      purpose: 'managed_api_credits',
      credits_micro_usd: String(credits),
      currency_value_micro_usd: String(currencyValueMicroUsd),
      charge_value_micro_usd: String(currencyValueMicroUsd),
      purchase_breakdown: JSON.stringify(purchaseBreakdown)
    }
  }, { idempotencyKey: `poai-credits-${organization.id}-${normalizedCurrency}-${minorUnits}` });
  return { url: session.url, credits_micro_usd: credits, breakdown: purchaseBreakdown };
}

async function createBillingPortal(organizationId) {
  const stripe = getStripe();
  const current = db.prepare('SELECT stripe_customer_id FROM subscriptions WHERE organization_id = ?')
    .get(organizationId);
  if (!current?.stripe_customer_id) throw new Error('This workspace has no billing account yet.');
  const portal = await stripe.billingPortal.sessions.create({
    customer: current.stripe_customer_id,
    return_url: `${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/`
  });
  return { url: portal.url };
}

function planForPrice(priceId) {
  if (priceId && priceId === process.env.STRIPE_PRICE_BYOK) return 'byok';
  if (priceId && priceId === process.env.STRIPE_PRICE_TEAM) return 'team';
  if (priceId && priceId === process.env.STRIPE_PRICE_BUSINESS) return 'business';
  if (priceId && priceId === process.env.STRIPE_PRICE_PAYG) return 'payg';
  return null;
}

function applyManagedCredit(organizationId, amountMicroUsd, referenceId) {
  if (!Number.isSafeInteger(amountMicroUsd) || amountMicroUsd <= 0) {
    throw new Error('Managed API credit amount must be a positive integer in micro-USD.');
  }
  const now = new Date().toISOString();
  const id = createId();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO billing_ledger
      (id, organization_id, entry_type, amount_micro_usd, reference_id, description, created_at)
    VALUES (?, ?, 'credit', ?, ?, 'Managed API credit purchase', ?)
  `).run(id, organizationId, amountMicroUsd, referenceId, now);
  if (insert.changes === 0) return false;
  db.prepare(`
    INSERT INTO billing_accounts (organization_id, mode, balance_micro_usd, updated_at)
    VALUES (?, 'managed', ?, ?)
    ON CONFLICT(organization_id) DO UPDATE SET
      mode = 'managed',
      balance_micro_usd = billing_accounts.balance_micro_usd + excluded.balance_micro_usd,
      updated_at = excluded.updated_at
  `).run(organizationId, amountMicroUsd, now);
  return true;
}

function persistSubscription(data) {
  const organizationId = data.metadata?.organization_id;
  if (!organizationId) throw new Error('Stripe subscription metadata is missing organization_id.');
  const priceId = data.items?.data?.[0]?.price?.id;
  const plan = data.metadata?.plan || planForPrice(priceId);
  if (!plan || !['byok', 'team', 'business', 'payg'].includes(plan)) {
    throw new Error('Stripe subscription uses an unrecognized plan price.');
  }
  db.prepare(`
    INSERT INTO subscriptions
      (organization_id, stripe_customer_id, stripe_subscription_id, plan, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(organization_id) DO UPDATE SET
      stripe_customer_id = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      plan = excluded.plan,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(
    organizationId,
    typeof data.customer === 'string' ? data.customer : data.customer?.id,
    data.id,
    plan,
    data.status || 'active',
    new Date().toISOString()
  );
  if (plan === 'byok') {
    db.prepare(`
      INSERT INTO billing_accounts (organization_id, mode, updated_at)
      VALUES (?, 'byok', ?)
      ON CONFLICT(organization_id) DO UPDATE SET mode = 'byok', updated_at = excluded.updated_at
    `).run(organizationId, new Date().toISOString());
  }
}

function processStripeEvent(event) {
  const process = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM stripe_events WHERE event_id = ?').get(event.id)) return false;

    if (event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted') {
      persistSubscription(event.data.object);
      if (event.type === 'customer.subscription.deleted') {
        db.prepare(`
          UPDATE subscriptions SET plan = 'free', status = 'active', updated_at = ?
          WHERE stripe_subscription_id = ?
        `).run(new Date().toISOString(), event.data.object.id);
        db.prepare(`
          UPDATE billing_accounts SET mode = 'managed', updated_at = ?
          WHERE organization_id = ?
        `).run(new Date().toISOString(), event.data.object.metadata?.organization_id);
      }
    } else if (event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      if (session.mode === 'subscription' && session.metadata?.organization_id) {
        db.prepare(`
          UPDATE subscriptions SET stripe_customer_id = ?, stripe_subscription_id = ?, plan = ?, status = 'active', updated_at = ?
          WHERE organization_id = ?
        `).run(
          typeof session.customer === 'string' ? session.customer : session.customer?.id,
          typeof session.subscription === 'string' ? session.subscription : session.subscription?.id,
          ['byok', 'team', 'business', 'payg'].includes(session.metadata.plan)
            ? session.metadata.plan
            : 'free',
          new Date().toISOString(),
          session.metadata.organization_id
        );
        if (session.metadata.plan === 'byok') {
          db.prepare(`
            INSERT INTO billing_accounts (organization_id, mode, updated_at)
            VALUES (?, 'byok', ?)
            ON CONFLICT(organization_id) DO UPDATE SET mode = 'byok', updated_at = excluded.updated_at
          `).run(session.metadata.organization_id, new Date().toISOString());
        }
      } else if (session.mode === 'payment' &&
        session.metadata?.purpose === 'managed_api_credits' &&
        session.metadata.organization_id &&
        session.payment_status === 'paid') {
        const amount = Number.parseInt(session.metadata.charge_value_micro_usd || session.metadata.credits_micro_usd, 10);
        if (!Number.isSafeInteger(amount) || amount <= 0) {
          throw new Error('Managed API credit checkout has an invalid charge value.');
        }
        applyManagedCredit(
          session.metadata.organization_id,
          amount,
          session.id || event.id
        );
      }
    }

    db.prepare('INSERT INTO stripe_events (event_id, processed_at) VALUES (?, ?)')
      .run(event.id, new Date().toISOString());
    return true;
  });
  return process();
}

async function reportMeteredUsage(organizationId, eventId, units) {
  if (!process.env.STRIPE_METER_EVENT_NAME) {
    throw new Error('STRIPE_METER_EVENT_NAME must match the configured Stripe usage meter.');
  }
  const stripe = getStripe();
  const subscription = db.prepare('SELECT stripe_customer_id FROM subscriptions WHERE organization_id = ?')
    .get(organizationId);
  if (!subscription?.stripe_customer_id) throw new Error('Pay-as-you-go workspace has no Stripe customer.');
  await stripe.billing.meterEvents.create({
    event_name: process.env.STRIPE_METER_EVENT_NAME,
    payload: {
      stripe_customer_id: subscription.stripe_customer_id,
      value: String(units)
    },
    identifier: eventId
  });
}

function recordUsage(organizationId, userId, eventType, units, billable, source) {
  const id = createId();
  const now = new Date().toISOString();
  const insert = db.transaction(() => {
    db.prepare(`
      INSERT INTO usage_events (id, organization_id, user_id, event_type, units, billable, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, organizationId, userId, eventType, units, billable ? 1 : 0, source, now);
    const subscription = db.prepare('SELECT plan FROM subscriptions WHERE organization_id = ?').get(organizationId);
    if (billable && subscription?.plan === 'payg') {
      db.prepare(`
        INSERT INTO billing_outbox (usage_event_id, next_attempt_at, updated_at)
        VALUES (?, ?, ?)
      `).run(id, now, now);
    }
  });
  insert();
  return id;
}

function getLlmRates(model = process.env.OPENAI_MODEL || 'gpt-4o-mini') {
  let input = positiveIntegerFromEnv('LLM_INPUT_COST_MICRO_USD_PER_MILLION', 150_000);
  let output = positiveIntegerFromEnv('LLM_OUTPUT_COST_MICRO_USD_PER_MILLION', 600_000);
  if (process.env.LLM_MODEL_PRICING_JSON) {
    let pricing;
    try {
      pricing = JSON.parse(process.env.LLM_MODEL_PRICING_JSON);
    } catch (error) {
      throw new Error('LLM_MODEL_PRICING_JSON must contain valid JSON.', { cause: error });
    }
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) {
      throw new Error('LLM_MODEL_PRICING_JSON must be a JSON object keyed by model name.');
    }
    const modelPricing = pricing[model];
    if (modelPricing !== undefined) {
      if (!Number.isSafeInteger(modelPricing.input_micro_usd_per_million) ||
        modelPricing.input_micro_usd_per_million < 0 ||
        !Number.isSafeInteger(modelPricing.output_micro_usd_per_million) ||
        modelPricing.output_micro_usd_per_million < 0) {
        throw new Error(`LLM model pricing for ${model} must provide non-negative integer input/output rates.`);
      }
      input = modelPricing.input_micro_usd_per_million;
      output = modelPricing.output_micro_usd_per_million;
    }
  }
  const markupBps = positiveIntegerFromEnv('MANAGED_LLM_MARKUP_BPS', 3000);
  if (markupBps <= 0 || markupBps > 100_000) {
    throw new Error('MANAGED_LLM_MARKUP_BPS must be between 1 and 100000.');
  }
  return {
    input,
    output,
    markupBps,
    inputSellingRate: Math.ceil(input * (10_000 + markupBps) / 10_000),
    outputSellingRate: Math.ceil(output * (10_000 + markupBps) / 10_000)
  };
}

function calculateLlmCost(inputTokens, outputTokens, rate) {
  return Math.ceil(
    (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000
  );
}

function estimateManagedReservation(context, callCount) {
  if (!Number.isInteger(callCount) || callCount < 1) {
    throw new Error('LLM reservation requires at least one generation call.');
  }
  const rates = getLlmRates();
  const configuredMaxOutput = Number(process.env.MANAGED_MAX_OUTPUT_TOKENS || 4096);
  if (!Number.isSafeInteger(configuredMaxOutput) || configuredMaxOutput <= 0) {
    throw new Error('MANAGED_MAX_OUTPUT_TOKENS must be a positive integer.');
  }
  const maxOutputTokens = Math.min(configuredMaxOutput, 16384);
  const estimatedInputTokensPerCall = String(context || '').length + 4000;
  const estimatedCost = calculateLlmCost(
    estimatedInputTokensPerCall * callCount,
    maxOutputTokens * callCount,
    { input: rates.inputSellingRate, output: rates.outputSellingRate }
  );
  return Math.max(1, estimatedCost);
}

function reserveManagedCredits(organizationId, userId, requestId, amountMicroUsd) {
  if (!Number.isSafeInteger(amountMicroUsd) || amountMicroUsd <= 0) {
    throw new Error('Managed API reservation must be a positive integer.');
  }
  const account = getBillingAccount(organizationId);
  if (account.mode !== 'managed') {
    throw new Error('The organization is not using managed API billing.');
  }
  const now = new Date().toISOString();
  const reserve = db.transaction(() => {
    const update = db.prepare(`
      UPDATE billing_accounts
      SET reserved_micro_usd = reserved_micro_usd + ?, updated_at = ?
      WHERE organization_id = ? AND mode = 'managed'
        AND balance_micro_usd - reserved_micro_usd >= ?
    `).run(amountMicroUsd, now, organizationId, amountMicroUsd);
    if (!update.changes) {
      throw new Error('Managed API credit balance is too low for this request. Add credits or switch to BYOK.');
    }
    db.prepare(`
      INSERT INTO billing_reservations
        (request_id, organization_id, user_id, remaining_micro_usd, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(requestId, organizationId, userId, amountMicroUsd, now);
  });
  reserve();
}

function recordLlmUsage(organizationId, userId, requestId, mode, usage) {
  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    throw new Error('LLM provider response did not include exact input and output token counts.');
  }
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens) || totalTokens < inputTokens + outputTokens) {
    throw new Error('LLM provider response included invalid total token usage.');
  }
  const model = typeof usage.model === 'string' && usage.model.trim()
    ? usage.model.trim()
    : '';
  const provider = typeof usage.provider === 'string' && usage.provider.trim()
    ? usage.provider.trim()
    : 'openai';
  if (!model) throw new Error('LLM provider response did not identify the model used.');

  const rates = getLlmRates(usage.pricingModel || model);
  const cost = calculateLlmCost(inputTokens, outputTokens, rates);
  const charge = mode === 'managed'
    ? calculateLlmCost(inputTokens, outputTokens, {
      input: rates.inputSellingRate,
      output: rates.outputSellingRate
    })
    : 0;
  const id = createId();
  const now = new Date().toISOString();
  const insert = db.transaction(() => {
    if (mode === 'managed') {
      const reservation = db.prepare(`
        SELECT remaining_micro_usd FROM billing_reservations
        WHERE request_id = ? AND organization_id = ? AND user_id = ?
      `).get(requestId, organizationId, userId);
      if (!reservation || reservation.remaining_micro_usd < charge) {
        throw new Error('Managed API request exceeded its reserved credit balance.');
      }
      const debit = db.prepare(`
        UPDATE billing_accounts
        SET balance_micro_usd = balance_micro_usd - ?,
          reserved_micro_usd = reserved_micro_usd - ?, updated_at = ?
        WHERE organization_id = ? AND balance_micro_usd >= ? AND reserved_micro_usd >= ?
      `).run(charge, charge, now, organizationId, charge, charge);
      if (!debit.changes) throw new Error('Managed API credit balance changed before settlement.');
      const updateReservation = db.prepare(`
        UPDATE billing_reservations SET remaining_micro_usd = remaining_micro_usd - ?
        WHERE request_id = ? AND organization_id = ?
      `).run(charge, requestId, organizationId);
      if (!updateReservation.changes) throw new Error('Managed API credit reservation disappeared before settlement.');
      if (charge > 0) {
        db.prepare(`
          INSERT INTO billing_ledger
            (id, organization_id, user_id, entry_type, amount_micro_usd, reference_id, description, created_at)
          VALUES (?, ?, ?, 'debit', ?, ?, 'Managed LLM generation with configured markup', ?)
        `).run(createId(), organizationId, userId, charge, id, now);
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
      id,
      organizationId,
      userId,
      requestId,
      provider,
      model,
      inputTokens,
      outputTokens,
      totalTokens,
      rates.input,
      rates.output,
      cost,
      charge,
      mode,
      now
    );
  });
  insert();
  return { id, cost_micro_usd: cost, charged_micro_usd: charge };
}

function releaseManagedReservation(requestId, organizationId) {
  const release = db.transaction(() => {
    const reservation = db.prepare(`
      SELECT remaining_micro_usd FROM billing_reservations
      WHERE request_id = ? AND organization_id = ?
    `).get(requestId, organizationId);
    if (!reservation) return;
    const update = db.prepare(`
      UPDATE billing_accounts
      SET reserved_micro_usd = reserved_micro_usd - ?, updated_at = ?
      WHERE organization_id = ? AND reserved_micro_usd >= ?
    `).run(reservation.remaining_micro_usd, new Date().toISOString(), organizationId, reservation.remaining_micro_usd);
    if (!update.changes) throw new Error('Managed API credit reservation could not be released.');
    db.prepare('DELETE FROM billing_reservations WHERE request_id = ?').run(requestId);
  });
  release();
}

function cleanupExpiredReservations(maxAgeMs = 24 * 60 * 60 * 1000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const rows = db.prepare(`
    SELECT request_id, organization_id, remaining_micro_usd FROM billing_reservations
    WHERE created_at <= ?
  `).all(cutoff);
  const cleanup = db.transaction(() => {
    for (const row of rows) {
      db.prepare(`
        UPDATE billing_accounts
        SET reserved_micro_usd = MAX(0, reserved_micro_usd - ?), updated_at = ?
        WHERE organization_id = ?
      `).run(row.remaining_micro_usd, new Date().toISOString(), row.organization_id);
      db.prepare('DELETE FROM billing_reservations WHERE request_id = ?').run(row.request_id);
    }
  });
  cleanup();
  return rows.length;
}

function setBillingMode(organizationId, mode) {
  if (!['byok', 'managed'].includes(mode)) {
    throw new Error('Billing mode must be byok or managed.');
  }
  const account = getBillingAccount(organizationId);
  if (mode === 'byok') {
    const subscription = db.prepare(`
      SELECT plan, status FROM subscriptions WHERE organization_id = ?
    `).get(organizationId);
    if (subscription?.plan !== 'byok' || !['active', 'trialing'].includes(subscription.status)) {
      throw new Error('An active BYOK platform-fee subscription is required before switching to BYOK.');
    }
  } else if (account.balance_micro_usd <= account.reserved_micro_usd) {
    throw new Error('Add managed API credits before switching to managed billing.');
  }
  db.prepare(`
    UPDATE billing_accounts SET mode = ?, updated_at = ? WHERE organization_id = ?
  `).run(mode, new Date().toISOString(), organizationId);
  return getBillingAccount(organizationId);
}

function getLlmUsage(organizationId, limit = 100) {
  const safeLimit = Math.min(500, Math.max(1, Number.isInteger(limit) ? limit : 100));
  return db.prepare(`
    SELECT user_id, request_id, provider, model, input_tokens, output_tokens, total_tokens,
      cost_micro_usd, charged_micro_usd, billing_mode, created_at
    FROM llm_usage WHERE organization_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(organizationId, safeLimit);
}

let draining = false;

async function drainBillingOutbox() {
  if (draining || !process.env.STRIPE_METER_EVENT_NAME || !process.env.STRIPE_SECRET_KEY) return;
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
