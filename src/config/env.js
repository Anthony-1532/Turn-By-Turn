'use strict';

require('dotenv').config({ quiet: true });

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer`);
  return n;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const nodeEnv = str('NODE_ENV', 'development');
const isProd = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

const squadSecret = str('SQUADCO_SECRET_KEY', '');

const config = {
  nodeEnv,
  isProd,
  isTest,
  port: int('PORT', 4000),
  appName: 'TurnByTurn',
  publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:4000'),
  corsOrigins: str('CORS_ORIGINS', '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  mongoUri: str('MONGODB_URI', 'mongodb://127.0.0.1:27017/turnbyturn'),

  jwt: {
    accessSecret: str('JWT_ACCESS_SECRET', isProd ? '' : 'dev-access-secret-change-me'),
    accessTtlSeconds: int('JWT_ACCESS_TTL_SECONDS', 15 * 60),
    refreshTtlDays: int('JWT_REFRESH_TTL_DAYS', 30),
    setupTtlSeconds: int('JWT_SETUP_TTL_SECONDS', 30 * 60),
  },

  otp: {
    length: 6,
    ttlSeconds: int('OTP_TTL_SECONDS', 10 * 60),
    resendCooldownSeconds: int('OTP_RESEND_COOLDOWN_SECONDS', 60),
    maxVerifyAttempts: int('OTP_MAX_VERIFY_ATTEMPTS', 5),
    // Only honoured outside production: lets the Flutter team use a fixed code against mock SMS.
    devFixedCode: isProd ? '' : str('OTP_DEV_FIXED_CODE', ''),
  },

  rateLimit: {
    signInMaxFailures: int('SIGNIN_MAX_FAILURES', 5),
    signInWindowSeconds: int('SIGNIN_WINDOW_SECONDS', 15 * 60),
    lockoutSeconds: int('LOCKOUT_SECONDS', 15 * 60),
    otpSendMaxPerHour: int('OTP_SEND_MAX_PER_HOUR', 5),
  },

  money: {
    // 2% expressed in basis points; added on top of the contribution, never deducted from payouts.
    platformFeeBps: int('PLATFORM_FEE_BPS', 200),
    minPartialPaymentKobo: int('MIN_PARTIAL_PAYMENT_KOBO', 100 * 100),
    currency: 'NGN',
  },

  cycles: {
    overdueGraceHours: int('CYCLE_OVERDUE_GRACE_HOURS', 24),
    resolutionAfterDays: int('CYCLE_RESOLUTION_AFTER_DAYS', 7),
    autoReminderDaysBefore: str('AUTO_REMINDER_DAYS_BEFORE', '3,1')
      .split(',')
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => !Number.isNaN(n)),
  },

  payouts: {
    // Open question with the client: keep manual ("Start payout") until confirmed otherwise.
    autoStart: bool('AUTO_START_PAYOUTS', false),
  },

  reminders: {
    cooldownHours: int('REMINDER_COOLDOWN_HOURS', 24),
  },

  timezone: str('APP_TIMEZONE', 'Africa/Lagos'),

  squadco: {
    secretKey: squadSecret,
    baseUrl: str(
      'SQUADCO_BASE_URL',
      isProd ? 'https://api-d.squadco.com' : 'https://sandbox-api-d.squadco.com',
    ),
    merchantId: str('SQUADCO_MERCHANT_ID', ''),
    smsSenderId: str('SQUADCO_SMS_SENDER_ID', 'TurnByTurn'),
    paymentCallbackUrl: str('SQUADCO_PAYMENT_CALLBACK_URL', ''),
    // Without credentials every Squadco call is simulated so the app works end-to-end locally.
    mock: bool('SQUADCO_MOCK', !squadSecret),
  },

  zeptomail: {
    token: str('ZEPTOMAIL_TOKEN', ''),
    baseUrl: str('ZEPTOMAIL_BASE_URL', 'https://api.zeptomail.com/v1.1/email'),
    fromAddress: str('ZEPTOMAIL_FROM_ADDRESS', 'noreply@turnbyturn.app'),
    fromName: str('ZEPTOMAIL_FROM_NAME', 'TurnByTurn'),
  },

  firebase: {
    // Full service-account JSON (stringified) or base64 of it.
    serviceAccount: str('FIREBASE_SERVICE_ACCOUNT', ''),
  },

  jobs: {
    inProcess: bool('ENABLE_INPROCESS_JOBS', false),
    intervalSeconds: int('INPROCESS_JOBS_INTERVAL_SECONDS', 300),
    cronSecret: str('CRON_SECRET', ''),
  },

  devRoutes: bool('ENABLE_DEV_ROUTES', !isProd),
};

function assertConfig() {
  if (!config.jwt.accessSecret) throw new Error('JWT_ACCESS_SECRET is required');
  if (config.isProd && config.squadco.mock) {
    // Allowed (e.g. a staging deploy), but loudly.
    console.warn('[config] SQUADCO_MOCK is enabled in production: payments are simulated');
  }
}

module.exports = { config, assertConfig };
