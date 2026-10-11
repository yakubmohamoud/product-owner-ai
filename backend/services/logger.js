function serializeError(error) {
  if (!(error instanceof Error)) {
    return { message: redact(String(error)) };
  }
  return {
    name: error.name,
    message: redact(error.message),
    stack: process.env.NODE_ENV === 'production' ? undefined : error.stack
  };
}

function redact(value) {
  return value.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|xox[a-z]-[A-Za-z0-9-]+|whsec_[A-Za-z0-9]+)\b/g, '[REDACTED]');
}

function log(level, event, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields
  };
  const output = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    console.error(output);
  } else {
    console.log(output);
  }
}

function logError(event, error, fields = {}) {
  log('error', event, { ...fields, error: serializeError(error) });
}

module.exports = { log, logError };
